/**
 * CI-only artifact gate.
 *
 * CI builds with a public anon-key placeholder so the production-isolation
 * suite stays offline. This suite proves that artifact is labelled as
 * non-deployable and that the pre-deploy gate refuses it.
 *
 *   node scripts/test-ci-artifact-gate.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARK_SCRIPT = resolve(ROOT, 'scripts/mark-ci-artifact.mjs');
const GATE_SCRIPT = resolve(ROOT, 'scripts/assert-deployable-artifact.mjs');

let pass = 0;
let fail = 0;
function ok(condition, label, detail = '') {
  if (condition) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label,
    `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function read(name) {
  return readFileSync(resolve(ROOT, name), 'utf8');
}
function run(script, buildDir) {
  return spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ZASHM_BUILD_DIR: buildDir },
  });
}

console.log('\n[1] build wiring marks the CI artifact');
{
  const pkg = JSON.parse(read('package.json'));
  const ciBuild = pkg.scripts['build:production:ci'];
  ok(ciBuild.includes('scripts/mark-ci-artifact.mjs'), 'the CI build labels its artifact');
  ok(ciBuild.includes('ZASHM_CATALOGUE_SNAPSHOT=config/catalogue-snapshot.json'),
    'the CI build prerenders products from the reviewed public snapshot');
  ok(pkg.scripts['artifact:assert-deployable'].includes('scripts/assert-deployable-artifact.mjs'),
    'a dedicated script runs the pre-deploy gate');
  ok(pkg.scripts.build.includes('ZASHM_BUILD_DIR=build node scripts/assert-deployable-artifact.mjs'),
    'the standard deployable build gates itself before it can be published');
  ok(pkg.scripts.test.includes('scripts/test-ci-artifact-gate.mjs'), 'this suite runs in npm test');
  const workflow = read('.github/workflows/ci.yml');
  ok(workflow.includes('npm run build:production:ci'),
    'CI still generates the isolated artifact');
  ok(workflow.includes('npm run build'),
    'CI runs the self-gating standard build as well');
}

console.log('\n[2] marker and gate behaviour');
{
  const mark = readFileSync(MARK_SCRIPT, 'utf8');
  const gate = readFileSync(GATE_SCRIPT, 'utf8');
  ok(mark.includes('CI_ONLY_DO_NOT_DEPLOY'), 'the marker name is explicit');
  ok(mark.includes('ZASHM_BUILD_DIR'), 'the marker honours a custom build directory');
  ok(gate.includes("process.exit(1)"), 'the gate fails closed');
  ok(gate.includes('PREP_ANON_KEY_NOT_A_REAL_CREDENTIAL'), 'the gate rejects the anon placeholder');
  ok(gate.includes('CI_ONLY_DO_NOT_DEPLOY'), 'the gate rejects the CI marker');

  const dir = mkdtempSync(resolve(ROOT, '.tmp-zashm-ci-gate-'));
  try {
    writeFileSync(resolve(dir, 'index.html'), '<html><body>ZASHM</body></html>', 'utf8');

    const marked = run(MARK_SCRIPT, dir);
    eq(marked.status, 0, 'the marker script succeeds');
    ok(existsSync(resolve(dir, 'CI_ONLY_DO_NOT_DEPLOY')), 'the marker file is written');
    const blocked = run(GATE_SCRIPT, dir);
    ok(blocked.status !== 0, 'the pre-deploy gate blocks the CI artifact');
    ok(blocked.stderr.includes('CI-only'), 'the failure reason is explicit');

    rmSync(resolve(dir, 'CI_ONLY_DO_NOT_DEPLOY'), { force: true });
    writeFileSync(resolve(dir, 'asset.js'), 'const anon = "PREP_ANON_KEY_NOT_A_REAL_CREDENTIAL";', 'utf8');
    const placeholderBlocked = run(GATE_SCRIPT, dir);
    ok(placeholderBlocked.status !== 0, 'the gate blocks an artifact with the placeholder key');
    ok(placeholderBlocked.stderr.includes('placeholder'), 'the placeholder reason is explicit');

    rmSync(resolve(dir, 'asset.js'), { force: true });
    const ready = run(GATE_SCRIPT, dir);
    eq(ready.status, 0, 'a clean artifact passes the gate');
    ok(ready.stdout.includes('READY TO DEPLOY'), 'the success message is explicit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
