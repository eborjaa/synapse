#!/usr/bin/env node
// vault-tokens.test.mjs — the bearer-token binding.
//
// This is the security boundary for multi-vault, so the tests are written as the rules themselves
// rather than as coverage of the functions. If one of these fails, the isolation between a finances
// vault and a work vault has stopped holding.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault, writeRegistry, readRegistry } from "../vaults.mjs";
import {
  VaultBindingPort, bearerVaultBinding, bearerBindingAdapters,
  readTokens, writeTokens, mintToken, revokeToken, lookupToken, lookupVaultId, extractBearer, hashToken,
  grantedVaults,
  tokensPath, TOKEN_SCOPES, VAULT_CREDENTIAL_REFUSAL,
} from "./vault-tokens.mjs";

const MANIFEST = JSON.stringify({
  repo: "t", logLabel: "t", vaultRoot: ".", skipDirs: [], targetTypes: ["hub"], roles: {},
  referenceRoles: [], profiles: {}, tokenBudgets: {}, excerptChars: {}, typePriority: ["note"],
  trailers: {}, invariants: [],
});

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "syn-tok-home-"));
  const prev = process.env.SYNAPSE_HOME;
  process.env.SYNAPSE_HOME = home;
  const made = [home];
  return {
    home,
    vault() {
      const d = mkdtempSync(join(tmpdir(), "syn-tok-v-"));
      mkdirSync(join(d, "_meta", "tools"), { recursive: true });
      writeFileSync(join(d, "_meta", "tools", "context.manifest.json"), MANIFEST);
      made.push(d);
      writeRegistry(addVault(d).reg);
      return { dir: d, id: readRegistry().vaults.find((v) => v.root === d).id };
    },
    clean() {
      if (prev === undefined) delete process.env.SYNAPSE_HOME; else process.env.SYNAPSE_HOME = prev;
      for (const d of made) rmSync(d, { recursive: true, force: true });
    },
  };
}
const req = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

test("the adapter satisfies VaultBindingPort", () => {
  for (const a of bearerBindingAdapters.all()) assert.doesNotThrow(() => VaultBindingPort.assert(a));
  assert.equal(bearerVaultBinding.describe().multiVault, true);
});

test("a minted token binds to its OWN vault, and only that vault", () => {
  const s = sandbox();
  try {
    const a = s.vault();
    const b = s.vault();
    let store = readTokens();
    const ta = mintToken(a.id, { store }); store = ta.store;
    const tb = mintToken(b.id, { store }); store = tb.store;
    writeTokens(store);

    const ra = bearerVaultBinding.bind(req(ta.plaintext));
    const rb = bearerVaultBinding.bind(req(tb.plaintext));
    assert.equal(ra.ok, true);
    assert.equal(ra.vaultDir, a.dir);
    assert.equal(ra.manifest.repo, "t", "the request factory receives a complete bound context");
    assert.equal(rb.vaultDir, b.dir);
    assert.notEqual(ra.vaultDir, rb.vaultDir, "two tokens must never resolve to one vault by accident");
  } finally { s.clean(); }
});

test("an UNKNOWN token is refused — never falls back to a default vault", () => {
  const s = sandbox();
  try {
    const v = s.vault();
    writeTokens(mintToken(v.id).store);
    // A fallback here would mean a typo silently reads someone else's vault. That is the failure class
    // this whole project has been removing.
    const r = bearerVaultBinding.bind(req("syn_not-a-real-token"));
    assert.equal(r.ok, false);
    assert.ok(r.reason);
    assert.equal(r.vaultDir, undefined, "a refusal must not carry a vault");
  } finally { s.clean(); }
});

test("a MISSING credential is refused", () => {
  const s = sandbox();
  try {
    s.vault();
    assert.equal(bearerVaultBinding.bind(req(null)).ok, false);
    assert.equal(bearerVaultBinding.bind({}).ok, false);
    assert.equal(bearerVaultBinding.bind({ headers: { authorization: "Basic xyz" } }).ok, false);
  } finally { s.clean(); }
});

test("a vault chosen by TOOL ARGUMENT is ignored — decision-0010's hard rule", () => {
  const s = sandbox();
  try {
    const a = s.vault();
    const b = s.vault();
    const t = mintToken(a.id);
    writeTokens(t.store);

    // Every shape a model could author, alongside a valid credential for vault A.
    const r = bearerVaultBinding.bind({
      headers: { authorization: `Bearer ${t.plaintext}` },
      arguments: { vault: b.dir, vaultId: b.id },
      params: { vault: b.dir },
      vault: b.dir,
    });
    assert.equal(r.ok, true);
    assert.equal(r.vaultDir, a.dir, "the credential decides the vault; an argument must never override it");

    // And an argument alone, with no credential, gets nothing at all.
    assert.equal(bearerVaultBinding.bind({ arguments: { vaultId: b.id } }).ok, false);
  } finally { s.clean(); }
});

test("a token grants an EXPLICIT set of vaults — never a wildcard", () => {
  const s = sandbox();
  try {
    const a = s.vault();
    const b = s.vault();
    const t = mintToken([a.id, b.id]);
    writeTokens(t.store);
    const row = readTokens().tokens[0];
    assert.ok(Array.isArray(row.vaultIds), "the grant is a list, and the list is enumerated");
    assert.deepEqual(row.vaultIds.sort(), [a.id, b.id].sort());
    assert.equal(row.vaultIds.includes("*"), false, "there is no wildcard grant");

    // Minting against a vault that is not registered must fail AT MINT TIME. A credential whose grant
    // cannot be verified when it is created is one that simply refuses later, for reasons no one can see.
    assert.throws(() => mintToken([a.id, "not-a-vault"], { store: readTokens() }), /no registered vault/);
  } finally { s.clean(); }
});

test("a pre-existing single-vault token keeps working with no migration", () => {
  const s = sandbox();
  try {
    const v = s.vault();
    // The shape minted before [[decision-0017-path-addressed-vaults]]. The store is a credential file;
    // rewriting one to change a field's shape is a risk with no upside, so the reader accepts both.
    const legacy = { hash: hashToken("syn_legacy"), vaultId: v.id, label: "old", scopes: [], createdAt: "x" };
    writeTokens({ version: 1, tokens: [legacy] });
    assert.deepEqual(grantedVaults(readTokens().tokens[0]), [v.id]);

    const bound = bearerVaultBinding.bind({ authInfo: { token: "syn_legacy" } });
    assert.equal(bound.ok, true, "a legacy token still binds at the bare endpoint");
    assert.equal(bound.vaultId, v.id);
  } finally { s.clean(); }
});

test("the path NARROWS the grant and can never widen it", () => {
  const s = sandbox();
  try {
    const a = s.vault();
    const b = s.vault();
    const outsider = s.vault();
    const t = mintToken([a.id, b.id], { label: "two" });
    writeTokens(t.store);
    const req = { authInfo: { token: t.plaintext } };

    assert.equal(bearerVaultBinding.bind(req, { requestedVaultId: a.id }).vaultId, a.id);
    assert.equal(bearerVaultBinding.bind(req, { requestedVaultId: b.id }).vaultId, b.id);

    // The vault is real and registered; it is simply not granted. Same refusal as everything else.
    const denied = bearerVaultBinding.bind(req, { requestedVaultId: outsider.id });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, VAULT_CREDENTIAL_REFUSAL);
  } finally { s.clean(); }
});

test("a multi-vault credential at the BARE endpoint is refused, never defaulted", () => {
  const s = sandbox();
  try {
    const a = s.vault();
    const b = s.vault();
    const t = mintToken([a.id, b.id]);
    writeTokens(t.store);

    // The whole point: a client that forgot its path segment must not silently read whichever vault
    // happens to sit first in the file. Ambiguous resolves to nothing.
    const bound = bearerVaultBinding.bind({ authInfo: { token: t.plaintext } });
    assert.equal(bound.ok, false);
    assert.equal(bound.reason, VAULT_CREDENTIAL_REFUSAL);

    // …while an unambiguous grant still needs no path at all, so every existing client is untouched.
    const one = mintToken(a.id, { store: readTokens() });
    writeTokens(one.store);
    assert.equal(bearerVaultBinding.bind({ authInfo: { token: one.plaintext } }).vaultId, a.id);
  } finally { s.clean(); }
});

test("the path segment is matched EXACTLY — no prefixes, no traversal", () => {
  const s = sandbox();
  try {
    const v = s.vault();
    const t = mintToken([v.id]);
    writeTokens(t.store);
    const req = { authInfo: { token: t.plaintext } };

    for (const attempt of [`${v.id}-archive`, v.id.slice(0, -1), `../${v.id}`, `${v.id}/..`, `${v.id} `, ""]) {
      const bound = bearerVaultBinding.bind(req, { requestedVaultId: attempt });
      if (attempt === "") {
        // An empty segment is "no path given", which the single grant answers unambiguously.
        assert.equal(bound.ok, true, "an empty segment falls back to the unambiguous grant");
      } else {
        assert.equal(bound.ok, false, `"${attempt}" must not resolve to "${v.id}"`);
      }
    }
    assert.equal(bearerVaultBinding.bind(req, { requestedVaultId: v.id }).vaultId, v.id);
  } finally { s.clean(); }
});

test("lookupVaultId answers null rather than guessing for a multi-vault credential", () => {
  const s = sandbox();
  try {
    const a = s.vault();
    const b = s.vault();
    const one = mintToken(a.id);
    writeTokens(one.store);
    assert.equal(lookupVaultId(one.plaintext), a.id);

    const two = mintToken([a.id, b.id], { store: readTokens() });
    writeTokens(two.store);
    assert.equal(lookupVaultId(two.plaintext), null, "picking the first would be a silent default");
  } finally { s.clean(); }
});

test("admin is an explicit credential scope; old and normal tokens stay unprivileged", () => {
  const s = sandbox();
  try {
    const v = s.vault();
    let store = readTokens();
    const normal = mintToken(v.id, { store }); store = normal.store;
    const admin = mintToken(v.id, { store, scopes: ["admin", "admin"] }); store = admin.store;
    writeTokens(store);

    assert.deepEqual(TOKEN_SCOPES, ["admin"]);
    assert.deepEqual(lookupToken(normal.plaintext).scopes, []);
    assert.deepEqual(lookupToken(admin.plaintext).scopes, ["admin"], "scopes are normalized and deduped");
    assert.deepEqual(bearerVaultBinding.bind(req(normal.plaintext)).scopes, []);
    assert.deepEqual(bearerVaultBinding.bind(req(admin.plaintext)).scopes, ["admin"]);
    assert.throws(() => mintToken(v.id, { scopes: ["root"] }), /unknown token scope/);

    // Backward compatibility: stores minted before scopes existed remain normal credentials.
    const legacy = readTokens();
    delete legacy.tokens[0].scopes;
    writeTokens(legacy);
    assert.deepEqual(bearerVaultBinding.bind(req(normal.plaintext)).scopes, []);
  } finally { s.clean(); }
});

test("the store keeps a HASH, never the token itself", () => {
  const s = sandbox();
  try {
    const v = s.vault();
    const t = mintToken(v.id);
    writeTokens(t.store);
    const raw = readTokens();
    assert.equal(raw.tokens[0].hash, hashToken(t.plaintext));
    assert.ok(!JSON.stringify(raw).includes(t.plaintext), "the plaintext must never reach disk");
  } finally { s.clean(); }
});

test("the token file is written 0600", () => {
  const s = sandbox();
  try {
    const v = s.vault();
    writeTokens(mintToken(v.id).store);
    const mode = statSync(tokensPath()).mode & 0o777;
    assert.equal(mode, 0o600, `credential file must not be group/world readable (was ${mode.toString(8)})`);
  } finally { s.clean(); }
});

test("minting refuses a vault that is not registered", () => {
  const s = sandbox();
  try {
    s.vault();
    assert.throws(() => mintToken("no-such-vault"), /no registered vault "no-such-vault"/);
  } finally { s.clean(); }
});

test("revoking a token stops it binding", () => {
  const s = sandbox();
  try {
    const v = s.vault();
    const t = mintToken(v.id, { label: "laptop" });
    writeTokens(t.store);
    assert.equal(bearerVaultBinding.bind(req(t.plaintext)).ok, true);

    const { store, revoked } = revokeToken("laptop", readTokens());
    assert.ok(revoked);
    writeTokens(store);
    assert.equal(bearerVaultBinding.bind(req(t.plaintext)).ok, false, "a revoked token must stop working");
  } finally { s.clean(); }
});

test("a token whose vault was unregistered or deleted is refused, and says no more than it must", () => {
  const s = sandbox();
  try {
    const v = s.vault();
    const t = mintToken(v.id);
    writeTokens(t.store);
    rmSync(v.dir, { recursive: true, force: true });
    const r = bearerVaultBinding.bind(req(t.plaintext));
    assert.equal(r.ok, false);

    // An unknown token and a token for a vanished vault give the SAME message: distinguishing them
    // hands a caller free information about which tokens exist.
    const unknown = bearerVaultBinding.bind(req("syn_bogus"));
    assert.equal(r.reason, VAULT_CREDENTIAL_REFUSAL);
    assert.equal(unknown.reason, VAULT_CREDENTIAL_REFUSAL);
    assert.equal(r.reason, unknown.reason);
  } finally { s.clean(); }
});

test("extractBearer tolerates the header shapes a transport might hand us", () => {
  assert.equal(extractBearer({ authInfo: { token: "from-context" } }), "from-context");
  assert.equal(extractBearer({ headers: { authorization: "Bearer abc" } }), "abc");
  assert.equal(extractBearer({ headers: { Authorization: "bearer abc" } }), "abc");
  assert.equal(extractBearer({ headers: new Map([["authorization", "Bearer abc"]]) }), "abc");
  assert.equal(extractBearer({ headers: { authorization: "Bearer   spaced  " } }), "spaced");
  assert.equal(extractBearer({}), null);
  assert.equal(extractBearer(null), null);
});

test("lookup is total — a malformed stored hash cannot crash a bind", () => {
  const s = sandbox();
  try {
    const v = s.vault();
    const t = mintToken(v.id);
    t.store.tokens.push({ hash: "not-hex-at-all", vaultId: v.id, label: "junk", createdAt: "x" });
    writeTokens(t.store);
    assert.equal(lookupVaultId(t.plaintext, readTokens()), v.id, "a junk row must be skipped, not thrown on");
    assert.equal(lookupVaultId("", readTokens()), null);
    assert.equal(lookupVaultId(null, readTokens()), null);
  } finally { s.clean(); }
});
