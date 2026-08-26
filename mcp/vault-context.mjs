// vault-context.mjs — ONE bound vault, as a value you pass around.
//
// WHAT THIS REPLACES, AND WHY IT HAD TO GO. mcp/vault.mjs resolved the vault ONCE, at module load,
// into a `VAULT` constant, and ~60 references across eight modules read it. On stdio that is exactly
// right and decision-0010 says so: one connection is one process is one vault, so "the vault" and
// "this request's vault" are the same string and a constant cannot be wrong.
//
// Off stdio it is wrong, quietly. The MCP SDK's own contract is the proof:
//
//     type McpServerFactory = (ctx: McpRequestContext) => McpServer | Server | Promise<…>
//     // createMcpHandler calls it ONCE PER HTTP REQUEST (with authInfo);
//     // serveStdio calls it ONCE PER CONNECTION.
//
// So under HTTP the module is loaded once and serves many vaults, and every tool would answer from
// whichever vault happened to win the import race. That failure mode is worse than having no HTTP at
// all, because a wrong answer from the wrong vault looks exactly like a right one.
//
// WHY A VALUE AND NOT AN AsyncLocalStorage. A per-request global would work, and it would also mean
// every tool could reach any vault by reading an ambient name — isolation would rest on nobody making
// a mistake. Here a handler closes over the context it was BUILT with and there is no other name to
// read, so "two vaults in one process share nothing" is a property of the wiring rather than a rule
// people follow. That is the sentence US-1.3 asks a test to prove.
//
// WHAT IT DELIBERATELY IS NOT. It is not a cache, and it opens nothing. Database handles and epochs
// belong to VaultStorePort (lib/ports/vault-store.mjs), keyed by vaultDir; this object carries the
// KEY, never the handle. Two contexts for the same vault are therefore interchangeable and cheap —
// which is what lets buildServer() mint one per connection without a second thought.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { vaultBindingAdapters } from "../lib/ports/index.mjs";

// The CLI is a sibling in THIS package — never in the consumer's node_modules. Package-level, not
// vault-level: every context shells out to the same binary.
export const SYNAPSE_BIN = fileURLToPath(new URL("../bin/synapse.mjs", import.meta.url));

// Directories never worth walking for hubs. Consumer-specific exclusions belong in the manifest's
// `skipDirs` (the same list the linter honours) — never hardcoded here.
const HUB_WALK_SKIP_BASE = ["node_modules", ".git", ".cursor", "db", "migrations", "inbox"];

/**
 * Build a bound vault context.
 *
 * `ok:false` is a first-class outcome, not a throw: a misconfigured vault must fail in assertVault()
 * with a message a human can act on, rather than during module evaluation — which an MCP client
 * reports only as "the server crashed".
 *
 * @param {object}  spec
 * @param {string}  spec.root      repo root (may differ from vaultDir in a nested layout)
 * @param {string}  spec.vaultDir  the vault itself — the VaultStorePort key
 * @param {object}  spec.manifest  context.manifest.json, or {}
 * @param {boolean} spec.ok        false when nothing resolved; assertVault() then explains why
 * @param {string}  spec.reason    why it did not resolve
 */
export function createVaultContext({ root, vaultDir, manifest = {}, ok = true, reason = "" } = {}) {
  if (!vaultDir) throw new Error("createVaultContext: vaultDir is required — refusing to guess a vault");
  const agentsDir = join(vaultDir, "agents");
  const handoverDir = join(vaultDir, "inbox", "handovers");

  const ctx = {
    // ── identity ──────────────────────────────────────────────────────────────
    // These three names match what lib/recall.mjs expects of a vault, so a context is accepted there
    // unchanged. Keep them that way: recall is the one engine module a context is handed to whole.
    root: root || vaultDir,
    vaultDir,
    manifest,
    agentsDir,
    handoverDir,
    ok,
    reason,

    /** Loud, actionable failure — the one place a bad vault is allowed to stop the process. */
    assertVault() {
      if (!ok) {
        throw new Error(
          `Synapse vault not found (no _meta/tools/context.manifest.json at or above ${process.cwd()}). `
          + `Set SYNAPSE_VAULT to the vault root.${reason ? ` (${reason})` : ""}`,
        );
      }
      if (!existsSync(SYNAPSE_BIN)) {
        throw new Error(`Missing the synapse CLI at ${SYNAPSE_BIN} — reinstall @eborja/synapse.`);
      }
    },

    /**
     * Run `node synapse.mjs <args…>` against THIS vault. Both cwd and $SYNAPSE_VAULT are pinned to
     * this context — the child re-resolves the vault itself, and if we let it inherit the parent's
     * env it would answer for the server's vault rather than the request's. Never throws on a
     * non-zero exit: returns { code, stdout, stderr, timedOut }.
     */
    runSynapse(args = [], { timeoutMs = 180_000 } = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [SYNAPSE_BIN, ...args], {
          cwd: vaultDir,
          env: { ...process.env, SYNAPSE_VAULT: vaultDir },
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
    },

    // ── vault contents ────────────────────────────────────────────────────────
    listAgentFiles() {
      if (!existsSync(agentsDir)) return [];
      return readdirSync(agentsDir)
        .filter((f) => f.startsWith("agent-") && f.endsWith(".md"))
        .sort();
    },

    /** hub-*.md at the vault root plus everything under hub/, deduped by id. */
    listHubFiles() {
      const out = [];
      const seen = new Set();
      const skip = new Set([...HUB_WALK_SKIP_BASE, ...(manifest.skipDirs || [])]);

      const take = (dir) => {
        if (!existsSync(dir)) return;
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (ent.name.startsWith(".")) continue;
          const p = join(dir, ent.name);
          if (ent.isDirectory()) {
            if (skip.has(ent.name)) continue;
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
      if (existsSync(vaultDir)) {
        for (const f of readdirSync(vaultDir)) {
          if (!f.startsWith("hub-") || !f.endsWith(".md")) continue;
          const id = f.replace(/\.md$/, "");
          if (seen.has(id)) continue;
          seen.add(id);
          out.push({ id, path: join(vaultDir, f) });
        }
      }
      take(join(vaultDir, "hub"));
      return out.sort((a, b) => a.id.localeCompare(b.id));
    },

    listHandoverFiles() {
      if (!existsSync(handoverDir)) return [];
      return readdirSync(handoverDir)
        .filter((f) => f.endsWith(".md") && f !== "README.md")
        .sort()
        .reverse();
    },

    ensureHandoverDir() {
      mkdirSync(handoverDir, { recursive: true });
    },

    writeHandoverNote(filename, body) {
      ctx.ensureHandoverDir();
      const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "-");
      const path = join(handoverDir, safe.endsWith(".md") ? safe : `${safe}.md`);
      writeFileSync(path, body, "utf8");
      return path;
    },
  };

  return ctx;
}

/**
 * The context for a process that serves ONE vault chosen by its environment — today's stdio server.
 *
 * Resolved FRESH on every call, deliberately. A module-load memo is the exact bug this file exists to
 * remove, and resolution is a couple of stat() calls: cheap enough that "always current" beats "cached
 * and occasionally lying". It also keeps a single test process that drives several vaults honest,
 * which is how US-1.1 is tested at all.
 *
 * Routed through VaultBindingPort rather than calling resolveVault() directly: the port's contract is
 * that a vault comes from the caller's identity and never from a tool argument, and Epic 2 swaps the
 * bearer adapter in HERE without touching a single tool module.
 */
export function envPinnedContext() {
  const r = vaultBindingAdapters.get("env-pinned").bind();
  if (r.ok) return createVaultContext({ root: r.root, vaultDir: r.vaultDir, manifest: r.manifest || {} });
  // Best-effort shape so assertVault() can produce the good message. Nothing may READ from it first.
  const fallback = process.env.SYNAPSE_VAULT || process.cwd();
  return createVaultContext({ root: fallback, vaultDir: fallback, manifest: {}, ok: false, reason: r.reason });
}
