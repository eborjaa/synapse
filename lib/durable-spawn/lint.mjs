// durable-spawn / lint.mjs
//
// Structural enforcement of the one rule that would have prevented the incident:
// an agent briefing/rule must NEVER instruct judging a spawned agent's liveness
// by the `.output` transcript's mtime/timestamp/staleness. Prose discipline is
// not enough (that IS how the incident happened) — this lint fails the build.
//
// A legitimate mention (e.g. the rule note explaining "never use mtime") can be
// exempted per-line with a trailing marker:  <!-- durable-spawn-lint:allow why -->

const ALLOW = /durable-spawn-lint:allow/;

// Token sources. NOTE: `\.output` must NOT carry a leading `\b` — a word
// boundary requires a word char before the position, but `.` is non-word, so
// `\b\.output` never matches ".output" after a space. Anchor it with a
// non-word-char lookbehind instead.
const TRANSCRIPT = "(?:(?<![\\w.])\\.output|\\btranscript\\b|\\bjsonl\\b)";
const TIME =
  "(?:\\bmtime\\b|\\blast[-\\s]?modified\\b|\\bmodif\\w*\\b|\\btimestamp\\b|\\bstale\\b|\\blast[-\\s]?updated\\b|\\bfile[-\\s]?time\\b)";
const LIVENESS =
  "(?:\\baliv\\w*\\b|\\bdead\\b|\\bdied\\b|\\bliven\\w*\\b|is\\s+(?:it\\s+)?(?:still\\s+)?running)";

// A near B, in either order, within 80 chars.
const near = (a, b) => new RegExp(`(?:${a}[^\\n]{0,80}${b})|(?:${b}[^\\n]{0,80}${a})`, "i");

// The anti-pattern: a transcript/output file's TIME used as a LIVENESS signal —
// either transcript-near-time, or a file-time-near-liveness phrasing.
const FORBIDDEN = [
  { id: "transcript-time-as-liveness", re: near(TRANSCRIPT, TIME) },
  { id: "file-time-decides-liveness", re: near(TIME, LIVENESS) },
];

/**
 * Scan text; return array of findings {lineNo, id, text}.
 * - YAML frontmatter (the leading `---`…`---` block) is skipped: provenance/
 *   purpose fields legitimately describe the incident, and a YAML line can't
 *   carry an HTML-comment allow marker.
 * - Individual body lines can be exempted with a trailing allow marker.
 * There is deliberately NO whole-file escape hatch: a file-level exemption would
 * silently disable the guard for exactly the file most likely to discuss the
 * anti-pattern (the rule note). Exemptions must be per-line and thus reviewable.
 */
export function scanText(text) {
  const findings = [];
  const lines = text.split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) start = close + 1; // skip frontmatter
  }
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (ALLOW.test(line)) continue;
    for (const p of FORBIDDEN) {
      if (p.re.test(line)) {
        findings.push({ lineNo: i + 1, id: p.id, text: line.trim().slice(0, 160) });
        break; // one finding per line is enough
      }
    }
  }
  return findings;
}
