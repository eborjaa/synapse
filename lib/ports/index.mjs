#!/usr/bin/env node
// index.mjs — the five ports Synapse's core depends on, and where each one's adapters live.
//
// READ THIS FIRST IF YOU ARE ADDING A HARNESS. You should need to touch exactly one adapter file and
// nothing else. If adding a harness makes you edit a core module — lib/mcp-config.mjs, lib/skills.mjs,
// mcp/server.mjs, lib/vault-root.mjs — the boundary has leaked and the fix belongs here, not there.
// That is the acceptance test for this whole layer, stated once, in the file people will find.
//
// WHY FIVE. Each port is one axis along which harnesses genuinely disagree, established by reading the
// existing code rather than by guessing at extension points:
//
//   ClientConfigPort   — three clients, three file shapes, three merge rules   (fully extracted)
//   RosterPort         — decision-0011 tabulates FOUR independent implementations of "publish the
//                        roster", which is the strongest evidence in the repo that this is a real seam
//   ToolTransportPort  — stdio today; loopback HTTP is stage 5 of the plan
//   VaultBindingPort   — env-pinned today; bearer-token is what un-defers multi-vault
//   VaultStorePort     — the seam that must exist before HTTP is safe (stage 4)
//
// HONEST STATUS. Ports are declared here in full, but they are not all extracted yet, and a declared
// port with no adapter would be decoration. So each one below states what it is TODAY:
//
//   ClientConfigPort   ✅ extracted, 3 adapters, contract-tested against every adapter
//   RosterPort         ✅ declared + dsh adapter over the existing generator, contract-tested
//   ToolTransportPort  ◻︎ declared; stdio adapter is a thin wrapper, http lands in stage 5
//   VaultBindingPort   ◻︎ declared; env-pinned adapter wraps today's resolver, bearer-token in stage 5
//   VaultStorePort     ◻︎ DECLARED ONLY — deliberately. See the note on it below.
//
// Nothing here starts a process; importing this file is free.

import { definePort, registry } from "./port.mjs";
import { ClientConfigPort, clientConfigAdapters } from "./client-config.mjs";
import { buildSkillTargets, applySkillTargets } from "../skills.mjs";
import { resolveVault } from "../vault-root.mjs";

export { definePort, registry, assertImplements } from "./port.mjs";
export { ClientConfigPort, clientConfigAdapters } from "./client-config.mjs";

// ── RosterPort ────────────────────────────────────────────────────────────────
// Publish a vault's agent roster to one harness.
//
// The contract's teeth are the "kept, never clobbered" rule from decision-0011: a hand-authored file is
// the human's, and a generator that overwrites it destroys tuned work. The four shipped skills were
// written against observed local-30B failure modes; a regeneration that flattened them would be a
// regression no test currently catches at this layer, so the contract test catches it here.

export const RosterPort = definePort({
  name: "RosterPort",
  fields: ["label"],
  methods: ["targets", "apply", "discoveryHint"],
  contract:
    "targets() is pure and writes nothing; apply() is idempotent and NEVER overwrites a hand-authored "
    + "file without an explicit force.",
});

const dshRoster = {
  id: "dsh",
  label: "DeepSeek Harness",
  // Default output is the vault REPO ROOT's .dsh/skills — DSH's highest-ranked root (project-dsh),
  // discovered with no symlink and no YAML. `outDir` targets the user-scoped root instead.
  targets: ({ root, vaultDir, agent = null, outDir = null }) =>
    buildSkillTargets({ root, vaultDir, agent, outDir }),
  apply: (targets, { root, write = false, force = false } = {}) =>
    applySkillTargets(targets, { root, write, force }),
  discoveryHint: ({ root, outDir = null }) => ({
    path: outDir || `${root}/.dsh/skills`,
    rank: outDir ? 400 : 100,
    note: outDir
      ? "user-scoped root — found from wherever DSH starts"
      : "project root — highest-ranked, needs no configuration",
  }),
};

export const rosterAdapters = registry(RosterPort, [dshRoster]);

// ── ToolTransportPort ─────────────────────────────────────────────────────────
// Expose the tool surface over one transport. The server FACTORY is the boundary: decision-0010 already
// refactored mcp/server.mjs into a factory precisely so a second transport could reuse it unchanged.
//
// The contract that matters is that the transport cannot change the tool list. When the HTTP adapter
// lands in stage 5, the same contract test runs against both and a divergence fails there rather than
// in someone's client six weeks later.

export const ToolTransportPort = definePort({
  name: "ToolTransportPort",
  fields: ["label"],
  methods: ["serve", "describe"],
  contract:
    "the same server factory yields an identical tool list on every transport; serve() never mutates "
    + "the factory or the vault.",
});

const stdioTransport = {
  id: "stdio",
  label: "stdio (dual-era)",
  // Imported lazily: pulling in the MCP SDK at module load would make importing this index start the
  // dependency chain for every consumer, including the CLI, which never serves anything.
  async serve(buildServer, { legacy = "serve" } = {}) {
    const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
    return serveStdio(buildServer, { legacy });
  },
  describe: () => ({
    transport: "stdio",
    multiVault: false,          // one connection is one process is one vault
    eras: ["2025-11-25", "2026-07-28"],
  }),
};

export const toolTransportAdapters = registry(ToolTransportPort, [stdioTransport]);

// ── VaultBindingPort ──────────────────────────────────────────────────────────
// Resolve an inbound request to exactly ONE vault.
//
// THE CONTRACT IS A SECURITY BOUNDARY, not a convenience. decision-0010 deferred multi-vault with a
// specific reason: "the moment vault selection is a tool argument, the only thing isolating vaults
// holding finance, health and contacts data is the model's choice of argument." So `bind()` takes a
// request and reads its CREDENTIAL; an adapter that reads a tool argument is not a valid adapter, and a
// token that does not resolve is a refusal — never a fallback to some default vault.

export const VaultBindingPort = definePort({
  name: "VaultBindingPort",
  fields: ["label"],
  methods: ["bind", "describe"],
  contract:
    "binding derives the vault from the caller's identity, NEVER from a tool argument; an unresolvable "
    + "credential is a refusal, never a fallback to a default vault.",
});

const envPinnedBinding = {
  id: "env-pinned",
  label: "environment-pinned (one vault per process)",
  // Today's behavior, unchanged: the harness launches the server with $SYNAPSE_VAULT set in generated
  // config, and a long-lived server cannot `cd`, so the env is the authoritative vault and must beat
  // whatever cwd the harness happened to start in. Hence preferCwd:false.
  bind() {
    try {
      const r = resolveVault({ readManifest: true, preferCwd: false });
      return { ok: true, root: r.root, vaultDir: r.vaultDir, manifest: r.manifest || {} };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  },
  describe: () => ({ mode: "env-pinned", multiVault: false, source: "$SYNAPSE_VAULT" }),
};

export const vaultBindingAdapters = registry(VaultBindingPort, [envPinnedBinding]);

// ── VaultStorePort ────────────────────────────────────────────────────────────
// All vault reads and writes behind one seam.
//
// DECLARED ONLY, ON PURPOSE. Writing an adapter now would be the wrong move: the whole point of this
// port is to un-memoize state that is currently correct precisely BECAUSE it is memoized per module
// load. mcp/tools/spawn.mjs mints `EPOCH` once per process and memoizes `_db`/`_edb`; episodes.mjs does
// the same. On stdio — one connection, one process, one vault — that is right, and decision-0010 says
// so. Off stdio it is wrong: EPOCH becomes per-request and staleSpawns reports every other request's
// spawns as stale.
//
// Changing that touches the lease-and-fence path, which is the single-writer guarantee for a database
// holding financial records. It is stage 4, it gets its own PR, and it does not get done as a footnote
// to an interface-extraction change. The port is declared here so the boundary is visible and stage 4
// has something to implement against — not so it can be quietly half-done today.

export const VaultStorePort = definePort({
  name: "VaultStorePort",
  fields: ["label"],
  methods: ["db", "epoch", "read", "list"],
  contract:
    "handles and epochs are keyed BY VAULT, never memoized per module load; two vaults exercised in one "
    + "process never share a handle or an epoch.",
});

/** Every port declared in this package, for diagnostics and for the contract-test sweep. */
export const ALL_PORTS = Object.freeze([
  ClientConfigPort, RosterPort, ToolTransportPort, VaultBindingPort, VaultStorePort,
]);
