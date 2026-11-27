#!/usr/bin/env node
// Fail-closed pre-deploy gate. CI builds carry a machine-readable marker and a
// preparation anon-key placeholder; neither may ever reach a Worker release.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = process.env.ZASHM_BUILD_DIR || 'build-production';
const ABSOLUTE = resolve(ROOT, BUILD_DIR);
const MARKER = 'CI_ONLY_DO_NOT_DEPLOY';
const PLACEHOLDER = 'PREP_ANON_KEY_NOT_A_REAL_CREDENTIAL';
const TEXT_FILE = /\.(html|js|mjs|css|json|txt|svg|map|xml|webmanifest)$|^\/?_headers$/;

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

const problems = [];
if (!existsSync(join(ABSOLUTE, 'index.html'))) {
  problems.push(`${BUILD_DIR}/index.html is missing`);
}
if (existsSync(join(ABSOLUTE, MARKER))) {
  problems.push(`${BUILD_DIR}/${MARKER} is present: this artifact is CI-only`);
}
if (existsSync(ABSOLUTE)) {
  for (const file of walk(ABSOLUTE)) {
    if (!TEXT_FILE.test(file.slice(ABSOLUTE.length + 1))) continue;
    if (readFileSync(file, 'utf8').includes(PLACEHOLDER)) {
      problems.push(`public anon-key placeholder found in ${file.slice(ABSOLUTE.length + 1)}`);
    }
  }
}

if (problems.length) {
  console.error(`NOT READY TO DEPLOY: ${problems.length} problem(s)`);
  for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`READY TO DEPLOY: ${BUILD_DIR} has no CI marker or anon-key placeholder`);
