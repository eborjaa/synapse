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
//   admin        — HTTP + admin-scoped bearer only. stdio refuses it at startup.
//
// Consumer-specific tools do NOT belong in this package. Drop an ESM module exporting
// `register(server, ctx)` into <vault>/_meta/mcp-plugins/ and it is discovered automatically —
// every vault carries its own tools with no per-machine configuration. SYNAPSE_MCP_PLUGINS adds
// extra paths on top, for plugins that live outside the vault.
//
// ctx = { server, surface, vault, asToolResult, VAULT, runSynapse, manifest } — the same helpers the
// built-in tool modules use, so a plugin is written exactly like `tools/health.mjs`. Prefer `ctx.vault`
// (a bound context); the flat `VAULT`/`runSynapse`/`manifest` members are kept for existing plugins and
// are derived from that same bound vault.

import { toolTransportAdapters } from "../lib/ports/index.mjs";
import { envPinnedContext } from "./vault-context.mjs";
import { buildServer, loadPlugins, resolveSurface, version } from "./build-server.mjs";

// THIS process serves exactly one vault, chosen by its environment — that is what stdio IS (one
// connection, one process, one vault). Resolve it ONCE here and hand the same context to every
// connection, so the failure is loud at startup rather than on the first tool call.
const vault = envPinnedContext();
vault.assertVault();

const surface = resolveSurface();
if (surface === "admin") {
  throw new Error(
    "Admin surface requires an admin-scoped bearer credential; it is unavailable on stdio. "
    + "Mint with `synapse vaults token <id> --admin` and connect over `synapse-mcp --http`.",
  );
}

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
// Going through ToolTransportPort is what makes stdio and HTTP share this exact buildServer factory
// instead of growing two registration paths whose tool lists can drift.
await toolTransportAdapters.get("stdio").serve(
  () => buildServer({ surface, plugins, vault }),
  { legacy: "serve" },
);

process.stderr.write(
  `[synapse-mcp] ready · v${version} · surface=${surface} · vault=${vault.vaultDir}`
  + `${plugins.length ? ` · plugins=${plugins.map((p) => p.name).join(",")}` : ""}\n`,
);
