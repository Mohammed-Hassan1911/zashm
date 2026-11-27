#!/usr/bin/env node
// Label the artifact produced by `npm run build:production:ci`. CI deliberately
// builds with a public preparation anon-key placeholder, so that directory is
// for isolation tests only. The marker makes that status machine-readable and
// `npm run artifact:assert-deployable` refuses any artifact carrying it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = process.env.ZASHM_BUILD_DIR || 'build-production';
const marker = resolve(ROOT, BUILD_DIR, 'CI_ONLY_DO_NOT_DEPLOY');

mkdirSync(dirname(marker), { recursive: true });
writeFileSync(marker, [
  'CI-ONLY ARTIFACT — DO NOT DEPLOY',
  '',
  'Built by npm run build:production:ci with a public anon-key placeholder.',
  'It exists only to keep the production-isolation tests offline and honest.',
  'Deploy only from a build made with the real public Supabase configuration,',
  'after `npm run artifact:assert-deployable` succeeds.',
  '',
].join('\n'), 'utf8');

console.log(`marked ${BUILD_DIR} as CI-only: CI_ONLY_DO_NOT_DEPLOY`);
