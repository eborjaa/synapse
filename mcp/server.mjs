// synapse-mcp — a Synapse vault exposed as MCP tools (local, stdio).
//
// This module is the STARTUP half: locate the vault, load plugins, and hand stdio a server FACTORY.
// The server itself is built by `buildServer()` in ./build-server.mjs, which has no side effects —
// importing it does not start anything. Importing THIS file does.
//
// Serves both MCP eras from one process (see the serveStdio call below).
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

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { assertVault, VAULT } from "./vault.mjs";
import { buildServer, loadPlugins, resolveSurface, version } from "./build-server.mjs";

assertVault();

const surface = resolveSurface();

// Load plugin MODULES before serving: a plugin that cannot be imported must fail the process, not
// leave a server running with a tool quietly missing ([[rule-synapse-fail-loudly]]).
const plugins = await loadPlugins();

// DUAL-ERA. `legacy: 'serve'` (the default, stated here so it is not silently changed) makes one
// process answer BOTH protocol eras from one factory:
//   • legacy  (2025-11-25) — `initialize` handshake. Cursor, opencode and DeepSeek Harness speak this.
//   • modern  (2026-07-28) — stateless; the client probes `server/discover`. Claude Code speaks this.
// Never switch to 'reject' until every client we support has moved, because a legacy client has no
// fall-forward path and would simply fail. See [[decision-0010-mcp-2026-07-28-dual-era]].
//
// The factory is invoked per connection, so it must stay cheap — plugins are already imported above.
serveStdio(() => buildServer({ surface, plugins }), { legacy: "serve" });

process.stderr.write(
  `[synapse-mcp] ready · v${version} · surface=${surface} · vault=${VAULT}`
  + `${plugins.length ? ` · plugins=${plugins.map((p) => p.name).join(",")}` : ""}\n`,
);
