/**
 * Real-PostgreSQL harness for the six SQL migrations.
 *
 *   node scripts/test-sql-concurrency.mjs
 *
 * Unlike the other suites (which simulate the database in JavaScript), this
 * file starts a THROWAWAY PostgreSQL cluster in a temp directory, creates the
 * minimum Supabase-shaped schema (roles, products/orders/coupons/users,
 * storage.objects/buckets, auth.users), applies the migrations and then runs
 * genuine concurrent transactions against them.
 *
 * It is a no-op (SKIP, exit 0) when the PostgreSQL server tools or psql are not
 * installed, so `npm test` still works on machines/CI without PostgreSQL.
 * It also skips PostgreSQL < 15 because products_public_view.sql needs
 * `security_invoker`.
 *
 * Nothing here touches Supabase, production, staging or any existing database:
 * the cluster lives in a fresh `mkdtemp()` directory and is destroyed at exit.
 *
 * Covers:
 *   - atomic_place_order.sql: same key + same cart, same key + DIFFERENT carts
 *     (with a coupon), order-id collision after a failed INSERT, and the
 *     guarantee that coupon usageCount moves exactly once.
 *   - atomic_order_lifecycle.sql: legacy/double-encoded/non-array/broken items,
 *     skipped-line warnings, missing product (no partial restore).
 *   - admin_protection.sql: two concurrent last-admin demotions.
 *   - products_public_view.sql: Phase 1 vs Phase 3 (PUBLIC/anon/authenticated).
 *   - storage_hardening.sql: only products-scoped policies are dropped, blanket
 *     and other-bucket policies are kept, and restore recreates them verbatim.
 *   - security_hardening.sql: existing provisioning trigger blocks a duplicate,
 *     unrelated triggers are preserved, re-runs do not duplicate.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = new URL('..', import.meta.url);
const DB = 'zshm_sql_test';

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}
function ok(value, label) { eq(Boolean(value), true, label); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Tool discovery ─────────────────────────────────────────────────────────
function findTool(name) {
  const candidates = [
    process.env.PGBIN ? join(process.env.PGBIN, name) : null,
    name,
    join('/opt/homebrew/bin', name),
    join('/usr/local/bin', name),
    join('/usr/bin', name),
  ].filter(Boolean);
  for (const candidate of candidates) {
    // `postgres --version` prints and exits; pg_ctl/initdb/psql do the same.
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return candidate;
  }
  return null;
}

const tools = {
  initdb: findTool('initdb'),
  pgCtl: findTool('pg_ctl'),
  psql: findTool('psql'),
  postgres: findTool('postgres'),
};

function postgresMajor() {
  if (!tools.postgres) return 0;
  const r = spawnSync(tools.postgres, ['--version'], { encoding: 'utf8' });
  const m = /(\d+)(?:\.\d+)?/.exec(r.stdout || '');
  return m ? Number(m[1]) : 0;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ─── Cluster lifecycle ──────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'zashm-sql-'));
const dataDir = join(tmp, 'data');
const sockDir = join(tmp, 'sock');
let clusterStarted = false;
let sockPort = 0;

function clusterCleanup() {
  if (!clusterStarted) return;
  try {
    spawnSync(tools.pgCtl, ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], {
      encoding: 'utf8', timeout: 15000,
    });
  } catch { /* best effort */ }
  clusterStarted = false;
}
process.on('exit', () => {
  clusterCleanup();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function startCluster() {
  mkdirSync(sockDir, { recursive: true });
  sockPort = await freePort();

  const init = spawnSync(tools.initdb, [
    '-D', dataDir, '-U', 'postgres', '-A', 'trust', '--locale=C', '--encoding=UTF8',
  ], { encoding: 'utf8', timeout: 120000 });
  if (init.status !== 0) {
    throw new Error(`initdb failed:\n${init.stdout || ''}${init.stderr || ''}`);
  }

  const options = `-k ${sockDir} -p ${sockPort} -c fsync=off -c full_page_writes=off -c autovacuum=off`;
  const start = spawnSync(tools.pgCtl, [
    '-D', dataDir, '-l', join(tmp, 'postgres.log'), '-o', options, '-w', 'start',
  ], { encoding: 'utf8', timeout: 120000 });
  if (start.status !== 0) {
    throw new Error(`pg_ctl start failed:\n${start.stdout || ''}${start.stderr || ''}`);
  }
  clusterStarted = true;
}

function psqlArgs(db = DB) {
  return [
    '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
    '-h', sockDir, '-p', String(sockPort), '-U', 'postgres', '-d', db,
  ];
}

function runSql(db, sql) {
  const r = spawnSync(tools.psql, psqlArgs(db).concat(['-c', sql]), {
    encoding: 'utf8', timeout: 60000,
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  return {
    status: r.status,
    stdout,
    stderr,
    out: `${stdout}${stderr}`,
  };
}

function apply(db, relativePath) {
  const r = spawnSync(tools.psql, psqlArgs(db).concat(['-f', fileURLToPath(new URL(relativePath, ROOT))]), {
    encoding: 'utf8', timeout: 120000,
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const out = `${stdout}${stderr}`;
  if (process.env.DEBUG_SQL) console.log(out);
  eq(r.status, 0, `applies ${relativePath}`);
  if (r.status !== 0) {
    console.log(out.split('\n').slice(-25).join('\n'));
  }
  return out;
}

function applyAsRole(db, role, relativePath) {
  const r = spawnSync(tools.psql, psqlArgs(db).concat([
    '-v', 'ON_ERROR_STOP=1',
    '-c', `SET ROLE ${role};`,
    '-f', fileURLToPath(new URL(relativePath, ROOT)),
  ]), { encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (process.env.DEBUG_SQL) console.log(out);
  return { status: r.status, out };
}

function scalar(db, sql) {
  const r = runSql(db, sql);
  if (r.status !== 0) throw new Error(`SQL failed: ${sql}\n${r.out}`);
  return r.stdout.trim();
}
function scalarNum(db, sql) { return Number(scalar(db, sql)); }

// ─── Small helpers ──────────────────────────────────────────────────────────
let dollarSeq = 0;
function dollar(value) {
  dollarSeq += 1;
  const tag = `zshm${dollarSeq}`;
  return `$${tag}$${value}$${tag}$`;
}
function textLit(value) { return dollar(value); }

function lastJson(out) {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  throw new Error(`no JSON result in output:\n${out}`);
}

// ─── Interactive psql sessions (for real race windows) ──────────────────────
function openSession(db) {
  const child = spawn(tools.psql, psqlArgs(db), { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let exited = false;
  const listeners = new Set();

  const notify = () => { for (const fn of listeners) fn(); };
  child.stdout.on('data', (d) => { output += d.toString(); notify(); });
  child.stderr.on('data', (d) => { output += d.toString(); notify(); });
  child.on('exit', () => { exited = true; notify(); });

  function waitFor(check, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const tick = () => {
        const value = check();
        if (value) {
          listeners.delete(tick);
          clearTimeout(timer);
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(tick);
        reject(new Error(`timed out waiting for psql output.\n${output}`));
      }, timeoutMs);
      listeners.add(tick);
      tick();
    });
  }

  return {
    child,
    send(sql) { child.stdin.write(`${sql}\n`); },
    waitForMarker(marker, timeoutMs) {
      return waitFor(() => (output.includes(marker) ? 'marker' : null), timeoutMs);
    },
    waitForMarkerOrExit(marker, timeoutMs) {
      return waitFor(() => {
        if (output.includes(marker)) return 'marker';
        if (exited) return 'exit';
        return null;
      }, timeoutMs);
    },
    finish() {
      if (!child.killed) {
        try { child.stdin.end(); } catch { /* already closed */ }
      }
    },
    get output() { return output; },
    get exited() { return exited; },
  };
}

async function waitForBlockedBackend(db, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = scalarNum(db, `
      SELECT count(*) FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND state = 'active'
    `);
    if (n > 0) return true;
    await sleep(40);
  }
  return false;
}

/**
 * Runs `aSql` in an open transaction, then `bSql` in a second connection which
 * is guaranteed to meet the first one mid-transaction (we wait until the second
 * backend is actually blocked on a lock before committing A). This is the real
 * race window: B passes the pre-INSERT idempotency check, then blocks/conflicts
 * on the UNIQUE index (or on a row lock) until A commits.
 */
async function raceTwoTransactions(db, aSql, bSql) {
  const a = openSession(db);
  a.send('BEGIN;');
  a.send(aSql);
  a.send("SELECT 'READY_A';");
  await a.waitForMarker('READY_A');

  const b = openSession(db);
  b.send('BEGIN;');
  b.send(bSql);
  b.send("SELECT 'READY_B';");

  const blocked = await waitForBlockedBackend(db);
  eq(blocked, true, 'the second transaction is genuinely blocked on a lock');

  a.send('COMMIT;');
  a.send("SELECT 'COMMIT_A';");
  await a.waitForMarker('COMMIT_A');

  const bState = await b.waitForMarkerOrExit('READY_B');
  if (bState === 'marker') {
    b.send('COMMIT;');
    b.send("SELECT 'COMMIT_B';");
    await b.waitForMarker('COMMIT_B');
  }

  const result = { a: a.output, b: b.output, bExited: bState === 'exit' };
  a.finish();
  b.finish();
  return result;
}

// ─── JSON fixtures ──────────────────────────────────────────────────────────
function makeOrder({
  id, items, discountCode = null, subtotal = 100, discount = 0, total,
}) {
  return {
    id,
    subtotal,
    discount,
    total: total === undefined ? subtotal - discount : total,
    discountCode,
    status: 'Pending',
    date: '2026-01-01',
    customer: 'Concurrency Test',
    phone: '01000000000',
    address: 'Test street',
    city: 'Cairo',
    notes: '',
    items,
    timestamps: { created: '2026-01-01T00:00:00.000Z' },
  };
}

function placeSql(order, key) {
  return `SELECT public.atomic_place_order(
    ${dollar(JSON.stringify(order))}::jsonb,
    ${key === null || key === undefined ? 'NULL' : textLit(key)}
  );`;
}

function setStatusSql(id, expected, next) {
  return `SELECT public.atomic_set_order_status(
    ${textLit(id)}, ${textLit(expected)}, ${textLit(next)}, NULL);`;
}
function deleteOrderSql(id) {
  return `SELECT public.atomic_delete_order(${textLit(id)});`;
}

function seedShop(db) {
  const r = runSql(db, `
    DELETE FROM public.orders;
    DELETE FROM public.coupons;
    DELETE FROM public.products;
    INSERT INTO public.products
      (id, name, category, price, stock, "variantStock", "reservedStock", active)
    VALUES
      (1, 'Tee', 'clothing', 50, 10, '{"M-Black": 10}'::jsonb, 0, true),
      (2, 'Hat', 'clothing', 40, 10, '{"L-White": 10}'::jsonb, 0, true);
    INSERT INTO public.coupons
      (code, type, value, "discountValue", active, "startDate", "endDate",
       "usageLimit", "usageCount", "minOrderAmount", "maxDiscount")
    VALUES
      ('SAVE10', 'percentage', 10, 10, true, '2020-01-01', '2099-12-31',
       100, 0, 0, 0);
  `);
  if (r.status !== 0) throw new Error(`seedShop failed:\n${r.out}`);
}

function seedLegacyOrder(db, {
  id = 'ORD-LEGACY-1', status = 'Pending', itemsJson, code = 'SAVE10',
  stock = 10, couponUsage = 3,
} = {}) {
  const r = runSql(db, `
    DELETE FROM public.orders;
    DELETE FROM public.coupons;
    DELETE FROM public.products;
    INSERT INTO public.products
      (id, name, category, price, stock, "variantStock", "reservedStock", active)
    VALUES (1, 'Tee', 'clothing', 50, ${stock}, ${dollar(`{"M-Black": ${stock}}`)}::jsonb, 0, true);
    INSERT INTO public.coupons
      (code, type, value, "discountValue", active, "startDate", "endDate",
       "usageLimit", "usageCount", "minOrderAmount", "maxDiscount")
    VALUES
      ('SAVE10', 'percentage', 10, 10, true, '2020-01-01', '2099-12-31',
       100, ${couponUsage}, 0, 0);
    INSERT INTO public.orders
      (id, subtotal, discount, total, "discountCode", status, date,
       customer, phone, address, city, notes, items, timestamps)
    VALUES (
      ${textLit(id)}, 100, 10, 90,
      ${code === null ? 'NULL' : textLit(code)},
      ${textLit(status)}, '2026-01-01', 'Legacy', '01000000000', 'x', 'Cairo', '',
      ${dollar(JSON.stringify(itemsJson))}::jsonb, '{}'::jsonb
    );
  `);
  if (r.status !== 0) throw new Error(`seedLegacyOrder failed:\n${r.out}`);
}

// ─── Schema stub ────────────────────────────────────────────────────────────
function bootstrap(db) {
  const sql = `
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;

    CREATE SCHEMA auth;
    CREATE SCHEMA storage;

    CREATE TABLE public.products (
      id              bigint PRIMARY KEY,
      name            text,
      category        text,
      price           numeric,
      "salePrice"     numeric,
      description     text,
      stock           integer DEFAULT 0,
      "variantStock"  jsonb DEFAULT '{}'::jsonb,
      "reservedStock" integer DEFAULT 0,
      sku             text,
      label           text,
      tags            jsonb,
      active          boolean DEFAULT true,
      colors          jsonb,
      sizes           jsonb,
      images          jsonb,
      image           text,
      "sizeGuide"     jsonb,
      rating          numeric,
      reviews         jsonb
    );

    CREATE TABLE public.orders (
      id              text PRIMARY KEY,
      subtotal        numeric,
      discount        numeric,
      total           numeric,
      "discountCode"  text,
      status          text,
      date            text,
      customer        text,
      phone           text,
      "phoneAlt"      text,
      email           text,
      address         text,
      city            text,
      notes           text,
      items           jsonb,
      timestamps      jsonb,
      tracking_url    text
    );

    CREATE TABLE public.coupons (
      code            text PRIMARY KEY,
      type            text,
      value           numeric,
      "discountValue" numeric,
      "minOrderAmount" numeric,
      "maxDiscount"   numeric,
      active          boolean,
      "startDate"     text,
      "endDate"       text,
      "usageLimit"    integer,
      "usageCount"    integer DEFAULT 0
    );

    CREATE TABLE public.users (
      id    text PRIMARY KEY,
      name  text,
      email text,
      role  text
    );

    CREATE TABLE auth.users (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email              text,
      raw_user_meta_data jsonb DEFAULT '{}'::jsonb
    );

    CREATE TABLE storage.buckets (
      id                 text PRIMARY KEY,
      public             boolean DEFAULT false,
      file_size_limit    bigint,
      allowed_mime_types text[]
    );
    INSERT INTO storage.buckets (id, public) VALUES ('products', true), ('avatars', true);

    CREATE TABLE storage.objects (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket_id text,
      name      text,
      owner     uuid
    );

    CREATE POLICY products_read ON storage.objects
      FOR SELECT TO anon USING (bucket_id = 'products');
    CREATE POLICY products_all ON storage.objects
      FOR ALL TO authenticated USING (bucket_id = 'products')
      WITH CHECK (bucket_id = 'products');
    CREATE POLICY blanket_read ON storage.objects
      FOR SELECT TO anon USING (true);
    CREATE POLICY avatars_read ON storage.objects
      FOR SELECT TO anon USING (bucket_id = 'avatars');
    CREATE POLICY shared_read ON storage.objects
      FOR SELECT TO anon
      USING (bucket_id = ANY (ARRAY['products'::text, 'avatars'::text]));

    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    -- Emulate the pre-migration Supabase grant the storefront relied on: anon
    -- could read the whole products table (including reservedStock).
    GRANT SELECT ON public.products TO anon, authenticated;
    -- Supabase grants the service role full DML on application tables. Phase 3
    -- must never remove these.
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO service_role;
    -- A lingering column-level grant (common after a partial manual revoke)
    -- must not survive Phase 3 and re-expose the private column.
    GRANT SELECT ("reservedStock") ON public.products TO anon;
  `;
  const r = runSql(db, sql);
  if (r.status !== 0) throw new Error(`bootstrap failed:\n${r.out}`);
}

// ════════════════════════════════════════════════════════════════════════════
// By default a missing PostgreSQL is a non-fatal SKIP so `npm test` works on
// developer machines without it. CI sets ZSHM_REQUIRE_SQL_TESTS=1 to turn that
// skip into a hard failure, so the concurrency suite can never be silently
// omitted in a pipeline that claims to run it.
const REQUIRE_SQL_TESTS = /^(1|true|yes)$/i.test(String(process.env.ZSHM_REQUIRE_SQL_TESTS || ''));

function skipOrFail(message) {
  if (REQUIRE_SQL_TESTS) {
    throw new Error(`${message} — ZSHM_REQUIRE_SQL_TESTS=1 makes this skip fatal`);
  }
  console.log(`\nSKIPPED: ${message}`);
  console.log('Install PostgreSQL 15+ (initdb/pg_ctl/psql) to run the real SQL harness.');
  console.log('CI must set ZSHM_REQUIRE_SQL_TESTS=1 to fail instead of skipping.');
}

async function main() {
  const missing = Object.entries(tools).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    skipOrFail(`PostgreSQL tools not found (${missing.join(', ')})`);
    return;
  }
  const major = postgresMajor();
  if (major < 15) {
    skipOrFail(`PostgreSQL ${major} found; >= 15 is required (security_invoker)`);
    return;
  }

  await startCluster();
  console.log(`\n[0] temporary PostgreSQL ${major} cluster on port ${sockPort} (auto-destroyed)`);

  // Isolated database; the cluster itself is disposable.
  const created = runSql('postgres', `CREATE DATABASE ${DB}`);
  if (created.status !== 0) throw new Error(`CREATE DATABASE failed:\n${created.out}`);

  bootstrap(DB);
  ok(true, 'Supabase-shaped schema + storage policies created');

  // Migrations under test. Order matters: lifecycle depends on the stock and
  // coupon helpers created by atomic_place_order.sql.
  console.log('\n[1] applying migrations');
  apply(DB, 'supabase/atomic_place_order.sql');
  apply(DB, 'supabase/atomic_order_lifecycle.sql');
  apply(DB, 'supabase/admin_protection.sql');
  const viewPhase1 = apply(DB, 'supabase/products_public_view.sql');
  apply(DB, 'supabase/storage_hardening.sql');

  ok(/PHASE 3 SKIPPED/.test(viewPhase1), 'products view runs Phase 1 only before the deploy flag');
  ok(scalarNum(DB, `SELECT count(*) FROM pg_proc WHERE proname = 'atomic_place_order'`) === 1,
    'atomic_place_order exists');
  ok(scalarNum(DB, `SELECT count(*) FROM pg_indexes
                     WHERE tablename = 'orders' AND indexname = 'orders_idempotency_key_unique'`) === 1,
    'idempotency unique index exists');
  ok(scalar(DB, `SELECT has_function_privilege('anon',
                    'public.atomic_place_order(jsonb, text)', 'EXECUTE')`) === 'f',
    'anon cannot execute atomic_place_order');

  // ── Products view: staged rollout ────────────────────────────────────────
  console.log('\n[2] products_public_view: allow-list + Phase 1/Phase 3');
  runSql(DB, `
    INSERT INTO public.products (id, name, category, price, stock, "reservedStock", active)
    VALUES
      (77, 'Public Tee',   'clothing', 99, 5, 3, true),
      (78, 'Hidden Tee',   'clothing', 99, 5, 3, false),
      (79, 'Null Active',  'clothing', 99, 5, 3, NULL)
    ON CONFLICT (id) DO UPDATE
      SET "reservedStock" = 3, active = EXCLUDED.active;
  `);
  ok(scalarNum(DB, `SELECT count(*) FROM information_schema.columns
                     WHERE table_schema='public' AND table_name='products_public'
                       AND lower(column_name) = 'reservedstock'`) === 0,
    'products_public never exposes reservedStock');
  ok(scalarNum(DB, `SELECT count(*) FROM information_schema.columns
                     WHERE table_schema='public' AND table_name='products_public'
                       AND column_name IN ('id','name','price','stock','variantStock')`) === 5,
    'products_public exposes the allow-listed columns');
  ok(scalarNum(DB, `SELECT count(*) FROM information_schema.columns
                     WHERE table_schema='public' AND table_name='products_public'
                       AND column_name IN ('tags','rating','reviews','active')`) === 0,
    'products_public does not expose columns the storefront does not use');
  eq(scalarNum(DB, `SELECT count(*) FROM public.products_public`), 1,
    'the view itself returns only active = true rows');
  eq(scalarNum(DB, `SELECT count(*) FROM public.products_public WHERE id IN (78,79)`), 0,
    'inactive and NULL-active products are excluded by the view');
  {
    const r = runSql(DB, 'SET ROLE anon; SELECT count(*) FROM public.products_public;');
    eq(r.status, 0, 'anon can read products_public in Phase 1');
    eq(r.stdout.trim(), '1', 'anon sees only the active product');
  }
  {
    const r = runSql(DB, 'SET ROLE authenticated; SELECT count(*) FROM public.products_public;');
    eq(r.status, 0, 'authenticated can read products_public in Phase 1');
    eq(r.stdout.trim(), '1', 'authenticated sees only the active product');
  }
  eq(scalar(DB, `SELECT has_table_privilege('anon', 'public.products', 'SELECT')`), 't',
    'Phase 1 deliberately keeps the base table readable');

  runSql(DB, `INSERT INTO public.zshm_deploy_flags (name, note)
              VALUES ('products_public_frontend_live', 'test')
              ON CONFLICT (name) DO NOTHING;`);
  const viewPhase3 = apply(DB, 'supabase/products_public_view.sql');
  ok(/PHASE 3 applied/.test(viewPhase3), 're-running after the flag applies Phase 3');
  eq(scalar(DB, `SELECT has_table_privilege('public', 'public.products', 'SELECT')`), 'f',
    'PUBLIC cannot SELECT the base table');
  eq(scalar(DB, `SELECT has_table_privilege('anon', 'public.products', 'SELECT')`), 'f',
    'anon cannot SELECT the base table');
  eq(scalar(DB, `SELECT has_table_privilege('authenticated', 'public.products', 'SELECT')`), 'f',
    'authenticated cannot SELECT the base table');
  const anonBase = runSql(DB, 'SET ROLE anon; SELECT count(*) FROM public.products;');
  ok(anonBase.status !== 0 && /permission denied/i.test(anonBase.out),
    'anon SELECT on products actually fails (permission denied)');
  const authBase = runSql(DB, 'SET ROLE authenticated; SELECT count(*) FROM public.products;');
  ok(authBase.status !== 0 && /permission denied/i.test(authBase.out),
    'authenticated SELECT on products actually fails (permission denied)');
  eq(scalar(DB, `SELECT has_any_column_privilege('anon', 'public.products', 'SELECT')`), 'f',
    'anon has no column-level SELECT grant on products');
  eq(scalar(DB, `SELECT has_any_column_privilege('authenticated', 'public.products', 'SELECT')`), 'f',
    'authenticated has no column-level SELECT grant on products');
  {
    const col = runSql(DB, 'SET ROLE anon; SELECT "reservedStock" FROM public.products;');
    ok(col.status !== 0 && /permission denied/i.test(col.out),
      'a pre-existing column grant on reservedStock does not survive Phase 3');
  }
  const anonView = runSql(DB, 'SET ROLE anon; SELECT count(*) FROM public.products_public;');
  eq(anonView.status, 0, 'anon can still read products_public after the revoke');
  eq(anonView.stdout.trim(), '1', 'anon still sees only the active product after Phase 3');
  const authView = runSql(DB, 'SET ROLE authenticated; SELECT count(*) FROM public.products_public;');
  eq(authView.status, 0, 'authenticated can still read products_public after the revoke');
  eq(authView.stdout.trim(), '1', 'authenticated still sees only the active product after Phase 3');
  eq(scalar(DB, `SELECT has_table_privilege('service_role', 'public.products', 'SELECT')`), 't',
    'service_role keeps SELECT on products after Phase 3');
  eq(scalar(DB, `SELECT has_table_privilege('service_role', 'public.products', 'INSERT')`), 't',
    'service_role keeps INSERT on products after Phase 3');
  eq(scalar(DB, `SELECT has_table_privilege('service_role', 'public.products', 'UPDATE')`), 't',
    'service_role keeps UPDATE on products after Phase 3');
  eq(scalar(DB, `SELECT has_table_privilege('service_role', 'public.products', 'DELETE')`), 't',
    'service_role keeps DELETE on products after Phase 3');

  // ── atomic_place_order races ─────────────────────────────────────────────
  console.log('\n[3] atomic_place_order: idempotency races');
  seedShop(DB);

  // [3a] same key + same cart, but the request that started first wins the row.
  {
    const cart = [{ productId: 1, qty: 2, size: 'M', color: 'Black', price: 50 }];
    const orderA = makeOrder({ id: 'ORD-RACE-SAME-A', items: cart, discountCode: 'SAVE10', discount: 10 });
    const orderB = makeOrder({ id: 'ORD-RACE-SAME-B', items: cart, discountCode: 'SAVE10', discount: 10 });
    const out = await raceTwoTransactions(DB,
      placeSql(orderA, 'race-same-key'),
      placeSql(orderB, 'race-same-key'));
    const a = lastJson(out.a);
    const b = lastJson(out.b);

    eq(a.ok, true, 'same key/same cart: first request succeeds');
    eq(b.ok, true, 'same key/same cart: second request succeeds (idempotent)');
    eq(b.duplicate, true, 'same key/same cart: second request is duplicate=true');
    eq(scalarNum(DB, `SELECT count(*) FROM public.orders WHERE idempotency_key = 'race-same-key'`), 1,
      'exactly one order row exists for the key');
    eq(scalarNum(DB, `SELECT "usageCount" FROM public.coupons WHERE code='SAVE10'`), 1,
      'coupon usageCount moved exactly once');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 8,
      'stock decremented exactly once');
    eq(scalarNum(DB, `SELECT ("variantStock"->>'M-Black')::int FROM public.products WHERE id=1`), 8,
      'variant stock decremented exactly once');
  }

  // [3b] same key + DIFFERENT carts + coupon: the loser must be a conflict,
  // never a false duplicate, and must not consume the coupon or touch stock.
  seedShop(DB);
  {
    const cartA = [{ productId: 1, qty: 2, size: 'M', color: 'Black', price: 50 }];
    const cartB = [{ productId: 2, qty: 1, size: 'L', color: 'White', price: 40 }];
    const orderA = makeOrder({ id: 'ORD-RACE-DIFF-A', items: cartA, discountCode: 'SAVE10', discount: 10 });
    const orderB = makeOrder({ id: 'ORD-RACE-DIFF-B', items: cartB, discountCode: 'SAVE10', discount: 10 });
    const out = await raceTwoTransactions(DB,
      placeSql(orderA, 'race-diff-key'),
      placeSql(orderB, 'race-diff-key'));
    const a = lastJson(out.a);
    const b = lastJson(out.b);

    eq(a.ok, true, 'different carts: the first request succeeds');
    eq(b.ok, false, 'different carts: the second request is rejected');
    eq(b.reason, 'idempotency_conflict', 'different carts: rejected as idempotency_conflict');
    eq(b.duplicate, undefined, 'different carts: never reported as duplicate=true');
    eq(b.orderId, 'ORD-RACE-DIFF-A', 'the conflict points at the winning order');
    eq(scalarNum(DB, `SELECT count(*) FROM public.orders`), 1, 'only the winning order exists');
    eq(scalarNum(DB, `SELECT "usageCount" FROM public.coupons WHERE code='SAVE10'`), 1,
      'the losing request did not consume the coupon');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 8,
      'the winning cart decremented its product');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=2`), 10,
      'the losing cart did not touch its product');
  }

  // [3c] a replay with yet another cart stays a conflict (fast path).
  {
    const replay = makeOrder({
      id: 'ORD-RACE-DIFF-C',
      items: [{ productId: 2, qty: 3, size: 'L', color: 'White', price: 40 }],
      discountCode: 'SAVE10', discount: 10,
    });
    const r = lastJson(runSql(DB, placeSql(replay, 'race-diff-key')).out);
    eq(r.ok, false, 'replay with a third cart is rejected');
    eq(r.reason, 'idempotency_conflict', 'replay is an idempotency conflict');
    eq(scalarNum(DB, `SELECT count(*) FROM public.orders`), 1, 'replay created no order');
    eq(scalarNum(DB, `SELECT "usageCount" FROM public.coupons WHERE code='SAVE10'`), 1,
      'replay did not consume the coupon');
  }

  // [3d] same key + two carts on DIFFERENT products and NO coupon: the loser's
  // only possible blocking point is the UNIQUE index INSERT, so this exercises
  // the EXCEPTION WHEN unique_violation handler itself.
  seedShop(DB);
  {
    const orderA = makeOrder({
      id: 'ORD-RACE-IDX-A',
      items: [{ productId: 1, qty: 1, size: 'M', color: 'Black', price: 50 }],
    });
    const orderB = makeOrder({
      id: 'ORD-RACE-IDX-B',
      items: [{ productId: 2, qty: 1, size: 'L', color: 'White', price: 40 }],
    });
    const out = await raceTwoTransactions(DB,
      placeSql(orderA, 'race-index-key'),
      placeSql(orderB, 'race-index-key'));
    const b = lastJson(out.b);
    eq(b.ok, false, 'unique-index loser: rejected');
    eq(b.reason, 'idempotency_conflict',
      'unique-index loser compares the cart signature and reports a conflict');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=2`), 10,
      'unique-index loser wrote no stock');
    eq(scalarNum(DB, `SELECT count(*) FROM public.orders`), 1,
      'unique-index loser created no order');
  }

  // [3e] a failed INSERT (order id collision) must not consume the coupon.
  seedShop(DB);
  {
    const cart = [{ productId: 1, qty: 1, size: 'M', color: 'Black', price: 50 }];
    const first = makeOrder({ id: 'ORD-COLLIDE', items: cart });
    const second = makeOrder({ id: 'ORD-COLLIDE', items: cart, discountCode: 'SAVE10', discount: 10 });
    const out = await raceTwoTransactions(DB,
      placeSql(first, 'collision-key-a'),
      placeSql(second, 'collision-key-b'));
    const a = lastJson(out.a);
    const b = lastJson(out.b);

    eq(a.ok, true, 'collision: the first order is inserted');
    eq(b.ok, false, 'collision: the second order is rejected');
    eq(b.reason, 'order_id_collision', 'collision is reported as order_id_collision');
    eq(scalarNum(DB, `SELECT count(*) FROM public.orders`), 1, 'only one order row exists');
    eq(scalarNum(DB, `SELECT "usageCount" FROM public.coupons WHERE code='SAVE10'`), 0,
      'a failed INSERT did not consume the coupon');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 9,
      'the failed request did not decrement stock a second time');
  }

  // ── atomic_place_order: non-variant aggregation + malformed payloads ────
  console.log('\n[3f] atomic_place_order: products without variants');

  // [3f] a non-variant product has ONE global stock pool. Two lines in different
  // sizes/colors must be summed before the check, or each line passes alone and
  // the product is oversold.
  seedShop(DB);
  runSql(DB, `
    INSERT INTO public.products
      (id, name, category, price, stock, "variantStock", "reservedStock", active)
    VALUES (3, 'Scarf', 'accessories', 30, 5, '{}'::jsonb, 0, true);
  `);
  {
    const order = makeOrder({
      id: 'ORD-NOVAR-OVER',
      items: [
        { productId: 3, qty: 3, size: 'M', color: 'Red', price: 30 },
        { productId: 3, qty: 3, size: 'L', color: 'Blue', price: 30 },
      ],
    });
    const r = lastJson(runSql(DB, placeSql(order, null)).out);
    eq(r.ok, false, 'non-variant split lines are aggregated across sizes');
    eq(r.reason, 'unavailable', 'non-variant oversell is rejected as unavailable');
    eq(Number(r.requested), 6, 'the rejection reports the aggregate quantity');
    eq(scalarNum(DB, `SELECT count(*) FROM public.orders WHERE id='ORD-NOVAR-OVER'`), 0,
      'non-variant oversell writes no order');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=3`), 5,
      'non-variant oversell leaves stock untouched');
  }
  {
    const order = makeOrder({
      id: 'ORD-NOVAR-OK',
      items: [
        { productId: 3, qty: 2, size: 'M', color: 'Red', price: 30 },
        { productId: 3, qty: 2, size: 'L', color: 'Blue', price: 30 },
      ],
    });
    const r = lastJson(runSql(DB, placeSql(order, null)).out);
    eq(r.ok, true, 'non-variant: an in-stock split cart succeeds');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=3`), 1,
      'non-variant: the aggregate quantity is decremented exactly once');
    eq(scalar(DB, `SELECT ("variantStock" = '{}'::jsonb)::text FROM public.products WHERE id=3`), 'true',
      'non-variant: the empty variantStock object is preserved (not rewritten)');
  }

  // [3g] duplicate lines for the SAME variant are aggregated too, and the
  // global stock invariant holds for every variant product.
  seedShop(DB);
  {
    const order = makeOrder({
      id: 'ORD-VAR-AGG',
      items: [
        { productId: 1, qty: 3, size: 'M', color: 'Black', price: 50 },
        { productId: 1, qty: 2, size: 'M', color: 'Black', price: 50 },
      ],
    });
    const r = lastJson(runSql(DB, placeSql(order, null)).out);
    eq(r.ok, true, 'duplicate variant lines within stock succeed');
    eq(scalarNum(DB, `SELECT ("variantStock"->>'M-Black')::int FROM public.products WHERE id=1`), 5,
      'duplicate variant lines are decremented once (aggregated)');
    eq(scalarNum(DB, `SELECT stock - (
        SELECT COALESCE(SUM(value::integer), 0) FROM jsonb_each_text("variantStock")
      ) FROM public.products WHERE id=1`), 0,
      'stock stays equal to the sum of variantStock');
  }

  // [3h] malformed payloads must return a JSON reason — never a raw SQL error.
  seedShop(DB);
  {
    const cases = [
      ['NULL', 'invalid_payload'],
      [`'[]'::jsonb`, 'invalid_payload'],
      [`'{"items": {"productId": 1, "qty": 1}}'::jsonb`, 'invalid_payload'],
      [`'{"items": []}'::jsonb`, 'invalid_payload'],
      [`'{"items": [{"productId": 1, "qty": 0}]}'::jsonb`, 'invalid_line'],
      [`'{"items": ["not-an-object"]}'::jsonb`, 'invalid_line'],
      [`'{"id": "X", "subtotal": "abc", "discount": 0, "total": 0,
           "items": [{"productId": 1, "qty": 1}]}'::jsonb`, 'invalid_payload'],
      [`'{"id": "X", "items": [{"productId": 1, "qty": 1}]}'::jsonb`, 'invalid_payload'],
    ];
    for (const [payload, reason] of cases) {
      const res = runSql(DB, `SELECT public.atomic_place_order(${payload}, NULL);`);
      eq(res.status, 0, `malformed payload does not raise: ${payload}`);
      const r = lastJson(res.out);
      eq(r.ok, false, `malformed payload is rejected: ${payload}`);
      eq(r.reason, reason, `malformed payload → ${reason}: ${payload}`);
    }
    eq(scalarNum(DB, `SELECT count(*) FROM public.orders`), 0,
      'malformed payloads write no orders');
  }

  // [3i] atomic_adjust_stock: aggregate non-variant demand, preserve the
  // stock = sum(variantStock) invariant, and reject malformed payloads safely.
  console.log('\n[3i] atomic_adjust_stock: aggregation + invariants');
  seedShop(DB);
  runSql(DB, `
    INSERT INTO public.products
      (id, name, category, price, stock, "variantStock", "reservedStock", active)
    VALUES (4, 'Scarf', 'accessories', 30, 5, '{}'::jsonb, 0, true);
  `);
  {
    const lines = [
      { productId: 4, qty: 3, size: 'M', color: 'Red' },
      { productId: 4, qty: 3, size: 'L', color: 'Blue' },
    ];
    const r = lastJson(runSql(DB,
      `SELECT public.atomic_adjust_stock(${dollar(JSON.stringify(lines))}::jsonb, -1);`).out);
    eq(r.ok, false, 'adjust: non-variant split lines are aggregated');
    eq(r.reason, 'unavailable', 'adjust: aggregated oversell is rejected');
    eq(Number(r.requested), 6, 'adjust: the aggregate quantity is reported');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=4`), 5,
      'adjust: rejected change leaves stock untouched');
  }
  runSql(DB, `UPDATE public.products SET stock = 6 WHERE id = 4;`);
  {
    const lines = [
      { productId: 4, qty: 3, size: 'M', color: 'Red' },
      { productId: 4, qty: 3, size: 'L', color: 'Blue' },
    ];
    const r = lastJson(runSql(DB,
      `SELECT public.atomic_adjust_stock(${dollar(JSON.stringify(lines))}::jsonb, -1);`).out);
    eq(r.ok, true, 'adjust: an in-stock aggregate deduction succeeds');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=4`), 0,
      'adjust: the aggregate quantity is deducted exactly once');
  }
  {
    const lines = [
      { productId: 1, qty: 3, size: 'M', color: 'Black' },
      { productId: 1, qty: 2, size: 'M', color: 'Black' },
    ];
    const r = lastJson(runSql(DB,
      `SELECT public.atomic_adjust_stock(${dollar(JSON.stringify(lines))}::jsonb, -1);`).out);
    eq(r.ok, true, 'adjust: duplicate variant lines succeed');
    eq(scalarNum(DB, `SELECT ("variantStock"->>'M-Black')::int FROM public.products WHERE id=1`), 5,
      'adjust: duplicate variant lines are deducted once');
    eq(scalarNum(DB, `SELECT stock - (
        SELECT COALESCE(SUM(value::integer), 0) FROM jsonb_each_text("variantStock")
      ) FROM public.products WHERE id=1`), 0,
      'adjust: stock stays equal to the sum of variantStock');
  }
  {
    const bad = lastJson(runSql(DB,
      `SELECT public.atomic_adjust_stock('{"productId": 1}'::jsonb, -1);`).out);
    eq(bad.ok, false, 'adjust: a non-array payload is rejected');
    eq(bad.reason, 'invalid_payload', 'adjust: non-array → invalid_payload (no SQL error)');
    const badLine = lastJson(runSql(DB,
      `SELECT public.atomic_adjust_stock('[{"productId": 1, "qty": 0}]'::jsonb, -1);`).out);
    eq(badLine.reason, 'invalid_line', 'adjust: invalid qty → invalid_line');
  }

  // ── atomic_order_lifecycle: legacy data ──────────────────────────────────
  console.log('\n[4] atomic_order_lifecycle: legacy / non-standard orders');

  // [4a] double-encoded JSON string.
  seedLegacyOrder(DB, {
    itemsJson: JSON.stringify([{ productId: 1, qty: 2, size: 'M', color: 'Black' }]),
  });
  {
    const r = lastJson(runSql(DB, setStatusSql('ORD-LEGACY-1', 'Pending', 'Cancelled')).out);
    eq(r.ok, true, 'cancel accepts a double-encoded items string');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 12,
      'the valid legacy line was restored');
    eq(scalarNum(DB, `SELECT "usageCount" FROM public.coupons WHERE code='SAVE10'`), 2,
      'the coupon was freed once');
  }

  // [4b] a JSON object instead of an array.
  seedLegacyOrder(DB, { itemsJson: { productId: 1, qty: 2 } });
  {
    const r = lastJson(runSql(DB, deleteOrderSql('ORD-LEGACY-1')).out);
    eq(r.ok, true, 'delete tolerates a non-array items value');
    eq(r.stockRestored, false, 'no stock is invented for an unusable cart');
    eq(scalarNum(DB, `SELECT count(*) FROM public.orders WHERE id='ORD-LEGACY-1'`), 0,
      'the order row is still deleted');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 10,
      'stock is untouched for an unusable cart');
  }

  // [4c] a malformed JSON string (double-encoded and broken).
  seedLegacyOrder(DB, { itemsJson: '{"broken":' });
  {
    const r = lastJson(runSql(DB, deleteOrderSql('ORD-LEGACY-1')).out);
    eq(r.ok, true, 'delete tolerates a broken JSON string');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 10,
      'broken JSON leaves stock untouched');
  }

  // [4d] mixed valid + invalid lines: process the valid one, report the rest.
  seedLegacyOrder(DB, {
    itemsJson: [
      { productId: 1, qty: 2, size: 'M', color: 'Black' },
      { productId: 1, qty: 0, size: 'M', color: 'Black' },
      { productId: 'abc', qty: 2, size: 'M', color: 'Black' },
      'not-an-object',
    ],
  });
  {
    const r = lastJson(runSql(DB, deleteOrderSql('ORD-LEGACY-1')).out);
    eq(r.ok, true, 'mixed legacy lines delete successfully');
    eq(r.stockRestored, true, 'the valid line is restored');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 12,
      'only the valid line is restored');
    const skipped = (r.warnings || []).find((w) => w.code === 'legacy_items_skipped');
    eq(skipped && skipped.count, 3, 'three unusable lines are reported as skipped');
  }

  // [4e] cancelled order: delete must not restore stock twice.
  seedLegacyOrder(DB, {
    status: 'Cancelled',
    itemsJson: [{ productId: 1, qty: 2, size: 'M', color: 'Black' }],
  });
  {
    const r = lastJson(runSql(DB, deleteOrderSql('ORD-LEGACY-1')).out);
    eq(r.ok, true, 'a cancelled order can be deleted');
    eq(r.wasCancelled, true, 'response reports wasCancelled=true');
    eq(r.stockRestored, false, 'a cancelled order is not restored a second time');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 10,
      'stock is unchanged by deleting a cancelled order');
  }

  // [4f] a permanently deleted product: delete proceeds, nothing is restored.
  seedLegacyOrder(DB, {
    itemsJson: [
      { productId: 1, qty: 2, size: 'M', color: 'Black' },
      { productId: 999, qty: 1, size: 'M', color: 'Black' },
    ],
  });
  {
    const r = lastJson(runSql(DB, deleteOrderSql('ORD-LEGACY-1')).out);
    eq(r.ok, true, 'a missing product does not block deletion forever');
    eq(r.stockRestored, false, 'stockRestored=false when any product is missing');
    ok((r.warnings || []).some((w) => w.reason === 'missing_product' && Number(w.productId) === 999),
      'the missing product is reported as a warning');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 10,
      'no partial restore happens for the other lines');
    eq(scalarNum(DB, `SELECT count(*) FROM public.orders WHERE id='ORD-LEGACY-1'`), 0,
      'the order is still deleted');
  }

  // ── admin_protection: concurrent last-admin demotions ────────────────────
  console.log('\n[5] admin_protection: concurrent demotions');
  runSql(DB, `
    DELETE FROM public.users;
    INSERT INTO public.users (id, name, email, role) VALUES
      ('admin-a', 'A', 'a@example.com', 'admin'),
      ('admin-b', 'B', 'b@example.com', 'admin');
  `);
  {
    const out = await raceTwoTransactions(DB,
      `UPDATE public.users SET role='support' WHERE id='admin-a';`,
      `UPDATE public.users SET role='support' WHERE id='admin-b';`);
    const aFailed = /ERROR/.test(out.a);
    const bFailed = /ERROR/.test(out.b);
    eq(aFailed, false, 'the first demotion succeeds');
    eq(bFailed, true, 'the racing demotion fails');
    ok(/last_admin/.test(out.b), 'the loser is rejected with last_admin');
    eq(scalarNum(DB, `SELECT count(*) FROM public.users WHERE role='admin'`), 1,
      'exactly one admin remains after the race');
  }
  {
    const remaining = scalar(DB, `SELECT id FROM public.users WHERE role='admin'`);
    const r = runSql(DB, `UPDATE public.users SET role='support' WHERE id='${remaining}';`);
    ok(r.status !== 0 && /last_admin/.test(r.out), 'demoting the final admin is rejected');
    eq(scalarNum(DB, `SELECT count(*) FROM public.users WHERE role='admin'`), 1,
      'the final admin is still an admin');
  }
  runSql(DB, `INSERT INTO public.users (id, name, email, role)
              VALUES ('admin-c', 'C', 'c@example.com', 'admin');`);
  {
    const r = runSql(DB, `UPDATE public.users SET role='support' WHERE id='admin-c';`);
    eq(r.status, 0, 'demotion is allowed while another admin exists');
    eq(scalarNum(DB, `SELECT count(*) FROM public.users WHERE role='admin'`), 1,
      'one admin remains');
  }

  // ── storage_hardening: conservative policy removal + restore ─────────────
  console.log('\n[6] storage_hardening: conservative deletion + restore');
  const kept = scalar(DB, `SELECT string_agg(policyname, ',' ORDER BY policyname)
                             FROM pg_policies WHERE schemaname='storage' AND tablename='objects'`);
  const keptSet = kept.split(',').filter(Boolean);
  eq(keptSet.sort(), ['avatars_read', 'blanket_read', 'shared_read'],
    'blanket and other-bucket policies are kept');
  ok(!keptSet.includes('products_read'), 'products-only SELECT policy was removed');
  ok(!keptSet.includes('products_all'), 'products-only ALL policy was removed');
  eq(scalarNum(DB, `SELECT count(*) FROM public.zshm_storage_policy_backup`), 2,
    'both removed policies were backed up');
  eq(scalarNum(DB, `SELECT count(*) FROM public.zshm_storage_policy_backup WHERE restored_at IS NOT NULL`), 0,
    'the backup is not marked restored yet');
  eq(scalar(DB, `SELECT file_size_limit::text FROM storage.buckets WHERE id='products'`), '5242880',
    'products bucket size limit is applied');
  ok(scalar(DB, `SELECT (allowed_mime_types @> ARRAY['image/webp']::text[])::text
                   FROM storage.buckets WHERE id='products'`) === 'true',
    'products bucket MIME allow-list is applied');
  {
    const r = runSql(DB, 'SET ROLE anon; SELECT count(*) FROM public.zshm_storage_policy_backup;');
    ok(r.status !== 0 && /permission denied/i.test(r.out),
      'the policy backup is not readable by anon');
  }
  {
    const restored = lastJson(runSql(DB,
      `SELECT public.zshm_restore_storage_policies(ARRAY['products_read','products_all']);`).out);
    eq(restored.ok, true, 'restore function reports success');
    eq(Number(restored.restored), 2, 'both policies were restored');
    eq(scalarNum(DB, `SELECT count(*) FROM pg_policies
                       WHERE schemaname='storage' AND policyname IN ('products_read','products_all')`), 2,
      'the restored policies exist again');
    eq(scalarNum(DB, `SELECT count(*) FROM public.zshm_storage_policy_backup
                       WHERE restored_at IS NOT NULL`), 2,
      'the backup rows are marked restored');
    const defs = scalar(DB, `SELECT string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, '+') ||
                                      ':' || COALESCE(qual, '') || ':' || COALESCE(with_check, ''),
                                      ' | ' ORDER BY policyname)
                              FROM pg_policies
                             WHERE schemaname='storage' AND tablename='objects'
                               AND policyname IN ('products_read','products_all')`);
    ok(/products_read:SELECT:anon:\(bucket_id = 'products'::text\):/.test(defs),
      'products_read was restored with its original USING expression');
    ok(/products_all:ALL:authenticated:\(bucket_id = 'products'::text\):\(bucket_id = 'products'::text\)/.test(defs),
      'products_all was restored with its original USING + WITH CHECK');
  }

  // ── storage_hardening: role without storage.objects ownership ─────────────
  console.log('\n[6b] storage_hardening: non-owner role skips storage.objects DDL');
  {
    const setup = runSql(DB, `
      CREATE ROLE storage_owner NOLOGIN;
      CREATE ROLE storage_migrator NOLOGIN;
      GRANT USAGE ON SCHEMA storage TO storage_migrator;
      GRANT SELECT, UPDATE ON storage.buckets TO storage_migrator;
      GRANT SELECT ON storage.objects TO storage_migrator;
      GRANT USAGE, CREATE ON SCHEMA public TO storage_migrator;
      ALTER TABLE storage.objects OWNER TO storage_owner;
      ALTER TABLE public.zshm_storage_policy_backup OWNER TO storage_migrator;
      ALTER SEQUENCE public.zshm_storage_policy_backup_id_seq OWNER TO storage_migrator;
      ALTER FUNCTION public.zshm_storage_policy_scope_is_products(text) OWNER TO storage_migrator;
      ALTER FUNCTION public.zshm_restore_storage_policies(text[]) OWNER TO storage_migrator;
    `);
    eq(setup.status, 0, 'non-owner test roles/table ownership prepared');

    const run1 = applyAsRole(DB, 'storage_migrator', 'supabase/storage_hardening.sql');
    eq(run1.status, 0, 'storage_hardening succeeds without storage.objects ownership');
    ok(/MANUAL ACTION REQUIRED/.test(run1.out),
      'non-owner run reports the exact policies for Dashboard removal');
    ok(/products_read/.test(run1.out) && /products_all/.test(run1.out),
      'non-owner run names both products-only policies');
    eq(scalarNum(DB, `SELECT count(*) FROM pg_policies
                       WHERE schemaname='storage' AND policyname IN ('products_read','products_all')`), 2,
      'non-owner run does not drop any policy');
    eq(scalarNum(DB, `SELECT count(*) FROM public.zshm_storage_policy_backup
                       WHERE restored_at IS NULL AND reason LIKE 'manual removal required%'`), 2,
      'manual-removal policies are backed up verbatim');

    const run2 = applyAsRole(DB, 'storage_migrator', 'supabase/storage_hardening.sql');
    eq(run2.status, 0, 'non-owner run is rerunnable');
    eq(scalarNum(DB, `SELECT count(*) FROM pg_policies
                       WHERE schemaname='storage' AND policyname IN ('products_read','products_all')`), 2,
      'rerun still does not drop any policy');
    eq(scalarNum(DB, `SELECT count(*) FROM public.zshm_storage_policy_backup
                       WHERE restored_at IS NULL AND reason LIKE 'manual removal required%'`), 2,
      'rerun does not duplicate manual backup rows');

    const restore = runSql(DB, 'SET ROLE storage_migrator; SELECT public.zshm_restore_storage_policies();');
    ok(restore.status !== 0 && /cannot manage storage\.objects/.test(restore.out),
      'restore refuses to bypass storage.objects ownership');

    // Restore the test schema owner for the remaining suites.
    const reset = runSql(DB, `
      ALTER TABLE storage.objects OWNER TO postgres;
      ALTER TABLE public.zshm_storage_policy_backup OWNER TO postgres;
      ALTER SEQUENCE public.zshm_storage_policy_backup_id_seq OWNER TO postgres;
      ALTER FUNCTION public.zshm_storage_policy_scope_is_products(text) OWNER TO postgres;
      ALTER FUNCTION public.zshm_restore_storage_policies(text[]) OWNER TO postgres;
    `);
    eq(reset.status, 0, 'non-owner test schema ownership restored');
  }

  // ── security_hardening: auth.users trigger safety ────────────────────────
  console.log('\n[7] security_hardening: auth.users trigger safety');

  // Scenario 1a: a custom-named trigger whose FUNCTION inserts into public.users
  // (the name test cannot catch this; the source inspection must).
  runSql(DB, `
    CREATE OR REPLACE FUNCTION public.sync_profile_from_auth()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO public.users (name, email, role)
      VALUES (NEW.email, NEW.email, 'support')
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END;
    $fn$;
    CREATE TRIGGER custom_provision
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.sync_profile_from_auth();
  `);
  {
    const out = apply(DB, 'supabase/security_hardening.sql');
    ok(/Refusing to create on_auth_user_created_secure/.test(out),
      'a custom-named trigger whose source inserts into users blocks a duplicate');
    ok(/custom_provision → public\.sync_profile_from_auth/.test(out),
      'the existing provisioning trigger is documented in the notice');
    eq(scalarNum(DB, `SELECT count(*) FROM pg_trigger
                       WHERE tgrelid='auth.users'::regclass AND tgname='on_auth_user_created_secure'`), 0,
      'no second provisioning trigger was created (source-detected case)');
  }
  runSql(DB, `
    DROP TRIGGER custom_provision ON auth.users;
    DROP FUNCTION public.sync_profile_from_auth();
  `);

  // Scenario 1b: the vanilla Supabase provisioning trigger already exists.
  runSql(DB, `
    CREATE OR REPLACE FUNCTION public.handle_new_user()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO public.users (name, email, role)
      VALUES (COALESCE(NEW.raw_user_meta_data ->> 'name', split_part(NEW.email, '@', 1)),
              NEW.email, 'support')
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END;
    $fn$;
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
  `);
  {
    const out = apply(DB, 'supabase/security_hardening.sql');
    ok(/Refusing to create on_auth_user_created_secure/.test(out),
      'an existing provisioning trigger blocks a duplicate');
    eq(scalarNum(DB, `SELECT count(*) FROM pg_trigger
                       WHERE tgrelid='auth.users'::regclass AND tgname='on_auth_user_created_secure'`), 0,
      'no second provisioning trigger was created');
    eq(scalarNum(DB, `SELECT count(*) FROM pg_trigger
                       WHERE tgrelid='auth.users'::regclass AND tgname='on_auth_user_created'`), 1,
      'the existing provisioning trigger was left untouched');
  }

  // Scenario 2: only an unrelated audit trigger exists → secure trigger created.
  runSql(DB, `
    DROP TRIGGER on_auth_user_created ON auth.users;
    DROP FUNCTION public.handle_new_user();
    CREATE OR REPLACE FUNCTION public.zshm_test_audit()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN RETURN NEW; END;
    $fn$;
    CREATE TRIGGER audit_auth_users
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.zshm_test_audit();
  `);
  {
    const out = apply(DB, 'supabase/security_hardening.sql');
    ok(/Created on_auth_user_created_secure/.test(out),
      'the secure trigger is created when no provisioning trigger exists');
    ok(/auth.users triggers left untouched \(unrelated to user provisioning\): audit_auth_users/.test(out),
      'the unrelated audit trigger is documented and kept');
    eq(scalarNum(DB, `SELECT count(*) FROM pg_trigger
                       WHERE tgrelid='auth.users'::regclass AND tgname='audit_auth_users'`), 1,
      'the unrelated audit trigger still exists');
    eq(scalarNum(DB, `SELECT count(*) FROM pg_trigger
                       WHERE tgrelid='auth.users'::regclass AND tgname='on_auth_user_created_secure'`), 1,
      'exactly one secure trigger exists');
  }
  {
    const out = apply(DB, 'supabase/security_hardening.sql');
    ok(/already wired to handle_new_user_secure; nothing to do/.test(out),
      'a second run is a no-op');
    eq(scalarNum(DB, `SELECT count(*) FROM pg_trigger
                       WHERE tgrelid='auth.users'::regclass AND tgname='on_auth_user_created_secure'`), 1,
      'a second run does not duplicate the trigger');
  }

  // Scenario 3: the secure trigger name exists but points elsewhere → refuse.
  runSql(DB, `
    DROP TRIGGER on_auth_user_created_secure ON auth.users;
    CREATE OR REPLACE FUNCTION public.zshm_test_other()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN RETURN NEW; END;
    $fn$;
    CREATE TRIGGER on_auth_user_created_secure
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.zshm_test_other();
  `);
  {
    const out = apply(DB, 'supabase/security_hardening.sql');
    ok(/already exists with a different function; refusing to replace it/.test(out),
      'a same-named trigger with another function is never replaced');
    eq(scalar(DB, `SELECT p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
                    WHERE t.tgrelid='auth.users'::regclass AND t.tgname='on_auth_user_created_secure'`),
      'zshm_test_other', 'the existing trigger still uses its original function');
  }
  eq(scalarNum(DB, `SELECT count(*) FROM pg_proc WHERE proname='prevent_last_admin_demotion'`), 0,
    'security_hardening.sql does not recreate the duplicate last-admin function');

  // ── Function privileges ─────────────────────────────────────────────────
  console.log('\n[8] function privileges');
  eq(scalar(DB, `SELECT has_function_privilege('anon',
                    'public.atomic_adjust_stock(jsonb, integer)', 'EXECUTE')`), 'f',
    'anon cannot execute atomic_adjust_stock');
  eq(scalar(DB, `SELECT has_function_privilege('anon',
                    'public.atomic_set_order_status(text, text, text, jsonb)', 'EXECUTE')`), 'f',
    'anon cannot execute atomic_set_order_status');
  eq(scalar(DB, `SELECT has_function_privilege('anon',
                    'public.zshm_order_signature(jsonb)', 'EXECUTE')`), 'f',
    'anon cannot execute zshm_order_signature');
  eq(scalar(DB, `SELECT has_function_privilege('anon',
                    'public.zshm_adjust_coupon_usage(text, integer)', 'EXECUTE')`), 'f',
    'anon cannot execute zshm_adjust_coupon_usage');
  eq(scalar(DB, `SELECT has_function_privilege('service_role',
                    'public.zshm_adjust_coupon_usage(text, integer)', 'EXECUTE')`), 't',
    'service_role can execute zshm_adjust_coupon_usage');
  eq(scalar(DB, `SELECT has_function_privilege('service_role',
                    'public.atomic_place_order(jsonb, text)', 'EXECUTE')`), 't',
    'service_role can execute atomic_place_order');
}

try {
  await main();
} catch (err) {
  fail += 1;
  console.error(`\nFATAL: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
} finally {
  clusterCleanup();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
