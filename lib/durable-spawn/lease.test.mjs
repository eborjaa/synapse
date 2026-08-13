// durable-spawn / lease.test.mjs
// Run: node --experimental-sqlite --test src/tools/durable-spawn/lease.test.mjs
//
// Deterministic: `now` is injected everywhere, so expiry needs no real waiting.
// Self-contained: each test opens a fresh temp DB and deletes it after.

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { openDb, isLive, acquire, renew, release, validateFence, withFence } from "./lease.mjs";

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "durable-spawn-lease-"));
  const db = openDb(join(dir, "ds.db"));
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const TTL = 60_000;

test("acquire on a free job succeeds and tokens are monotonic", () => {
  withDb((db) => {
    const a = acquire(db, "jobA", "orch-1", TTL, 1000);
    assert.equal(a.ok, true);
    const b = acquire(db, "jobB", "orch-1", TTL, 1000);
    assert.equal(b.ok, true);
    assert.ok(b.token > a.token, "tokens strictly increase across jobs");
  });
});

test("a live lease blocks a different owner (the dedup gate)", () => {
  withDb((db) => {
    const a = acquire(db, "J", "doer-1", TTL, 1000);
    assert.equal(a.ok, true);
    const b = acquire(db, "J", "doer-2", TTL, 5000); // still within TTL
    assert.equal(b.ok, false);
    assert.equal(b.reason, "held");
    assert.equal(b.holder, "doer-1");
  });
});

test("F-A: a live lease is refused for the SAME owner too (extend via renew, not acquire)", () => {
  withDb((db) => {
    const a = acquire(db, "J", "doer-1", TTL, 1000);
    const dup = acquire(db, "J", "doer-1", TTL, 2000); // same owner, still live
    assert.equal(dup.ok, false, "a second acquire for a live job must be refused, even same-owner");
    assert.equal(dup.reason, "held");
    // the holder extends its OWN lease with renew (token required) — token stays valid
    assert.equal(renew(db, "J", "doer-1", a.token, 2000).ok, true);
    assert.deepEqual(validateFence(db, "J", a.token, 3000), { ok: true });
  });
});

test("withFence applies a same-DB mutation only under a valid fence (atomic, no TOCTOU)", () => {
  withDb((db) => {
    db.exec("CREATE TABLE r(n INTEGER); INSERT INTO r VALUES(0);");
    const bump = (d) => d.prepare("UPDATE r SET n = n + 1").run();
    const n = () => db.prepare("SELECT n FROM r").get().n;
    const a = acquire(db, "J", "doer-1", TTL, 1000);
    assert.equal(withFence(db, "J", a.token, bump, 1000).ok, true);
    assert.equal(n(), 1);
    assert.equal(withFence(db, "J", a.token - 1, bump, 1000).ok, false, "stale token → no write");
    assert.equal(n(), 1);
    assert.equal(withFence(db, "J", a.token, bump, 1000 + TTL + 1).ok, false, "expired → no write");
    assert.equal(n(), 1);
  });
});

test("F-B: validateFence with no now uses the DB clock, not a caller-supplied one", () => {
  withDb((db) => {
    const a = acquire(db, "J", "doer-1", TTL, 1000); // 'acquired' at epoch=1000 (ancient)
    // a zombie feeding its own stale clock would pass its expired lease off as live:
    assert.equal(validateFence(db, "J", a.token, 2000).ok, true);
    // but with now omitted, the DB clock (real ~now) sees it long expired:
    const r = validateFence(db, "J", a.token);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "lease-expired");
  });
});

test("validateFence accepts current+live, rejects stale, rejects expired-current", () => {
  withDb((db) => {
    const a = acquire(db, "J", "doer-1", TTL, 1000);
    assert.deepEqual(validateFence(db, "J", a.token, 2000), { ok: true });
    const stale = validateFence(db, "J", a.token - 1, 2000);
    assert.equal(stale.reason, "stale-token");
    // REVIEW F1: current token but the lease has EXPIRED and no one re-leased yet.
    // Must be rejected — a zombie cannot write just because no takeover happened.
    const expired = validateFence(db, "J", a.token, 1000 + TTL + 1);
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, "lease-expired");
  });
});

test("renew succeeds for a live holder; fails when expired; fails after takeover", () => {
  withDb((db) => {
    const a = acquire(db, "J", "doer-1", TTL, 1000);
    assert.equal(renew(db, "J", "doer-1", a.token, 2000).ok, true);
    // REVIEW F2: renew on an expired lease must NOT revive it.
    const rev = renew(db, "J", "doer-1", a.token, 2000 + TTL + 1);
    assert.equal(rev.ok, false);
    assert.equal(rev.reason, "expired");
    // after a legitimate takeover, the old holder is 'lost'
    const b = acquire(db, "J", "doer-2", TTL, 100_000);
    assert.equal(b.ok, true);
    assert.equal(renew(db, "J", "doer-1", a.token, 101_000).reason, "lost");
  });
});

test("INFO: a holder that lost its token cannot reclaim a live lease (fail-closed, waits TTL)", () => {
  // A tokenless caller is indistinguishable from a duplicate, so it is refused
  // until the TTL lapses. Intended liveness cost, documented so it is not a surprise.
  withDb((db) => {
    acquire(db, "J", "doer-1", TTL, 1000);
    assert.equal(acquire(db, "J", "doer-1", TTL, 2000).reason, "held"); // re-acquire refused
    assert.equal(renew(db, "J", "doer-1", 999999, 2000).reason, "lost"); // wrong token
    assert.equal(acquire(db, "J", "doer-1", TTL, 1000 + TTL + 1).ok, true); // fresh after TTL
  });
});

test("release frees the job for another owner", () => {
  withDb((db) => {
    const a = acquire(db, "J", "doer-1", TTL, 1000);
    assert.equal(release(db, "J", "doer-1", a.token).ok, true);
    const b = acquire(db, "J", "doer-2", TTL, 1500);
    assert.equal(b.ok, true);
  });
});

test("ZOMBIE: a presumed-dead holder cannot write after its job is re-leased", () => {
  withDb((db) => {
    const A = acquire(db, "rt01:hierarchy-dedup", "doer-A", TTL, 1000);
    assert.equal(A.ok, true);
    const now = 1000 + TTL + 1;
    assert.equal(isLive({ renewed_at: 1000, ttl_ms: TTL }, now), false);
    const B = acquire(db, "rt01:hierarchy-dedup", "doer-B", TTL, now);
    assert.equal(B.ok, true);
    assert.ok(B.token > A.token, "takeover mints a strictly higher token");
    const zombie = validateFence(db, "rt01:hierarchy-dedup", A.token, now);
    assert.equal(zombie.reason, "stale-token");
    assert.deepEqual(validateFence(db, "rt01:hierarchy-dedup", B.token, now), { ok: true });
  });
});

test("an expired lease is takeable by a new owner", () => {
  withDb((db) => {
    acquire(db, "J", "doer-1", TTL, 1000);
    const b = acquire(db, "J", "doer-2", TTL, 1000 + TTL + 1);
    assert.equal(b.ok, true);
  });
});

test("ttlMs <= 0 is rejected (cannot silently disable the dedup gate)", () => {
  withDb((db) => {
    assert.equal(acquire(db, "J", "doer-1", 0, 1000).reason, "bad-ttl");
    assert.equal(acquire(db, "J", "doer-1", -5, 1000).reason, "bad-ttl");
    // and a real lease is not somehow bypassable by a 0-ttl acquirer
    acquire(db, "J", "doer-1", TTL, 1000);
    assert.equal(acquire(db, "J", "doer-2", 0, 2000).reason, "bad-ttl");
    assert.deepEqual(validateFence(db, "J", 1, 2000), { ok: true });
  });
});
