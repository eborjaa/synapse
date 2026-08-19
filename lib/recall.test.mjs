// recall.test.mjs — the topic-shift top-up. Trigger matching is deterministic (no Ollama); semantic
// hits degrade to a skip note when no index/model is present, so these tests assert the DETERMINISTIC
// halves and the gate, and tolerate the semantic layer being unavailable in CI.
//   node --experimental-sqlite --test lib/recall.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { triggeredRules, recall } from "./recall.mjs";

const M = { logLabel: "synapse", vaultRoot: ".", skipDirs: ["inbox"] };
function note(id, type, fm = "", body = "body-" + id) {
  return `---\nid: ${id}\ntype: ${type}\ntitle: ${id}\n${fm}---\n${body}\n`;
}
function vault(files) {
  const root = mkdtempSync(join(tmpdir(), "syn-recall-"));
  mkdirSync(join(root, "_meta", "tools"), { recursive: true });
  writeFileSync(join(root, "_meta", "tools", "context.manifest.json"), JSON.stringify(M));
  for (const [rel, c] of Object.entries(files)) {
    const p = join(root, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, c);
  }
  return { ctx: { root, vaultDir: root, manifest: M }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("triggeredRules fires on a task that names the situation", () => {
  const v = vault({
    "docs/doc-zephyr.md": note("doc-zephyr", "doc", 'on_demand: true\ntrigger: "before posting a Zephyr execution comment"\n'),
    "docs/doc-pr.md": note("doc-pr", "doc", 'on_demand: true\ntrigger: "before commenting on a GitHub pull request"\n'),
  });
  try {
    const r = triggeredRules(v.ctx, "I need to post the Zephyr execution results for this cycle");
    assert.equal(r.length >= 1, true);
    assert.equal(r[0].id, "doc-zephyr", "the Zephyr trigger ranks first for a Zephyr task");
  } finally { v.cleanup(); }
});

test("triggeredRules does NOT fire on an unrelated task (the gate holds)", () => {
  const v = vault({
    "docs/doc-zephyr.md": note("doc-zephyr", "doc", 'on_demand: true\ntrigger: "before posting a Zephyr execution comment"\n'),
  });
  try {
    assert.deepEqual(triggeredRules(v.ctx, "what is 2 plus 2"), []);
  } finally { v.cleanup(); }
});

test("only on_demand notes are considered — an ordinary rule never triggers", () => {
  const v = vault({
    "rules/rule-normal.md": note("rule-normal", "rule", "", "always applies, carried in the briefing"),
  });
  try {
    assert.deepEqual(triggeredRules(v.ctx, "rule normal applies"), []);
  } finally { v.cleanup(); }
});

test("punctuation and question form don't break matching", () => {
  const v = vault({
    "docs/doc-zephyr.md": note("doc-zephyr", "doc", 'on_demand: true\ntrigger: "before writing a Zephyr comment"\n'),
  });
  try {
    assert.equal(triggeredRules(v.ctx, "how do I write the Zephyr comment??").length, 1);
  } finally { v.cleanup(); }
});

test("the GATE: recall on an empty/irrelevant task says 'nothing new', invents nothing", async () => {
  const v = vault({
    "docs/doc-zephyr.md": note("doc-zephyr", "doc", 'on_demand: true\ntrigger: "before posting a Zephyr execution comment"\n'),
  });
  try {
    const r = await recall({ vault: v.ctx, task: "completely unrelated arithmetic" });
    assert.equal(r.applicableRules.length, 0);
    assert.match(r.guidance, /Nothing new/);
  } finally { v.cleanup(); }
});

test("recall surfaces an applicable rule + says fetch it before acting", async () => {
  const v = vault({
    "docs/doc-zephyr.md": note("doc-zephyr", "doc", 'on_demand: true\ntrigger: "before posting a Zephyr execution comment"\n'),
  });
  try {
    const r = await recall({ vault: v.ctx, task: "post the Zephyr execution comment now" });
    assert.equal(r.applicableRules[0].id, "doc-zephyr");
    assert.match(r.guidance, /Fetch any applicable rule/);
  } finally { v.cleanup(); }
});

test("recall folds in prior episodes via the injected episodesFn (no durable-spawn coupling)", async () => {
  const v = vault({});
  try {
    const episodesFn = (task) => task.includes("sensors")
      ? [{ when: "2026-08-10", outcome: "done", summary: "already migrated the sensors grid" }] : [];
    const r = await recall({ vault: v.ctx, task: "work on the sensors grid", episodesFn });
    assert.equal(r.priorWork.length, 1);
    assert.match(r.priorWork[0].summary, /already migrated/);
    assert.doesNotMatch(r.guidance, /Nothing new/, "prior work alone makes the turn non-empty");
  } finally { v.cleanup(); }
});

test("semantic layer degrades to a skip note when there is no index — never throws", async () => {
  const v = vault({ "notes/note-x.md": note("note-x", "note") });
  try {
    const r = await recall({ vault: v.ctx, task: "anything" });
    assert.equal(r.hits.length, 0);
    assert.match(r.semanticSkipped, /no index|note_vectors|sqlite/);
  } finally { v.cleanup(); }
});
