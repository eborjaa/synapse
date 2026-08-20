// note-as-task.test.mjs — the "boot an agent FROM a handover" primitive.
//   node --test lib/note-as-task.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNoteRef, taskFromNote, noteAsTask } from "./note-as-task.mjs";

function vault() {
  const root = mkdtempSync(join(tmpdir(), "syn-h-"));
  const put = (rel, c) => { const p = join(root, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, c); };
  put("inbox/handovers/2026-08-19-qa-lead-cases.md", "---\nid: h1\ntype: journal\ntitle: Cases handover\n---\n# Cases\nfinish the suite\n");
  put("inbox/handovers/README.md", "# handovers\n");
  put("journal/2026-08-19-ci-baked-image.md", "---\nid: h2\ntype: journal\ntitle: CI image\n---\n# CI\nbake the image\n");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("resolves a note by a VAULT-RELATIVE path — even in a skipDir like journal/", () => {
  const v = vault();
  try {
    const r = resolveNoteRef("journal/2026-08-19-ci-baked-image.md", { vaultDir: v.root });
    assert.equal(r.status, "unique");
    assert.match(r.path, /journal\/2026-08-19-ci-baked-image\.md$/);
  } finally { v.cleanup(); }
});

test("resolves a handover by fuzzy slug inside inbox/handovers/", () => {
  const v = vault();
  try {
    const r = resolveNoteRef("cases", { vaultDir: v.root });
    assert.equal(r.status, "unique");
    assert.match(r.path, /qa-lead-cases\.md$/);
  } finally { v.cleanup(); }
});

test("an ambiguous slug is reported, not guessed", () => {
  const v = vault();
  try {
    // both handovers share the date prefix
    writeFileSync(join(v.root, "inbox/handovers/2026-08-19-other-thing.md"), "---\ntype: journal\n---\nx\n");
    const r = resolveNoteRef("2026-08-19", { vaultDir: v.root });
    assert.equal(r.status, "ambiguous");
    assert.ok(r.matches.length >= 2);
  } finally { v.cleanup(); }
});

test("a missing ref is 'none', never a throw", () => {
  const v = vault();
  try {
    assert.equal(resolveNoteRef("nothing-like-this", { vaultDir: v.root }).status, "none");
  } finally { v.cleanup(); }
});

test("taskFromNote strips frontmatter and prepends the successor protocol for a handover", () => {
  const v = vault();
  try {
    const path = join(v.root, "journal/2026-08-19-ci-baked-image.md");
    const t = taskFromNote(path, { vaultDir: v.root, handover: true });
    assert.doesNotMatch(t, /^---/, "frontmatter stripped");
    assert.doesNotMatch(t, /id: h2/, "no frontmatter leaked");
    assert.match(t, /Continue from the handover note `journal\/2026-08-19-ci-baked-image\.md`/);
    assert.match(t, /do NOT re-litigate/);
    assert.match(t, /bake the image/, "the body survives");
  } finally { v.cleanup(); }
});

test("--plain (handover:false) is the raw body, no protocol", () => {
  const v = vault();
  try {
    const path = join(v.root, "journal/2026-08-19-ci-baked-image.md");
    const t = taskFromNote(path, { vaultDir: v.root, handover: false });
    assert.doesNotMatch(t, /Continue from the handover/);
    assert.match(t, /bake the image/);
  } finally { v.cleanup(); }
});

test("noteAsTask: one call, ref → { ok, task }", () => {
  const v = vault();
  try {
    const r = noteAsTask("cases", { vaultDir: v.root, handover: true });
    assert.equal(r.ok, true);
    assert.match(r.task, /finish the suite/);
    const miss = noteAsTask("does-not-exist", { vaultDir: v.root, handover: true });
    assert.equal(miss.ok, false);
    assert.match(miss.reason, /not found/);
  } finally { v.cleanup(); }
});
