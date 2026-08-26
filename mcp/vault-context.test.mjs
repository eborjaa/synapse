// vault-context.test.mjs — Epic 1's acceptance tests: a request carries its own vault.
//
// These are the executable form of three user stories, and each name says which:
//
//   US-1.1  one running Synapse answers for whichever vault the request is for
//   US-1.2  nothing changes for the existing stdio setup
//   US-1.3  two vaults in one process share NOTHING — no handle, no epoch, no cached briefing
//
// Everything here runs in ONE process against TWO temp vaults, offline. That is the whole point: the
// bug this file guards against cannot be reproduced with one vault per process, which is exactly why
// it survived until an HTTP transport was on the table.
//
//   node --experimental-sqlite --test mcp/vault-context.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createVaultContext, envPinnedContext } from "./vault-context.mjs";
import { buildServer } from "./build-server.mjs";
import { registerSkeletonTools } from "./tools/agents.mjs";
import { registerEpisodeTools } from "./tools/episodes.mjs";
import { registerSpawnTools } from "./tools/spawn.mjs";
import { vaultStore } from "../lib/ports/vault-store.mjs";

const MANIFEST = {
  repo: "t", logLabel: "synapse", vaultRoot: ".", skipDirs: ["node_modules", "inbox"],
  roles: {
    CONSTRAINS: { field: "applies_rules", direction: "forward", mandatoryFull: true },
    USES: { field: ["invokes_skills", "uses_tools"], direction: "forward" },
    NAVIGATES: { field: "related", direction: "forward", endpointTypes: ["hub", "moc"] },
  },
  profiles: { lean: { roles: [], depth: {} }, standard: { roles: [], depth: {} }, fat: { roles: [], depth: {} } },
  tokenBudgets: { lean: 4000, standard: 15000, fat: 30000 },
  excerptChars: { lean: 40, standard: 4000, fat: 0 },
  typePriority: ["agent", "hub"], trailers: { canary: false }, invariants: [],
};

const note = (id, type, extra = "") =>
  `---\nid: ${id}\ntype: ${type}\ntitle: ${id}\npurpose: purpose of ${id}\n${extra}---\nbody of ${id}\n`;

/** A throwaway vault whose contents are unique to it, so a cross-vault read is unmistakable. */
function makeVault(tag) {
  const dir = mkdtempSync(join(tmpdir(), `synapse-ctx-${tag}-`));
  const put = (rel, c) => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
  put("_meta/tools/context.manifest.json", JSON.stringify(MANIFEST));
  put(`agents/agent-${tag}-only.md`, note(`agent-${tag}-only`, "agent"));
  put(`hub-${tag}-only.md`, note(`hub-${tag}-only`, "hub"));
  put("inbox/handovers/handover-" + tag + ".md", `# handover ${tag}\n`);
  return { dir, tag, ctx: createVaultContext({ root: dir, vaultDir: dir, manifest: MANIFEST }) };
}

/** Register a surface's tools over one bound vault and return a name → handler map. */
function toolsFor(vault, register = registerSkeletonTools) {
  const H = {};
  register({ registerTool: (n, _s, fn) => { H[n] = fn; } }, vault);
  return H;
}
const textOf = async (fn, args = {}) => (await fn(args)).content[0].text;
const jsonOf = async (fn, args = {}) => JSON.parse(await textOf(fn, args));

// ─── US-1.1 — one process, two vaults, each answering for itself ──────────────

test("US-1.1: two vaults in ONE process each answer from their own vault, with no leakage either way",
  async () => {
    const a = makeVault("alpha");
    const b = makeVault("bravo");
    try {
      const A = toolsFor(a.ctx);
      const B = toolsFor(b.ctx);

      const agentsA = await textOf(A.synapse_list_agents);
      const agentsB = await textOf(B.synapse_list_agents);

      // Each sees its own…
      assert.match(agentsA, /agent-alpha-only/);
      assert.match(agentsB, /agent-bravo-only/);
      // …and NEITHER sees the other's. Both directions, because a one-way check passes even when the
      // first vault to load wins — which is precisely the bug.
      assert.doesNotMatch(agentsA, /bravo/);
      assert.doesNotMatch(agentsB, /alpha/);

      const hubsA = await textOf(A.synapse_list_hubs);
      const hubsB = await textOf(B.synapse_list_hubs);
      assert.match(hubsA, /hub-alpha-only/);
      assert.match(hubsB, /hub-bravo-only/);
      assert.doesNotMatch(hubsA, /bravo/);
      assert.doesNotMatch(hubsB, /alpha/);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

test("US-1.1: interleaving requests does not let the FIRST vault touched win", async () => {
  // Ordering is the tell. A module-load constant is decided by whichever vault loaded first, so it
  // survives any test that touches vaults in a fixed order. This one alternates.
  const a = makeVault("alpha");
  const b = makeVault("bravo");
  try {
    const A = toolsFor(a.ctx);
    const B = toolsFor(b.ctx);
    for (const [tools, tag, other] of [[A, "alpha", "bravo"], [B, "bravo", "alpha"], [A, "alpha", "bravo"], [B, "bravo", "alpha"]]) {
      const out = await textOf(tools.synapse_list_agents);
      assert.match(out, new RegExp(`agent-${tag}-only`));
      assert.doesNotMatch(out, new RegExp(other));
    }
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("US-1.1: the SAME canonical job id can be live in two vaults at once", async () => {
  // The lease is per vault database. If two vaults shared a handle, the second claim would be refused
  // as 'held' — which would be a leak reported as correct dedup, the most convincing kind of wrong.
  const a = makeVault("alpha");
  const b = makeVault("bravo");
  try {
    const stub = { launch: () => ({ pid: 1 }), render: async () => ({ ok: true, briefing: "b" }) };
    const A = toolsFor(a.ctx, (s, v) => registerSpawnTools(s, v, stub));
    const B = toolsFor(b.ctx, (s, v) => registerSpawnTools(s, v, stub));
    const job = "doer:SHARED-1:same-id-in-both-vaults";

    const ca = await jsonOf(A.synapse_claim_and_brief, { agent: "doer", task: "alpha work", job, force: true });
    const cb = await jsonOf(B.synapse_claim_and_brief, { agent: "doer", task: "bravo work", job, force: true });
    assert.equal(ca.ok, true, "vault A claims the job");
    assert.equal(cb.ok, true, "vault B claims the SAME job id — different vault, different lease");

    // …and the hard gate still bites WITHIN a vault.
    const again = await jsonOf(A.synapse_claim_and_brief, { agent: "doer", task: "alpha work", job, force: true });
    assert.equal(again.refused, "held", "a second live claim in the SAME vault is still refused");
  } finally {
    vaultStore._reset();
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("US-1.1: episodic memory written in one vault is invisible in the other", async () => {
  const a = makeVault("alpha");
  const b = makeVault("bravo");
  try {
    const A = toolsFor(a.ctx, registerEpisodeTools);
    const B = toolsFor(b.ctx, registerEpisodeTools);

    await jsonOf(A.synapse_log, { task: "alpha secret task", summary: "alpha private summary" });
    const inA = await jsonOf(A.synapse_history, { query: "alpha" });
    const inB = await jsonOf(B.synapse_history, { query: "alpha" });

    assert.equal(inA.count, 1, "vault A recalls its own episode");
    assert.deepEqual(inB.episodes, [], "vault B recalls nothing — a separate database, not a filter");
  } finally {
    vaultStore._reset();
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

// ─── US-1.3 — two vaults share NO handle, NO epoch, NO cached briefing ────────

test("US-1.3: two vaults never share an epoch, and each vault's epoch is stable for the process",
  async () => {
    const a = makeVault("alpha");
    const b = makeVault("bravo");
    try {
      const ea1 = vaultStore.epoch(a.dir);
      const eb1 = vaultStore.epoch(b.dir);
      assert.notEqual(ea1, eb1, "distinct vaults, distinct reconciliation keys");
      // Stable per vault: minted per REQUEST and staleSpawns() would report every other concurrent
      // request's spawns as stale — the failure decision-0010 named explicitly.
      assert.equal(vaultStore.epoch(a.dir), ea1);
      assert.equal(vaultStore.epoch(b.dir), eb1);
    } finally {
      vaultStore._reset();
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

test("US-1.3: two vaults never share a database handle", async () => {
  const a = makeVault("alpha");
  const b = makeVault("bravo");
  try {
    const open = (path) => ({ path });
    const ha = vaultStore.db(a.dir, { name: "probe", open });
    const hb = vaultStore.db(b.dir, { name: "probe", open });
    assert.notEqual(ha, hb, "different objects");
    assert.notEqual(ha.path, hb.path, "…backed by different files");
    assert.equal(vaultStore.db(a.dir, { name: "probe", open }), ha, "memoized per (vault, name)");
  } finally {
    vaultStore._reset();
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("US-1.3: a context caches nothing — it re-reads the vault, so it can never serve a stale briefing",
  async () => {
    const a = makeVault("alpha");
    try {
      const tools = toolsFor(a.ctx);
      const before = await textOf(tools.synapse_list_agents);
      assert.doesNotMatch(before, /agent-added-later/);

      writeFileSync(join(a.dir, "agents", "agent-added-later.md"), note("agent-added-later", "agent"));
      const after = await textOf(tools.synapse_list_agents);
      assert.match(after, /agent-added-later/, "a context holds the KEY, never a snapshot of the contents");
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

test("US-1.3: contexts are values — one does not mutate when another is created", async () => {
  const a = makeVault("alpha");
  const b = makeVault("bravo");
  try {
    const before = { vaultDir: a.ctx.vaultDir, agentsDir: a.ctx.agentsDir, handoverDir: a.ctx.handoverDir };
    createVaultContext({ root: b.dir, vaultDir: b.dir, manifest: MANIFEST });
    assert.equal(a.ctx.vaultDir, before.vaultDir);
    assert.equal(a.ctx.agentsDir, before.agentsDir);
    assert.equal(a.ctx.handoverDir, before.handoverDir);
    assert.notEqual(a.ctx.vaultDir, b.ctx.vaultDir);
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

// ─── US-1.2 — nothing changes for the existing stdio setup ────────────────────

test("US-1.2: buildServer() with no vault serves the identical tool list to buildServer({ vault })",
  async () => {
    // The stdio contract: omitting the vault must behave exactly as the module constant did.
    for (const surface of ["skeleton", "standard", "full", "orchestrator"]) {
      const implicit = buildServer({ surface });
      const explicit = buildServer({ surface, vault: envPinnedContext() });
      const names = (s) => Object.keys(s._registeredTools ?? s.registeredTools ?? {}).sort();
      assert.deepEqual(names(implicit), names(explicit), `${surface}: same tools either way`);
      assert.ok(names(implicit).length > 0, `${surface}: the list is not empty (the assertion would be vacuous)`);
    }
  });

test("US-1.2: the transport cannot change the tool list — a second vault yields the same NAMES", async () => {
  // ToolTransportPort's contract, applied one layer early: binding a different vault changes the
  // ANSWERS, never the catalogue. Epic 2's HTTP adapter inherits this assertion unchanged.
  const a = makeVault("alpha");
  try {
    const names = (s) => Object.keys(s._registeredTools ?? s.registeredTools ?? {}).sort();
    assert.deepEqual(
      names(buildServer({ surface: "orchestrator" })),
      names(buildServer({ surface: "orchestrator", vault: a.ctx })),
    );
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
});

test("US-1.2: the deprecated single-vault surface still resolves, for out-of-tree plugins", async () => {
  const mod = await import("./vault.mjs");
  const env = envPinnedContext();
  assert.equal(mod.VAULT, env.vaultDir, "VAULT still names the env-pinned vault");
  assert.equal(mod.AGENTS_DIR, env.agentsDir);
  assert.equal(mod.HANDOVER_DIR, env.handoverDir);
  assert.deepEqual(mod.manifest(), env.manifest);
  assert.deepEqual(mod.vaultContext(), { root: env.root, vaultDir: env.vaultDir, manifest: env.manifest });
  for (const fn of ["runSynapse", "listAgentFiles", "listHubFiles", "listHandoverFiles",
                    "ensureHandoverDir", "writeHandoverNote", "assertVault", "asToolResult",
                    "normalizeAgentId", "readFrontmatter"]) {
    assert.equal(typeof mod[fn], "function", `${fn} is still exported`);
  }
});

test("US-1.2: an existing plugin's ctx keeps working AND is now bound to the request's vault", async () => {
  // <vault>/_meta/mcp-plugins/*.mjs is a documented extension point with consumers we do not ship.
  // ctx.VAULT / ctx.runSynapse / ctx.manifest must survive — and must now follow the bound vault, so a
  // plugin written for stdio becomes multi-vault-correct without its author changing a line.
  const a = makeVault("alpha");
  try {
    let seen = null;
    const plugin = { path: "/probe.mjs", name: "probe.mjs", register: (_s, ctx) => { seen = ctx; } };
    buildServer({ surface: "standard", plugins: [plugin], vault: a.ctx });
    assert.equal(seen.VAULT, a.dir, "ctx.VAULT follows the bound vault, not the environment");
    assert.equal(seen.vault.vaultDir, a.dir, "…and ctx.vault is the context itself");
    assert.deepEqual(seen.manifest(), MANIFEST);
    assert.equal(typeof seen.runSynapse, "function");
    assert.equal(typeof seen.asToolResult, "function");
    assert.equal(seen.surface, "standard");
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
});

// ─── the regression guard ────────────────────────────────────────────────────

test("no module under mcp/ reads the deprecated module-load vault constant", async () => {
  // THE POINT OF THIS TEST is that the old bug is re-introducible by one careless import, and would
  // then be invisible until something served two vaults. mcp/vault.mjs may export VAULT (out-of-tree
  // plugins import it); nothing in this package may import it back.
  const here = dirname(fileURLToPath(import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith(".mjs") || ent.name.endsWith(".test.mjs")) continue;
      if (p === join(here, "vault.mjs")) continue;              // the shim itself
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*vault\.mjs"/g)) {
        const named = m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0].trim());
        for (const n of named) {
          if (["VAULT", "AGENTS_DIR", "HANDOVER_DIR", "manifest", "vaultContext", "runSynapse",
               "listAgentFiles", "listHubFiles", "listHandoverFiles", "ensureHandoverDir",
               "writeHandoverNote", "assertVault"].includes(n)) {
            offenders.push(`${p.slice(here.length + 1)} imports { ${n} }`);
          }
        }
      }
    }
  };
  walk(here);
  assert.deepEqual(offenders, [],
    "these read a vault decided at module load; take the bound `vault` argument instead");
});
