#!/usr/bin/env node
/**
 * Validate the ZASHM OpenCode skill/agent pack.
 *
 *   node .opencode/scripts/validate-skills.mjs
 *
 * Checks the documented discovery contract:
 *   - .opencode/skills/<id>/SKILL.md with YAML frontmatter (name + description)
 *   - unique, kebab-case skill IDs
 *   - .opencode/agents/<id>.md with description + mode + permissions
 *   - .opencode/opencode.json parses and allows the skill tool
 *   - AGENTS.md references every skill and agent
 *
 * Read-only: it never writes or changes configuration.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let YAML = null;
try {
  YAML = require('yaml');
} catch {
  // Fallback: a tiny frontmatter reader for the fields we validate.
}

const root = new URL('../../', import.meta.url).pathname;
const skillsDir = join(root, '.opencode', 'skills');
const agentsDir = join(root, '.opencode', 'agents');

const EXPECTED_SKILLS = [
  'frontend-expert',
  'ui-ux-design',
  'supabase-database',
  'backend-api',
  'ecommerce-engineering',
  'security-auditing',
  'testing-qa',
  'seo-performance',
  'production-devops',
  'senior-code-review',
];

const EXPECTED_AGENTS = [
  'zashm-lead',
  'zashm-frontend',
  'zashm-backend',
  'zashm-security',
  'zashm-qa',
  'zashm-seo',
  'zashm-devops',
  'zashm-reviewer',
];

let pass = 0;
let fail = 0;
const ok = (label) => { pass += 1; console.log(`  ok  ${label}`); };
const bad = (label) => { fail += 1; console.log(`  FAIL ${label}`); };

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) return null;
  let data;
  if (YAML) {
    try {
      data = YAML.parse(match[1]);
    } catch (e) {
      return { error: e.message, body: match[2] };
    }
  } else {
    data = {};
    for (const line of match[1].split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (m) data[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return { data: data || {}, body: match[2] };
}

function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
}

console.log('\n[1] skills');
const seen = new Set();
for (const id of EXPECTED_SKILLS) {
  const file = join(skillsDir, id, 'SKILL.md');
  if (!existsSync(file)) { bad(`${id}: missing ${file}`); continue; }
  const parsed = frontmatter(readFileSync(file, 'utf8'));
  if (!parsed) { bad(`${id}: missing/invalid YAML frontmatter`); continue; }
  if (parsed.error) { bad(`${id}: YAML error: ${parsed.error}`); continue; }
  const { data, body } = parsed;
  if (typeof data.name !== 'string' || !data.name.trim()) bad(`${id}: frontmatter name`);
  else ok(`${id}: name = ${data.name}`);
  if (typeof data.description !== 'string' || data.description.trim().length < 40) {
    bad(`${id}: description is missing or too short`);
  } else ok(`${id}: description present (${data.description.length} chars)`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) bad(`${id}: ID is not kebab-case`);
  if (body.trim().length < 1500) bad(`${id}: body looks like an empty template (${body.trim().length} chars)`);
  else ok(`${id}: body has real instructions (${body.trim().length} chars)`);
  seen.add(id);
}

const extraDirs = listDirs(skillsDir).filter((id) => !EXPECTED_SKILLS.includes(id));
for (const id of extraDirs) bad(`unexpected skill directory: ${id}`);
ok(`exactly ${EXPECTED_SKILLS.length} expected skill directories (${seen.size} valid)`);

console.log('\n[2] agents');
for (const id of EXPECTED_AGENTS) {
  const file = join(agentsDir, `${id}.md`);
  if (!existsSync(file)) { bad(`${id}: missing ${file}`); continue; }
  const parsed = frontmatter(readFileSync(file, 'utf8'));
  if (!parsed) { bad(`${id}: missing/invalid YAML frontmatter`); continue; }
  if (parsed.error) { bad(`${id}: YAML error: ${parsed.error}`); continue; }
  const { data, body } = parsed;
  if (typeof data.description !== 'string' || data.description.trim().length < 20) {
    bad(`${id}: description is missing or too short`);
  } else ok(`${id}: description present`);
  if (!['primary', 'subagent', 'all'].includes(data.mode)) bad(`${id}: invalid mode ${data.mode}`);
  else ok(`${id}: mode = ${data.mode}`);
  if (!Array.isArray(data.permissions) || data.permissions.length === 0) {
    bad(`${id}: permissions list is missing`);
  } else ok(`${id}: ${data.permissions.length} permission rules`);
  if (body.trim().length < 800) bad(`${id}: system prompt looks like an empty template`);
  else ok(`${id}: system prompt has real instructions (${body.trim().length} chars)`);
}

const extraAgents = readdirSync(agentsDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))
  .filter((id) => !EXPECTED_AGENTS.includes(id));
for (const id of extraAgents) bad(`unexpected agent file: ${id}`);
ok(`exactly ${EXPECTED_AGENTS.length} expected agent files`);

console.log('\n[3] permissions and instructions');
{
  const configPath = join(root, '.opencode', 'opencode.json');
  if (!existsSync(configPath)) {
    bad('missing .opencode/opencode.json');
  } else {
    let config = null;
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
    catch (e) { bad(`opencode.json is not valid JSON: ${e.message}`); }
    if (config) {
      const allowSkill = (config.permissions || []).some(
        (r) => r.action === 'skill' && r.resource === '*' && r.effect === 'allow'
      );
      allowSkill ? ok('skill tool is allowed for *') : bad('no allow rule for the skill tool');
      const denyEnv = (config.permissions || []).some(
        (r) => r.action === 'edit' && r.resource === '.env*' && r.effect === 'deny'
      );
      denyEnv ? ok('.env* edits are denied') : bad('.env* edits are not denied');
    }
  }

  const agentsGuide = join(root, 'AGENTS.md');
  if (!existsSync(agentsGuide)) bad('missing AGENTS.md');
  else {
    const text = readFileSync(agentsGuide, 'utf8');
    const missingSkills = EXPECTED_SKILLS.filter((id) => !text.includes(id));
    const missingAgents = EXPECTED_AGENTS.filter((id) => !text.includes(id));
    missingSkills.length === 0
      ? ok('AGENTS.md documents all skills')
      : bad(`AGENTS.md is missing skills: ${missingSkills.join(', ')}`);
    missingAgents.length === 0
      ? ok('AGENTS.md documents all agents')
      : bad(`AGENTS.md is missing agents: ${missingAgents.join(', ')}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
