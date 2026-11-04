/**
 * Real-PostgreSQL harness for the SQL migrations.
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
 *   - storage_hardening.sql: only products-scoped policies are dropped, product
 *     listing is denied, and removed policies can be restored verbatim.
 *   - rate_limit_storage.sql: server-only shared counters and concurrent limits.
 *   - security_hardening.sql: existing provisioning trigger blocks a duplicate,
 *     unrelated triggers are preserved, re-runs do not duplicate.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
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

  // Homebrew PostgreSQL 17 on macOS aborts with "postmaster became
  // multithreaded during startup" when the inherited locale is not one it
  // recognizes; LC_ALL=C is always valid there.
  const env = { ...process.env, LC_ALL: 'C' };

  const init = spawnSync(tools.initdb, [
    '-D', dataDir, '-U', 'postgres', '-A', 'trust', '--locale=C', '--encoding=UTF8',
  ], { encoding: 'utf8', timeout: 120000, env });
  if (init.status !== 0) {
    throw new Error(`initdb failed:\n${init.stdout || ''}${init.stderr || ''}`);
  }

  const options = `-c unix_socket_directories='${sockDir}' -p ${sockPort} -c fsync=off -c full_page_writes=off -c autovacuum=off`;
  const start = spawnSync(tools.pgCtl, [
    '-D', dataDir, '-l', join(tmp, 'postgres.log'), '-o', options, '-w', 'start',
  ], { encoding: 'utf8', timeout: 120000, env });
  if (start.status !== 0) {
    let log = '';
    try { log = readFileSync(join(tmp, 'postgres.log'), 'utf8'); } catch { /* no log */ }
    throw new Error(`pg_ctl start failed:\n${start.stdout || ''}${start.stderr || ''}${log ? `\n--- postgres.log ---\n${log}` : ''}`);
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

function runSqlAsync(db, sql) {
  return new Promise((resolve) => {
    const child = spawn(tools.psql, psqlArgs(db).concat(['-c', sql]), { encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({
      status: 1,
      stdout,
      stderr: `${stderr}${error.message}`,
      out: `${stdout}${stderr}${error.message}`,
    }));
    child.on('close', (status) => resolve({ status, stdout, stderr, out: `${stdout}${stderr}` }));
  });
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

function applyExpectOutcome(db, relativePath) {
  const r = spawnSync(tools.psql, psqlArgs(db).concat(['-f', fileURLToPath(new URL(relativePath, ROOT))]), {
    encoding: 'utf8', timeout: 120000,
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
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
      (id, name, category, price, stock, "variantStock", "reservedStock", active, sizes, colors)
    VALUES
      (1, 'Tee', 'clothing', 50, 10, '{"M-Black": 10}'::jsonb, 0, true,
       '["M"]'::jsonb, '["Black"]'::jsonb),
      (2, 'Hat', 'clothing', 40, 10, '{"L-White": 10}'::jsonb, 0, true,
       '["L"]'::jsonb, '["White"]'::jsonb);
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
      (id, name, category, price, stock, "variantStock", "reservedStock", active, sizes, colors)
    VALUES (1, 'Tee', 'clothing', 50, ${stock}, ${dollar(`{"M-Black": ${stock}}`)}::jsonb, 0, true,
            '["M"]'::jsonb, '["Black"]'::jsonb);
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
    -- Supabase's service_role has BYPASSRLS. The lockdown migrations abort if
    -- this is false, so the test cluster must mirror production.
    CREATE ROLE service_role NOLOGIN BYPASSRLS;

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
      id              bigint,
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

    GRANT SELECT ON storage.objects TO anon, authenticated;
    GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
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
  apply(DB, 'supabase/coupons_lockdown.sql');
  apply(DB, 'supabase/users_orders_lockdown.sql');
  const viewPhase1 = apply(DB, 'supabase/products_public_view.sql');
  apply(DB, 'supabase/storage_hardening.sql');
  apply(DB, 'supabase/rate_limit_storage.sql');

  ok(/PHASE 3 SKIPPED/.test(viewPhase1), 'products view runs Phase 1 only before the deploy flag');
  ok(scalarNum(DB, `SELECT count(*) FROM pg_proc WHERE proname = 'atomic_place_order'`) === 1,
    'atomic_place_order exists');
  ok(scalarNum(DB, `SELECT count(*) FROM pg_indexes
                     WHERE tablename = 'orders' AND indexname = 'orders_idempotency_key_unique'`) === 1,
    'idempotency unique index exists');
  ok(scalar(DB, `SELECT has_function_privilege('anon',
                    'public.atomic_place_order(jsonb, text)', 'EXECUTE')`) === 'f',
    'anon cannot execute atomic_place_order');

  // ── Shared database rate limiter ────────────────────────────────────────
  console.log('\n[1b] rate_limit_storage: server-only shared counter');
  eq(scalar(DB, `SELECT has_table_privilege('anon', 'public.zshm_rate_limits', 'SELECT')`), 'f',
    'anon cannot read shared rate-limit counters');
  eq(scalar(DB, `SELECT has_function_privilege('anon',
                    'public.zshm_rate_limit(text,integer,integer,text)', 'EXECUTE')`), 'f',
    'anon cannot execute the rate-limit RPC');
  eq(scalar(DB, `SELECT has_function_privilege('service_role',
                    'public.zshm_rate_limit(text,integer,integer,text)', 'EXECUTE')`), 't',
    'service_role can execute the rate-limit RPC');
  const verification = runSql(DB, `
    SELECT (
             SELECT relrowsecurity FROM pg_class
              WHERE oid = to_regclass('public.zshm_rate_limits')
           ),
           CASE WHEN to_regclass('public.zshm_rate_limits') IS NULL THEN NULL
                ELSE has_table_privilege('anon', to_regclass('public.zshm_rate_limits'), 'SELECT')
           END,
           CASE WHEN to_regprocedure('public.zshm_rate_limit(text,integer,integer,text)') IS NULL THEN NULL
                ELSE has_function_privilege('anon',
                  to_regprocedure('public.zshm_rate_limit(text,integer,integer,text)'), 'EXECUTE')
           END,
           CASE WHEN to_regprocedure('public.zshm_rate_limit(text,integer,integer,text)') IS NULL THEN NULL
                ELSE has_function_privilege('service_role',
                  to_regprocedure('public.zshm_rate_limit(text,integer,integer,text)'), 'EXECUTE')
           END;
  `);
  eq(verification.status, 0, 'production verification query runs against applied rate-limit migration');
  eq(verification.stdout.trim(), 't|f|f|t',
    'production verifier confirms RLS, browser denial, and service_role execution');
  for (const [sql, label] of [
    [`SELECT public.zshm_rate_limit('${'c'.repeat(64)}', NULL, 60, 'consume')`, 'null attempt limit is rejected'],
    [`SELECT public.zshm_rate_limit('${'d'.repeat(64)}', 2, NULL, 'consume')`, 'null window is rejected'],
    [`SELECT public.zshm_rate_limit('${'e'.repeat(64)}', 2, 60, NULL)`, 'null action is rejected'],
  ]) {
    eq(runSql(DB, sql).status !== 0, true, label);
  }
  {
    const key = 'a'.repeat(64);
    const consume = () => scalar(DB,
      `SELECT public.zshm_rate_limit('${key}', 2, 60, 'consume')->>'allowed'`);
    eq(consume(), 'true', 'first shared request is allowed');
    eq(consume(), 'true', 'request at limit is allowed');
    eq(consume(), 'false', 'request over limit is denied');
    eq(scalar(DB, `SELECT public.zshm_rate_limit('${key}', 2, 60, 'peek')->>'count'`), '3',
      'peek reads without incrementing');
    runSql(DB, `UPDATE public.zshm_rate_limits SET reset_at = clock_timestamp() - interval '1 second'
                 WHERE rate_key = '${key}';`);
    eq(consume(), 'true', 'expired counter starts a new window');
    eq(scalar(DB, `SELECT public.zshm_rate_limit('${key}', 2, 60, 'peek')->>'count'`), '1',
      'new window count starts at one');
    scalar(DB, `SELECT public.zshm_rate_limit('${key}', 2, 60, 'reset')->>'count'`);
    eq(scalar(DB, `SELECT public.zshm_rate_limit('${key}', 2, 60, 'peek')->>'count'`), '0',
      'reset removes the shared counter');
  }
  {
    const key = 'b'.repeat(64);
    const calls = await Promise.all(Array.from({ length: 12 }, () =>
      runSqlAsync(DB, `SELECT public.zshm_rate_limit('${key}', 4, 60, 'consume')->>'allowed'`)));
    eq(calls.every((result) => result.status === 0), true, 'concurrent RPC requests complete successfully');
    eq(calls.filter((result) => result.stdout.trim() === 'true').length, 4,
      'concurrent requests enforce the shared limit exactly once');
  }

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

  // [3l] REVISION 9 guard: a variantStock key left behind by a removed size or
  // colour must NOT stay purchasable at the database level. Fixtures mirror the
  // real Production row 1793739505270547 (Jacket Boxy): colors has no "White"
  // yet variantStock still holds M-White/L-White.
  console.log('\n[3l] atomic_place_order: undeclared sizes/colours are refused');
  seedShop(DB);
  runSql(DB, `
    INSERT INTO public.products
      (id, name, category, price, stock, "variantStock", "reservedStock",
       active, sizes, colors)
    VALUES
      -- the production-shaped case: 2 declared colours, 2 orphan White keys
      (20, 'Jacket', 'Jackets', 100, 18,
       '{"M-Black": 5, "M-Burgundy": 1, "M-White": 4, "L-White": 4}'::jsonb, 0, true,
       '["M","L","XL"]'::jsonb, '["Black","Burgundy"]'::jsonb),
      -- legacy: variantStock with no declared options at all
      (21, 'Legacy Tee', 'clothing', 100, 5, '{"M-Black": 5}'::jsonb, 0, true, NULL, NULL),
      -- declared arrays are EMPTY
      (22, 'Empty Options', 'clothing', 100, 5, '{"M-Black": 5}'::jsonb, 0, true,
       '[]'::jsonb, '[]'::jsonb),
      -- only sizes declared: sizes are still enforced, colours are not
      (23, 'Sizes Only', 'clothing', 100, 5, '{"M-Black": 5}'::jsonb, 0, true,
       '["M"]'::jsonb, NULL),
      -- colour contains a hyphen: the key is never re-parsed
      (24, 'Coat', 'Outerwear', 100, 3, '{"M-Off-White": 3}'::jsonb, 0, true,
       '["M"]'::jsonb, '["Off-White"]'::jsonb);
  `);
  {
    const order = makeOrder({
      id: 'ORD-ORPHAN-COLOR',
      items: [{ productId: 20, qty: 1, size: 'M', color: 'White', price: 100 }],
    });
    const r = lastJson(runSql(DB, placeSql(order, null)).out);
    eq(r.ok, false, 'an undeclared colour with existing stock is refused');
    eq(r.reason, 'undefined_variant', 'the refusal is specific, not a generic unavailable');
    eq(r.color, 'White', 'the rejection names the offending colour');
    eq(scalarNum(DB, `SELECT count(*) FROM public.orders WHERE id='ORD-ORPHAN-COLOR'`), 0,
      'undeclared colour writes no order');
    eq(scalarNum(DB, `SELECT ("variantStock"->>'M-White')::int FROM public.products WHERE id=20`), 4,
      'the orphan key keeps its quantity — the guard never deletes stock');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=20`), 18,
      'a refused undeclared line leaves the global stock untouched');
  }
  {
    const order = makeOrder({
      id: 'ORD-ORPHAN-SIZE',
      items: [{ productId: 20, qty: 1, size: 'XXL', color: 'Black', price: 100 }],
    });
    const r = lastJson(runSql(DB, placeSql(order, null)).out);
    eq(r.reason, 'undefined_variant', 'an undeclared SIZE is refused too');
    eq(r.size, 'XXL', 'the rejection names the offending size');
  }
  {
    // An undeclared colour asked in an undeclared size is still refused, and a
    // line with empty size+colour (legacy cart) cannot slip through either.
    const order = makeOrder({
      id: 'ORD-ORPHAN-EMPTY',
      items: [{ productId: 20, qty: 1, size: '', color: '', price: 100 }],
    });
    const r = lastJson(runSql(DB, placeSql(order, null)).out);
    eq(r.reason, 'undefined_variant', 'an empty size/colour pair is refused when options are declared');
  }
  {
    // Declared variations keep working — the guard must not over-block.
    const order = makeOrder({
      id: 'ORD-DECLARED-OK',
      items: [
        { productId: 20, qty: 1, size: 'M', color: 'Burgundy', price: 100 },
        { productId: 20, qty: 2, size: 'M', color: 'Black', price: 100 },
      ],
      subtotal: 300,
    });
    const r = lastJson(runSql(DB, placeSql(order, null)).out);
    eq(r.ok, true, 'declared variations still purchase normally');
    eq(scalarNum(DB, `SELECT ("variantStock"->>'M-Burgundy')::int FROM public.products WHERE id=20`), 0,
      'declared variation decremented');
    eq(scalarNum(DB, `SELECT ("variantStock"->>'M-White')::int FROM public.products WHERE id=20`), 4,
      'the orphan key is still untouched after a successful declared order');
    // REVISION 10 (owner decision 1أ): the decrement pass recomputes stock over
    // the DECLARED keys only, so the 8 orphan White units can no longer re-enter
    // the global counter. Here the declared pool is 3 (M-Black) + 0 (M-Burgundy).
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=20`), 3,
      'stock is recomputed over the declared keys only — orphans excluded');
    eq(scalarNum(DB, `SELECT ("variantStock"->>'M-White')::int +
             ("variantStock"->>'L-White')::int FROM public.products WHERE id=20`), 8,
      'the orphan quantities are still in the map, untouched');
    eq(scalarNum(DB, `SELECT public.zshm_sellable_stock("variantStock", sizes, colors)
             FROM public.products WHERE id=20`), 3,
      'stored stock equals the sellable (declared-only) pool');
  }
  {
    // REVISION 10 (owner decision 3ب): a variant pool that has no declared size
    // list or no declared colour list is an invalid configuration. Nothing can be
    // matched against it, so it is refused instead of sold by raw key lookup —
    // in the UI and in the RPC, on the same rule.
    const cases = [
      [21, 'M', 'Black', 'invalid_product_config', 'legacy NULL sizes/colors is refused as invalid config'],
      [22, 'M', 'Black', 'invalid_product_config', 'empty declared arrays are invalid config'],
      [23, 'M', 'Black', 'invalid_product_config', 'sizes without any colour list is invalid config'],
      [23, 'XL', 'Black', 'invalid_product_config', 'an undeclared size on an invalid config hits the config guard first'],
    ];
    let n = 0;
    for (const [pid, size, color, expectReason, label] of cases) {
      n += 1;
      const order = makeOrder({
        id: `ORD-GUARD-${n}`,
        items: [{ productId: pid, qty: 1, size, color, price: 100 }],
        subtotal: 100,
      });
      const r = lastJson(runSql(DB, placeSql(order, null)).out);
      eq(r.ok, false, `${label} (got ok=${r.ok})`);
      eq(r.reason, expectReason, `${label} — reason`);
      eq(scalarNum(DB, `SELECT count(*) FROM public.orders WHERE id='ORD-GUARD-${n}'`), 0,
        `${label} — no order row`);
    }
    {
      // A fully declared pool still sells, hyphenated colours included — the key
      // is matched whole, never re-parsed with split('-').
      const order = makeOrder({
        id: 'ORD-GUARD-HYPHEN',
        items: [{ productId: 24, qty: 2, size: 'M', color: 'Off-White', price: 100 }],
        subtotal: 200,
      });
      const r = lastJson(runSql(DB, placeSql(order, null)).out);
      eq(r.ok, true, 'a declared hyphenated colour purchases normally');
      eq(scalarNum(DB, `SELECT ("variantStock"->>'M-Off-White')::int FROM public.products WHERE id=24`), 1,
        'the hyphenated variant decremented by the ordered quantity');
      eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=24`), 1,
        'its stock matches the declared pool exactly');
    }
    {
      // A product with NO variant pool at all keeps using the global counter —
      // the legacy path this change must not touch.
      runSql(DB, `
        INSERT INTO public.products (id, name, category, price, stock, "variantStock", "reservedStock", active, sizes, colors)
        VALUES (25, 'Plain Cap', 'caps', 100, 4, NULL, 0, true, NULL, NULL);
      `);
      const order = makeOrder({
        id: 'ORD-LEGACY-PLAIN',
        items: [{ productId: 25, qty: 3, size: '', color: '', price: 100 }],
        subtotal: 300,
      });
      const r = lastJson(runSql(DB, placeSql(order, null)).out);
      eq(r.ok, true, 'a product without variantStock still sells from the global counter');
      eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=25`), 1,
        'the non-variant decrement path is unchanged');
    }
  }
  {
    // The cancel/delete lifecycle keeps its tolerant contract: historical orders
    // that DO contain an orphan variation still restore. Only new purchases gate.
    runSql(DB, `
      INSERT INTO public.orders (id, subtotal, discount, total, status, date,
        customer, phone, address, city, items, timestamps)
      VALUES ('ORD-HISTORIC-WHITE', 100, 0, 100, 'Pending', '2026-01-01',
        'Old Cart', '01000000000', 'street', 'Cairo',
        '[{"productId": 20, "qty": 1, "size": "M", "color": "White"}]'::jsonb,
        '{"created":"2026-01-01T00:00:00.000Z"}'::jsonb);
    `);
    const r = lastJson(runSql(DB, `SELECT public.atomic_adjust_stock(
      '[{"productId": 20, "qty": 1, "size": "M", "color": "White"}]'::jsonb, 1);`).out);
    eq(r.ok, true, 'restocking an existing order line with an orphan key still works');
    eq(scalarNum(DB, `SELECT ("variantStock"->>'M-White')::int FROM public.products WHERE id=20`), 5,
      'restore returns the unit to the same orphan key');
    // REVISION 10: the returned unit lands on a key that is not sellable, so it
    // must NOT raise the global counter. Before this change the same restore took
    // stock from 3 to 4 while nothing new could actually be sold.
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=20`), 3,
      'a restore onto an orphan key leaves the sellable stock unchanged');
  }

  // [3m] REVISION 10 stock recompute (owner decision 1أ): products.stock is the
  // DECLARED size × colour pool, written identically by atomic_place_order() and
  // atomic_adjust_stock(). The fixture is the real Production row
  // 1793739505270547 (Jacket Boxy): stock 18, declared pool 18, and 8 units
  // sitting on orphan "M-White"/"L-White" keys that the admin removed.
  console.log('\n[3m] REVISION 10: stock is recomputed from declared combinations only');
  seedShop(DB);
  runSql(DB, `
    INSERT INTO public.products
      (id, name, category, price, stock, "variantStock", "reservedStock",
       active, sizes, colors)
    VALUES
      (30, 'Jacket Boxy', 'Jackets', 100, 18,
       '{"M-Black": 6, "L-Black": 6, "XL-Black": 3, "XXL-Black": 3,
         "M-White": 4, "L-White": 4}'::jsonb, 0, true,
       '["M","L","XL","XXL"]'::jsonb, '["Black","Burgundy"]'::jsonb),
      -- legacy shape: variant pool, no declared option lists at all
      (31, 'Legacy Tee', 'clothing', 100, 5, '{"M-Black": 5}'::jsonb, 0, true, NULL, NULL);
  `);
  {
    // The helper is pure, so it can be measured directly before any write.
    const cases = [
      [`SELECT public.zshm_sellable_stock('{"M-Black": 6, "M-White": 4}'::jsonb, '["M"]'::jsonb, '["Black"]'::jsonb)`, 6,
        'an orphan colour is excluded from the pool'],
      [`SELECT public.zshm_sellable_stock('{"M-Black": 6, "M-White": 4}'::jsonb, NULL, NULL)`, 10,
        'legacy NULL lists fall back to the all-keys sum'],
      [`SELECT public.zshm_sellable_stock('{"M-Black": 6}'::jsonb, '[]'::jsonb, '["Black"]'::jsonb)`, 6,
        'an empty sizes array still uses the legacy fallback'],
      [`SELECT public.zshm_sellable_stock('{"M-Black": 6, "L-Black": 2}'::jsonb, '["M","L","XL"]'::jsonb, '["Black"]'::jsonb)`, 8,
        'declared keys that are missing from the map count as zero'],
      [`SELECT public.zshm_sellable_stock('{"M-Black": -3, "L-Black": 5}'::jsonb, '["M","L"]'::jsonb, '["Black"]'::jsonb)`, 5,
        'a negative declared value never inflates the pool'],
      [`SELECT public.zshm_sellable_stock('{"M-Black": "abc", "L-Black": 5}'::jsonb, '["M","L"]'::jsonb, '["Black"]'::jsonb)`, 5,
        'a non-numeric junk value is ignored, not an error'],
      [`SELECT public.zshm_sellable_stock(NULL, '["M"]'::jsonb, '["Black"]'::jsonb)`, 0,
        'a product with no variant pool has no sellable variant stock'],
      [`SELECT public.zshm_sellable_stock('{}'::jsonb, '["M"]'::jsonb, '["Black"]'::jsonb)`, 0,
        'an empty variant pool is zero'],
      [`SELECT public.zshm_sellable_stock('"nope"'::jsonb, '["M"]'::jsonb, '["Black"]'::jsonb)`, 0,
        'a scalar variantStock cannot raise an error'],
      [`SELECT public.zshm_sellable_stock('{"M-Off-White": 7}'::jsonb, '["M"]'::jsonb, '["Off-White"]'::jsonb)`, 7,
        'hyphenated colours match on the whole key'],
    ];
    for (const [sql, expected, label] of cases) {
      eq(scalarNum(DB, sql), expected, label);
    }
  }
  {
    // Production baseline: stored stock already equals the declared pool, and the
    // orphans are the 8 units of un-declared White.
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=30`), 18, 'baseline stock');
    eq(scalarNum(DB, `SELECT public.zshm_sellable_stock("variantStock", sizes, colors) FROM public.products WHERE id=30`), 18,
      'baseline declared pool');
    eq(scalarNum(DB, `SELECT (SELECT COALESCE(SUM((kv.value)::int),0) FROM jsonb_each_text("variantStock") kv)
             FROM public.products WHERE id=30`), 26, 'baseline all-keys sum (18 declared + 8 orphan)');
  }
  {
    // Buying ONE declared unit. Old behaviour: stock jumped 18 → 25 because the
    // 8 orphans were re-added. New behaviour: 18 → 17.
    const r = lastJson(runSql(DB, placeSql(makeOrder({
      id: 'ORD-REC-1', items: [{ productId: 30, qty: 1, size: 'M', color: 'Black', price: 100 }], subtotal: 100,
    }), null)).out);
    eq(r.ok, true, 'the first declared purchase succeeds');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=30`), 17,
      'one unit bought from a 18-unit declared pool leaves 17 (not 24/25)');
    eq(scalarNum(DB, `SELECT ("variantStock"->>'M-White')::int FROM public.products WHERE id=30`), 4,
      'the orphan key still holds its 4 units');
  }
  {
    // THREE more declared units (2 L-Black + 1 XL-Black, different lines):
    // 17 → 14. The old code produced 23 for this exact purchase.
    const r = lastJson(runSql(DB, placeSql(makeOrder({
      id: 'ORD-REC-2',
      items: [
        { productId: 30, qty: 2, size: 'L', color: 'Black', price: 100 },
        { productId: 30, qty: 1, size: 'XL', color: 'Black', price: 100 },
      ],
      subtotal: 300,
    }), null)).out);
    eq(r.ok, true, 'the multi-line declared order places');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=30`), 14,
      'stock tracks the declared pool: 14 after 4 declared units sold');
    eq(scalarNum(DB, `SELECT public.zshm_sellable_stock("variantStock", sizes, colors)
             FROM public.products WHERE id=30`), 14,
      'stored stock and sellable pool agree exactly');
    eq(scalarNum(DB, `SELECT stock - public.zshm_sellable_stock("variantStock", sizes, colors)
             FROM public.products WHERE id=30`), 0,
      'no drift is left between the global counter and the sellable pool');
  }
  {
    // Cancellation restores through atomic_adjust_stock(+1) — the second writer.
    // It must land on the same declared-only rule.
    const r = lastJson(runSql(DB, `SELECT public.atomic_set_order_status(
      'ORD-REC-2', 'Pending', 'Cancelled', '{}'::jsonb);`).out);
    eq(r.ok, true, 'cancelling the declared order succeeds');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=30`), 17,
      'the cancel restores the units into the declared pool (14 → 17)');
    eq(scalarNum(DB, `SELECT ("variantStock"->>'L-Black')::int FROM public.products WHERE id=30`), 6,
      'each unit returns to the variant it was bought from');
  }
  {
    // A restore onto an ORPHAN key (a historical order for the removed colour)
    // still puts the unit back where it belongs, and still leaves the sellable
    // counter alone — the orphan is not sellable, so it is not stock.
    const before = scalarNum(DB, `SELECT stock FROM public.products WHERE id=30`);
    const r = lastJson(runSql(DB, `SELECT public.atomic_adjust_stock(
      '[{"productId": 30, "qty": 1, "size": "M", "color": "White"}]'::jsonb, 1);`).out);
    eq(r.ok, true, 'orphan restore is tolerated (partial-restore contract)');
    eq(scalarNum(DB, `SELECT ("variantStock"->>'M-White')::int FROM public.products WHERE id=30`), 5,
      'the orphan key received the returned unit');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=30`), before,
      'the sellable stock is unchanged by a restore onto an orphan key');
  }
  {
    // The legacy fallback is preserved where it is still needed: cancelling an
    // OLD order that carried a legacy (undeclared-list) product restores the key
    // and recomputes stock over ALL keys, exactly as before REVISION 10.
    runSql(DB, `
      INSERT INTO public.orders (id, subtotal, discount, total, status, date,
        customer, phone, address, city, items, timestamps)
      VALUES ('ORD-LEGACY-HIST', 100, 0, 100, 'Pending', '2025-01-01',
        'Old Cart', '01000000000', 'street', 'Cairo',
        '[{"productId": 31, "qty": 1, "size": "M", "color": "Black"}]'::jsonb,
        '{"created":"2025-01-01T00:00:00.000Z"}'::jsonb);
    `);
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=31`), 5, 'legacy stock before restore');
    const r = lastJson(runSql(DB, `SELECT public.atomic_adjust_stock(
      '[{"productId": 31, "qty": 1, "size": "M", "color": "Black"}]'::jsonb, 1);`).out);
    eq(r.ok, true, 'legacy restore works with no declared option lists');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=31`), 6,
      'the legacy all-keys fallback raised stock by exactly the restored unit');
    const deduct = lastJson(runSql(DB, `SELECT public.atomic_adjust_stock(
      '[{"productId": 31, "qty": 2, "size": "M", "color": "Black"}]'::jsonb, -1);`).out);
    eq(deduct.ok, true, 'legacy deduct passes the preflight against the variant key');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=31`), 4,
      'legacy deduct recomputes with the same fallback');
    // New purchases of that legacy shape are refused (3ب) — the pool is not gone,
    // only the ability to sell it without declared options.
    const refused = lastJson(runSql(DB, placeSql(makeOrder({
      id: 'ORD-LEGACY-BUY', items: [{ productId: 31, qty: 1, size: 'M', color: 'Black', price: 100 }], subtotal: 100,
    }), null)).out);
    eq(refused.ok, false, 'a new order for a legacy-config product is refused');
    eq(refused.reason, 'invalid_product_config', 'the refusal names the invalid configuration');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=31`), 4,
      'the refused purchase changed nothing');
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

  // [3j] reservedStock is retained but excluded from availability.
  console.log('\n[3j] reservedStock is ignored by availability');
  seedShop(DB);
  runSql(DB, `UPDATE public.products SET "reservedStock" = 999 WHERE id = 1;`);
  {
    const cart = [{ productId: 1, qty: 10, size: 'M', color: 'Black', price: 50 }];
    const order = makeOrder({ id: 'ORD-RESERVED', items: cart, subtotal: 500, total: 500 });
    const r = lastJson(runSql(DB, placeSql(order, 'reserved-ignored')).out);
    eq(r.ok, true, 'reservedStock=999 does not block a 10-piece order');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 0,
      'stock is deducted normally while reservedStock is ignored');
  }

  // [3k] partial restore: missing products/variants are skipped and reported.
  console.log('\n[3k] atomic_adjust_stock: partial restore');
  seedShop(DB);
  {
    const lines = [
      { productId: 1, qty: 2, size: 'M', color: 'Black' },
      { productId: 999, qty: 1, size: 'M', color: 'Black' },
    ];
    const r = lastJson(runSql(DB,
      `SELECT public.atomic_adjust_stock(${dollar(JSON.stringify(lines))}::jsonb, 1);`).out);
    eq(r.ok, true, 'restore succeeds with one missing product');
    eq(Number(r.restored), 1, 'the existing product group is restored');
    ok((r.warnings || []).some((w) =>
      w.reason === 'missing_product' && Number(w.productId) === 999),
      'the missing product is reported');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 12,
      'the existing line is actually restored');
    eq(scalarNum(DB, `SELECT ("variantStock"->>'M-Black')::int FROM public.products WHERE id=1`), 12,
      'the existing variant is actually restored');
  }
  {
    const lines = [{ productId: 1, qty: 1, size: 'X', color: 'Y' }];
    const up = lastJson(runSql(DB,
      `SELECT public.atomic_adjust_stock(${dollar(JSON.stringify(lines))}::jsonb, 1);`).out);
    eq(up.ok, true, 'restoring a missing variant is tolerated');
    eq(Number(up.restored), 0, 'nothing is restored for a missing variant');
    ok((up.warnings || []).some((w) => w.reason === 'missing_variant' && w.variant === 'X-Y'),
      'the missing variant is reported');
    eq(scalarNum(DB, `SELECT count(*) FROM jsonb_object_keys(
        (SELECT "variantStock" FROM public.products WHERE id=1)) k WHERE k = 'X-Y'`), 0,
      'the missing variant is not resurrected');

    const down = lastJson(runSql(DB,
      `SELECT public.atomic_adjust_stock(${dollar(JSON.stringify(lines))}::jsonb, -1);`).out);
    eq(down.ok, false, 'deducting a missing variant stays strict');
    eq(down.reason, 'missing_variant', 'deduct reports missing_variant');
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

  // [4f] a permanently deleted product: delete proceeds AND every existing line
  // is restored (partial restore), with a warning for the vanished product.
  seedLegacyOrder(DB, {
    itemsJson: [
      { productId: 1, qty: 2, size: 'M', color: 'Black' },
      { productId: 999, qty: 1, size: 'M', color: 'Black' },
    ],
  });
  {
    const r = lastJson(runSql(DB, deleteOrderSql('ORD-LEGACY-1')).out);
    eq(r.ok, true, 'a missing product does not block deletion forever');
    eq(r.stockRestored, true, 'stockRestored=true when at least one line is restored');
    ok((r.warnings || []).some((w) => w.reason === 'missing_product' && Number(w.productId) === 999),
      'the missing product is reported as a warning');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 12,
      'the existing line is restored (partial restore)');
    eq(scalarNum(DB, `SELECT count(*) FROM public.orders WHERE id='ORD-LEGACY-1'`), 0,
      'the order is still deleted');
  }

  // [4g] coupon delete guard: open orders block deletion; cancelled ones do not.
  console.log('\n[4g] coupon delete guard');
  seedLegacyOrder(DB, {
    id: 'ORD-GUARD',
    status: 'Confirmed',
    itemsJson: [{ productId: 1, qty: 2, size: 'M', color: 'Black' }],
  });
  {
    const blocked = runSql(DB, `DELETE FROM public.coupons WHERE code='SAVE10';`);
    ok(blocked.status !== 0 && /coupon_in_use/.test(blocked.out),
      'deleting a coupon used by an open order is rejected');
    eq(scalarNum(DB, `SELECT count(*) FROM public.coupons WHERE code='SAVE10'`), 1,
      'the coupon still exists after the rejected delete');

    const c = lastJson(runSql(DB, setStatusSql('ORD-GUARD', 'Confirmed', 'Cancelled')).out);
    eq(c.ok, true, 'the order can still be cancelled');
    eq(scalarNum(DB, `SELECT "usageCount" FROM public.coupons WHERE code='SAVE10'`), 2,
      'coupon usage is released on cancellation');

    const allowed = runSql(DB, `DELETE FROM public.coupons WHERE code='SAVE10';`);
    eq(allowed.status, 0, 'a coupon referenced only by a cancelled order can be deleted');
    eq(scalarNum(DB, `SELECT count(*) FROM public.coupons WHERE code='SAVE10'`), 0,
      'the coupon is deleted after cancellation');
  }

  // [4h] a coupon deleted before the guard existed must not block lifecycle ops.
  console.log('\n[4h] coupon_not_found is tolerated');
  seedLegacyOrder(DB, {
    itemsJson: [{ productId: 1, qty: 2, size: 'M', color: 'Black' }],
    code: 'GONE',
  });
  {
    const r = lastJson(runSql(DB, deleteOrderSql('ORD-LEGACY-1')).out);
    eq(r.ok, true, 'delete succeeds when the coupon no longer exists');
    ok((r.warnings || []).some((w) => w.warning === 'coupon_not_found'),
      'the missing coupon is reported as a warning');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 12,
      'stock is still restored');
  }
  seedLegacyOrder(DB, {
    status: 'Confirmed',
    itemsJson: [{ productId: 1, qty: 2, size: 'M', color: 'Black' }],
    code: 'GONE',
  });
  {
    const r = lastJson(runSql(DB, setStatusSql('ORD-LEGACY-1', 'Confirmed', 'Cancelled')).out);
    eq(r.ok, true, 'cancel succeeds when the coupon no longer exists');
    ok((r.warnings || []).some((w) => w.warning === 'coupon_not_found'),
      'cancel reports coupon_not_found');
    eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=1`), 12,
      'cancel still restores stock');
  }

  // [4i] users/orders/coupons lockdown: browser roles are denied, service_role works.
  console.log('\n[4i] users/orders/coupons lockdown');
  {
    for (const table of ['users', 'orders', 'coupons']) {
      eq(scalar(DB, `SELECT has_table_privilege('anon', 'public.${table}', 'SELECT')`), 'f',
        `anon cannot SELECT ${table}`);
      eq(scalar(DB, `SELECT has_table_privilege('authenticated', 'public.${table}', 'SELECT')`), 'f',
        `authenticated cannot SELECT ${table}`);
      eq(scalar(DB, `SELECT has_table_privilege('service_role', 'public.${table}', 'SELECT')`), 't',
        `service_role can SELECT ${table}`);
      eq(scalar(DB, `SELECT has_table_privilege('service_role', 'public.${table}', 'DELETE')`), 't',
        `service_role can DELETE ${table}`);
      eq(scalar(DB, `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${table}'::regclass`), 't',
        `RLS is enabled on ${table}`);
    }
    const anonUsers = runSql(DB, 'SET ROLE anon; SELECT count(*) FROM public.users;');
    ok(anonUsers.status !== 0 && /permission denied/i.test(anonUsers.out),
      'anon SELECT on users actually fails');
    const authOrders = runSql(DB, 'SET ROLE authenticated; SELECT count(*) FROM public.orders;');
    ok(authOrders.status !== 0 && /permission denied/i.test(authOrders.out),
      'authenticated SELECT on orders actually fails');
    const svcUsers = runSql(DB, 'SET ROLE service_role; SELECT count(*) FROM public.users;');
    eq(svcUsers.status, 0, 'service_role can still read users');
    const svcOrders = runSql(DB, 'SET ROLE service_role; SELECT count(*) FROM public.orders;');
    eq(svcOrders.status, 0, 'service_role can still read orders');
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
  runSql(DB, `INSERT INTO storage.objects (bucket_id, name)
              VALUES ('products', 'listed-product.jpg'), ('avatars', 'listed-avatar.jpg');`);
  const kept = scalar(DB, `SELECT string_agg(policyname, ',' ORDER BY policyname)
                             FROM pg_policies WHERE schemaname='storage' AND tablename='objects'`);
  const keptSet = kept.split(',').filter(Boolean);
  eq(keptSet.sort(), ['avatars_read', 'blanket_read', 'shared_read', 'zshm_products_no_public_listing'],
    'blanket and other-bucket policies are kept alongside the restrictive listing guard');
  ok(!keptSet.includes('products_read'), 'products-only SELECT policy was removed');
  ok(!keptSet.includes('products_all'), 'products-only ALL policy was removed');
  eq(scalar(DB, `SET ROLE anon; SELECT count(*) FROM storage.objects WHERE bucket_id = 'products';`), '0',
    'anon cannot list product-bucket objects despite other permissive policies');
  {
    const otherBucket = runSql(DB,
      `SET ROLE anon; SELECT count(*) FROM storage.objects WHERE bucket_id = 'avatars';`);
    eq(otherBucket.stdout.trim(), '1', 'other-bucket listing remains available under its existing policy');
  }
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
      DROP POLICY IF EXISTS zshm_products_no_public_listing ON storage.objects;
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

  await stagedMigrationRollout();
}

// [9] THE STAGED MIGRATIONS THEMSELVES. Up to here the cluster was built from
// supabase/atomic_place_order.sql (the canonical source). Applying the two
// migration files must (a) succeed with no SQL error, and (b) leave exactly the
// same behaviour — the reviewed rollout and the canonical file cannot diverge.
// This is the last section: it deliberately rewrites the functions it just
// proved identical. It runs as the last step of main(), once the throwaway
// cluster is up and the canonical definitions have passed every scenario.
async function stagedMigrationRollout() {
  console.log('\n[9] staged migrations apply cleanly and behave identically');
  apply(DB, 'supabase/reject_undefined_variants.sql');
  apply(DB, 'supabase/declared_only_stock_recompute.sql');

  eq(scalarNum(DB, `SELECT count(*) FROM pg_proc
                    WHERE proname IN ('atomic_place_order', 'atomic_adjust_stock',
                                      'zshm_order_signature', 'zshm_sellable_stock')`), 4,
    'all four definitions exist after the rollout');
  eq(scalar(DB, `SELECT has_function_privilege('anon',
                    'public.zshm_sellable_stock(jsonb, jsonb, jsonb)', 'EXECUTE')`), 'f',
    'the new helper is not callable by anon');
  eq(scalar(DB, `SELECT has_function_privilege('service_role',
                    'public.zshm_sellable_stock(jsonb, jsonb, jsonb)', 'EXECUTE')`), 't',
    'the service role can execute the helper');

  const body = runSql(DB, `SELECT pg_get_functiondef('public.atomic_place_order(jsonb, text)'::regprocedure);`).out;
  ok(body.includes('undefined_variant'), 'the applied RPC still refuses undeclared variations');
  ok(body.includes('invalid_product_config'), 'the applied RPC still refuses invalid variant configs');
  ok(body.includes('zshm_sellable_stock'), 'the applied RPC still recomputes stock through the helper');

  seedShop(DB);
  runSql(DB, `
    INSERT INTO public.products
      (id, name, category, price, stock, "variantStock", "reservedStock",
       active, sizes, colors)
    VALUES (30, 'Jacket Boxy', 'Jackets', 100, 18,
       '{"M-Black": 6, "L-Black": 6, "XL-Black": 3, "XXL-Black": 3,
         "M-White": 4, "L-White": 4}'::jsonb, 0, true,
       '["M","L","XL","XXL"]'::jsonb, '["Black","Burgundy"]'::jsonb);
  `);
  const orphan = lastJson(runSql(DB, placeSql(makeOrder({
    id: 'ORD-MIG-ORPHAN',
    items: [{ productId: 30, qty: 1, size: 'M', color: 'White', price: 100 }],
    subtotal: 100,
  }), null)).out);
  eq(orphan.reason, 'undefined_variant', 'the applied migration still refuses the orphan colour');
  const declared = lastJson(runSql(DB, placeSql(makeOrder({
    id: 'ORD-MIG-DECLARED',
    items: [{ productId: 30, qty: 1, size: 'M', color: 'Black', price: 100 }],
    subtotal: 100,
  }), null)).out);
  eq(declared.ok, true, 'a declared variation purchases through the applied migration');
  eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=30`), 17,
    'and stock is recomputed declared-only (18 → 17, not 25)');
  eq(scalarNum(DB, `SELECT ("variantStock"->>'M-White')::int FROM public.products WHERE id=30`), 4,
    'the orphan key is still there, untouched, with its quantity intact');

  await stockHardeningChecks();
}

// ─── [10] stock_hardening_constraints.sql ─────────────────────────────────────
// The hardening file was never executable before: it used unquoted camelCase
// identifiers, ran outside a transaction and ended with a literal "EOF". These
// checks apply it for real, prove it fails closed on dirty data, prove a second
// run is a no-op, and prove the rollback file is executable. They run on the
// same throwaway cluster as [9], so they are called from the end of main().
async function stockHardeningChecks() {
console.log('\n[10] stock_hardening_constraints: fail-closed preflight, idempotency, rollback');
{
  const hardening = () => applyExpectOutcome(DB, 'supabase/stock_hardening_constraints.sql');
  const rollback  = () => applyExpectOutcome(DB, 'supabase/stock_hardening_constraints_rollback.sql');
  const HARDENING_CONSTRAINTS = `'products_active_boolean','products_stock_nonnegative',
    'products_reserved_nonnegative','products_variant_stock_shape'`.replace(/\s+/g, ' ');
  const constraintCount = () => scalarNum(DB,
    `SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.products'::regclass
        AND conname IN (${HARDENING_CONSTRAINTS})`);
  const helperExists = () => scalar(DB,
    `SELECT to_regprocedure('public.zshm_valid_variant_stock(jsonb)') IS NOT NULL`);
  const attnotnull = (col) => scalar(DB,
    `SELECT attnotnull FROM pg_attribute
      WHERE attrelid = 'public.products'::regclass AND attname = '${col}'`);

  eq(helperExists(), 'f', 'the variant-shape helper does not exist before the migration');
  eq(constraintCount(), 0, 'no hardening constraint exists before the migration');

  // A dirty catalogue must abort with zero side effects (no NOT NULL, no CHECK,
  // no helper function left behind by the rolled-back transaction).
  runSql(DB, `
    INSERT INTO public.products (id, name, category, price, stock, "variantStock", active)
    VALUES (901, 'QA null active', 'QA', 10, 0, '{}'::jsonb, NULL),
           (902, 'QA negative variant', 'QA', 10, 0, '{"S-Black": -2}'::jsonb, true),
           (903, 'QA padded variant key', 'QA', 10, 0, '{" S-Black": 2}'::jsonb, true);
  `);
  const dirty = hardening();
  ok(dirty.status !== 0, 'dirty data (NULL active, negative/padded variant) aborts the migration');
  ok(/aborted/i.test(dirty.out), 'the preflight explains why it aborted');
  ok(/901/.test(dirty.out) && /902/.test(dirty.out) && /903/.test(dirty.out),
    'the preflight lists every offending product id');
  ok(!/does not exist/i.test(dirty.out),
    'no unquoted camelCase identifier is referenced (the PostgreSQL 17 failure)');
  eq(constraintCount(), 0, 'the aborted transaction added no constraint');
  eq(helperExists(), 'f', 'the aborted transaction rolled the helper function back');
  eq(attnotnull('active'), 'f', 'the aborted transaction left active nullable');
  // The abort must not have modified the offending rows either.
  eq(scalarNum(DB, `SELECT count(*) FROM public.products WHERE id IN (901, 902, 903)`), 3,
    'the aborted migration did not delete or rewrite the offending rows');
  eq(scalarNum(DB, `SELECT count(*) FROM public.products WHERE id = 901 AND active IS NULL`), 1,
    'NULL active is preserved for an explicit owner decision');
  runSql(DB, `DELETE FROM public.products WHERE id IN (901, 902, 903)`);

  const first = hardening();
  eq(first.status, 0, 'the migration applies on a clean catalogue');
  ok(!/does not exist/i.test(first.out), 'quoting "reservedStock"/"variantStock" is correct');
  eq(constraintCount(), 4, 'all four constraints exist after the first run');
  eq(attnotnull('active'), 't', 'active is NOT NULL');
  eq(attnotnull('stock'), 't', 'stock is NOT NULL');
  eq(attnotnull('reservedStock'), 't', '"reservedStock" is NOT NULL');
  eq(helperExists(), 't', 'the variant-shape helper exists after the run');

  const second = hardening();
  eq(second.status, 0, 'a second run succeeds instead of failing on an existing constraint');
  ok(!/already exists/i.test(second.out), 'the second run never raises "already exists"');
  eq(constraintCount(), 4, 'the constraints were not duplicated by the second run');

  // The constraints must defend the real columns.
  ok(runSql(DB, `UPDATE public.products SET stock = -1 WHERE id = 30`).status !== 0,
    'negative stock is rejected by the CHECK');
  ok(runSql(DB, `UPDATE public.products SET "reservedStock" = -1 WHERE id = 30`).status !== 0,
    'negative reservedStock is rejected by the CHECK');
  ok(runSql(DB, `UPDATE public.products SET active = NULL WHERE id = 30`).status !== 0,
    'NULL active is rejected by NOT NULL');
  ok(runSql(DB, `UPDATE public.products SET "variantStock" = '[]'::jsonb WHERE id = 30`).status !== 0,
    'a non-object variantStock is rejected');
  ok(runSql(DB, `UPDATE public.products SET "variantStock" = '{"S-Black": 1.5}'::jsonb WHERE id = 30`).status !== 0,
    'a non-integer variant quantity is rejected');
  ok(runSql(DB, `UPDATE public.products SET "variantStock" = '{" S-Black": 1}'::jsonb WHERE id = 30`).status !== 0,
    'a padded variant key is rejected');
  eq(scalar(DB, `SELECT public.zshm_valid_variant_stock(NULL::jsonb)`), 't',
    'the helper still accepts a NULL variant pool');
  eq(scalar(DB, `SELECT public.zshm_valid_variant_stock('{"M-Black": 3}'::jsonb)`), 't',
    'the helper accepts a well-formed variant pool');
  eq(scalar(DB, `SELECT public.zshm_valid_variant_stock('{"M-Black": -3}'::jsonb)`), 'f',
    'the helper rejects a negative quantity');

  // The constraints must not break the order path that legitimately rewrites stock.
  const afterHardening = lastJson(runSql(DB, placeSql(makeOrder({
    id: 'ORD-HARDEN-1',
    items: [{ productId: 30, qty: 1, size: 'M', color: 'Black', price: 100 }],
    subtotal: 100,
  }), null)).out);
  eq(afterHardening.ok, true, 'a declared purchase still goes through with the constraints on');
  eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=30`), 16,
    'and the declared-only stock counter still moves by exactly one');

  const rb = rollback();
  eq(rb.status, 0, 'the rollback file is executable as-is');
  eq(constraintCount(), 0, 'the rollback drops all four constraints');
  eq(helperExists(), 'f', 'the rollback drops the helper function');
  eq(attnotnull('active'), 'f', 'the rollback restores a nullable active column');
  eq(attnotnull('reservedStock'), 'f', 'the rollback restores a nullable "reservedStock" column');

  eq(hardening().status, 0, 'the migration can be re-applied after the rollback');
  eq(constraintCount(), 4, 'and the constraints are back');
}

// ─── [10b] duplicated declared options never double-count ─────────────────────
console.log('\n[10b] duplicated declared sizes/colours are counted once');
{
  eq(scalarNum(DB, `SELECT public.zshm_sellable_stock(
        '{"S-Black": 7, "M-Black": 5, "L-Black": 5}'::jsonb,
        '["S","S","M","M","L"]'::jsonb,
        '["Black","Black"]'::jsonb)`), 17,
    'duplicate size/colour lines sum each combination once (not 24/34)');
  eq(scalarNum(DB, `SELECT public.zshm_sellable_stock(
        '{"S-Black": 7, "M-Black": 5}'::jsonb,
        '["s","S","M"]'::jsonb,
        '["Black"]'::jsonb)`), 12,
    'a case variant resolves to its own key and never inflates the total');
  eq(scalarNum(DB, `SELECT public.zshm_sellable_stock(
        '{"S-Black": 7, "S-Burgundy": 2}'::jsonb,
        '["S","S"]'::jsonb,
        '["Black","Burgundy"]'::jsonb)`), 9,
    'duplicate sizes keep every distinct colour combination');

  seedShop(DB);
  runSql(DB, `
    INSERT INTO public.products
      (id, name, category, price, stock, "variantStock", "reservedStock",
       active, sizes, colors)
    VALUES (31, 'Legacy Duplicate Tee', 'Tees', 100, 12,
       '{"S-Black": 7, "M-Black": 5, "S-White": 4}'::jsonb, 0, true,
       '["S","S","M","M"]'::jsonb, '["Black","Black"]'::jsonb);
  `);
  const dupOrder = lastJson(runSql(DB, placeSql(makeOrder({
    id: 'ORD-DUP-1',
    items: [{ productId: 31, qty: 1, size: 'S', color: 'Black', price: 100 }],
    subtotal: 100,
  }), null)).out);
  eq(dupOrder.ok, true, 'a legacy product with duplicated option lines can still be purchased');
  eq(scalarNum(DB, `SELECT stock FROM public.products WHERE id=31`), 11,
    'its recomputed stock is 12 − 1, not the inflated 24 − 1');
  eq(scalarNum(DB, `SELECT ("variantStock"->>'S-White')::int FROM public.products WHERE id=31`), 4,
    'the orphan colour stock is still untouched');
}
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
