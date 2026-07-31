// synapse-mcp — a Synapse vault exposed as MCP tools (local, stdio).
//
// Surfaces (SYNAPSE_MCP_SURFACE):
//   skeleton — list_agents, list_hubs, render
//   standard — + brief, augment, embeddings_*, lint          ← recommended for read-only agents
//   full     — default: + handover tools (incl. handover_write)
//
// Consumer-specific tools do NOT belong in this package. Point SYNAPSE_MCP_PLUGINS at one or more
// ESM modules exporting `register(server, ctx)` and they are registered after the built-ins:
//
//   SYNAPSE_MCP_PLUGINS=/path/to/vault/_meta/mcp-plugins/factory.mjs
//
// ctx = { server, surface, VAULT, runSynapse, asToolResult, manifest } — the same helpers the
// built-in tool modules use, so a plugin is written exactly like `tools/health.mjs`.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { assertVault, VAULT, manifest, runSynapse, asToolResult } from "./vault.mjs";
import { registerSkeletonTools, registerBriefTool } from "./tools/agents.mjs";
import { registerRetrievalTools } from "./tools/retrieval.mjs";
import { registerHealthTools } from "./tools/health.mjs";
import { registerHandoverTools } from "./tools/handover.mjs";

assertVault();

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const raw = (process.env.SYNAPSE_MCP_SURFACE || "full").toLowerCase();
const surface = ["skeleton", "standard", "full"].includes(raw) ? raw : "full";

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
    "Synapse context vault — full surface (standard + handover).\n\n"
    + "Same one-hub + augment + lint rules as standard.\n"
    + "Handover write is human-triggered only — never call synapse_handover_write unless asked.\n"
    + "All tools return text — they do NOT start an agent chat session.",
}[surface];

const server = new McpServer({ name: "synapse", version }, { instructions });

registerSkeletonTools(server);
if (surface === "standard" || surface === "full") {
  registerBriefTool(server);
  registerRetrievalTools(server);
  registerHealthTools(server);
}
if (surface === "full") {
  registerHandoverTools(server);
}

// Consumer plugins — registered last so they can extend the surface. Failures throw rather than
// degrade silently ([[rule-synapse-fail-loudly]]): a bot must never report a clean tool list while
// the tool it was asked for is quietly missing.
const pluginPaths = (process.env.SYNAPSE_MCP_PLUGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
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
