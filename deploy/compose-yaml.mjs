// compose-yaml.mjs — the smallest YAML that reads this repo's compose files.
//
// WHY hand-rolled. The package ships two runtime dependencies on purpose, and a YAML library for two
// test files is not worth a third. The subset here (2-space block maps, scalar lists, quote-aware
// comment stripping) covers both compose files completely.
//
// WHY strict. `parseStrict` throws on anything it does not understand rather than returning a partial
// tree. A parser that quietly dropped `ports:` would turn the most important assertion in either test
// — that nothing is published on a wildcard — into a vacuous pass.
//
// Shared by deploy/compose.test.mjs and deploy/standalone.test.mjs. One parser, or the two tests drift
// and the weaker one becomes the one that is true.

/** Strip a trailing `# comment`, but never one inside quotes (`"${BIND_ADDR}:8080:8080"`). */
export function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

export function scalar(raw) {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  return t;
}

export function parseStrict(text, label = "compose") {
  const lines = [];
  for (const raw of text.split("\n")) {
    const line = stripComment(raw).replace(/\s+$/, "");
    if (!line.trim()) continue;
    lines.push({ indent: line.match(/^ */)[0].length, body: line.trim() });
  }

  let i = 0;
  function block(indent) {
    if (lines[i].body.startsWith("- ")) {
      const arr = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].body.startsWith("- ")) {
        arr.push(scalar(lines[i++].body.slice(2)));
      }
      return arr;
    }
    const map = {};
    while (i < lines.length && lines[i].indent === indent) {
      const { body } = lines[i];
      const colon = body.indexOf(":");
      if (colon === -1) throw new Error(`${label}: cannot parse line "${body}"`);
      const key = body.slice(0, colon).trim();
      const rest = body.slice(colon + 1).trim();
      i++;
      if (rest !== "") map[key] = scalar(rest);
      else if (i < lines.length && lines[i].indent > indent) map[key] = block(lines[i].indent);
      else map[key] = null;
    }
    return map;
  }

  const out = block(0);
  if (i !== lines.length) throw new Error(`${label}: stopped at "${lines[i].body}"`);
  return out;
}
