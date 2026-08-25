#!/usr/bin/env node
// vault-tokens.mjs — the bearer-token VaultBindingPort adapter, and the token store behind it.
//
// THIS IS THE SECURITY MODEL FOR MULTI-VAULT, and it exists in this exact shape because
// [[decision-0010-mcp-2026-07-28-dual-era]] refused the obvious alternative in as many words:
//
//   "The spec does not define multi-tenancy — it suggests minting an explicit handle from a tool and
//    passing it back as an argument. That is not an authorization model: the moment vault selection is
//    a tool argument, the only thing isolating vaults holding finance, health and contacts data is the
//    model's choice of argument. If this returns, the minimum is auth-derived vault binding (the
//    caller's identity determines the vault set, never an argument)."
//
// So: the vault is something the caller HAS, never something the model SAYS. `bind()` is handed a
// request and reads its credential. It never looks at tool arguments, and there is no code path by
// which a tool argument can influence which vault answers. The contract test asserts that.
//
// THREE RULES THAT ARE NOT NEGOTIABLE, each with a test:
//   1. An unknown or missing token is a REFUSAL — never a fallback to "the default vault". A fallback
//      would mean a typo silently reads a different vault, which is the whole failure class this
//      project has been removing (the global vault pin, the registration env-fallback, and now this).
//   2. One token maps to exactly ONE vault. Not a set, not a wildcard. Broadening is a future decision
//      with its own review, not an emergent property of a data structure.
//   3. Tokens are compared in constant time. A token is a credential; leaking its prefix through
//      early-exit string comparison is a real, boring, well-understood mistake.
//
// STORAGE. $SYNAPSE_HOME/tokens.json, mode 0600, outside every repo — the same reasoning as the vault
// registry: it describes the machine, must never be committed, and is not any one vault's business.
// The file stores a SHA-256 of each token, not the token. A store that can hand back a live credential
// is a store whose theft is worse than it needs to be; minting is the only time the plaintext exists.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { definePort, registry } from "./port.mjs";
import { readRegistry, synapseHome } from "../vaults.mjs";

export const VaultBindingPort = definePort({
  name: "VaultBindingPort",
  fields: ["label"],
  methods: ["bind", "describe"],
  contract:
    "binding derives the vault from the caller's identity, NEVER from a tool argument; an unresolvable "
    + "credential is a refusal, never a fallback to a default vault.",
});

export const tokensPath = () => join(synapseHome(), "tokens.json");

/** Tokens are stored hashed. The plaintext exists exactly once, at mint time. */
export const hashToken = (t) => createHash("sha256").update(String(t), "utf8").digest("hex");

export function readTokens() {
  const p = tokensPath();
  if (!existsSync(p)) return { version: 1, tokens: [] };
  let raw;
  try { raw = JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { throw new Error(`${p} is not valid JSON (${e.message}). Refusing to overwrite it.`); }
  if (!raw || !Array.isArray(raw.tokens)) throw new Error(`${p} has no "tokens" array — refusing to overwrite it.`);
  return { version: raw.version || 1, tokens: raw.tokens };
}

/** Write atomically, then tighten the mode. A credential file must not be world-readable. */
export function writeTokens(store) {
  const p = tokensPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, tokens: store.tokens }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, p);
  try { chmodSync(p, 0o600); } catch { /* best effort on exotic filesystems */ }
  return p;
}

/**
 * Mint a token for ONE vault. Returns the plaintext ONCE — it is never recoverable afterwards, which is
 * the point. `label` is for the human ("laptop dsh workspace"), never for authorization.
 */
export function mintToken(vaultId, { label = "", store = readTokens(), reg = readRegistry() } = {}) {
  if (!reg.vaults.some((v) => v.id === vaultId)) {
    throw new Error(`no registered vault "${vaultId}" (have: ${reg.vaults.map((v) => v.id).join(", ") || "none"})`);
  }
  const plaintext = `syn_${randomBytes(24).toString("base64url")}`;
  store.tokens.push({
    hash: hashToken(plaintext),
    vaultId,                                  // exactly ONE vault — never a list
    label: String(label).slice(0, 80),
    createdAt: new Date().toISOString(),
  });
  return { store, plaintext, vaultId };
}

/** Revoke by label or by the token's own prefix-free hash. Returns what was removed, or null. */
export function revokeToken(selector, store = readTokens()) {
  const i = store.tokens.findIndex((t) => t.label === selector || t.hash === selector || t.hash.startsWith(selector));
  if (i < 0) return { store, revoked: null };
  const [revoked] = store.tokens.splice(i, 1);
  return { store, revoked };
}

/**
 * Constant-time lookup of a token's vault id. Returns null when unknown.
 *
 * Every candidate is compared even after a match is found: returning early on the first hit leaks, via
 * timing, roughly where in the list a guessed token would sit.
 */
export function lookupVaultId(plaintext, store = readTokens()) {
  if (typeof plaintext !== "string" || !plaintext) return null;
  const want = Buffer.from(hashToken(plaintext), "hex");
  let found = null;
  for (const t of store.tokens) {
    let got;
    try { got = Buffer.from(String(t.hash), "hex"); } catch { continue; }
    if (got.length !== want.length) continue;
    if (timingSafeEqual(got, want)) found = t.vaultId;   // deliberately no `break`
  }
  return found;
}

/** Pull the bearer credential out of a request, tolerating the shapes a transport might hand us. */
export function extractBearer(request) {
  const h = request?.headers || {};
  const raw = h.authorization || h.Authorization
    || (typeof h.get === "function" ? h.get("authorization") : null)
    || null;
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1].trim() : null;
}

const bearerBinding = {
  id: "bearer-token",
  label: "bearer token (many vaults, one process)",

  bind(request, { store = readTokens(), reg = readRegistry() } = {}) {
    // NOTE what is NOT read here: request.arguments, request.params, anything the model can author.
    // The credential is the only input. See the decision-0010 quote at the top of this file.
    const token = extractBearer(request);
    if (!token) return { ok: false, reason: "no bearer credential on the request" };

    const vaultId = lookupVaultId(token, store);
    // Deliberately the SAME message for "no such token" and "token for a vault that is gone": telling
    // a caller which of the two it was is free information about what tokens exist.
    const deny = { ok: false, reason: "credential does not resolve to a registered vault" };
    if (!vaultId) return deny;

    const v = reg.vaults.find((x) => x.id === vaultId);
    if (!v) return deny;
    if (!existsSync(v.root)) return { ok: false, reason: `vault "${vaultId}" is registered but its path is gone` };

    return { ok: true, vaultId, root: v.root, vaultDir: v.vaultDir };
  },

  describe: () => ({ mode: "bearer-token", multiVault: true, source: "Authorization: Bearer" }),
};

export const bearerVaultBinding = bearerBinding;
export const bearerBindingAdapters = registry(VaultBindingPort, [bearerBinding]);
