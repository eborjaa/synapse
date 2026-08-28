// vault-pool.test.mjs — the per-vault process pool, with a fake child so nothing is spawned.
//
// The behaviours worth pinning are the ones whose failure is invisible: two sessions racing onto one
// vault must not produce two children (two writers against a single-writer DB), a dead child must not
// be handed out again, and a released child must not linger forever holding ~85 MB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createVaultPool } from "./vault-pool.mjs";

/** A stand-in for a spawned synapse-mcp, recording how many times it was created. */
function fakeSpawner({ delayMs = 0 } = {}) {
  const spawns = [];
  const exits = [];
  const spawnChild = async ({ vaultRoot }) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const handlers = new Set();
    const child = {
      vaultRoot,
      closed: false,
      client: { id: `client:${vaultRoot}:${spawns.length}` },
      onExit(fn) { handlers.add(fn); },
      async close() { child.closed = true; },
      die() { for (const fn of handlers) fn(); },
    };
    spawns.push(child);
    exits.push(child.die);
    return child;
  };
  return { spawnChild, spawns };
}

const dir = (tag) => mkdtempSync(join(tmpdir(), `syn-pool-${tag}-`));

test("one vault means one child, however many sessions hold it", async () => {
  const v = dir("one");
  const { spawnChild, spawns } = fakeSpawner();
  const pool = createVaultPool({ spawnChild, idleMs: 0 });
  try {
    const a = await pool.acquire(v);
    const b = await pool.acquire(v);
    assert.equal(spawns.length, 1, "the second session reuses the first child");
    assert.equal(a.client, b.client);
    a.release(); b.release();
  } finally {
    await pool.disposeAll();
    rmSync(v, { recursive: true, force: true });
  }
});

test("two sessions starting AT ONCE do not race two children onto one vault", async () => {
  const v = dir("race");
  // A slow spawn is what exposes the race: store the settled client and both callers spawn.
  const { spawnChild, spawns } = fakeSpawner({ delayMs: 25 });
  const pool = createVaultPool({ spawnChild, idleMs: 0 });
  try {
    const [a, b] = await Promise.all([pool.acquire(v), pool.acquire(v)]);
    assert.equal(spawns.length, 1, "two writers against one vault DB is the failure this prevents");
    assert.equal(a.client, b.client);
    a.release(); b.release();
  } finally {
    await pool.disposeAll();
    rmSync(v, { recursive: true, force: true });
  }
});

test("different vaults get different children", async () => {
  const a = dir("a");
  const b = dir("b");
  const { spawnChild, spawns } = fakeSpawner();
  const pool = createVaultPool({ spawnChild, idleMs: 0 });
  try {
    const first = await pool.acquire(a);
    const second = await pool.acquire(b);
    assert.equal(spawns.length, 2);
    assert.notEqual(first.client, second.client);
    assert.equal(pool.size, 2);
    first.release(); second.release();
  } finally {
    await pool.disposeAll();
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("a child that dies is dropped, and the next use respawns", async () => {
  const v = dir("die");
  const { spawnChild, spawns } = fakeSpawner();
  const pool = createVaultPool({ spawnChild, idleMs: 0 });
  try {
    const first = await pool.acquire(v);
    first.release();
    spawns[0].die();
    assert.equal(pool.size, 0, "a dead child must not keep its slot");

    const second = await pool.acquire(v);
    assert.equal(spawns.length, 2, "handing back a client whose transport is gone is the bug here");
    assert.notEqual(second.client, first.client);
    second.release();
  } finally {
    await pool.disposeAll();
    rmSync(v, { recursive: true, force: true });
  }
});

test("an idle child is evicted; a held one is not", async () => {
  const v = dir("idle");
  const { spawnChild, spawns } = fakeSpawner();
  const pool = createVaultPool({ spawnChild, idleMs: 20 });
  try {
    const held = await pool.acquire(v);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(pool.size, 1, "a child in use must never be evicted out from under a session");
    assert.equal(spawns[0].closed, false);

    held.release();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(pool.size, 0, "~85 MB per vault is worth returning when nothing is using it");
    assert.equal(spawns[0].closed, true);
  } finally {
    await pool.disposeAll();
    rmSync(v, { recursive: true, force: true });
  }
});

test("a failed spawn does not poison the vault's slot", async () => {
  const v = dir("fail");
  let attempts = 0;
  const spawnChild = async ({ vaultRoot }) => {
    attempts += 1;
    if (attempts === 1) throw new Error("boom");
    return {
      client: { id: "recovered" },
      onExit() {},
      async close() {},
      vaultRoot,
    };
  };
  const pool = createVaultPool({ spawnChild, idleMs: 0 });
  try {
    await assert.rejects(pool.acquire(v), /boom/);
    assert.equal(pool.size, 0, "a failed spawn must not leave a slot that never resolves");
    const ok = await pool.acquire(v);
    assert.equal(ok.client.id, "recovered");
    ok.release();
  } finally {
    await pool.disposeAll();
    rmSync(v, { recursive: true, force: true });
  }
});

test("release is idempotent and disposeAll closes everything", async () => {
  const a = dir("d1");
  const b = dir("d2");
  const { spawnChild, spawns } = fakeSpawner();
  const pool = createVaultPool({ spawnChild, idleMs: 0 });
  const first = await pool.acquire(a);
  const second = await pool.acquire(b);
  try {
    first.release();
    first.release();   // a double release must not drop someone else's reference
    const again = await pool.acquire(a);
    assert.equal(spawns.length, 2, "the double release must not have evicted a live child");
    again.release();
  } finally {
    second.release();
    await pool.disposeAll();
    assert.equal(pool.size, 0);
    assert.ok(spawns.every((s) => s.closed), "disposal must leave no child behind");
    await assert.rejects(pool.acquire(a), /disposed/);
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("http transport refuses an unregistered folder before opening a socket", async () => {
  const home = mkdtempSync(join(tmpdir(), "syn-http-home-"));
  const v = mkdtempSync(join(tmpdir(), "syn-http-unknown-"));
  const prevHome = process.env.SYNAPSE_HOME;
  const prevSkills = process.env.SYNAPSE_SKILLS_ROOT;
  process.env.SYNAPSE_HOME = home;
  delete process.env.SYNAPSE_SKILLS_ROOT;
  const pool = createVaultPool({
    httpUrl: "http://127.0.0.1:9/mcp",
    token: "syn_test",
    idleMs: 0,
  });
  try {
    await assert.rejects(pool.acquire(v), /no registered vault id/);
  } finally {
    await pool.disposeAll();
    if (prevHome === undefined) delete process.env.SYNAPSE_HOME; else process.env.SYNAPSE_HOME = prevHome;
    if (prevSkills === undefined) delete process.env.SYNAPSE_SKILLS_ROOT;
    else process.env.SYNAPSE_SKILLS_ROOT = prevSkills;
    rmSync(home, { recursive: true, force: true });
    rmSync(v, { recursive: true, force: true });
  }
});

test("http transport refuses to talk to core without a bearer", async () => {
  const home = mkdtempSync(join(tmpdir(), "syn-http-tok-home-"));
  const skills = mkdtempSync(join(tmpdir(), "syn-http-tok-skills-"));
  const v = mkdtempSync(join(tmpdir(), "syn-http-tok-v-"));
  const prevHome = process.env.SYNAPSE_HOME;
  const prevSkills = process.env.SYNAPSE_SKILLS_ROOT;
  process.env.SYNAPSE_HOME = home;
  process.env.SYNAPSE_SKILLS_ROOT = skills;
  writeFileSync(join(skills, "index.json"), `${JSON.stringify({
    version: 1,
    vaults: [{ id: "tok-v", root: v, vaultDir: v }],
  })}\n`);
  const pool = createVaultPool({
    httpUrl: "http://127.0.0.1:9/mcp",
    token: "",
    idleMs: 0,
  });
  try {
    await assert.rejects(pool.acquire(v), /SYNAPSE_MCP_TOKEN is empty/);
  } finally {
    await pool.disposeAll();
    if (prevHome === undefined) delete process.env.SYNAPSE_HOME; else process.env.SYNAPSE_HOME = prevHome;
    if (prevSkills === undefined) delete process.env.SYNAPSE_SKILLS_ROOT;
    else process.env.SYNAPSE_SKILLS_ROOT = prevSkills;
    rmSync(home, { recursive: true, force: true });
    rmSync(skills, { recursive: true, force: true });
    rmSync(v, { recursive: true, force: true });
  }
});

test("LIVE: the real spawner starts a Synapse child bound to one vault", async () => {
  // Everything above uses a fake child, so this is the only test that exercises defaultSpawnChild:
  // the argv, the cwd/env binding, the handshake, and that the child is reachable afterwards.
  const home = mkdtempSync(join(tmpdir(), "syn-live-home-"));
  const v = mkdtempSync(join(tmpdir(), "syn-live-vault-"));
  const prevHome = process.env.SYNAPSE_HOME;
  process.env.SYNAPSE_HOME = home;
  mkdirSync(join(v, "_meta", "tools"), { recursive: true });
  mkdirSync(join(v, "agents"), { recursive: true });
  writeFileSync(join(v, "_meta", "tools", "context.manifest.json"), JSON.stringify({
    repo: "live", logLabel: "live", vaultRoot: ".", skipDirs: [], targetTypes: ["hub"],
    roles: { NAVIGATES: { field: "related", direction: "forward", endpointTypes: ["hub"] } },
    referenceRoles: [],
    profiles: { lean: { roles: [], depth: {} }, standard: { roles: [], depth: {} }, fat: { roles: [], depth: {} } },
    tokenBudgets: { lean: 4000, standard: 15000, fat: 30000 },
    excerptChars: { lean: 40, standard: 4000, fat: 0 },
    typePriority: ["agent", "hub"], trailers: { canary: false }, invariants: [],
  }));
  writeFileSync(join(v, "agents", "agent-live-only.md"),
    '---\nid: agent-live-only\ntype: agent\ntitle: "live"\npurpose: "p"\n'
    + "addressable: true\nautonomous: false\ntags:\n  - type/agent\n---\n\n# live\n");

  const pool = createVaultPool({ idleMs: 0, surface: "standard" });
  try {
    const lease = await pool.acquire(v);
    const listed = await lease.client.listTools();
    const names = (listed.tools || []).map((t) => t.name);
    assert.ok(names.includes("synapse_list_agents"), `expected synapse tools, got ${names.join(", ")}`);

    // The binding is structural: the child was pointed at this vault by cwd and env, so it can only
    // answer from it. Proven by asking for something only this vault contains.
    const answer = await lease.client.callTool({ name: "synapse_list_agents", arguments: {} });
    const text = JSON.stringify(answer?.content || "");
    assert.match(text, /agent-live-only/, "the child must answer from the vault it was launched in");

    lease.release();
  } finally {
    await pool.disposeAll();
    if (prevHome === undefined) delete process.env.SYNAPSE_HOME; else process.env.SYNAPSE_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(v, { recursive: true, force: true });
  }
});
