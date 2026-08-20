#!/usr/bin/env node
// mcp-config.mjs — generate MCP client config for THIS vault.
//
//   synapse mcp-config              # show what would be written
//   synapse mcp-config --write      # write .mcp.json + .cursor/mcp.json + opencode.json
//   synapse mcp-config --write --client claude|cursor|opencode
//   synapse mcp-config --write --env ZEPHYR_MCP_DISABLE=1   # extra env a vault plugin needs
//   synapse mcp-config --write --surface standard
//
// Why generate instead of hand-editing: a hand-written config hardcodes one machine's absolute
// paths and one vault's layout, so every new vault (or sub-vault) needs the wiring redone and every
// move breaks it. This resolves the current vault, points the client at the `synapse-mcp` bin that
// npm installed *into that vault*, and rewrites the file idempotently. Plugins need no entry at all
// — the server discovers <vault>/_meta/mcp-plugins/*.mjs by convention.
//
// This module is BOTH a CLI (guarded by isMain at the bottom) and a library: `synapse install` imports
// buildMcpTargets + applyMcpTargets so one `synapse install --write` also wires the MCP clients — the
// generation logic lives here once, in-process, not duplicated or shelled out to a subprocess.

import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVault } from "./vault-root.mjs";

export const MCP_SURFACES = ["skeleton", "standard", "full", "orchestrator"];
export const MCP_CLIENTS = ["claude", "cursor", "opencode", "all"];

// The bin npm installed for THIS vault. Falls back to the package's own bin when the vault IS the
// package repo (development), and finally to a bare `synapse-mcp` resolved on PATH.
export function resolveServerCommand(root) {
  const local = join(root, "node_modules", ".bin", "synapse-mcp");
  if (existsSync(local)) return local;
  const own = new URL("../bin/synapse-mcp.mjs", import.meta.url).pathname;
  if (existsSync(own)) return own;
  return "synapse-mcp";
}

// A LOCAL-ollama vault also needs the NATIVE provider, not the OpenAI-compatible /v1 path: ollama's
// /v1 STREAMING drops tool-call delta chunks, so MCP tools silently never fire (opencode #20995,
// ollama #5769). The native ai-sdk provider (ollama-ai-provider-v2, /api endpoint) round-trips them —
// verified: a local qwen model then actually calls synapse_* tools in the opencode TUI. Only seeded
// when the target config does NOT already define an ollama provider, so a cloud/custom provider a user
// configured is never clobbered.
function maybeAddNativeOllama(cfg, existing) {
  if (existing?.provider?.ollama) return;                 // respect an existing provider
  const base = process.env.SYNAPSE_OLLAMA_URL || "http://localhost:11434";
  const api = base.replace(/\/v1\/?$/, "").replace(/\/$/, "") + "/api";
  cfg.provider = {
    ...(cfg.provider || {}),
    ollama: {
      npm: "ollama-ai-provider-v2",
      name: "Ollama (native — tool calls round-trip; /v1 streaming drops them)",
      options: { baseURL: api },
    },
  };
}

// Build the list of { path, cfg, label } targets for a vault. Pure except for reading any existing
// config files (needed to carry over user env / model / provider) — writes nothing.
export function buildMcpTargets({ root, vaultDir, surface = "full", client = "all", extraEnv = {} } = {}) {
  const command = resolveServerCommand(root);
  const env = {
    SYNAPSE_VAULT: vaultDir,
    SYNAPSE_MCP_SURFACE: surface,
    // node:sqlite is behind a flag on the supported Node range; the server's child processes inherit it.
    NODE_OPTIONS: "--experimental-sqlite",
    ...extraEnv,
  };

  // Carry over any extra env already present in a target config. A vault PLUGIN can require env of its
  // own (a missing one makes the plugin throw and takes the WHOLE server down, per rule-synapse-fail-
  // loudly) — so a var set for one client must not be silently dropped for another.
  function carryOverEnv(path, read) {
    if (!existsSync(path)) return;
    try {
      const prev = read(JSON.parse(readFileSync(path, "utf8")));
      for (const [k, v] of Object.entries(prev || {})) if (!(k in env)) env[k] = v;
    } catch { /* unreadable/!json — nothing to carry */ }
  }
  carryOverEnv(join(root, ".mcp.json"), (c) => c?.mcpServers?.synapse?.env);
  carryOverEnv(join(root, ".cursor", "mcp.json"), (c) => c?.mcpServers?.synapse?.env);
  carryOverEnv(join(root, "opencode.json"), (c) => c?.mcp?.synapse?.environment);

  const entry = { command, args: [], env };
  const claudeCfg = { mcpServers: { synapse: { type: "stdio", ...entry } } };
  const cursorCfg = { mcpServers: { synapse: entry } };
  // opencode uses a DIFFERENT shape and does not read .mcp.json / .cursor/mcp.json at all: the key is
  // `mcp` (not `mcpServers`), `command` is an ARRAY (argv), and env is `environment`.
  const opencodeSynapse = { type: "local", command: [command], enabled: true, environment: env };

  const targets = [];
  if (client === "claude" || client === "all") targets.push({ path: join(root, ".mcp.json"), cfg: claudeCfg, label: "Claude Code" });
  if (client === "cursor" || client === "all") targets.push({ path: join(root, ".cursor", "mcp.json"), cfg: cursorCfg, label: "Cursor" });
  if (client === "opencode" || client === "all") {
    const ocPath = join(root, "opencode.json");
    // The writer OVERWRITES the whole file, so carry forward everything already there (a user's model /
    // small_model / provider / etc.) — only synapse's mcp entry and, if absent, the native ollama
    // provider are ours to set. Never wipe user config.
    let existingOc = {};
    if (existsSync(ocPath)) { try { existingOc = JSON.parse(readFileSync(ocPath, "utf8")); } catch { existingOc = {}; } }
    const merged = {
      ...existingOc,
      $schema: existingOc.$schema || "https://opencode.ai/config.json",
      mcp: { ...(existingOc.mcp || {}), synapse: opencodeSynapse },
    };
    maybeAddNativeOllama(merged, existingOc);   // adds provider.ollama only if the user has none
    targets.push({ path: ocPath, cfg: merged, label: "opencode" });
  }

  return { command, env, targets };
}

// Write (or, with write:false, just diff) the targets. Returns the count of files that changed.
export function applyMcpTargets(targets, { root, write = false, log = console.log } = {}) {
  let changed = 0;
  for (const { path, cfg, label } of targets) {
    const next = `${JSON.stringify(cfg, null, 2)}\n`;
    const prev = existsSync(path) ? readFileSync(path, "utf8") : null;
    const same = prev === next;
    const rel = root ? relative(root, path) : path;
    if (!write) {
      log(`--- ${rel} (${label})${same ? " — already current" : ""} ---`);
      log(next);
      continue;
    }
    if (same) { log(`  unchanged  ${rel}`); continue; }
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, next, "utf8");
    log(`  wrote      ${rel} (${label})`);
    changed++;
  }
  return changed;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const pick = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
  };
  const surface = pick("surface", "full");
  const client = pick("client", "all");

  // Keep in step with mcp/server.mjs's surface list — `orchestrator` (full + dedup-safe delegation) was
  // added in 0.10 and this validator was never updated, so `--surface orchestrator` was rejected even
  // though the server accepts it.
  if (!MCP_SURFACES.includes(surface)) {
    console.error(`mcp-config: --surface must be ${MCP_SURFACES.join("|")}`);
    process.exit(2);
  }
  if (!MCP_CLIENTS.includes(client)) {
    console.error(`mcp-config: --client must be ${MCP_CLIENTS.join("|")}`);
    process.exit(2);
  }

  // preferCwd: this WRITES into a vault, so the vault you are standing in wins over a stale
  // exported $SYNAPSE_VAULT (same guard as `synapse install` and `synapse new`).
  const { root, vaultDir } = resolveVault({ preferCwd: true, readManifest: false });

  // --env KEY=VAL (repeatable): extra env a vault plugin needs.
  const extraEnv = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env" && argv[i + 1]) {
      const eq = argv[i + 1].indexOf("=");
      if (eq > 0) extraEnv[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1);
    }
  }

  const { command, targets } = buildMcpTargets({ root, vaultDir, surface, client, extraEnv });

  console.log(`vault:   ${vaultDir}`);
  console.log(`server:  ${command}`);
  console.log(`surface: ${surface}`);
  const pluginDir = join(vaultDir, "_meta", "mcp-plugins");
  console.log(`plugins: ${existsSync(pluginDir) ? `auto-discovered from ${relative(root, pluginDir)}/` : "none (create _meta/mcp-plugins/ to add some)"}`);
  console.log("");

  const changed = applyMcpTargets(targets, { root, write });

  if (!write) {
    console.log("Re-run with --write to apply.");
  } else {
    console.log(changed ? `\nRestart the client to pick up the change.` : `\nNothing to do.`);
  }
}

// Run the CLI only when invoked directly (synapse mcp-config) — NOT when imported by `synapse install`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
