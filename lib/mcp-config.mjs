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
import { homedir } from "node:os";
import { resolveVault } from "./vault-root.mjs";

export const MCP_SURFACES = ["skeleton", "standard", "full", "orchestrator"];
export const MCP_CLIENTS = ["claude", "cursor", "opencode", "all"];

// The bin npm installed for THIS vault. Falls back to the package's own bin when the vault IS the
// package repo (development), and finally to a bare `synapse-mcp` resolved on PATH.
// The surface a vault is ALREADY wired to, read back from whichever client configs exist. Regenerating
// used to reset every vault to `full`, so a vault deliberately raised to `orchestrator` was silently
// downgraded by the next `install --write` — which is exactly what the upgrade path tells people to run.
// Same principle as the opencode provider policy: the surface is the user's choice, not ours to reset.
export function existingSurface(root) {
  const probes = [
    [join(root, ".mcp.json"), (c) => c?.mcpServers?.synapse?.env?.SYNAPSE_MCP_SURFACE],
    [join(root, ".cursor", "mcp.json"), (c) => c?.mcpServers?.synapse?.env?.SYNAPSE_MCP_SURFACE],
    [join(root, "opencode.json"), (c) => c?.mcp?.synapse?.environment?.SYNAPSE_MCP_SURFACE],
  ];
  const found = [];
  for (const [path, read] of probes) {
    if (!existsSync(path)) continue;
    try {
      const v = read(JSON.parse(readFileSync(path, "utf8")));
      if (v && MCP_SURFACES.includes(v)) found.push(v);
    } catch { /* unreadable/!json — nothing to read back */ }
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

// Normalize any ollama base to the NATIVE provider's /api endpoint: strip a trailing /v1 (the
// OpenAI-compatible path) or /api, then re-append /api. Empty/undefined → localhost.
function toApiBase(url) {
  const u = String(url || "").replace(/\/(v1|api)\/?$/, "").replace(/\/+$/, "");
  return (u || "http://localhost:11434") + "/api";
}

// Read the user's GLOBAL opencode config (~/.config/opencode/opencode.json). Read-ONLY, and only to
// answer two agnostic questions: does a provider already exist anywhere (so we stay hands-off), and is
// the effective provider on ollama's /v1 path (so we can advise). We never copy values out of it.
function readGlobalOpencode() {
  const p = join(homedir(), ".config", "opencode", "opencode.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// Minimal NATIVE ollama provider for the ZERO-CONFIG local case: localhost over ollama's /api endpoint
// (the /v1 path drops streamed tool-call deltas — opencode #20995, ollama #5769 — so tools go silent).
// SYNAPSE_OLLAMA_URL overrides the host. This is the ONLY provider synapse ever writes, and ONLY into a
// total vacuum (see below) — so `localhost` is correct by definition (there is no other endpoint known)
// and nothing is clobbered.
export function nativeOllamaProvider({ ollamaUrlOverride = process.env.SYNAPSE_OLLAMA_URL } = {}) {
  return {
    npm: "ollama-ai-provider-v2",
    name: "Ollama (native — tool calls round-trip; /v1 streaming drops them)",
    options: { baseURL: toApiBase(ollamaUrlOverride || "http://localhost:11434") },
  };
}

// Is a provider config on ollama's OpenAI-compatible /v1 path? (the tool-call-dropping one.)
export function providerUsesV1(prov) {
  if (!prov) return false;
  if (prov.npm === "@ai-sdk/openai-compatible") return true;
  return /\/v1\/?$/.test(String(prov.options?.baseURL || ""));
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

  // Carry forward every OTHER server already configured for a client. Only the `synapse` key is ours;
  // a vault is a normal repo and its .mcp.json routinely holds github/postgres/whatever rows a user set
  // up by hand. Regenerating used to replace the whole file, silently deleting them — the opencode
  // branch below already got this right ("never wipe user config") and these two did not.
  function mergeServers(path, cfg, key) {
    if (!existsSync(path)) return cfg;
    let prev;
    try {
      prev = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Unparseable: say so rather than quietly overwrite something the user may still want.
      warnings.push(`${relative(root, path)} is not valid JSON — it will be REPLACED. Move it aside first if it matters.`);
      return cfg;
    }
    const foreign = { ...(prev?.[key] || {}) };
    delete foreign.synapse;
    const kept = Object.keys(foreign);
    if (kept.length) warnings.push(`${relative(root, path)}: kept ${kept.length} other server(s) — ${kept.join(", ")}.`);
    return { ...prev, [key]: { ...(prev?.[key] || {}), ...cfg[key] } };
  }

  const entry = { command, args: [], env };
  const claudeCfg = { mcpServers: { synapse: { type: "stdio", ...entry } } };
  const cursorCfg = { mcpServers: { synapse: entry } };
  // opencode uses a DIFFERENT shape and does not read .mcp.json / .cursor/mcp.json at all: the key is
  // `mcp` (not `mcpServers`), `command` is an ARRAY (argv), and env is `environment`.
  const opencodeSynapse = { type: "local", command: [command], enabled: true, environment: env };

  const targets = [];
  if (client === "claude" || client === "all") {
    const p = join(root, ".mcp.json");
    targets.push({ path: p, cfg: mergeServers(p, claudeCfg, "mcpServers"), label: "Claude Code" });
  }
  if (client === "cursor" || client === "all") {
    const p = join(root, ".cursor", "mcp.json");
    targets.push({ path: p, cfg: mergeServers(p, cursorCfg, "mcpServers"), label: "Cursor" });
  }
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

    // PROVIDER POLICY — agnostic. synapse owns the `mcp` entry, NOT your model runtime. The provider is
    // the user's config: we never clobber one that exists (project OR global). We seed a provider in
    // exactly ONE case — a total vacuum (no project provider AND no global one) — where a native
    // localhost/api provider is the correct zero-config local default and there is nothing to overwrite.
    // Whatever provider will actually be in effect, if it is on the /v1 path we ADVISE (never mutate).
    const projectProvider = existingOc?.provider?.ollama || null;
    const globalProvider = readGlobalOpencode()?.provider?.ollama || null;
    const effectiveProvider = projectProvider || globalProvider;
    if (!effectiveProvider) {
      merged.provider = { ...(merged.provider || {}), ollama: nativeOllamaProvider() };  // vacuum seed
    } else if (providerUsesV1(effectiveProvider)) {
      const where = projectProvider ? "opencode.json" : "~/.config/opencode/opencode.json";
      warnings.push(
        `opencode: your ollama provider (${where}) uses the /v1 path — MCP tool calls may silently not ` +
        `fire (opencode #20995, ollama #5769). Switch it to the native provider: ` +
        `npm "ollama-ai-provider-v2" and baseURL "${toApiBase(effectiveProvider.options?.baseURL || "http://localhost:11434")}".`,
      );
    }
    targets.push({ path: ocPath, cfg: merged, label: "opencode" });
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
