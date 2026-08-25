#!/usr/bin/env node
// client-config.mjs — ClientConfigPort: write ONE harness's MCP wiring file, idempotently.
//
// EXTRACTED, NOT INVENTED. Every line of per-client knowledge below already existed inside
// buildMcpTargets as an `if (client === …)` branch. Moving it here changes no behavior; it changes WHERE
// the knowledge lives, so that adding a fifth harness is one new adapter in this file rather than a
// fourth branch, a fourth carry-over probe and a fourth surface probe scattered across three functions.
//
// THE THREE CLIENTS GENUINELY DIFFER, which is why this is a port and not a config table:
//   • Claude Code  .mcp.json          { mcpServers: { synapse: { type:"stdio", command, args, env } } }
//   • Cursor       .cursor/mcp.json   { mcpServers: { synapse: { command, args, env } } }   (no `type`)
//   • opencode     opencode.json      { mcp: { synapse: { type:"local", command:[argv], environment } } }
// opencode alone uses a different top-level key, an ARRAY command, `environment` instead of `env`, and
// carries a model-provider block that is the USER's, not ours. A flat table cannot express that; a
// `merge()` method per adapter can.
//
// TWO GUARDS LIVE IN THE CONTRACT, NOT IN A COMMENT. Both already existed and both are easy to lose in
// a refactor, so lib/ports/client-config.test.mjs asserts them against EVERY adapter:
//   1. Foreign servers survive. A vault is a normal repo; its .mcp.json routinely holds github/postgres
//      rows a human added. Only the `synapse` key is ours.
//   2. A raised surface is never silently downgraded. Regeneration is exactly what the upgrade path
//      tells people to run, so a re-run that resets `orchestrator` to `full` is a data-loss bug.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { definePort, registry } from "./port.mjs";

export const ClientConfigPort = definePort({
  name: "ClientConfigPort",
  fields: ["label"],
  methods: ["configPath", "readEnv", "readSurface", "merge"],
  contract:
    "merge() is pure and idempotent; it preserves every foreign server already in the file and never "
    + "downgrades a surface the vault is already wired to.",
});

// ── shared helpers ────────────────────────────────────────────────────────────

/** Parse a JSON config, or null when absent/unreadable. Never throws — a bad file is a warning, not a crash. */
export function readConfig(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }  // undefined = present but unparseable
}

// Merge a `{ [key]: { synapse } }`-shaped config, keeping every OTHER server the user configured.
// Shared by claude and cursor, which differ only in their path and entry shape.
function mergeNamedServers({ prev, cfg, key, path, root, warn }) {
  if (prev === undefined) {
    warn(`${relative(root, path)} is not valid JSON — it will be REPLACED. Move it aside first if it matters.`);
    return cfg;
  }
  if (prev === null) return cfg;
  const foreign = { ...(prev?.[key] || {}) };
  delete foreign.synapse;
  const kept = Object.keys(foreign);
  if (kept.length) warn(`${relative(root, path)}: kept ${kept.length} other server(s) — ${kept.join(", ")}.`);
  return { ...prev, [key]: { ...(prev?.[key] || {}), ...cfg[key] } };
}

// ── opencode's provider policy — agnostic, and the ONLY provider synapse ever writes ──────────────
// Normalize any ollama base to the NATIVE provider's /api endpoint: strip a trailing /v1 (the
// OpenAI-compatible path) or /api, then re-append /api. Empty/undefined → localhost.
export function toApiBase(url) {
  const u = String(url || "").replace(/\/(v1|api)\/?$/, "").replace(/\/+$/, "");
  return (u || "http://localhost:11434") + "/api";
}

// Read the user's GLOBAL opencode config. Read-ONLY, and only to answer two agnostic questions: does a
// provider already exist anywhere (so we stay hands-off), and is the effective provider on ollama's /v1
// path (so we can advise). We never copy values out of it.
function readGlobalOpencode() {
  const p = join(homedir(), ".config", "opencode", "opencode.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// Minimal NATIVE ollama provider for the ZERO-CONFIG local case: localhost over ollama's /api endpoint
// (the /v1 path drops streamed tool-call deltas — opencode #20995, ollama #5769 — so tools go silent).
export function nativeOllamaProvider({ ollamaUrlOverride = process.env.SYNAPSE_OLLAMA_URL } = {}) {
  return {
    npm: "ollama-ai-provider-v2",
    name: "Ollama (native — tool calls round-trip; /v1 streaming drops them)",
    options: { baseURL: toApiBase(ollamaUrlOverride || "http://localhost:11434") },
  };
}

/** Is a provider config on ollama's OpenAI-compatible /v1 path? (the tool-call-dropping one.) */
export function providerUsesV1(prov) {
  if (!prov) return false;
  if (prov.npm === "@ai-sdk/openai-compatible") return true;
  return /\/v1\/?$/.test(String(prov.options?.baseURL || ""));
}

// ── adapters ──────────────────────────────────────────────────────────────────

const claude = {
  id: "claude",
  label: "Claude Code",
  configPath: (root) => join(root, ".mcp.json"),
  readEnv: (cfg) => cfg?.mcpServers?.synapse?.env,
  readSurface: (cfg) => cfg?.mcpServers?.synapse?.env?.SYNAPSE_MCP_SURFACE,
  merge({ root, path, prev, command, env, warn }) {
    const cfg = { mcpServers: { synapse: { type: "stdio", command, args: [], env } } };
    return mergeNamedServers({ prev, cfg, key: "mcpServers", path, root, warn });
  },
};

const cursor = {
  id: "cursor",
  label: "Cursor",
  configPath: (root) => join(root, ".cursor", "mcp.json"),
  readEnv: (cfg) => cfg?.mcpServers?.synapse?.env,
  readSurface: (cfg) => cfg?.mcpServers?.synapse?.env?.SYNAPSE_MCP_SURFACE,
  merge({ root, path, prev, command, env, warn }) {
    // No `type` key: Cursor's schema does not carry one, and adding it is not harmless noise.
    const cfg = { mcpServers: { synapse: { command, args: [], env } } };
    return mergeNamedServers({ prev, cfg, key: "mcpServers", path, root, warn });
  },
};

const opencode = {
  id: "opencode",
  label: "opencode",
  configPath: (root) => join(root, "opencode.json"),
  readEnv: (cfg) => cfg?.mcp?.synapse?.environment,
  readSurface: (cfg) => cfg?.mcp?.synapse?.environment?.SYNAPSE_MCP_SURFACE,
  merge({ prev, command, env, warn }) {
    // The writer OVERWRITES the whole file, so carry forward everything already there (a user's model /
    // small_model / provider / etc.). Only synapse's mcp entry — and, in a total vacuum, the native
    // ollama provider — are ours to set. Never wipe user config.
    const existing = (prev === null || prev === undefined) ? {} : prev;
    const merged = {
      ...existing,
      $schema: existing.$schema || "https://opencode.ai/config.json",
      mcp: {
        ...(existing.mcp || {}),
        synapse: { type: "local", command: [command], enabled: true, environment: env },
      },
    };

    // PROVIDER POLICY — agnostic. synapse owns the `mcp` entry, NOT your model runtime. We never clobber
    // a provider that exists (project OR global). We seed one in exactly ONE case — a total vacuum —
    // where a native localhost/api provider is the correct zero-config default and there is nothing to
    // overwrite. Whatever provider will be in effect, if it is on /v1 we ADVISE (never mutate).
    const projectProvider = existing?.provider?.ollama || null;
    const globalProvider = readGlobalOpencode()?.provider?.ollama || null;
    const effective = projectProvider || globalProvider;
    if (!effective) {
      merged.provider = { ...(merged.provider || {}), ollama: nativeOllamaProvider() };  // vacuum seed
    } else if (providerUsesV1(effective)) {
      const where = projectProvider ? "opencode.json" : "~/.config/opencode/opencode.json";
      warn(
        `opencode: your ollama provider (${where}) uses the /v1 path — MCP tool calls may silently not `
        + `fire (opencode #20995, ollama #5769). Switch it to the native provider: `
        + `npm "ollama-ai-provider-v2" and baseURL "${toApiBase(effective.options?.baseURL || "http://localhost:11434")}".`,
      );
    }
    return merged;
  },
};

// Registration order is the order targets are emitted, which the CLI's output and every existing test
// depend on — claude, cursor, opencode.
export const clientConfigAdapters = registry(ClientConfigPort, [claude, cursor, opencode]);
