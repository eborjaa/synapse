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
import { clientConfigAdapters, readConfig } from "./ports/client-config.mjs";

// Re-exported for back-compat: these moved into the opencode ADAPTER (that is where the knowledge
// belongs), but they were public API of this module and lib/mcp-config.test.mjs imports them from here.
export { nativeOllamaProvider, providerUsesV1, toApiBase } from "./ports/client-config.mjs";

export const MCP_SURFACES = ["skeleton", "standard", "full", "orchestrator"];
// Derived from the registry, never hand-listed: a new adapter must not require editing this line.
export const MCP_CLIENTS = [...clientConfigAdapters.ids(), "all"];

// The bin npm installed for THIS vault. Falls back to the package's own bin when the vault IS the
// package repo (development), and finally to a bare `synapse-mcp` resolved on PATH.
// The surface a vault is ALREADY wired to, read back from whichever client configs exist. Regenerating
// used to reset every vault to `full`, so a vault deliberately raised to `orchestrator` was silently
// downgraded by the next `install --write` — which is exactly what the upgrade path tells people to run.
// Same principle as the opencode provider policy: the surface is the user's choice, not ours to reset.
export function existingSurface(root) {
  const found = [];
  for (const a of clientConfigAdapters.all()) {
    const cfg = readConfig(a.configPath(root));
    if (!cfg) continue;                     // null = absent, undefined = unreadable; nothing to read either way
    const v = a.readSurface(cfg);
    if (v && MCP_SURFACES.includes(v)) found.push(v);
  }
  const distinct = [...new Set(found)];
  return { surface: distinct.length === 1 ? distinct[0] : null, found: distinct };
}

export function resolveServerCommand(root) {
  const local = join(root, "node_modules", ".bin", "synapse-mcp");
  if (existsSync(local)) return local;
  const own = new URL("../bin/synapse-mcp.mjs", import.meta.url).pathname;
  if (existsSync(own)) return own;
  return "synapse-mcp";
}

// Build the list of { path, cfg, label } targets for a vault. Pure except for reading any existing
// config files (needed to carry over user env / model / provider) — writes nothing.
// `surface: null` (the default) means KEEP whatever this vault is already wired to, falling back to
// `full` for a vault with no config yet. Pass an explicit surface to change it.
export function buildMcpTargets({ root, vaultDir, surface = null, client = "all", extraEnv = {} } = {}) {
  const command = resolveServerCommand(root);
  const warnings = [];
  const prior = existingSurface(root);
  const resolved = surface || prior.surface || "full";
  const surfaceSource = surface ? "--surface" : prior.surface ? "kept from this vault's existing config" : "default";
  if (!surface && prior.found.length > 1) {
    warnings.push(
      `your clients disagree on the MCP surface (${prior.found.join(" vs ")}) — defaulting to `
      + `${resolved}. Pass --surface to set them all deliberately.`,
    );
  }
  const env = {
    SYNAPSE_VAULT: vaultDir,
    SYNAPSE_MCP_SURFACE: resolved,
    // node:sqlite is behind a flag on the supported Node range; the server's child processes inherit it.
    NODE_OPTIONS: "--experimental-sqlite",
    ...extraEnv,
  };

  const warn = (m) => warnings.push(m);

  // Carry over any extra env already present in a target config. A vault PLUGIN can require env of its
  // own (a missing one makes the plugin throw and takes the WHOLE server down, per rule-synapse-fail-
  // loudly) — so a var set for one client must not be silently dropped for another. Read from EVERY
  // adapter regardless of which client we are about to write: the env is shared, the files are not.
  for (const a of clientConfigAdapters.all()) {
    const cfg = readConfig(a.configPath(root));
    if (!cfg) continue;
    for (const [k, v] of Object.entries(a.readEnv(cfg) || {})) if (!(k in env)) env[k] = v;
  }

  // One target per selected adapter. Each adapter owns its own path, config shape and merge strategy —
  // including keeping every foreign server the user configured, which is part of the port's contract.
  const targets = [];
  for (const a of clientConfigAdapters.select(client)) {
    const path = a.configPath(root);
    targets.push({
      path,
      cfg: a.merge({ root, path, prev: readConfig(path), command, env, warn }),
      label: a.label,
    });
  }

  return { command, env, targets, warnings, surface: resolved, surfaceSource };
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
      if (!same) changed++;   // count in dry-run too, so the trailer can say whether anything WOULD change
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
  const surface = pick("surface", null);   // null = keep this vault's existing surface
  const client = pick("client", "all");

  // Keep in step with mcp/server.mjs's surface list — `orchestrator` (full + dedup-safe delegation) was
  // added in 0.10 and this validator was never updated, so `--surface orchestrator` was rejected even
  // though the server accepts it.
  if (surface !== null && !MCP_SURFACES.includes(surface)) {
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

  const { command, targets, warnings, surface: resolvedSurface, surfaceSource } = buildMcpTargets({ root, vaultDir, surface, client, extraEnv });

  console.log(`vault:   ${vaultDir}`);
  console.log(`server:  ${command}`);
  console.log(`surface: ${resolvedSurface}   (${surfaceSource})`);
  const pluginDir = join(vaultDir, "_meta", "mcp-plugins");
  console.log(`plugins: ${existsSync(pluginDir) ? `auto-discovered from ${relative(root, pluginDir)}/` : "none (create _meta/mcp-plugins/ to add some)"}`);
  console.log("");

  const changed = applyMcpTargets(targets, { root, write });

  for (const w of warnings) console.log(`\n⚠ ${w}`);
  if (!write) {
    console.log(changed
      ? `\n${changed} file(s) would change. Re-run with --write to apply.`
      : "\nAll current — nothing to do.");
  } else {
    console.log(changed ? `\nRestart the client to pick up the change.` : `\nNothing to do.`);
  }
}

// Run the CLI only when invoked directly (synapse mcp-config) — NOT when imported by `synapse install`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
