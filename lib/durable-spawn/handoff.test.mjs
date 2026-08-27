// handoff.test.mjs — HandoffPort against a real sqlite pair.
//
// The seven tests in SPEC-handoff-identity §7: #1–#6 are here; #7 greps mcp/tools/spawn.mjs
// (mcp/tools/spawn.test.mjs). These mutate handles, they do not review them.
//
//   node --experimental-sqlite --test lib/durable-spawn/handoff.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintHandle, parseHandle, HandoffPort } from "../ports/handoff.mjs";
import { createSqliteHandoff, openSpawnDb, openEpisodeDb } from "./handoff.mjs";
import { searchEpisodes, open as openEpisode } from "./episodes.mjs";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "syn-handoff-"));
  const db = openSpawnDb(join(dir, "durable-spawn.db"));
  const edb = openEpisodeDb(join(dir, "episodes.db"));
  const port = createSqliteHandoff({ db, edb, epoch: "test-epoch" });
  return {
    dir, db, edb, port,
    cleanup() { try { db.close(); } catch {} try { edb.close(); } catch {} rmSync(dir, { recursive: true, force: true }); },
  };
}

function oneCharOff(handle) {
  const alph = "0123456789abcdefghjkmnpqrstvwxyz";
  const last = handle[handle.length - 1];
  return handle.slice(0, -1) + alph[(alph.indexOf(last) + 1) % alph.length];
}

const CLAIM = { agent: "agent-oracle", task: "do the thing", ttlMs: 60_000 };

test("sqlite adapter satisfies HandoffPort", () => {
  const { port, cleanup } = setup();
  try { assert.doesNotThrow(() => HandoffPort.assert(port)); }
  finally { cleanup(); }
});

test("1. close() with a one-character-off handle → invalid-handle, row untouched", () => {
  const { port, edb, cleanup } = setup();
  try {
    const c = port.claim({ job: "oracle:BUG:typo:main", ...CLAIM, now: 1000 });
    assert.ok(c.handle);
    assert.equal(parseHandle(c.handle).ok, true);

    const bad = oneCharOff(c.handle);
    assert.notEqual(bad, c.handle);
    assert.equal(parseHandle(bad).reason, "invalid-handle");

    const r = port.close({ handle: bad, outcome: "done", summary: "must not land", now: 2000 });
    assert.equal(r.refused, "invalid-handle");
    assert.equal(r.closed, undefined);

    const open = port.openHandoffs({ now: 2000 });
    assert.equal(open.length, 1);
    assert.equal(open[0].handle, c.handle);
    const [ep] = searchEpisodes(edb, { job: "oracle:BUG:typo:main" });
    assert.equal(ep.outcome, "open");
    assert.equal(ep.summary, null);
    assert.equal(ep.endedAt, null);
  } finally { cleanup(); }
});

test("2. close() with a well-formed but unknown handle → unknown-handle", () => {
  const { port, cleanup } = setup();
  try {
    port.claim({ job: "oracle:BUG:unk:main", ...CLAIM, now: 1000 });
    const ghost = mintHandle();
    assert.equal(parseHandle(ghost).ok, true);
    const r = port.close({ handle: ghost, outcome: "done", summary: "x", now: 2000 });
    assert.equal(r.refused, "unknown-handle");
    assert.equal(port.openHandoffs({ now: 2000 }).length, 1, "the real handoff stays open");
  } finally { cleanup(); }
});

test("3. ticket expires, job re-claimed, old handle → superseded, new claim untouched", () => {
  const { port, edb, cleanup } = setup();
  try {
    const job = "oracle:BUG:super:main";
    const a = port.claim({ job, ...CLAIM, ttlMs: 1000, now: 1000 });
    const b = port.claim({ job, ...CLAIM, ttlMs: 1000, now: 3000 });
    assert.ok(b.handle);
    assert.notEqual(a.handle, b.handle);

    const r = port.close({ handle: a.handle, outcome: "done", summary: "old attempt", now: 4000 });
    assert.equal(r.refused, "superseded");

    const open = port.openHandoffs({ now: 4000 });
    assert.equal(open.length, 1);
    assert.equal(open[0].handle, b.handle);
    const [live] = searchEpisodes(edb, { job }).filter((e) => e.handle === b.handle);
    assert.equal(live.outcome, "open");
    assert.equal(live.summary, null);
  } finally { cleanup(); }
});

test("4. close() twice → already-closed, no duplicate, no lost summary", () => {
  const { port, edb, cleanup } = setup();
  try {
    const job = "oracle:BUG:idem:main";
    const c = port.claim({ job, ...CLAIM, now: 1000 });
    const first = port.close({ handle: c.handle, outcome: "done", summary: "keep this", refs: ["PR#1"], now: 2000 });
    assert.equal(first.closed, true);
    assert.equal(first.outcome, "done");

    const second = port.close({ handle: c.handle, outcome: "failed", summary: "must not overwrite", now: 3000 });
    assert.equal(second.refused, "already-closed");

    const all = searchEpisodes(edb, { job });
    assert.equal(all.length, 1);
    assert.equal(all[0].outcome, "done");
    assert.equal(all[0].summary, "keep this");
    assert.deepEqual(all[0].refs, ["PR#1"]);
  } finally { cleanup(); }
});

test("5. crash between ticket-close and logbook-close → sweep closes ended-unknown", () => {
  const { port, db, edb, cleanup } = setup();
  try {
    const job = "oracle:BUG:crash:main";
    const c = port.claim({ job, ...CLAIM, ttlMs: 5000, now: 1000 });
    // Simulate the original failure mode: ticket gone, logbook still open.
    db.prepare("DELETE FROM lease WHERE handle = ?").run(c.handle);
    db.prepare("UPDATE spawn SET state = 'done', updated_at = ? WHERE handle = ?").run(2000, c.handle);
    const [before] = searchEpisodes(edb, { job });
    assert.equal(before.outcome, "open");

    const swept = port.sweep({ now: 3000 });
    assert.equal(swept.length, 1);
    assert.equal(swept[0].job, job);
    assert.equal(swept[0].handle, c.handle);
    assert.equal(swept[0].outcome, "ended-unknown");

    const [after] = searchEpisodes(edb, { job });
    assert.equal(after.outcome, "ended-unknown");
    assert.ok(after.endedAt);
    assert.equal(port.openHandoffs({ now: 3000 }).length, 0);
  } finally { cleanup(); }
});

test("6. sweep is idempotent and never rewrites a properly closed entry", () => {
  const { port, edb, cleanup } = setup();
  try {
    const job = "oracle:BUG:sweep:main";
    const c = port.claim({ job, ...CLAIM, now: 1000 });
    port.close({ handle: c.handle, outcome: "done", summary: "final account", now: 2000 });
    const before = searchEpisodes(edb, { job })[0];

    assert.deepEqual(port.sweep({ now: 999_000 }), []);
    assert.deepEqual(port.sweep({ now: 999_000 }), []);

    const after = searchEpisodes(edb, { job })[0];
    assert.equal(after.outcome, "done");
    assert.equal(after.summary, "final account");
    assert.equal(after.endedAt, before.endedAt);
    assert.equal(after.closedAt, before.closedAt);
  } finally { cleanup(); }
});

test("pre-handle open rows with no live ticket are swept (the stranded-fixture path)", () => {
  const { port, edb, cleanup } = setup();
  try {
    // A row that looks like the synapse-vault fixture: open, no handle, no lease.
    const { episodeId } = openEpisode(edb, {
      agent: "agent-oracle",
      job: "user-profile-analysis:career:hub-career:v1",
      task: "analyze career",
    }, 1);
    edb.prepare("UPDATE episode SET handle = NULL WHERE episode_id = ?").run(episodeId);
    const swept = port.sweep({ now: 86_400_000 });
    assert.equal(swept.length, 1);
    assert.equal(swept[0].job, "user-profile-analysis:career:hub-career:v1");
    assert.equal(swept[0].outcome, "ended-unknown");
    assert.equal(searchEpisodes(edb, { job: "user-profile-analysis:career:hub-career:v1" })[0].outcome, "ended-unknown");
  } finally { cleanup(); }
});
