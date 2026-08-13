// synapse-mcp — a Synapse vault exposed as MCP tools (local, stdio).
//
// Surfaces (SYNAPSE_MCP_SURFACE):
//   skeleton — list_agents, list_hubs, render
//   standard — + brief, augment, embeddings_*, lint          ← recommended for read-only agents
//   full     — default: + handover tools (incl. handover_write)
//
// Consumer-specific tools do NOT belong in this package. Drop an ESM module exporting
// `register(server, ctx)` into <vault>/_meta/mcp-plugins/ and it is discovered automatically —
// every vault carries its own tools with no per-machine configuration. SYNAPSE_MCP_PLUGINS adds
// extra paths on top, for plugins that live outside the vault.
//
// ctx = { server, surface, VAULT, runSynapse, asToolResult, manifest } — the same helpers the
// built-in tool modules use, so a plugin is written exactly like `tools/health.mjs`.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { assertVault, VAULT, manifest, runSynapse, asToolResult } from "./vault.mjs";
import { registerSkeletonTools, registerBriefTool } from "./tools/agents.mjs";
import { registerRetrievalTools } from "./tools/retrieval.mjs";
import { registerHealthTools } from "./tools/health.mjs";
import { registerHandoverTools } from "./tools/handover.mjs";
import { registerAuthoringTools } from "./tools/authoring.mjs";
import { registerSpawnTools } from "./tools/spawn.mjs";

assertVault();

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const raw = (process.env.SYNAPSE_MCP_SURFACE || "full").toLowerCase();
const surface = ["skeleton", "standard", "full", "orchestrator"].includes(raw) ? raw : "full";

const instructions = {
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
    + "All tools return text — they do NOT start an agent chat session.",
  full:
    "Synapse context vault — full surface (standard + handover + authoring).\n\n"
    + "Same one-hub + augment + lint rules as standard.\n"
    + "synapse_create_* PROPOSE by default — they write only when called with write:true, and a new "
    + "rule/tool needs used_by:[<agent-id>] or it lands as an orphan.\n"
    + "Handover write is human-triggered only — never call synapse_handover_write unless asked.\n"
    + "All tools return text — they do NOT start an agent chat session.",
  orchestrator:
    "Synapse context vault — orchestrator surface (full + durable delegation).\n\n"
    + "Same one-hub + augment + lint + authoring rules as full.\n"
    + "PLUS synapse_spawn — launch a DETACHED, dedup-safe background doer via --cli. This is the ONE "
    + "tool that starts work rather than returning text.\n"
    + "CRITICAL: synapse_spawn's `job` MUST be a canonical id from stable facts "
    + "(agent:TICKET:suite:branch) — extract the ticket/branch, never name it from prose, or two "
    + "phrasings of the same task both run. A live/near-identical job is refused; poll synapse_spawn_status.",
}[surface];

const server = new McpServer({ name: "synapse", version }, { instructions });

registerSkeletonTools(server);
if (surface !== "skeleton") {
  registerBriefTool(server);
  registerRetrievalTools(server);
  registerHealthTools(server);
}
if (surface === "full" || surface === "orchestrator") {
  registerHandoverTools(server);
  registerAuthoringTools(server);
}
if (surface === "orchestrator") {
  registerSpawnTools(server);
}

// Consumer plugins — registered last so they can extend the surface. Failures throw rather than
// degrade silently ([[rule-synapse-fail-loudly]]): a bot must never report a clean tool list while
// the tool it was asked for is quietly missing.
//
// Discovered BY CONVENTION from <vault>/_meta/mcp-plugins/*.mjs, so any vault (or sub-vault) gets
// its own tools by dropping a file there — no per-machine config to maintain. SYNAPSE_MCP_PLUGINS
// still adds explicit paths on top, for plugins living outside the vault.
function discoverPlugins() {
  const dir = join(VAULT, "_meta", "mcp-plugins");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mjs") && !f.startsWith(".") && !f.endsWith(".test.mjs"))
    .sort()
    .map((f) => join(dir, f));
}

const pluginPaths = [...new Set([
  ...discoverPlugins(),
  ...(process.env.SYNAPSE_MCP_PLUGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
])];
const loaded = [];
for (const p of pluginPaths) {
  const mod = await import(pathToFileURL(p).href);
  if (typeof mod.register !== "function") {
    throw new Error(`MCP plugin ${p} does not export register(server, ctx)`);
  }
  await mod.register(server, { server, surface, VAULT, runSynapse, asToolResult, manifest });
  loaded.push(p.split("/").pop());
}

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(
  `[synapse-mcp] ready · v${version} · surface=${surface} · vault=${VAULT}`
  + `${loaded.length ? ` · plugins=${loaded.join(",")}` : ""}\n`,
);
