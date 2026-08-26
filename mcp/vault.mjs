// vault.mjs — the pure helpers every tool shares, plus the DEPRECATED single-vault surface.
//
// A bound vault is now a VALUE: see ./vault-context.mjs, and buildServer({ vault }) for where one is
// minted. This file keeps two things.
//
// 1. THE VAULT-INDEPENDENT HELPERS. `asToolResult`, `normalizeAgentId` and `readFrontmatter` are pure
//    functions of their arguments — they never needed a vault, and duplicating them into the context
//    would have implied they did.
//
// 2. THE BACK-COMPAT SURFACE, deprecated but load-bearing. `VAULT`, `AGENTS_DIR`, `manifest()` and the
//    rest are the documented contract for out-of-tree MCP plugins — <vault>/_meta/mcp-plugins/*.mjs is
//    a public extension point, and a vault on disk somewhere is importing these names right now.
//    Removing them would break code we do not ship and cannot test. They behave exactly as before:
//    resolved once, from the environment, at module load.
//
//    NOTHING IN THIS PACKAGE MAY USE THEM ANY MORE. They are module-load constants, so under an HTTP
//    handler — where one process serves many vaults — they answer for whichever vault loaded first.
//    That is the whole bug Epic 1 removes. A plugin that wants to be multi-vault-correct reads
//    `ctx.vault` (the bound context, passed to register()) instead; `ctx.VAULT` remains for the ones
//    that do not.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envPinnedContext, createVaultContext, SYNAPSE_BIN } from "./vault-context.mjs";

export { SYNAPSE_BIN, createVaultContext, envPinnedContext };

// ── pure helpers (no vault involved) ─────────────────────────────────────────

export function asToolResult(res, { emptyMessage = "(no output)" } = {}) {
  if (res.timedOut) {
    return {
      isError: true,
      content: [{ type: "text", text: `Timed out.\n\n--- engine log ---\n${res.stderr}` }],
    };
  }
  if (res.code !== 0) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `Exited ${res.code}.\n\n--- stderr ---\n${res.stderr}\n\n--- stdout ---\n${res.stdout}`,
      }],
    };
  }
  const body = res.stdout.trim() || emptyMessage;
  const log = res.stderr.trim();
  return {
    content: [{ type: "text", text: log ? `${body}\n\n--- engine log ---\n${log}` : body }],
  };
}

export function normalizeAgentId(agent) {
  const a = String(agent).trim();
  return a.startsWith("agent-") ? a : `agent-${a}`;
}

export function readFrontmatter(path) {
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim().replace(/^["']|["']$/g, "");
      out[key] = v === "" ? [] : v;
    } else if (key && /^\s*-\s+/.test(line)) {
      if (!Array.isArray(out[key])) out[key] = [];
      out[key].push(line.replace(/^\s*-\s+/, "").trim());
    }
  }
  return out;
}

// ── DEPRECATED single-vault surface — for out-of-tree plugins only ───────────
// Resolved once, at module load, exactly as before. Do not add a caller inside this package.

/** @deprecated read `ctx.vault` (a bound context) instead — this answers for one vault per process. */
const legacy = envPinnedContext();

/** @deprecated */ export const VAULT = legacy.vaultDir;
/** @deprecated */ export const AGENTS_DIR = legacy.agentsDir;
/** @deprecated */ export const HANDOVER_DIR = legacy.handoverDir;

/** @deprecated */ export function manifest() { return legacy.manifest; }
/** @deprecated */ export function assertVault() { return legacy.assertVault(); }
/** @deprecated */ export function runSynapse(args, opts) { return legacy.runSynapse(args, opts); }
/** @deprecated */ export function listAgentFiles() { return legacy.listAgentFiles(); }
/** @deprecated */ export function listHubFiles() { return legacy.listHubFiles(); }
/** @deprecated */ export function listHandoverFiles() { return legacy.listHandoverFiles(); }
/** @deprecated */ export function ensureHandoverDir() { return legacy.ensureHandoverDir(); }
/** @deprecated */ export function writeHandoverNote(f, b) { return legacy.writeHandoverNote(f, b); }

/**
 * @deprecated pass the bound context instead.
 * Kept resolving FRESH per call (not from `legacy`): that was already this function's documented
 * behaviour, and a test process driving several vaults depends on it.
 */
export function vaultContext() {
  const c = envPinnedContext();
  return { root: c.root, vaultDir: c.vaultDir, manifest: c.manifest };
}

export { existsSync, readFileSync, join };
