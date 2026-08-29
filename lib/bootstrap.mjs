#!/usr/bin/env node
// bootstrap.mjs — the two optional steps that let a stack come up with nobody typing into it.
//
// WHY THIS EXISTS. Registering a vault and minting a credential are `docker exec` steps. That is fine
// on the machine that built the stack and hostile on any other: a colleague handed a compose file has
// to run two commands inside a container and copy a secret out of one and into a file, and every one
// of those is a step that can be done wrong in a way that surfaces four steps later as "no tools".
//
// So both steps become declarative, and BOTH ARE OFF BY DEFAULT. An existing stack has a populated
// registry and minted credentials; turning either of these on implicitly could add vaults its owner
// never registered. Three modes fall out of two switches, which is the whole design:
//
//   SYNAPSE_AUTO_REGISTER   SYNAPSE_BOOTSTRAP_TOKEN   what happens
//   ─────────────────────   ───────────────────────   ────────────────────────────────────────────
//   unset                   unset                     nothing. Today's behaviour, unchanged.
//   1                       unset                     vaults on the volume register themselves.
//   1                       <secret>                  ...and that secret grants all of them.
//
// WHAT THIS IS NOT. It is not a way to get a vault; a vault is still authored by a human and mounted.
// It is not a new authorization model: the bootstrap secret becomes an ordinary credential row, hashed
// like any other, granting an EXPLICIT set of vaults ([[decision-0017-path-addressed-vaults]]). And it
// never invents a grant — a token with no registered vault to grant is refused, not stored empty.
//
// Every function here is idempotent. This runs on every container start, and a restart loop must not
// append a credential row per boot.

import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { addVault, readRegistry, writeRegistry } from "./vaults.mjs";
import { grantedVaults, hashToken, mintToken, readTokens, writeTokens } from "./ports/vault-tokens.mjs";

/** The same shape `vault-for-cwd` recognises. One definition of "is a vault" or they drift. */
const looksLikeVault = (dir) => existsSync(join(dir, "_meta", "tools", "context.manifest.json"));

/** Truthy env values, spelled the ways people actually spell them. */
export const envFlag = (value) => ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());

/**
 * Vault directories one level under `dir`. Deliberately NOT recursive: a vault contains directories
 * that are themselves nearly vault-shaped, and walking into them would register a vault's innards as
 * siblings of the vault.
 *
 * @returns {string[]} absolute paths, sorted, so the registry order is stable across boots
 */
export function discoverVaults(dir) {
  if (!dir || !existsSync(dir)) return [];
  let entries;
  try { entries = readdirSync(dir); }
  catch { return []; }
  const found = [];
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    try { if (!statSync(path).isDirectory()) continue; }
    catch { continue; }
    if (looksLikeVault(path)) found.push(path);
  }
  return found;
}

/**
 * Register every vault directory found under `dir` that is not registered already.
 *
 * Never removes. A vault that has disappeared from the volume keeps its registry row, because "the
 * directory is not there right now" and "this vault is gone" are not the same claim, and a mount that
 * has not come up yet would otherwise silently unregister everything.
 *
 * @param {{ dir: string, reg?: object, write?: boolean }} opts
 * @returns {{ reg: object, added: string[], skipped: string[], errors: string[] }}
 */
export function autoRegisterVaults({ dir, reg = readRegistry(), write = false } = {}) {
  const out = { reg, added: [], skipped: [], errors: [] };
  for (const path of discoverVaults(dir)) {
    try {
      const result = addVault(path, out.reg);
      out.reg = result.reg;
      if (result.added) out.added.push(result.entry.id);
      else out.skipped.push(result.entry.id);
    } catch (e) {
      out.errors.push(`${path}: ${e.message}`);
    }
  }
  if (write && out.added.length) writeRegistry(out.reg);
  return out;
}

/**
 * Make `secret` a credential granting every registered vault, if it is not one already.
 *
 * Idempotency is by HASH, not by label: the store never holds a plaintext, so "is this secret already
 * here" is the only question it can answer, and it is the right one. A boot loop therefore adds one
 * row, not one per boot.
 *
 * Re-running after a NEW vault is registered updates the existing row's grants rather than adding a
 * second row — otherwise the bootstrap credential would silently keep answering for the old set while
 * the operator watched a new vault fail to appear.
 *
 * @param {{ secret: string, reg?: object, store?: object, label?: string, write?: boolean }} opts
 * @returns {{ store: object, created: boolean, updated: boolean, vaultIds: string[], reason?: string }}
 */
export function ensureBootstrapToken({
  secret,
  reg = readRegistry(),
  store = readTokens(),
  label = "bootstrap (from environment)",
  write = false,
} = {}) {
  const value = String(secret ?? "").trim();
  const vaultIds = (reg.vaults || []).map((v) => v.id);
  if (!value) return { store, created: false, updated: false, vaultIds: [], reason: "no-secret" };
  if (!vaultIds.length) {
    // Refusing beats storing a credential that grants nothing: an empty grant is indistinguishable at
    // the listener from a revoked one, so the operator would debug a credential problem that is a
    // registration problem.
    return { store, created: false, updated: false, vaultIds: [], reason: "no-vaults" };
  }

  const hash = hashToken(value);
  const existing = store.tokens.find((t) => t.hash === hash);
  if (existing) {
    const had = grantedVaults(existing);
    const same = had.length === vaultIds.length && had.every((id) => vaultIds.includes(id));
    if (same) return { store, created: false, updated: false, vaultIds };
    existing.vaultIds = vaultIds;
    delete existing.vaultId;          // drop the legacy single-vault spelling rather than leave both
    if (write) writeTokens(store);
    return { store, created: false, updated: true, vaultIds };
  }

  const out = mintToken(vaultIds, { label, store, reg, secret: value });
  if (write) writeTokens(out.store);
  return { store: out.store, created: true, updated: false, vaultIds };
}

/**
 * Both steps, in the only order that works: a credential cannot grant a vault that is not registered.
 *
 * Never throws. This runs before the HTTP listener, and a stack that serves nothing because its
 * optional convenience failed is worse than one that serves what it can and says what went wrong.
 *
 * @param {{ vaultsDir?: string, autoRegister?: boolean, secret?: string, log?: (s: string) => void }} opts
 */
export function bootstrap({
  vaultsDir = process.env.SYNAPSE_VAULTS_DIR || "/synapse/vaults",
  autoRegister = envFlag(process.env.SYNAPSE_AUTO_REGISTER),
  secret = process.env.SYNAPSE_BOOTSTRAP_TOKEN || "",
  log = (s) => process.stderr.write(`${s}\n`),
} = {}) {
  const result = { registered: [], tokenState: "skipped", errors: [] };

  if (autoRegister) {
    try {
      const reg = autoRegisterVaults({ dir: vaultsDir, write: true });
      result.registered = reg.added;
      result.errors.push(...reg.errors);
      for (const e of reg.errors) log(`[synapse-core] bootstrap: ${e}`);
      log(reg.added.length
        ? `[synapse-core] bootstrap: registered ${reg.added.join(", ")}`
        : `[synapse-core] bootstrap: no new vaults under ${vaultsDir}`);
    } catch (e) {
      result.errors.push(`auto-register: ${e.message}`);
      log(`[synapse-core] bootstrap: auto-register failed (${e.message}) — continuing`);
    }
  }

  if (secret) {
    try {
      const token = ensureBootstrapToken({ secret, write: true });
      result.tokenState = token.reason || (token.created ? "created" : token.updated ? "updated" : "current");
      if (token.reason === "no-vaults") {
        log("[synapse-core] bootstrap: SYNAPSE_BOOTSTRAP_TOKEN is set but no vault is registered — not stored");
      } else if (token.created) {
        log(`[synapse-core] bootstrap: credential from environment grants ${token.vaultIds.join(", ")}`);
      } else if (token.updated) {
        log(`[synapse-core] bootstrap: credential from environment now grants ${token.vaultIds.join(", ")}`);
      }
    } catch (e) {
      result.tokenState = "error";
      result.errors.push(`bootstrap-token: ${e.message}`);
      log(`[synapse-core] bootstrap: credential from environment rejected (${e.message})`);
    }
  }

  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  bootstrap();
}
