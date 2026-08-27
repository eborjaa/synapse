// build-server.mjs — the pure factory half of synapse-mcp.
//
// Split out of server.mjs so building a server is a CALL, not a side effect of importing a module.
// Two reasons:
//   1. Tests can construct a server without starting one.
//   2. MCP's stateless era (2026-07-28) hands the transport a factory it invokes per connection
//      rather than a pre-built singleton — see [[decision-0010-mcp-2026-07-28-dual-era]].
//
// The split that matters is load vs register. Plugin MODULES are imported once, at startup, by
// `loadPlugins()` — so a broken plugin still throws before we serve anything ([[rule-synapse-fail-loudly]]).
// Plugin REGISTRATION then happens inside `buildServer()`, which we keep synchronous ON PURPOSE.
//
// To be accurate: the SDK does NOT require this. `McpServerFactory` is
// `(ctx) => McpServer | Server | Promise<McpServer | Server>`, so an async factory is legal. We choose
// sync because the factory runs per connection (and, under a future HTTP handler, per request): keeping
// it allocation-only means no I/O on that path, and no window in which a half-registered server can be
// handed to a client. Async setup belongs at module load, where it happens once and can fail loudly.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";

import { asToolResult } from "./vault.mjs";
import { envPinnedContext } from "./vault-context.mjs";
import { registerSkeletonTools, registerBriefTool } from "./tools/agents.mjs";
import { registerRetrievalTools } from "./tools/retrieval.mjs";
import { registerHealthTools } from "./tools/health.mjs";
import { registerEpisodeTools } from "./tools/episodes.mjs";
import { registerHandoverTools } from "./tools/handover.mjs";
import { registerAuthoringTools } from "./tools/authoring.mjs";
import { registerSpawnTools } from "./tools/spawn.mjs";
import { registerAdminTools } from "./tools/admin.mjs";

export const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const EVERYDAY_SURFACES = Object.freeze(["skeleton", "standard", "full", "orchestrator"]);
export const SURFACES = [...EVERYDAY_SURFACES, "admin"];

/** The surface this process serves. Invalid values fall back to `full` rather than failing. */
export function resolveSurface(raw = process.env.SYNAPSE_MCP_SURFACE) {
  const s = (raw || "full").toLowerCase();
  return SURFACES.includes(s) ? s : "full";
}

export function isAdminAuthorized(bound) {
  return Array.isArray(bound?.scopes) && bound.scopes.includes("admin");
}

/**
 * Choose the catalogue for one request.
 *
 * WHY this is a function of the credential, not of `--surface`. `--surface` is the everyday ceiling
 * for this process. An admin-scoped bearer upgrades to `admin`; any other credential never sees those
 * tools. If the process itself was started with `--surface admin`, a normal token is served
 * `orchestrator` instead of inheriting privileged tools. Failure mode of the other design: a shared
 * HTTP server started as admin would give every client mint/revoke.
 */
export function surfaceForRequest(requested, adminAuthorized) {
  if (adminAuthorized) return "admin";
  if (requested === "admin") return "orchestrator";
  return requested;
}

const MEMORY_BRIEF =
  "\n\nMEMORY — three stores you should actually use, not just have:\n"
  + "• Your briefing was built ONCE, at the start. When the work moves to a NEW subtask, call "
  + "synapse_recall(task) with what you are doing now — it returns only the delta (relevant notes, any "
  + "rule that now applies, whether it was already done), never your whole briefing. Cheap; call it "
  + "whenever the topic shifts. A stale briefing is how agents drift.\n"
  + "• A briefing carries a 'Fetch before you act' checklist of on-demand notes — only their triggers, "
  + "not their bodies. When a trigger matches what you are about to do, fetch that note FIRST "
  + "(synapse_brief note:<id>); do not improvise it from memory.\n"
  + "• Before starting work that might already be done, call synapse_history(query). An empty result "
  + "means it was not RECORDED, not that it never happened. Record your own finished work with "
  + "synapse_log (delegated work is recorded for you by claim_and_brief + spawn_release).";

export const INSTRUCTIONS = {
  skeleton:
    "Synapse context vault — skeleton surface.\n\n"
    + "Happy path: synapse_list_agents → synapse_list_hubs → synapse_render with "
    + "ids [agent, one hub] and a profile (lean|standard|fat).\n\n"
    + "One parent hub per render. Tools return text only — they never start a chat session.",
  standard:
    "Synapse context vault — standard surface (read-only).\n\n"
    + "Happy path: list agents/hubs → synapse_brief or synapse_render with ONE hub.\n"
    + "Cross-domain hints: synapse_augment (or brief with task) — suggestions to verify.\n"
    + "synapse_lint = mechanical health (read-only). "
    + "Never call synapse_embeddings_rebuild unless the user asks.\n"
    + "All tools return text — they do NOT start an agent chat session."
    + MEMORY_BRIEF,
  full:
    "Synapse context vault — full surface (standard + handover + authoring).\n\n"
    + "Same one-hub + augment + lint rules as standard.\n"
    + "synapse_create_* PROPOSE by default — they write only when called with write:true, and a new "
    + "rule/tool needs used_by:[<agent-id>] or it lands as an orphan.\n"
    + "Handover write is human-triggered only — never call synapse_handover_write unless asked.\n"
    + "All tools return text — they do NOT start an agent chat session."
    + MEMORY_BRIEF,
  orchestrator:
    "Synapse context vault — orchestrator surface (full + dedup-safe delegation).\n\n"
    + "Same one-hub + augment + lint + authoring rules as full.\n"
    + "DELEGATE WITH synapse_claim_and_brief: it claims the job (lease) and returns the doer's briefing; "
    + "YOU launch with your own harness (Task tool, @mention, terminal) so you keep every native feature "
    + "— task panel, streaming, completion notification — while dedup is still enforced. Release with "
    + "synapse_spawn_release({ handle, summary }) when the doer finishes. Peek at unfinished "
    + "handoffs with synapse_handoffs_open.\n"
    + "synapse_spawn is the SPECIALIST alternative: synapse launches a DETACHED process that outlives "
    + "your session but is invisible to your harness (poll synapse_spawn_status). Use it only for work "
    + "that must survive your session, or when there is no harness to launch with.\n"
    + "CRITICAL for both: `job` MUST be a canonical id from stable facts (agent:TICKET:suite:branch) — "
    + "extract the ticket/branch, never name it from prose, or two phrasings of the same task both run."
    + MEMORY_BRIEF,
  admin:
    "Synapse context vault — ADMIN surface (orchestrator + machine administration).\n\n"
    + "This surface exists only for an admin-scoped bearer credential. Vault registration, credential "
    + "mint/revoke, and config sync mutate machine or generated state and report every affected path in "
    + "the transcript. Never paste a minted plaintext credential into a vault note or commit it."
    + MEMORY_BRIEF,
};

/**
 * Plugin paths, by convention from <vault>/_meta/mcp-plugins/*.mjs so any vault carries its own
 * tools with no per-machine config, plus explicit paths from SYNAPSE_MCP_PLUGINS.
 */
export function discoverPluginPaths(vault = envPinnedContext().vaultDir) {
  const dir = join(typeof vault === "string" ? vault : vault.vaultDir, "_meta", "mcp-plugins");
  const fromVault = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".mjs") && !f.startsWith(".") && !f.endsWith(".test.mjs"))
        .sort()
        .map((f) => join(dir, f))
    : [];
  const fromEnv = (process.env.SYNAPSE_MCP_PLUGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...fromVault, ...fromEnv])];
}

/**
 * Import every plugin module ONCE, at startup. Throws on a plugin that cannot be imported or does
 * not export register() — a bot must never report a clean tool list while a tool it was asked for
 * is quietly missing.
 */
export async function loadPlugins(paths = discoverPluginPaths()) {
  const loaded = [];
  for (const p of paths) {
    const mod = await import(pathToFileURL(p).href);
    if (typeof mod.register !== "function") {
      throw new Error(`MCP plugin ${p} does not export register(server, ctx)`);
    }
    loaded.push({ path: p, name: p.split("/").pop(), register: mod.register });
  }
  return loaded;
}

/**
 * Build a fully-registered server bound to ONE vault. Synchronous by contract — see the note at the top
 * of this file: the SDK would permit an async factory, we decline it. A plugin whose register() returns
 * a promise is rejected here rather than silently producing a server with missing tools.
 *
 * `vault` IS THE PER-REQUEST SEAM, and it is here rather than deeper because of what the SDK promises:
 *
 *     type McpServerFactory = (ctx: McpRequestContext) => McpServer | Server | Promise<…>
 *     // createMcpHandler invokes it ONCE PER HTTP REQUEST (ctx carries authInfo);
 *     // serveStdio invokes it ONCE PER CONNECTION.
 *
 * So "one server per bound vault" and "one server per serving unit" are the same object, and a
 * per-request vault needs no ambient state to travel in — every handler simply closes over the context
 * it was built with. On stdio the caller passes the env-pinned context every time, which is what makes
 * this change invisible there (US-1.2); under Epic 2's HTTP adapter the caller resolves the credential
 * to a vault first and passes THAT (US-2.2). Two vaults in one process get two servers that share no
 * handle, no epoch and no cached briefing (US-1.3) because they share no name.
 *
 * `adminAuthorized` is the matching seam for the catalogue. Admin tools are registered only when the
 * bound credential carries the `admin` scope. `--surface admin` alone is not authorization: a stdio
 * process has no bearer, so it throws rather than serving privileged tools to whoever launched it.
 *
 * It defaults to the env-pinned context so every existing caller — tests included — keeps working
 * unchanged. Resolution happens per CALL, never at module load: a module-load vault is precisely the
 * bug this parameter removes.
 */
export function buildServer({
  surface = resolveSurface(),
  plugins = [],
  vault = envPinnedContext(),
  adminAuthorized = false,
} = {}) {
  if (surface === "admin" && !adminAuthorized) {
    throw new Error(
      "Admin surface requires an admin-scoped bearer credential; it is unavailable on stdio and normal credentials.",
    );
  }
  const server = new McpServer({ name: "synapse", version }, { instructions: INSTRUCTIONS[surface] });

  registerSkeletonTools(server, vault);
  if (surface !== "skeleton") {
    registerBriefTool(server, vault);
    registerRetrievalTools(server, vault);
    registerHealthTools(server, vault);
    registerEpisodeTools(server, vault);
  }
  if (surface === "full" || surface === "orchestrator" || surface === "admin") {
    registerHandoverTools(server, vault);
    registerAuthoringTools(server, vault);
  }
  if (surface === "orchestrator" || surface === "admin") {
    registerSpawnTools(server, vault);
  }
  if (surface === "admin") registerAdminTools(server);

  // Plugins register LAST so they can extend any surface.
  //
  // `vault` is the new, multi-vault-correct member. `VAULT`, `runSynapse` and `manifest` are kept
  // because <vault>/_meta/mcp-plugins/*.mjs is a documented extension point with out-of-tree consumers
  // — but they are now derived from the BOUND vault rather than from a module constant, so an existing
  // plugin becomes per-request correct without its author changing a line.
  const ctx = {
    server,
    surface,
    vault,
    asToolResult,
    VAULT: vault.vaultDir,
    runSynapse: (args, opts) => vault.runSynapse(args, opts),
    manifest: () => vault.manifest,
  };
  for (const p of plugins) {
    const r = p.register(server, ctx);
    if (r && typeof r.then === "function") {
      throw new Error(
        `MCP plugin ${p.path} has an async register(). Registration must be synchronous: the server `
        + `factory runs per connection, so it stays allocation-only. Do async setup at module top level `
        + `(it runs once, at load, where a failure is loud), then register synchronously.`,
      );
    }
  }

  return server;
}
