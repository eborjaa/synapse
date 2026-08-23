// synapse-mcp — a Synapse vault exposed as MCP tools (local, stdio).
//
// This module is the STARTUP half: locate the vault, load plugins, build one server, connect it to
// stdio. The server itself is built by `buildServer()` in ./build-server.mjs, which has no side
// effects — importing it does not start anything. Importing THIS file does.
//
// Surfaces (SYNAPSE_MCP_SURFACE):
//   skeleton     — list_agents, list_hubs, render
//   standard     — + brief, augment, embeddings_*, lint       ← recommended for read-only agents
//   full         — default: + handover + authoring tools
//   orchestrator — + dedup-safe delegation (claim_and_brief, spawn_*)
//
// Consumer-specific tools do NOT belong in this package. Drop an ESM module exporting
// `register(server, ctx)` into <vault>/_meta/mcp-plugins/ and it is discovered automatically —
// every vault carries its own tools with no per-machine configuration. SYNAPSE_MCP_PLUGINS adds
// extra paths on top, for plugins that live outside the vault.
//
// ctx = { server, surface, VAULT, runSynapse, asToolResult, manifest } — the same helpers the
// built-in tool modules use, so a plugin is written exactly like `tools/health.mjs`.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { assertVault, VAULT } from "./vault.mjs";
import { buildServer, loadPlugins, resolveSurface, version } from "./build-server.mjs";

assertVault();

const surface = resolveSurface();

// Load plugin MODULES before serving: a plugin that cannot be imported must fail the process, not
// leave a server running with a tool quietly missing ([[rule-synapse-fail-loudly]]).
const plugins = await loadPlugins();

const server = buildServer({ surface, plugins });

await server.connect(new StdioServerTransport());

process.stderr.write(
  `[synapse-mcp] ready · v${version} · surface=${surface} · vault=${VAULT}`
  + `${plugins.length ? ` · plugins=${plugins.map((p) => p.name).join(",")}` : ""}\n`,
);
