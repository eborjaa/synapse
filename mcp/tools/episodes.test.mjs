// episodes.test.mjs — the episodic-memory MCP tools, driven directly (no server, no vault render).
//   node --experimental-sqlite --test mcp/tools/episodes.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VAULT = mkdtempSync(join(tmpdir(), "synapse-ep-mcp-"));
process.env.SYNAPSE_VAULT = VAULT;

const { registerEpisodeTools } = await import("./episodes.mjs");

const handlers = {};
registerEpisodeTools({ registerTool: (name, _s, fn) => { handlers[name] = fn; } });
const call = async (name, args) => JSON.parse((await handlers[name](args)).content[0].text);

test("both tools register on the read surface", () => {
  assert.ok(handlers.synapse_history, "history");
  assert.ok(handlers.synapse_log, "log");
});

test("an empty memory says UNKNOWN, not 'never happened'", async () => {
  const r = await call("synapse_history", { query: "something nobody logged" });
  assert.deepEqual(r.episodes, []);
  assert.match(r.note, /NOT that it was never/, "absence of a record is not evidence of absence");
});

test("log then recall by exact ticket id", async () => {
  const w = await call("synapse_log", {
    agent: "agent-debug-triager", hub: "moc-report",
    task: "triage REL-38837 report e2e failures",
    summary: "root cause = stale anchor in the grid POM; parked 2 specs",
    refs: ["PR#41", "spec-report-grid"],
  });
  assert.equal(w.recorded, true);
  assert.ok(w.episodeId);

  const r = await call("synapse_history", { query: "REL-38837" });
  assert.equal(r.count, 1);
  assert.match(r.episodes[0].summary, /stale anchor/);
  assert.deepEqual(r.episodes[0].refs, ["PR#41", "spec-report-grid"]);
  assert.equal(r.episodes[0].agent, "agent-debug-triager");
  assert.match(r.episodes[0].when, /^\d{4}-\d{2}-\d{2}T/, "timestamps come back human-readable");
});

test("filters narrow the recall", async () => {
  await call("synapse_log", { agent: "agent-spec-builder", hub: "moc-sensors", task: "migrate sensors specs", summary: "12 migrated" });
  await call("synapse_log", { agent: "agent-spec-builder", hub: "moc-sensors", task: "sensors flake hunt", summary: "none found", outcome: "failed" });

  assert.equal((await call("synapse_history", { hub: "moc-sensors" })).count, 2);
  assert.equal((await call("synapse_history", { outcome: "failed" })).count, 1);
  assert.equal((await call("synapse_history", { agent: "agent-debug-triager" })).count, 1);
});

test("a question with punctuation searches instead of erroring", async () => {
  const r = await call("synapse_history", { query: "did anyone already migrate the sensors specs?" });
  assert.ok(r.count >= 1);
});

test("recent-first, and sinceDays bounds the window", async () => {
  const r = await call("synapse_history", { sinceDays: 1, limit: 50 });
  assert.ok(r.count >= 3, "everything logged in this test run is inside a day");
  const stamps = r.episodes.map((e) => Date.parse(e.when));
  assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a), "newest first");
});
