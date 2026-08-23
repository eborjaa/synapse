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
// Plugin REGISTRATION then happens inside `buildServer()`, which must stay synchronous because a
// per-connection factory cannot await.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { VAULT, manifest, runSynapse, asToolResult } from "./vault.mjs";
import { registerSkeletonTools, registerBriefTool } from "./tools/agents.mjs";
import { registerRetrievalTools } from "./tools/retrieval.mjs";
import { registerHealthTools } from "./tools/health.mjs";
import { registerEpisodeTools } from "./tools/episodes.mjs";
import { registerHandoverTools } from "./tools/handover.mjs";
import { registerAuthoringTools } from "./tools/authoring.mjs";
import { registerSpawnTools } from "./tools/spawn.mjs";

export const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const SURFACES = ["skeleton", "standard", "full", "orchestrator"];

/** The surface this process serves. Invalid values fall back to `full` rather than failing. */
export function resolveSurface(raw = process.env.SYNAPSE_MCP_SURFACE) {
  const s = (raw || "full").toLowerCase();
  return SURFACES.includes(s) ? s : "full";
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
    + "synapse_spawn_release when the doer finishes.\n"
    + "synapse_spawn is the SPECIALIST alternative: synapse launches a DETACHED process that outlives "
    + "your session but is invisible to your harness (poll synapse_spawn_status). Use it only for work "
    + "that must survive your session, or when there is no harness to launch with.\n"
    + "CRITICAL for both: `job` MUST be a canonical id from stable facts (agent:TICKET:suite:branch) — "
    + "extract the ticket/branch, never name it from prose, or two phrasings of the same task both run."
    + MEMORY_BRIEF,
};

/**
 * Plugin paths, by convention from <vault>/_meta/mcp-plugins/*.mjs so any vault carries its own
 * tools with no per-machine config, plus explicit paths from SYNAPSE_MCP_PLUGINS.
 */
export function discoverPluginPaths(vault = VAULT) {
  const dir = join(vault, "_meta", "mcp-plugins");
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
 * Build a fully-registered server. Synchronous by contract: the stateless transport calls this per
 * connection and cannot await. A plugin whose register() returns a promise is rejected here rather
 * than silently producing a server with missing tools.
 */
export function buildServer({ surface = resolveSurface(), plugins = [] } = {}) {
  const server = new McpServer({ name: "synapse", version }, { instructions: INSTRUCTIONS[surface] });

  registerSkeletonTools(server);
  if (surface !== "skeleton") {
    registerBriefTool(server);
    registerRetrievalTools(server);
    registerHealthTools(server);
    registerEpisodeTools(server);
  }
  if (surface === "full" || surface === "orchestrator") {
    registerHandoverTools(server);
    registerAuthoringTools(server);
  }
  if (surface === "orchestrator") {
    registerSpawnTools(server);
  }

  // Plugins register LAST so they can extend any surface.
  const ctx = { server, surface, VAULT, runSynapse, asToolResult, manifest };
  for (const p of plugins) {
    const r = p.register(server, ctx);
    if (r && typeof r.then === "function") {
      throw new Error(
        `MCP plugin ${p.path} has an async register(). Registration must be synchronous — the server `
        + `factory is invoked per connection and cannot await. Do async setup at module top level, `
        + `then register synchronously.`,
      );
    }
  }

  return server;
}
