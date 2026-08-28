// vault-pool.mjs — one Synapse MCP process per vault, shared by every session in that vault.
//
// The shape is deliberately copied from dsh's own `lsp-stdio`, which pools one language server per
// workspace and routes each call by the calling session's cwd. That is the same problem with `gopls`
// where Synapse goes, and it is already shipping in-tree — so this is a known-good pattern rather than
// invented plumbing.
//
// WHY ONE PROCESS PER VAULT AND NOT ONE PROCESS TOTAL. Synapse binds a vault by the directory it was
// launched in, and a stdio server is one connection to one vault. A single shared process would need
// the vault to travel on each call, which is the thing decision-0010 refused. Per-vault children keep
// the binding structural: the child cannot answer from a vault it was never pointed at.
//
// The cost is real and bounded: ~85 MB resident per live child, for vaults actually opened, not vaults
// registered. Idle eviction returns it.

import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { canonical, readVaultDirectory } from "../lib/vault-for-cwd.mjs";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

/**
 * @param {object} [options]
 * @param {number} [options.idleMs]  how long an unused child lives before eviction; 0 disables.
 * @param {string} [options.httpUrl]  base MCP HTTP URL (`http://127.0.0.1:3000/mcp`). When set,
 *   children are HTTP clients to `${httpUrl}/<vault-id>` instead of stdio spawns — the container
 *   case, where synapse-core is already the only writer.
 * @param {string} [options.token]    bearer for that HTTP path.
 * @param {string} [options.surface] the everyday tool ceiling handed to each child.
 * @param {(line: string) => void} [options.log]
 */
export function createVaultPool({
  idleMs = DEFAULT_IDLE_MS,
  surface = "orchestrator",
  log = () => {},
  httpUrl = "",
  token = "",
  spawnChild = httpUrl ? makeHttpSpawner({ httpUrl, token, log }) : defaultSpawnChild,
} = {}) {
  /** canonical vault root → entry */
  const live = new Map();
  let disposed = false;

  function evict(key, why) {
    const entry = live.get(key);
    if (!entry) return;
    live.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    log(`[synapse-vault-pool] closing ${key} (${why})`);
    Promise.resolve(entry.close()).catch(() => { /* already gone */ });
  }

  function scheduleIdle(key) {
    const entry = live.get(key);
    if (!entry || entry.refs > 0 || idleMs <= 0) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => evict(key, "idle"), idleMs);
    // Never let a pooled child keep the host process alive.
    if (typeof entry.idleTimer.unref === "function") entry.idleTimer.unref();
  }

  return {
    get size() { return live.size; },

    /**
     * Get-or-spawn the child for `vaultRoot`, reference-counted.
     *
     * Concurrent callers for one vault share a single spawn: the pending promise is stored, not the
     * settled client, so two sessions starting at once cannot race two children onto one vault.
     */
    async acquire(vaultRoot) {
      if (disposed) throw new Error("vault pool is disposed");
      const key = canonical(vaultRoot);

      let entry = live.get(key);
      if (entry) {
        if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
      } else {
        entry = { refs: 0, idleTimer: null, ready: null, close: () => {} };
        live.set(key, entry);
        entry.ready = (async () => {
          const child = await spawnChild({ vaultRoot: key, surface, log });
          entry.close = child.close;
          // A child that dies takes its pool slot with it, so the next acquire spawns a fresh one
          // rather than handing out a client whose transport is already gone.
          child.onExit(() => {
            if (live.get(key) === entry) {
              live.delete(key);
              log(`[synapse-vault-pool] ${key} exited; it will respawn on next use`);
            }
          });
          return child.client;
        })();
        entry.ready.catch(() => { if (live.get(key) === entry) live.delete(key); });
      }

      entry.refs += 1;
      let client;
      try {
        client = await entry.ready;
      } catch (error) {
        entry.refs -= 1;
        throw error;
      }

      let released = false;
      return {
        client,
        release() {
          if (released) return;
          released = true;
          const current = live.get(key);
          if (current !== entry) return;   // already evicted or replaced
          entry.refs = Math.max(0, entry.refs - 1);
          scheduleIdle(key);
        },
      };
    },

    async disposeAll() {
      disposed = true;
      for (const key of [...live.keys()]) evict(key, "pool disposed");
    },
  };
}

/** Spawn `synapse-mcp` over stdio, bound to one vault by the directory it is launched in. */
async function defaultSpawnChild({ vaultRoot, surface, log }) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("@modelcontextprotocol/client/stdio"),
  ]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-sqlite", join(PKG_ROOT, "bin", "synapse-mcp.mjs")],
    cwd: vaultRoot,
    env: {
      ...process.env,
      // Both, deliberately: cwd is how a stdio server binds, and the env var is what survives a host
      // that scrubs or rewrites the child's working directory.
      SYNAPSE_VAULT: vaultRoot,
      SYNAPSE_MCP_SURFACE: surface,
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "synapse-vault-router", version: "1" }, { capabilities: {} });
  const exitHandlers = new Set();
  transport.onclose = () => { for (const fn of exitHandlers) fn(); };
  transport.onerror = (error) => log(`[synapse-vault-pool] ${vaultRoot}: ${error?.message || error}`);

  await client.connect(transport);
  log(`[synapse-vault-pool] started ${vaultRoot} (surface=${surface})`);

  return {
    client,
    onExit(fn) { exitHandlers.add(fn); },
    async close() {
      exitHandlers.clear();
      try { await client.close(); } catch { /* transport already gone */ }
    },
  };
}

function vaultIdForRoot(vaultRoot) {
  const key = canonical(vaultRoot);
  const hit = (readVaultDirectory().vaults || []).find((v) => canonical(v.root) === key);
  return hit?.id || null;
}

async function loadHttpClient() {
  const mod = await import("@modelcontextprotocol/client");
  if (mod.StreamableHTTPClientTransport) {
    return { Client: mod.Client, StreamableHTTPClientTransport: mod.StreamableHTTPClientTransport };
  }
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  return { Client: mod.Client, StreamableHTTPClientTransport };
}

/** HTTP to synapse-core: same pool shape, no extra MCP process. */
function makeHttpSpawner({ httpUrl, token, log }) {
  const base = String(httpUrl || "").replace(/\/+$/, "");
  return async ({ vaultRoot }) => {
    const id = vaultIdForRoot(vaultRoot);
    if (!id) throw new Error(`no registered vault id for ${vaultRoot}`);
    if (!token) throw new Error("SYNAPSE_MCP_TOKEN is empty — cannot reach synapse-core");
    const url = `${base}/${encodeURIComponent(id)}`;
    const { Client, StreamableHTTPClientTransport } = await loadHttpClient();
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      authProvider: { token: async () => token },
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "synapse-vault-router", version: "1" }, { capabilities: {} });
    const exitHandlers = new Set();
    transport.onclose = () => { for (const fn of exitHandlers) fn(); };
    transport.onerror = (error) => log(`[synapse-vault-pool] ${id}: ${error?.message || error}`);
    await client.connect(transport);
    log(`[synapse-vault-pool] http ${id} → ${url}`);
    return {
      client,
      onExit(fn) { exitHandlers.add(fn); },
      async close() {
        exitHandlers.clear();
        try { await client.close(); } catch { /* already gone */ }
      },
    };
  };
}
