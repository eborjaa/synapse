// durable-spawn / lint.test.mjs
// Run: node --experimental-sqlite --test src/tools/durable-spawn/lint.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { scanText } from "./lint.mjs";

test("flags the incident anti-pattern: judging liveness by .output mtime", () => {
  const bad = "Check if the agent is alive by reading its .output file mtime.";
  const f = scanText(bad);
  assert.equal(f.length, 1);
  assert.equal(f[0].lineNo, 1);
});

test("flags transcript-timestamp-as-liveness phrasings", () => {
  assert.equal(scanText("If the transcript timestamp is stale, the doer died.").length, 1);
  assert.equal(scanText("The .output was last-modified minutes ago, so it looks stale.").length, 1);
  assert.equal(scanText("Use the jsonl last-modified time to tell if it is still running.").length, 1);
});

test("does NOT flag the sanctioned protocol prose", () => {
  const good = [
    "The doer heartbeats HEARTBEAT/WAITING lines to a dedicated status file.",
    "Liveness is decided only by the harness task-notification or an expired lease.",
    "Monitor the status file for per-substep progress.",
  ].join("\n");
  assert.deepEqual(scanText(good), []);
});

test("respects a per-line allow marker (for the rule note's own explanation)", () => {
  const line =
    "Never judge liveness by the .output mtime — it buffers and freezes. <!-- durable-spawn-lint:allow explains the ban -->";
  assert.deepEqual(scanText(line), []);
});

test("skips YAML frontmatter (incident descriptions in provenance/purpose)", () => {
  const note = [
    "---",
    "id: rule-x",
    'provenance: ["qa-lead judged the doer dead by its .output mtime staleness"]',
    "---",
    "Body: the doer heartbeats to a status file.",
  ].join("\n");
  assert.deepEqual(scanText(note), []);
});

test("there is NO whole-file escape hatch (a stray allow-file marker does not exempt)", () => {
  const note = [
    "<!-- durable-spawn-lint:allow-file canonical -->",
    "Never judge liveness by the .output mtime staleness.", // still flagged
  ].join("\n");
  assert.equal(scanText(note).length, 1, "the bad line is still caught");
});

test("multiple offending lines are all reported", () => {
  const text = [
    "line ok",
    "the .output mtime tells you it is dead",
    "another ok line",
    "is it alive? check the transcript last-modified time",
  ].join("\n");
  const f = scanText(text);
  assert.deepEqual(f.map((x) => x.lineNo), [2, 4]);
});
