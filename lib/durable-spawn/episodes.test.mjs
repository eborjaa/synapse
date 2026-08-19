// episodes.test.mjs — episodic memory: write on claim, close on release, recall by keyword.
//
//   node --experimental-sqlite --test lib/durable-spawn/episodes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./lease.mjs";
import { migrate, open, close, log, searchEpisodes, lastForJob, reindex } from "./episodes.mjs";

function db() {
  const dir = mkdtempSync(join(tmpdir(), "syn-ep-"));
  const d = migrate(openDb(join(dir, "durable-spawn.db")));
  return { d, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("an episode opens at CLAIM time, so interrupted work is still remembered", () => {
  const { d, cleanup } = db();
  try {
    const { episodeId } = open(d, { agent: "agent-qa-lead", job: "spec-builder:REL-1:sensors", task: "fix the sensors grid spec" });
    const [e] = searchEpisodes(d, { job: "spec-builder:REL-1:sensors" });
    assert.equal(e.episodeId, episodeId);
    assert.equal(e.outcome, "open", "still running — recorded before it finished");
    assert.equal(e.endedAt, null);
  } finally { cleanup(); }
});

test("closing records the outcome and the summary a future agent actually needs", () => {
  const { d, cleanup } = db();
  try {
    const { episodeId } = open(d, { agent: "agent-spec-builder", job: "j1", task: "migrate the report suite" });
    close(d, { episodeId, outcome: "done", summary: "migrated 12 specs; 2 parked on REL-38837", refs: ["PR#41", "spec-report-grid"] });
    const [e] = searchEpisodes(d, { job: "j1" });
    assert.equal(e.outcome, "done");
    assert.match(e.summary, /12 specs/);
    assert.deepEqual(e.refs, ["PR#41", "spec-report-grid"]);
    assert.ok(e.endedAt >= e.startedAt);
  } finally { cleanup(); }
});

test("close by job when the caller kept no episode id", () => {
  const { d, cleanup } = db();
  try {
    open(d, { job: "j2", task: "triage nightly" });
    const r = close(d, { job: "j2", outcome: "failed", summary: "env was down" });
    assert.equal(r.ok, true);
    assert.equal(searchEpisodes(d, { job: "j2" })[0].outcome, "failed");
  } finally { cleanup(); }
});

test("closing twice updates rather than errors (doer and orchestrator can both report)", () => {
  const { d, cleanup } = db();
  try {
    const { episodeId } = open(d, { job: "j3", task: "run the alerts suite" });
    close(d, { episodeId, outcome: "done", summary: "doer's own line" });
    close(d, { episodeId, outcome: "done", summary: "orchestrator's fuller account" });
    const all = searchEpisodes(d, { job: "j3" });
    assert.equal(all.length, 1, "one episode, not two");
    assert.equal(all[0].summary, "orchestrator's fuller account");
  } finally { cleanup(); }
});

test("closing an unknown episode is reported, never thrown", () => {
  const { d, cleanup } = db();
  try {
    assert.deepEqual(close(d, { job: "never-existed" }), { ok: false, reason: "no-such-episode" });
  } finally { cleanup(); }
});

// The whole point: an exact token (a ticket id) must be findable. This is why retrieval is keyword
// and not cosine — "REL-38837" is the query a human or agent actually types.
test("keyword recall finds an exact ticket id inside the task text", () => {
  const { d, cleanup } = db();
  try {
    log(d, { agent: "agent-debug-triager", task: "triage REL-38837 report e2e failures", summary: "root cause: stale anchor" });
    log(d, { agent: "agent-debug-triager", task: "triage REL-99999 alerts flake", summary: "unrelated" });
    const hits = searchEpisodes(d, { query: "REL-38837" });
    assert.equal(hits.length, 1);
    assert.match(hits[0].summary, /stale anchor/);
  } finally { cleanup(); }
});

test("keyword recall reaches into the SUMMARY, not just the task", () => {
  const { d, cleanup } = db();
  try {
    log(d, { task: "weekly sweep", summary: "parked the protection-loops spec pending a fixture" });
    assert.equal(searchEpisodes(d, { query: "protection-loops" }).length, 1);
  } finally { cleanup(); }
});

test("punctuation in a query is tokenised, not a syntax error", () => {
  const { d, cleanup } = db();
  try {
    log(d, { task: "fix rel-sanity park sensors", summary: "done" });
    for (const q of ["what about rel-sanity?", "sensors!!", "(park)"]) {
      assert.doesNotThrow(() => searchEpisodes(d, { query: q }));
    }
    assert.ok(searchEpisodes(d, { query: "did we already park sensors?" }).length >= 1);
  } finally { cleanup(); }
});

test("filters compose: agent + hub + outcome + since", () => {
  const { d, cleanup } = db();
  try {
    log(d, { agent: "a1", hub: "moc-sensors", task: "t1", outcome: "done" }, 1000);
    log(d, { agent: "a1", hub: "moc-report", task: "t2", outcome: "done" }, 2000);
    log(d, { agent: "a2", hub: "moc-sensors", task: "t3", outcome: "failed" }, 3000);
    assert.equal(searchEpisodes(d, { agent: "a1" }).length, 2);
    assert.equal(searchEpisodes(d, { hub: "moc-sensors" }).length, 2);
    assert.equal(searchEpisodes(d, { outcome: "failed" }).length, 1);
    assert.equal(searchEpisodes(d, { since: 2000 }).length, 2);
    assert.equal(searchEpisodes(d, { agent: "a1", hub: "moc-sensors" }).length, 1);
  } finally { cleanup(); }
});

// Historical dedup — the extension of the in-flight lease. The lease refuses a job running NOW;
// this answers "was this already done last week, and what came of it?"
test("lastForJob answers 'has this exact work been done before'", () => {
  const { d, cleanup } = db();
  try {
    assert.equal(lastForJob(d, "spec-builder:REL-5:report"), null);
    log(d, { job: "spec-builder:REL-5:report", task: "migrate report specs", summary: "done, PR#7" }, 1000);
    log(d, { job: "spec-builder:REL-5:report", task: "migrate report specs again", summary: "re-run after rebase" }, 2000);
    const last = lastForJob(d, "spec-builder:REL-5:report");
    assert.match(last.summary, /re-run after rebase/, "the MOST RECENT attempt wins");
  } finally { cleanup(); }
});

test("results are newest-first when there is no query to rank by", () => {
  const { d, cleanup } = db();
  try {
    log(d, { task: "older" }, 1000);
    log(d, { task: "newer" }, 2000);
    assert.equal(searchEpisodes(d, {})[0].task, "newer");
  } finally { cleanup(); }
});

test("an episode with no task is refused — a log entry that records nothing is worse than none", () => {
  const { d, cleanup } = db();
  try {
    assert.throws(() => open(d, { task: "" }), /task is required/);
  } finally { cleanup(); }
});

test("reindex rebuilds search from the episode table", () => {
  const { d, cleanup } = db();
  try {
    log(d, { task: "sensors grid regression", summary: "fixed" });
    d.exec("INSERT INTO episode_fts(episode_fts) VALUES('delete-all');");
    assert.equal(searchEpisodes(d, { query: "sensors" }).length, 0, "index deliberately corrupted");
    assert.equal(reindex(d), 1);
    assert.equal(searchEpisodes(d, { query: "sensors" }).length, 1, "recovered");
  } finally { cleanup(); }
});

test("episodes survive reopening the database (they are primary data, not a cache)", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-ep-p-"));
  try {
    const p = join(dir, "durable-spawn.db");
    const a = migrate(openDb(p));
    log(a, { job: "j9", task: "persist me", summary: "kept" });
    a.close();
    const b = migrate(openDb(p));
    assert.equal(searchEpisodes(b, { query: "persist" }).length, 1);
    b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
