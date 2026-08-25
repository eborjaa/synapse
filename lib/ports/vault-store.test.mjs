#!/usr/bin/env node
// vault-store.test.mjs — the contract test for VaultStorePort.
//
// One invariant carries this whole file: TWO VAULTS EXERCISED IN ONE PROCESS NEVER SHARE A HANDLE OR
// AN EPOCH. That is the precondition decision-0010 named for un-deferring multi-vault, and it is the
// thing that was NOT true before stage 4 — three module-level singletons decided a vault at import
// time, so under a shared process the first vault to touch a database owned it for everyone.
//
// These tests use a fake `open` rather than real SQLite on purpose: what is under test is the KEYING
// and the LIFETIME, not sqlite. A fake also lets us count opens, which is how "memoized per (vault,
// name)" is actually verified rather than assumed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultStorePort, vaultStoreAdapters, vaultStore } from "./vault-store.mjs";

const ADAPTERS = vaultStoreAdapters.all();

/** An opener that records every call, so "opened at most once" is checkable rather than assumed. */
function counter() {
  const opened = [];
  return { opened, open: (path) => { opened.push(path); return { path, id: opened.length }; } };
}

function vaults(n = 2) {
  const dirs = Array.from({ length: n }, () => mkdtempSync(join(tmpdir(), "syn-store-")));
  return { dirs, clean: () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); } };
}

test("every registered adapter satisfies VaultStorePort", () => {
  assert.ok(ADAPTERS.length > 0);
  for (const a of ADAPTERS) assert.doesNotThrow(() => VaultStorePort.assert(a));
});

for (const a of ADAPTERS) {
  test(`[${a.id}] two vaults NEVER share an epoch — the core invariant`, () => {
    const { dirs: [v1, v2], clean } = vaults();
    try {
      a._reset();
      assert.notEqual(a.epoch(v1), a.epoch(v2),
        "a shared epoch is exactly what makes staleSpawns report another vault's spawns as stale");
    } finally { a._reset(); clean(); }
  });

  test(`[${a.id}] one vault's epoch is STABLE across calls`, () => {
    const { dirs: [v], clean } = vaults(1);
    try {
      a._reset();
      // Stable, not fresh-per-call: minting per request is the other half of the decision-0010 failure.
      assert.equal(a.epoch(v), a.epoch(v));
    } finally { a._reset(); clean(); }
  });

  test(`[${a.id}] two vaults NEVER share a handle for the same logical database`, () => {
    const { dirs: [v1, v2], clean } = vaults();
    try {
      a._reset();
      const c = counter();
      const h1 = a.db(v1, { name: "episodes", open: c.open });
      const h2 = a.db(v2, { name: "episodes", open: c.open });
      assert.notEqual(h1, h2, "the first vault to touch the DB must not own it for every other vault");
      assert.equal(c.opened.length, 2, "each vault opens its own file");
      assert.ok(c.opened[0].startsWith(v1) && c.opened[1].startsWith(v2));
    } finally { a._reset(); clean(); }
  });

  test(`[${a.id}] one vault + one name is opened AT MOST ONCE`, () => {
    const { dirs: [v], clean } = vaults(1);
    try {
      a._reset();
      const c = counter();
      const first = a.db(v, { name: "episodes", open: c.open });
      const second = a.db(v, { name: "episodes", open: c.open });
      assert.equal(first, second, "the handle must be memoized");
      assert.equal(c.opened.length, 1, "a second call must not re-open the file");
    } finally { a._reset(); clean(); }
  });

  test(`[${a.id}] two logical databases in ONE vault stay separate`, () => {
    const { dirs: [v], clean } = vaults(1);
    try {
      a._reset();
      const c = counter();
      // durable-spawn is disposable runtime state; episodes is permanent memory. They must never be
      // collapsed into one handle just because they share a vault.
      const spawn = a.db(v, { name: "durable-spawn", open: c.open });
      const eps = a.db(v, { name: "episodes", open: c.open });
      assert.notEqual(spawn, eps);
      assert.equal(c.opened.length, 2);
    } finally { a._reset(); clean(); }
  });

  test(`[${a.id}] db() refuses to guess — a missing vault or opener is an error`, () => {
    const { dirs: [v], clean } = vaults(1);
    try {
      a._reset();
      assert.throws(() => a.db(null, { name: "x", open: () => ({}) }), /vault directory is required/);
      assert.throws(() => a.db(v, { name: "x" }), /`open\(path\)` function are required/);
      assert.throws(() => a.db(v, { open: () => ({}) }), /`name`/);
    } finally { a._reset(); clean(); }
  });

  test(`[${a.id}] the db file lands under the vault's own db/ directory`, () => {
    const { dirs: [v], clean } = vaults(1);
    try {
      a._reset();
      const c = counter();
      a.db(v, { name: "episodes", open: c.open });
      assert.equal(c.opened[0], join(v, "db", "episodes.db"));
    } finally { a._reset(); clean(); }
  });

  test(`[${a.id}] read() and list() are vault-scoped and tolerate absence`, () => {
    const { dirs: [v1, v2], clean } = vaults();
    try {
      mkdirSync(join(v1, "agents"), { recursive: true });
      writeFileSync(join(v1, "agents", "agent-a.md"), "hello");
      assert.equal(a.read(v1, "agents/agent-a.md"), "hello");
      assert.equal(a.read(v2, "agents/agent-a.md"), null, "one vault must not read another's file");
      assert.deepEqual(a.list(v1, "agents"), ["agent-a.md"]);
      assert.deepEqual(a.list(v2, "agents"), [], "an absent directory is not an error");
    } finally { clean(); }
  });

  test(`[${a.id}] _reset drops state for one vault without disturbing another`, () => {
    const { dirs: [v1, v2], clean } = vaults();
    try {
      a._reset();
      const e1 = a.epoch(v1), e2 = a.epoch(v2);
      a._reset(v1);
      assert.notEqual(a.epoch(v1), e1, "the reset vault gets fresh state");
      assert.equal(a.epoch(v2), e2, "the untouched vault keeps its state");
    } finally { a._reset(); clean(); }
  });
}

test("the store tracks one slot per vault, not one per process", () => {
  const { dirs: [v1, v2], clean } = vaults();
  try {
    vaultStore._reset();
    assert.equal(vaultStore._size(), 0);
    vaultStore.epoch(v1);
    vaultStore.epoch(v1);
    assert.equal(vaultStore._size(), 1, "touching one vault twice is still one slot");
    vaultStore.epoch(v2);
    assert.equal(vaultStore._size(), 2);
  } finally { vaultStore._reset(); clean(); }
});
