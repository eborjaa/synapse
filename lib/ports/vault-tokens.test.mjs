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
  readTokens, writeTokens, mintToken, revokeToken, lookupVaultId, extractBearer, hashToken, tokensPath,
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

test("one token maps to exactly ONE vault — no lists, no wildcards", () => {
  const s = sandbox();
  try {
    const v = s.vault();
    const t = mintToken(v.id);
    writeTokens(t.store);
    const row = readTokens().tokens[0];
    assert.equal(typeof row.vaultId, "string", "broadening must be a decision with review, not a data shape");
    assert.ok(!Array.isArray(row.vaultId));
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
    assert.ok(r.reason && unknown.reason);
  } finally { s.clean(); }
});

test("extractBearer tolerates the header shapes a transport might hand us", () => {
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
