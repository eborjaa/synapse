#!/usr/bin/env node
// fmt.mjs — terminal output helpers, so every synapse command reads the same way.
//
// WHY THIS EXISTS. `synapse vaults sync` and `vaults roster` grew their output one `console.log` at a
// time, and it showed: warnings were interleaved between the rows they belonged to, long sentences
// wrapped mid-word at whatever width the terminal happened to be, and four vaults' results ran together
// as one wall with no separation. Reading it meant reconstructing the structure by eye. The information
// was all there and none of it was scannable.
//
// The rules this file encodes:
//   • a GLYPH carries status, so state is legible before any word is read
//   • WARNINGS are grouped under the row they belong to, never interleaved between rows
//   • long prose WRAPS at the real terminal width, indented to its own column
//   • blocks are separated by BLANK LINES — the cheapest structure there is
//
// Glyphs are plain Unicode, not colour: a pipe, a log file and a CI transcript all keep them, and
// nothing here has to detect whether stdout is a TTY to stay correct.
//
// Zero dependencies. Pure — every function returns a string or an array of strings; printing is the
// caller's job, which keeps these testable without capturing stdout.

/** The terminal's width, clamped to something sane for pipes and very wide windows. */
export function termWidth() {
  const w = Number(process.stdout?.columns) || 0;
  if (!w) return 80;                    // piped, redirected, or no TTY
  return Math.max(48, Math.min(w, 100)); // never wrap narrower than readable, never run to 200 cols
}

/** Status glyphs. One column wide in every terminal that matters, and meaningful in monochrome. */
export const GLYPH = {
  ok: "✅",       // nothing to do — already correct
  change: "✏️",   // would change (dry-run)
  wrote: "💾",    // changed on disk
  warn: "⚠️",     // worth reading, not a failure
  error: "❌",    // failed or missing
  skip: "⏭️",     // deliberately not touched
  info: "•",
  arrow: "→",
};

/**
 * Wrap `text` to the terminal width, indenting every line (including the first) by `indent` spaces.
 * Words longer than the available width are emitted whole rather than broken — a path is more useful
 * intact than split across two lines.
 */
export function wrap(text, { indent = 0, width = termWidth() } = {}) {
  const pad = " ".repeat(indent);
  const room = Math.max(20, width - indent);
  const out = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (!line) { line = word; continue; }
    if (line.length + 1 + word.length <= room) { line += ` ${word}`; continue; }
    out.push(pad + line);
    line = word;
  }
  if (line) out.push(pad + line);
  return out.length ? out : [pad];
}

/** A section heading with a rule under it, returned as lines. */
export function heading(text, { width = termWidth() } = {}) {
  return ["", text, "─".repeat(Math.min(width, Math.max(text.length, 24)))];
}

/**
 * One status row: a glyph, a padded label, and a trailing detail.
 * The label column is fixed so several rows line up into a scannable table.
 */
export function row(glyph, label, detail = "", { labelWidth = 20 } = {}) {
  const l = String(label);
  const padded = l.length >= labelWidth ? l : l + " ".repeat(labelWidth - l.length);
  return `  ${glyph}  ${padded}  ${detail}`.trimEnd();
}

/** A continuation line under a row — aligned past the glyph and label columns. */
export function sub(detail, { labelWidth = 20 } = {}) {
  return `${" ".repeat(labelWidth + 7)}${detail}`;
}

/**
 * Render a row's warnings as an indented, wrapped block beneath it.
 *
 * Grouping under the row is the whole point: previously a vault's warnings were printed BEFORE its
 * result line, so a reader met three paragraphs of explanation before learning which vault they were
 * about. Same words, opposite order, and it is the difference between skimmable and not.
 */
export function warnBlock(warnings, { indent = 6 } = {}) {
  const out = [];
  for (const w of warnings) {
    const lines = wrap(w, { indent: indent + 3 });
    out.push(`${" ".repeat(indent)}${GLYPH.warn} ${lines[0].trimStart()}`);
    for (const rest of lines.slice(1)) out.push(rest);
  }
  return out;
}

/** "4 vaults" / "1 vault" — because "1 vault(s)" is the mark of output nobody re-read. */
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
