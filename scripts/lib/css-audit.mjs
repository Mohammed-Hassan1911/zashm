// Small shared helpers for proving that the generated CSS split preserves the
// original rule set. Comments are blanked (not removed) so offsets and line
// shapes stay predictable for callers that still need the raw source.
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

export function ruleHeads(css) {
  const clean = stripComments(css);
  const heads = [];
  let start = 0;
  for (let i = 0; i < clean.length; i += 1) {
    if (clean[i] === '{') {
      const head = clean.slice(start, i).trim().replace(/\s+/g, ' ');
      if (head && !head.startsWith('@')) heads.push(head);
      start = i + 1;
    } else if (clean[i] === '}') {
      start = i + 1;
    }
  }
  return heads;
}

export function declarations(css) {
  return (stripComments(css).match(/[^{};]+:[^{};]+;/g) || [])
    .map((decl) => decl.trim().replace(/\s+/g, ' '));
}

export function importantDeclarations(css) {
  return declarations(css).filter((decl) => /!important/.test(decl));
}

export function sameMultiset(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}
