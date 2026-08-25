#!/usr/bin/env node
// vault-store.mjs — VaultStorePort: every vault handle and epoch, keyed BY VAULT.
//
// WHAT WAS WRONG, PRECISELY. Three module-level singletons decided a vault at IMPORT time:
//
//   mcp/tools/spawn.mjs      const EPOCH = randomUUID()   // minted once per module load
//                            let _db  = null              // one durable-spawn handle, ever
//                            let _edb = null              // one episodes handle, ever
//   mcp/tools/episodes.mjs   let _db  = null              // one episodes handle, ever
//
// On stdio all three are CORRECT, and decision-0010 says so: one connection is one process is one
// vault, so "the handle" and "the vault's handle" are the same thing, and an epoch minted per boot is
// exactly the reconciliation key staleSpawns() wants. Nothing here is a latent bug on stdio.
//
// Off stdio they are all wrong, and wrong in a way that is quiet. Under an HTTP handler the module is
// loaded once and serves many vaults: the first vault to touch the database wins the handle and every
// later vault silently reads and writes THAT vault's file. The epoch is worse than wrong — decision-0010
// spells the failure out: "under HTTP, EPOCH would be minted per request and staleSpawns would report
// every other request's spawns as stale."
//
// WHY A PORT AND NOT JUST A MAP. The keying is the easy half. The half worth an interface is the
// INVARIANT: two vaults exercised in one process must never share a handle or an epoch. That is a
// sentence a contract test can check, and it is the precondition decision-0010 named for un-deferring
// multi-vault. A bare Map would satisfy today's callers and quietly stop being true the first time
// someone added a fourth cache next to the other three.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not open databases. The caller passes an `open` function,
// because WHICH opener and WHICH migration a file needs is domain knowledge belonging to the tool that
// owns it — durable-spawn migrates its schema on open, episodes does not, and a store that knew the
// difference would be a store that has to change every time a tool does. The store owns keying and
// lifetime; the caller owns meaning.
//
// SINGLE-WRITER IS NOT WEAKENED BY THIS. Keying per vault is necessary for a shared process and nowhere
// near sufficient for a shared vault: the lease/fence design still assumes one writer per vault DB, and
// that limit stands whatever the transport. This makes many vaults in one process safe. It does not
// make many processes on one vault safe, and nothing here should be read as suggesting otherwise.

import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { definePort, registry } from "./port.mjs";

export const VaultStorePort = definePort({
  name: "VaultStorePort",
  fields: ["label"],
  methods: ["db", "epoch", "read", "list"],
  contract:
    "handles and epochs are keyed BY VAULT, never memoized per module load; two vaults exercised in one "
    + "process never share a handle or an epoch.",
});

// vaultDir → { epoch, handles: Map<name, handle> }. Module-level, which is fine and is the point: the
// CACHE may live for the process, as long as what it is keyed BY is the vault and not the module.
const slots = new Map();

function slot(vaultDir) {
  if (!vaultDir) throw new Error("VaultStorePort: a vault directory is required — refusing to guess one");
  let s = slots.get(vaultDir);
  if (!s) {
    // The epoch is minted lazily, ONCE per vault per process. Not per module load (that is the bug this
    // replaces) and emphatically not per request (that is the bug decision-0010 warned HTTP would add).
    s = { epoch: randomUUID(), handles: new Map() };
    slots.set(vaultDir, s);
  }
  return s;
}

const fsSqlite = {
  id: "fs-sqlite",
  label: "filesystem + SQLite",

  /** The reconciliation key for THIS vault — stable for the life of the process, unique per vault. */
  epoch(vaultDir) {
    return slot(vaultDir).epoch;
  },

  /**
   * A database handle for this vault, memoized per (vault, name).
   * @param vaultDir the vault whose db/ directory holds the file
   * @param name     logical db name, also the filename stem (e.g. "durable-spawn", "episodes")
   * @param open     (absolutePath) => handle — called at most once per (vault, name)
   */
  db(vaultDir, { name, open } = {}) {
    if (!name || typeof open !== "function") {
      throw new Error("VaultStorePort.db: both `name` and an `open(path)` function are required");
    }
    const s = slot(vaultDir);
    const hit = s.handles.get(name);
    if (hit) return hit;
    const path = join(vaultDir, "db", `${name}.db`);
    mkdirSync(dirname(path), { recursive: true });
    const handle = open(path);
    s.handles.set(name, handle);
    return handle;
  },

  /** Read one file inside a vault. Returns null when absent rather than throwing. */
  read(vaultDir, relPath) {
    const p = join(vaultDir, relPath);
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8");
  },

  /** List a directory inside a vault. Returns [] when absent — an empty vault is not an error. */
  list(vaultDir, relPath = ".") {
    const p = join(vaultDir, relPath);
    if (!existsSync(p)) return [];
    try { return readdirSync(p); } catch { return []; }
  },

  // ── test seam ───────────────────────────────────────────────────────────────
  /** Drop cached state. For TESTS only — a long-lived server must never call this under traffic. */
  _reset(vaultDir = null) {
    if (vaultDir) slots.delete(vaultDir); else slots.clear();
  },
  /** How many vaults this process currently holds state for. Diagnostics + contract tests. */
  _size() { return slots.size; },
};

export const vaultStoreAdapters = registry(VaultStorePort, [fsSqlite]);

/** The adapter in use. A single default today; the port is what makes a second one possible. */
export const vaultStore = fsSqlite;
