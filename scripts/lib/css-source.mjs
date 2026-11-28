// Tests assert CSS guarantees against the original cascade order. After the
// route-specific split those rules live in several build inputs, so reassemble
// them in their original order from the generated manifest before asserting.
// Each span is checksummed: a CSS edit without `npm run css:split` fails loudly
// instead of silently making the tests inspect stale, shifted text.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const manifest = JSON.parse(readFileSync(new URL('css-order.json', import.meta.url), 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.spans)) {
  throw new Error('Unsupported CSS split manifest; run npm run css:split');
}

const original = readFileSync(new URL('css-original.css', import.meta.url), 'utf8');
if (sha(original) !== manifest.sourceSha256) {
  throw new Error('Pre-split CSS changed; run npm run css:split');
}

const cache = new Map();
function fileText(file) {
  if (!cache.has(file)) {
    const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    if (manifest.fileSha256?.[file] && sha(text) !== manifest.fileSha256[file]) {
      throw new Error(`${file} changed; run npm run css:split`);
    }
    cache.set(file, text);
  }
  return cache.get(file);
}

export function readCss() {
  return manifest.spans.map((span) => {
    const text = fileText(span.file).slice(span.start, span.end);
    if (sha(text) !== span.sha256) {
      throw new Error(`CSS drift in ${span.file} (rule ${span.key}); run npm run css:split`);
    }
    return text;
  }).join('\n');
}

export function readOriginalCss() {
  return original;
}
