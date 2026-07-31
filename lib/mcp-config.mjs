#!/usr/bin/env node
// mcp-config.mjs — generate MCP client config for THIS vault.
//
//   synapse mcp-config              # show what would be written
//   synapse mcp-config --write      # write .mcp.json + .cursor/mcp.json
//   synapse mcp-config --write --client claude|cursor
//   synapse mcp-config --write --surface standard
//
// Why generate instead of hand-editing: a hand-written config hardcodes one machine's absolute
// paths and one vault's layout, so every new vault (or sub-vault) needs the wiring redone and every
// move breaks it. This resolves the current vault, points the client at the `synapse-mcp` bin that
// npm installed *into that vault*, and rewrites the file idempotently. Plugins need no entry at all
// — the server discovers <vault>/_meta/mcp-plugins/*.mjs by convention.

import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveVault } from "./vault-root.mjs";

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const pick = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const surface = pick("surface", "full");
const client = pick("client", "all");

if (!["skeleton", "standard", "full"].includes(surface)) {
  console.error(`mcp-config: --surface must be skeleton|standard|full`);
  process.exit(2);
}
if (!["claude", "cursor", "all"].includes(client)) {
  console.error(`mcp-config: --client must be claude|cursor|all`);
  process.exit(2);
}

// preferCwd: this WRITES into a vault, so the vault you are standing in wins over a stale
// exported $SYNAPSE_VAULT (same guard as `synapse install` and `synapse new`).
const { root, vaultDir } = resolveVault({ preferCwd: true, readManifest: false });

// The bin npm installed for THIS vault. Falls back to the package's own bin when the vault IS the
// package repo (development), and finally to a bare `synapse-mcp` resolved on PATH.
function resolveServerCommand() {
  const local = join(root, "node_modules", ".bin", "synapse-mcp");
  if (existsSync(local)) return local;
  const own = new URL("../bin/synapse-mcp.mjs", import.meta.url).pathname;
  if (existsSync(own)) return own;
  return "synapse-mcp";
}

const command = resolveServerCommand();
const env = {
  SYNAPSE_VAULT: vaultDir,
  SYNAPSE_MCP_SURFACE: surface,
  // node:sqlite is behind a flag on the supported Node range; the server's child processes inherit it.
  NODE_OPTIONS: "--experimental-sqlite",
};

const entry = { command, args: [], env };
const claudeCfg = { mcpServers: { synapse: { type: "stdio", ...entry } } };
const cursorCfg = { mcpServers: { synapse: entry } };

const targets = [];
if (client === "claude" || client === "all") targets.push({ path: join(root, ".mcp.json"), cfg: claudeCfg, label: "Claude Code" });
if (client === "cursor" || client === "all") targets.push({ path: join(root, ".cursor", "mcp.json"), cfg: cursorCfg, label: "Cursor" });

console.log(`vault:   ${vaultDir}`);
console.log(`server:  ${command}`);
console.log(`surface: ${surface}`);
const pluginDir = join(vaultDir, "_meta", "mcp-plugins");
console.log(`plugins: ${existsSync(pluginDir) ? `auto-discovered from ${relative(root, pluginDir)}/` : "none (create _meta/mcp-plugins/ to add some)"}`);
console.log("");

let changed = 0;
for (const { path, cfg, label } of targets) {
  const next = `${JSON.stringify(cfg, null, 2)}\n`;
  const prev = existsSync(path) ? readFileSync(path, "utf8") : null;
  const same = prev === next;
  const rel = relative(root, path);
  if (!write) {
    console.log(`--- ${rel} (${label})${same ? " — already current" : ""} ---`);
    console.log(next);
    continue;
  }
  if (same) { console.log(`  unchanged  ${rel}`); continue; }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, next, "utf8");
  console.log(`  wrote      ${rel} (${label})`);
  changed++;
}

if (!write) {
  console.log("Re-run with --write to apply.");
} else {
  console.log(changed ? `\nRestart the client to pick up the change.` : `\nNothing to do.`);
}
