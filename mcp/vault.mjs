// vault.mjs — Synapse vault root + subprocess helper (shell out to the @eborja/synapse CLI).
//
// This module ships INSIDE the package, so it must never assume it lives under the consumer's
// vault: the vault is located with lib/vault-root.mjs (the same resolver every other tool uses),
// and the CLI is resolved relative to this package rather than the consumer's node_modules.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveVault } from "../lib/vault-root.mjs";

// The CLI is a sibling in this package — not in the consumer's node_modules.
export const SYNAPSE_BIN = fileURLToPath(new URL("../bin/synapse.mjs", import.meta.url));

// Resolve tolerantly at import time so a misconfigured vault fails in assertVault() with a good
// message, rather than throwing during module evaluation (which the MCP client reports as a crash).
let _resolved = null;
function resolved() {
  if (_resolved === null) {
    // preferCwd:false — the MCP server is config-pinned: the harness launches it with $SYNAPSE_VAULT
    // set in .mcp.json, and a long-lived server cannot `cd`, so the env is the authoritative vault and
    // must win over whatever cwd the harness happened to start in. (Interactive tools use the cwd-first
    // default; see lib/vault-root.mjs.)
    try { _resolved = resolveVault({ readManifest: true, preferCwd: false }); } catch { _resolved = false; }
  }
  return _resolved || null;
}

export const VAULT = resolved()?.vaultDir || process.env.SYNAPSE_VAULT || process.cwd();

/** The consumer's context.manifest.json, or {} when the vault could not be resolved. */
export function manifest() {
  return resolved()?.manifest || {};
}

/**
 * The server's PINNED vault context ({root, vaultDir, manifest}) — for in-process libs (recall) that
 * would otherwise re-resolve with the cwd-first default and could pick a different vault than the rest
 * of this env-pinned server. Resolved FRESH each call (preferCwd:false, so env wins) rather than from
 * the module-load memo: resolution is cheap, a fresh read honors the current pin, and it keeps a
 * single test process that drives many vaults correct (the memo would pin the first one). Falls back
 * to a best-effort shape when no vault resolves.
 */
export function vaultContext() {
  try {
    const r = resolveVault({ readManifest: true, preferCwd: false });
    return { root: r.root, vaultDir: r.vaultDir, manifest: r.manifest || {} };
  } catch {
    const fallback = process.env.SYNAPSE_VAULT || process.cwd();
    return { root: fallback, vaultDir: fallback, manifest: {} };
  }
}

export const AGENTS_DIR = join(VAULT, "agents");
export const HANDOVER_DIR = join(VAULT, "inbox", "handovers");

export function assertVault() {
  if (!resolved()) {
    throw new Error(
      `Synapse vault not found (no _meta/tools/context.manifest.json at or above ${process.cwd()}). `
      + `Set SYNAPSE_VAULT to the vault root.`,
    );
  }
  if (!existsSync(SYNAPSE_BIN)) {
    throw new Error(`Missing the synapse CLI at ${SYNAPSE_BIN} — reinstall @eborja/synapse.`);
  }
}

/**
 * Run `node synapse.mjs <args…>` with cwd=VAULT. stdout/stderr captured separately.
 * Never throws on non-zero exit — returns { code, stdout, stderr, timedOut }.
 */
export function runSynapse(args = [], { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SYNAPSE_BIN, ...args], {
      cwd: VAULT,
      env: { ...process.env, SYNAPSE_VAULT: VAULT },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

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

export function listAgentFiles() {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.startsWith("agent-") && f.endsWith(".md"))
    .sort();
}

// Directories never worth walking for hubs. Consumer-specific exclusions belong in the manifest's
// `skipDirs` (the same list the linter honours) — never hardcoded here.
const HUB_WALK_SKIP_BASE = ["node_modules", ".git", ".cursor", "db", "migrations", "inbox"];

/** Find hub-*.md under the vault (recursive under hub/ + vault root). */
export function listHubFiles() {
  const out = [];
  const seen = new Set();
  const HUB_WALK_SKIP = new Set([...HUB_WALK_SKIP_BASE, ...(manifest().skipDirs || [])]);

  const take = (dir) => {
    if (!existsSync(dir)) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (HUB_WALK_SKIP.has(ent.name)) continue;
        take(p);
        continue;
      }
      if (!ent.isFile() || !ent.name.startsWith("hub-") || !ent.name.endsWith(".md")) continue;
      const id = ent.name.replace(/\.md$/, "");
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, path: p });
    }
  };

  // Root-level hub-*.md (e.g. hub-synapse.md) without walking the whole vault tree.
  if (existsSync(VAULT)) {
    for (const f of readdirSync(VAULT)) {
      if (!f.startsWith("hub-") || !f.endsWith(".md")) continue;
      const id = f.replace(/\.md$/, "");
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, path: join(VAULT, f) });
    }
  }
  take(join(VAULT, "hub"));
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function listHandoverFiles() {
  if (!existsSync(HANDOVER_DIR)) return [];
  return readdirSync(HANDOVER_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => {
      const p = join(HANDOVER_DIR, f);
      let mtime = 0;
      try { mtime = readFileSync(p).length; } catch { /* ignore */ }
      return f;
    })
    .sort()
    .reverse();
}

export function ensureHandoverDir() {
  mkdirSync(HANDOVER_DIR, { recursive: true });
}

export function writeHandoverNote(filename, body) {
  ensureHandoverDir();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "-");
  const path = join(HANDOVER_DIR, safe.endsWith(".md") ? safe : `${safe}.md`);
  writeFileSync(path, body, "utf8");
  return path;
}

export { existsSync, readFileSync, join };
