// core-lock.test.mjs — the singleton lock, including the two ways a bare pid lies.
//
// The recycled-pid case here is not hypothetical. A hard-killed synapse-core container leaves the file
// behind; the restarted core is handed a low pid from a fresh namespace and frequently the SAME one it
// is reading out of the file. Signalling it finds "itself", the start is refused, and the container
// crash-loops until a retry happens to land on a different pid. Observed in the stack before the fix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireCoreLock, classifyLock, coreLockPath, reapForeignHostLock,
  CORE_LOCK_FOREIGN, CORE_LOCK_HELD,
} from "./core-lock.mjs";

const home = (tag) => mkdtempSync(join(tmpdir(), `syn-core-${tag}-`));
const plant = (dir, record) => writeFileSync(coreLockPath(dir), `${JSON.stringify(record)}\n`);

test("a second live holder against the same home is refused", () => {
  const dir = home("lock");
  try {
    const a = acquireCoreLock(dir);
    assert.equal(coreLockPath(dir), join(dir, "synapse-core.lock"));
    assert.throws(() => acquireCoreLock(dir), new RegExp(CORE_LOCK_HELD));
    a.release();
    const b = acquireCoreLock(dir);
    b.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a leftover lock whose pid is dead is stolen, not a permanent outage", () => {
  const dir = home("stale");
  try {
    plant(dir, { pid: 999999, host: hostname(), startedAt: "x" });
    const lock = acquireCoreLock(dir);
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two homes can each hold a lock", () => {
  const a = home("a");
  const b = home("b");
  try {
    const first = acquireCoreLock(a);
    const second = acquireCoreLock(b);
    first.release();
    second.release();
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("the lock records WHO wrote it, not just a bare pid", () => {
  const dir = home("record");
  try {
    const lock = acquireCoreLock(dir);
    const record = JSON.parse(readFileSync(coreLockPath(dir), "utf8"));
    assert.equal(record.pid, process.pid);
    assert.equal(record.host, hostname());
    assert.ok(Date.parse(record.startedAt), "startedAt must be a real timestamp");
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RECYCLED PID: a dead holder that happens to share our pid is stale, not alive", () => {
  const dir = home("recycled");
  try {
    // Exactly what a restarted container reads: same host, our own pid, written by a process that is
    // gone. kill(pid, 0) would find US and report "alive" — the crash loop.
    plant(dir, { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() });
    const lock = acquireCoreLock(dir);
    assert.equal(
      JSON.parse(readFileSync(coreLockPath(dir), "utf8")).startedAt !== undefined,
      true,
      "the restarted core must take the lock, not refuse itself",
    );
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("...but a lock this process REALLY holds is still held, pid coincidence or not", () => {
  const dir = home("mine");
  try {
    const lock = acquireCoreLock(dir);
    // Same record shape as the recycled case above. The only thing separating them is that this
    // process actually took this path, which is why the held-set exists.
    assert.throws(() => acquireCoreLock(dir), new RegExp(CORE_LOCK_HELD));
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FOREIGN NAMESPACE: an unverifiable lock is refused, never silently stolen", () => {
  const dir = home("foreign");
  try {
    // Two containers each have a pid 7. Trusting kill(7,0) here would let this process steal a lock a
    // live core in another namespace holds — two writers on a single-writer DB.
    plant(dir, { pid: process.pid, host: "some-other-container", startedAt: new Date().toISOString() });
    assert.throws(() => acquireCoreLock(dir), new RegExp(CORE_LOCK_FOREIGN));
    assert.ok(existsSync(coreLockPath(dir)), "a refused acquire must leave the foreign lock intact");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pre-format lock with no host is read as local, so an upgrade is not an outage", () => {
  const dir = home("legacy");
  try {
    plant(dir, { pid: 999999, startedAt: "x" });
    const lock = acquireCoreLock(dir);
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reapForeignHostLock clears ONLY a foreign record — the deployment-scoped escape hatch", () => {
  const dir = home("reap");
  try {
    plant(dir, { pid: 4321, host: "gone-container", startedAt: "2026-08-25T00:00:00.000Z" });
    const cleared = reapForeignHostLock(dir);
    assert.equal(cleared.host, "gone-container");
    assert.equal(existsSync(coreLockPath(dir)), false);

    // A live LOCAL holder is not the case this hatch is for, and must survive it.
    const lock = acquireCoreLock(dir);
    assert.equal(reapForeignHostLock(dir), null, "our own live lock is never reaped");
    assert.ok(existsSync(coreLockPath(dir)));
    lock.release();
    assert.equal(reapForeignHostLock(dir), null, "nothing to clear is not an error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyLock states the whole decision table in one place", () => {
  const here = hostname();
  const at = (existing, overrides) => classifyLock(existing, { host: here, pid: 100, ...overrides }).state;

  assert.equal(at(null), "stale", "an unreadable record cannot be a live holder");
  assert.equal(at({ pid: "nope", host: here }), "stale");
  assert.equal(at({ pid: 100, host: here }), "stale", "our own pid, not ours to hold → recycled");
  assert.equal(at({ pid: 100, host: "elsewhere" }), "foreign");
  assert.equal(at({ pid: 999999, host: here }), "stale", "a dead local pid is stealable");
  assert.equal(at({ pid: process.pid, host: here }, { pid: 100 }), "held", "a live local pid is not");
});
