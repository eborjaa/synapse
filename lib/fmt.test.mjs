#!/usr/bin/env node
// fmt.test.mjs — the terminal formatting helpers.
//
// These are pure string functions on purpose, which is what makes them testable without capturing
// stdout. The tests that matter are the ones about WIDTH: the original output wrapped at whatever the
// terminal happened to be, so a narrow window broke sentences mid-word and a wide one ran to 200
// columns. Both are checked here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { wrap, row, sub, warnBlock, plural, termWidth, GLYPH, heading } from "./fmt.mjs";

test("wrap never breaks a word, and honours the indent on every line", () => {
  const lines = wrap("alpha beta gamma delta epsilon zeta eta theta", { indent: 4, width: 24 });
  assert.ok(lines.length > 1, "should have wrapped");
  for (const l of lines) {
    assert.ok(l.startsWith("    "), `every line indented: ${JSON.stringify(l)}`);
    assert.ok(l.length <= 24 || l.trim().split(" ").length === 1, `within width: ${JSON.stringify(l)}`);
  }
  assert.equal(lines.join(" ").replace(/\s+/g, " ").trim(), "alpha beta gamma delta epsilon zeta eta theta");
});

test("a word longer than the line is emitted whole — a path is more use intact than split", () => {
  const long = "/Users/someone/a/very/deeply/nested/path/that/exceeds/the/width/entirely";
  const lines = wrap(long, { indent: 2, width: 30 });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(long));
});

test("wrap is total — empty input still returns a line rather than nothing", () => {
  assert.deepEqual(wrap("", { indent: 2 }), ["  "]);
  assert.deepEqual(wrap("   ", { indent: 0 }), [""]);
});

test("termWidth is clamped, so neither a pipe nor a 200-column window breaks the layout", () => {
  const real = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const set = (v) => Object.defineProperty(process.stdout, "columns", { value: v, configurable: true });
  try {
    set(undefined); assert.equal(termWidth(), 80, "no TTY → a sane default");
    set(20);        assert.equal(termWidth(), 48, "never narrower than readable");
    set(400);       assert.equal(termWidth(), 100, "never runs to the full width of a huge window");
    set(72);        assert.equal(termWidth(), 72, "an ordinary width is used as-is");
  } finally {
    if (real) Object.defineProperty(process.stdout, "columns", real);
  }
});

test("rows align into a column so several read as a table", () => {
  const a = row(GLYPH.ok, "short", "detail");
  const b = row(GLYPH.ok, "a-much-longer-vault", "detail");
  assert.equal(a.indexOf("detail"), b.indexOf("detail"), "the detail column must line up");
});

test("a label longer than the column still renders, just wider", () => {
  const r = row(GLYPH.ok, "x".repeat(40), "detail");
  assert.ok(r.includes("detail"));
  assert.ok(r.includes("x".repeat(40)));
});

test("rows have no trailing whitespace when there is no detail", () => {
  const r = row(GLYPH.ok, "vault");
  assert.equal(r, r.trimEnd(), "trailing spaces show up as diff noise in logs and transcripts");
});

test("sub lines are indented past the label column", () => {
  assert.ok(sub("x").length > row(GLYPH.ok, "v", "").indexOf("v"));
  assert.ok(sub("x").startsWith(" "));
});

test("warnBlock puts the glyph on the FIRST line and indents the continuation", () => {
  // The whole point of the change: a warning belongs UNDER the row it is about, not before it.
  const lines = warnBlock(["a fairly long warning sentence that will certainly need to wrap at any sane width"], { indent: 6 });
  assert.ok(lines[0].includes(GLYPH.warn), "first line carries the glyph");
  assert.ok(lines.length > 1, "should wrap");
  for (const l of lines.slice(1)) {
    assert.ok(!l.includes(GLYPH.warn), "continuation lines must not repeat the glyph");
    assert.ok(l.startsWith("         "), "continuation aligns under the text, not the glyph");
  }
});

test("warnBlock renders one block per warning", () => {
  const lines = warnBlock(["first", "second"], { indent: 4 });
  assert.equal(lines.filter((l) => l.includes(GLYPH.warn)).length, 2);
});

test("plural says '1 vault', never '1 vault(s)'", () => {
  assert.equal(plural(1, "vault"), "1 vault");
  assert.equal(plural(4, "vault"), "4 vaults");
  assert.equal(plural(0, "vault"), "0 vaults");
  assert.equal(plural(2, "entry", "entries"), "2 entries");
});

test("heading opens with a blank line and underlines the title", () => {
  const [blank, title, rule] = heading("Vaults");
  assert.equal(blank, "");
  assert.equal(title, "Vaults");
  assert.ok(/^─+$/.test(rule));
});

test("every glyph is non-empty, so a row never renders a hole", () => {
  for (const [k, v] of Object.entries(GLYPH)) assert.ok(v && v.length, `${k} must have a glyph`);
});
