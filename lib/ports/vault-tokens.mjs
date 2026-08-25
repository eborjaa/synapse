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
// FOUR RULES THAT ARE NOT NEGOTIABLE, each with a test:
//   1. An unknown or missing token is a REFUSAL — never a fallback to "the default vault". A fallback
//      would mean a typo silently reads a different vault, which is the whole failure class this
//      project has been removing (the global vault pin, the registration env-fallback, and now this).
//   2. One token maps to exactly ONE vault. Not a set, not a wildcard. Broadening is a future decision
//      with its own review, not an emergent property of a data structure.
//   3. Tokens are compared in constant time. A token is a credential; leaking its prefix through
//      early-exit string comparison is a real, boring, well-understood mistake.
//   4. Admin is an explicit scope on the token, never a process flag. A missing/legacy `scopes` field
//      is unprivileged. The failure mode of `--surface admin` as authorization: every client of that
//      process inherits mint/revoke. See [[decision-0015-admin-surface]].
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
export const TOKEN_SCOPES = Object.freeze(["admin"]);

/** Tokens are stored hashed. The plaintext exists exactly once, at mint time. */
export const hashToken = (t) => createHash("sha256").update(String(t), "utf8").digest("hex");

// ONE PUBLIC REFUSAL for every credential that cannot produce a live vault. A different answer for
// "unknown token" and "known token whose vault is gone" is an enumeration oracle: it tells an
// unauthenticated caller which guesses name real credentials.
export const VAULT_CREDENTIAL_REFUSAL = "credential does not resolve to a registered vault";

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
 * the point. `label` is for the human ("laptop dsh workspace"), never for authorization. `scopes` is an
 * explicit privilege grant; normal credentials carry none.
 */
export function mintToken(vaultId, {
  label = "",
  scopes = [],
  store = readTokens(),
  reg = readRegistry(),
} = {}) {
  if (!reg.vaults.some((v) => v.id === vaultId)) {
    throw new Error(`no registered vault "${vaultId}" (have: ${reg.vaults.map((v) => v.id).join(", ") || "none"})`);
  }
  const normalizedScopes = [...new Set(scopes.map((scope) => String(scope).trim()).filter(Boolean))];
  const unknownScopes = normalizedScopes.filter((scope) => !TOKEN_SCOPES.includes(scope));
  if (unknownScopes.length) {
    throw new Error(`unknown token scope(s): ${unknownScopes.join(", ")} (allowed: ${TOKEN_SCOPES.join(", ")})`);
  }
  const plaintext = `syn_${randomBytes(24).toString("base64url")}`;
  store.tokens.push({
    hash: hashToken(plaintext),
    vaultId,                                  // exactly ONE vault — never a list
    label: String(label).slice(0, 80),
    scopes: normalizedScopes,
    createdAt: new Date().toISOString(),
  });
  return { store, plaintext, vaultId, scopes: normalizedScopes };
}

/** Revoke by label or by the token's own prefix-free hash. Returns what was removed, or null. */
export function revokeToken(selector, store = readTokens()) {
  const i = store.tokens.findIndex((t) => t.label === selector || t.hash === selector || t.hash.startsWith(selector));
  if (i < 0) return { store, revoked: null };
  const [revoked] = store.tokens.splice(i, 1);
  return { store, revoked };
}

/**
 * Constant-time lookup of a token row. Returns null when unknown.
 *
 * Every candidate is compared even after a match is found: returning early on the first hit leaks, via
 * timing, roughly where in the list a guessed token would sit.
 */
export function lookupToken(plaintext, store = readTokens()) {
  if (typeof plaintext !== "string" || !plaintext) return null;
  const want = Buffer.from(hashToken(plaintext), "hex");
  let found = null;
  for (const t of store.tokens) {
    let got;
    try { got = Buffer.from(String(t.hash), "hex"); } catch { continue; }
    if (got.length !== want.length) continue;
    if (timingSafeEqual(got, want)) found = t;   // deliberately no `break`
  }
  return found;
}

/** Back-compatible convenience for callers that only need the one-vault identity. */
export function lookupVaultId(plaintext, store = readTokens()) {
  return lookupToken(plaintext, store)?.vaultId || null;
}

/**
 * Pull the bearer credential out of a request, tolerating the shapes a transport might hand us.
 *
 * `authInfo.token` is the HTTP path: createMcpHandler deliberately does no authentication itself, so
 * the adapter parses Authorization and passes validated request identity into the per-request factory.
 * Headers remain accepted for the port's transport-neutral tests and other adapters.
 */
export function extractBearer(request) {
  const fromAuth = request?.authInfo?.token;
  if (typeof fromAuth === "string" && fromAuth.trim()) return fromAuth.trim();

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

  bind(request, { store = null, reg = null } = {}) {
    // NOTE what is NOT read here: request.arguments, request.params, anything the model can author.
    // The credential is the only input. See the decision-0010 quote at the top of this file.
    const token = extractBearer(request);
    const deny = { ok: false, reason: VAULT_CREDENTIAL_REFUSAL };
    if (!token) return deny;

    store = store || readTokens();
    reg = reg || readRegistry();
    const tokenRow = lookupToken(token, store);
    if (!tokenRow?.vaultId) return deny;

    const v = reg.vaults.find((x) => x.id === tokenRow.vaultId);
    if (!v) return deny;
    if (!existsSync(v.root) || !existsSync(v.vaultDir)) return deny;

    // A binding includes the manifest because the request factory must build a complete vault context
    // without re-running cwd/env resolution. Falling back there could attach a different vault after
    // successful authentication — exactly the class of quiet redirect this port exists to prevent.
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(v.vaultDir, "_meta", "tools", "context.manifest.json"), "utf8"));
    } catch {
      return deny;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return deny;

    return {
      ok: true,
      vaultId: tokenRow.vaultId,
      root: v.root,
      vaultDir: v.vaultDir,
      manifest,
      scopes: Array.isArray(tokenRow.scopes) ? tokenRow.scopes.filter((scope) => TOKEN_SCOPES.includes(scope)) : [],
    };
  },

  describe: () => ({ mode: "bearer-token", multiVault: true, source: "Authorization: Bearer" }),
};

export const bearerVaultBinding = bearerBinding;
export const bearerBindingAdapters = registry(VaultBindingPort, [bearerBinding]);
