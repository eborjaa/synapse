// durable-spawn / registry.test.mjs
// Run: node --experimental-sqlite --test src/tools/durable-spawn/registry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { openDb } from "./lease.mjs";
import { migrate, record, markState, get, listByState, staleSpawns } from "./registry.mjs";

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "durable-spawn-reg-"));
  const db = migrate(openDb(join(dir, "ds.db")));
  try { fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("record then get returns a running spawn", () => {
  withDb((db) => {
    record(db, { spawnId: "s1", job: "J", owner: "orch-1", epoch: "boot-1", token: 7 }, 100);
    const s = get(db, "s1");
    assert.equal(s.state, "running");
    assert.equal(s.token, 7);
    assert.equal(s.epoch, "boot-1");
  });
});

test("record requires an epoch", () => {
  withDb((db) => {
    assert.throws(() => record(db, { spawnId: "s1", job: "J", owner: "o" }, 100), /epoch/);
  });
});

test("markState reaches terminal; terminal cannot be un-finished", () => {
  withDb((db) => {
    record(db, { spawnId: "s1", job: "J", owner: "o", epoch: "boot-1" }, 100);
    assert.equal(markState(db, "s1", "done", 200).ok, true);
    assert.equal(get(db, "s1").state, "done");
    // REVIEW: a terminal spawn must not be resurrected to running
    const back = markState(db, "s1", "running", 300);
    assert.equal(back.ok, false);
    assert.equal(back.reason, "terminal-locked");
    assert.deepEqual(markState(db, "nope", "done", 200), { ok: false, reason: "unknown-spawn" });
    assert.deepEqual(markState(db, "s1", "weird", 200), { ok: false, reason: "bad-state" });
  });
});

test("record does not resurrect a terminal spawn (same id re-recorded)", () => {
  withDb((db) => {
    record(db, { spawnId: "s1", job: "J", owner: "o", epoch: "boot-1" }, 100);
    markState(db, "s1", "failed", 150);
    record(db, { spawnId: "s1", job: "J", owner: "o", epoch: "boot-1" }, 200);
    assert.equal(get(db, "s1").state, "failed", "terminal state is sticky against re-record");
  });
});

test("staleSpawns keys on epoch, so a REUSED owner id across restart is still caught", () => {
  withDb((db) => {
    // previous incarnation (boot-1) left two running spawns; one finished
    record(db, { spawnId: "s1", job: "J1", owner: "orch", epoch: "boot-1" }, 100);
    record(db, { spawnId: "s2", job: "J2", owner: "orch", epoch: "boot-1" }, 100);
    markState(db, "s2", "done", 150);
    // restart: SAME owner id, NEW epoch, spawns its own job
    record(db, { spawnId: "s3", job: "J3", owner: "orch", epoch: "boot-2" }, 200);

    const stale = staleSpawns(db, "boot-2");
    assert.deepEqual(stale.map((s) => s.spawn_id), ["s1"]); // s2 finished, s3 is current epoch
  });
});
