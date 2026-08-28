// bootstrap.test.mjs — the two switches that let a stack wire itself, and the three modes they make.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { autoRegisterVaults, bootstrap, discoverVaults, ensureBootstrapToken, envFlag } from "./bootstrap.mjs";
import { readRegistry, writeRegistry } from "./vaults.mjs";
import { grantedVaults, hashToken, mintToken, readTokens, writeTokens } from "./ports/vault-tokens.mjs";

const MANIFEST = JSON.stringify({
  repo: "t", logLabel: "t", vaultRoot: ".", skipDirs: [], targetTypes: ["hub"], roles: {},
  referenceRoles: [], profiles: {}, tokenBudgets: {}, excerptChars: {}, typePriority: ["note"],
  trailers: {}, invariants: [],
});

const SECRET = "syn_bootstrap_secret_value_long_enough";

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "syn-bs-home-"));
  const vaults = mkdtempSync(join(tmpdir(), "syn-bs-vaults-"));
  const prevHome = process.env.SYNAPSE_HOME;
  const prevSkills = process.env.SYNAPSE_SKILLS_ROOT;
  const prevAuto = process.env.SYNAPSE_AUTO_REGISTER;
  const prevToken = process.env.SYNAPSE_BOOTSTRAP_TOKEN;
  const prevDir = process.env.SYNAPSE_VAULTS_DIR;
  process.env.SYNAPSE_HOME = home;
  process.env.SYNAPSE_SKILLS_ROOT = join(home, "skills");
  delete process.env.SYNAPSE_AUTO_REGISTER;
  delete process.env.SYNAPSE_BOOTSTRAP_TOKEN;
  delete process.env.SYNAPSE_VAULTS_DIR;

  return {
    home,
    vaults,
    /** A directory shaped like a vault, under the vaults dir. */
    make(name) {
      const d = join(vaults, name);
      mkdirSync(join(d, "_meta", "tools"), { recursive: true });
      writeFileSync(join(d, "_meta", "tools", "context.manifest.json"), MANIFEST);
      return d;
    },
    /** A directory that is NOT a vault. */
    makePlain(name) {
      const d = join(vaults, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "README.md"), "not a vault");
      return d;
    },
    cleanup() {
      for (const [k, v] of Object.entries({
        SYNAPSE_HOME: prevHome, SYNAPSE_SKILLS_ROOT: prevSkills, SYNAPSE_AUTO_REGISTER: prevAuto,
        SYNAPSE_BOOTSTRAP_TOKEN: prevToken, SYNAPSE_VAULTS_DIR: prevDir,
      })) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(vaults, { recursive: true, force: true });
    },
  };
}

test("discoverVaults finds vault-shaped directories and ignores everything else", () => {
  const s = sandbox();
  try {
    s.make("alpha");
    s.make("beta");
    s.makePlain("notes");
    writeFileSync(join(s.vaults, "loose-file.md"), "x");
    mkdirSync(join(s.vaults, ".hidden"), { recursive: true });

    const found = discoverVaults(s.vaults);
    assert.deepEqual(found.map((p) => p.split("/").pop()), ["alpha", "beta"]);
  } finally { s.cleanup(); }
});

test("discoverVaults does NOT recurse — a vault's innards are not siblings of the vault", () => {
  const s = sandbox();
  try {
    const alpha = s.make("alpha");
    // A nested directory that is itself vault-shaped. Recursing would register it as a second vault.
    mkdirSync(join(alpha, "sub", "_meta", "tools"), { recursive: true });
    writeFileSync(join(alpha, "sub", "_meta", "tools", "context.manifest.json"), MANIFEST);

    assert.equal(discoverVaults(s.vaults).length, 1);
  } finally { s.cleanup(); }
});

test("discoverVaults on a directory that does not exist is empty, not a throw", () => {
  const s = sandbox();
  try {
    assert.deepEqual(discoverVaults(join(s.vaults, "nope")), []);
    assert.deepEqual(discoverVaults(""), []);
  } finally { s.cleanup(); }
});

test("MODE 1 — both switches off changes nothing at all", () => {
  const s = sandbox();
  try {
    s.make("alpha");
    const out = bootstrap({ vaultsDir: s.vaults, autoRegister: false, secret: "", log: () => {} });

    assert.deepEqual(out.registered, []);
    assert.equal(out.tokenState, "skipped");
    assert.equal(readRegistry().vaults.length, 0, "nothing registered itself");
    assert.equal(readTokens().tokens.length, 0, "no credential appeared");
  } finally { s.cleanup(); }
});

test("MODE 2 — auto-register alone registers the vaults and mints nothing", () => {
  const s = sandbox();
  try {
    s.make("alpha");
    s.make("beta");
    const out = bootstrap({ vaultsDir: s.vaults, autoRegister: true, secret: "", log: () => {} });

    assert.deepEqual(out.registered.sort(), ["alpha", "beta"]);
    assert.deepEqual(readRegistry().vaults.map((v) => v.id).sort(), ["alpha", "beta"]);
    assert.equal(readTokens().tokens.length, 0, "no secret was given, so no credential exists");
  } finally { s.cleanup(); }
});

test("MODE 3 — a secret from the environment grants every registered vault", () => {
  const s = sandbox();
  try {
    s.make("alpha");
    s.make("beta");
    bootstrap({ vaultsDir: s.vaults, autoRegister: true, secret: SECRET, log: () => {} });

    const { tokens } = readTokens();
    assert.equal(tokens.length, 1);
    assert.deepEqual(grantedVaults(tokens[0]).sort(), ["alpha", "beta"]);
    assert.equal(tokens[0].hash, hashToken(SECRET), "stored hashed, and it is OUR secret");
    assert.equal(tokens[0].scopes.length, 0, "a bootstrap credential is never admin");
  } finally { s.cleanup(); }
});

test("the store never holds the secret in the clear", () => {
  const s = sandbox();
  try {
    s.make("alpha");
    bootstrap({ vaultsDir: s.vaults, autoRegister: true, secret: SECRET, log: () => {} });
    const raw = JSON.stringify(readTokens());
    assert.equal(raw.includes(SECRET), false);
  } finally { s.cleanup(); }
});

test("booting twice adds ONE credential row, not one per boot", () => {
  const s = sandbox();
  try {
    s.make("alpha");
    for (let i = 0; i < 4; i++) {
      bootstrap({ vaultsDir: s.vaults, autoRegister: true, secret: SECRET, log: () => {} });
    }
    assert.equal(readTokens().tokens.length, 1);
    assert.equal(readRegistry().vaults.length, 1, "and one registry row");
  } finally { s.cleanup(); }
});

test("a vault added later widens the existing credential instead of adding a second row", () => {
  const s = sandbox();
  try {
    s.make("alpha");
    bootstrap({ vaultsDir: s.vaults, autoRegister: true, secret: SECRET, log: () => {} });
    assert.deepEqual(grantedVaults(readTokens().tokens[0]), ["alpha"]);

    s.make("beta");
    const out = bootstrap({ vaultsDir: s.vaults, autoRegister: true, secret: SECRET, log: () => {} });

    assert.equal(out.tokenState, "updated");
    const { tokens } = readTokens();
    assert.equal(tokens.length, 1, "still one credential");
    assert.deepEqual(grantedVaults(tokens[0]).sort(), ["alpha", "beta"]);
  } finally { s.cleanup(); }
});

test("a secret with no registered vault is REFUSED, never stored granting nothing", () => {
  const s = sandbox();
  try {
    // An empty grant is indistinguishable from a revoked credential at the listener, so storing one
    // would send the operator hunting a credential bug that is a registration bug.
    const out = ensureBootstrapToken({ secret: SECRET, write: true });
    assert.equal(out.reason, "no-vaults");
    assert.equal(out.created, false);
    assert.equal(readTokens().tokens.length, 0);
  } finally { s.cleanup(); }
});

test("a short secret is refused rather than quietly accepted", () => {
  const s = sandbox();
  try {
    s.make("alpha");
    autoRegisterVaults({ dir: s.vaults, write: true });
    assert.throws(
      () => ensureBootstrapToken({ secret: "hunter2", write: true }),
      /at least 24/,
    );
    assert.equal(readTokens().tokens.length, 0);
  } finally { s.cleanup(); }
});

test("bootstrap reports a rejected secret and still returns — it never blocks the listener", () => {
  const s = sandbox();
  try {
    s.make("alpha");
    const lines = [];
    const out = bootstrap({ vaultsDir: s.vaults, autoRegister: true, secret: "short", log: (l) => lines.push(l) });

    assert.equal(out.tokenState, "error");
    assert.equal(out.registered.length, 1, "the vault still registered");
    assert.match(lines.join("\n"), /rejected/);
  } finally { s.cleanup(); }
});

test("auto-register never removes a vault whose directory is not there right now", () => {
  const s = sandbox();
  try {
    const alpha = s.make("alpha");
    autoRegisterVaults({ dir: s.vaults, write: true });
    assert.equal(readRegistry().vaults.length, 1);

    // A mount that has not come up yet looks exactly like this.
    rmSync(alpha, { recursive: true, force: true });
    autoRegisterVaults({ dir: s.vaults, write: true });

    assert.equal(readRegistry().vaults.length, 1, "the registry row survives a missing directory");
  } finally { s.cleanup(); }
});

test("auto-register leaves a hand-registered vault alone and does not duplicate it", () => {
  const s = sandbox();
  try {
    const alpha = s.make("alpha");
    // Registered by hand first, the way an existing stack's volume already looks.
    const { reg } = autoRegisterVaults({ dir: s.vaults });
    writeRegistry(reg);
    const before = readRegistry().vaults.length;

    const out = autoRegisterVaults({ dir: s.vaults, write: true });
    assert.deepEqual(out.added, []);
    assert.deepEqual(out.skipped, ["alpha"]);
    assert.equal(readRegistry().vaults.length, before);
  } finally { s.cleanup(); }
});

test("a credential minted by hand is untouched by the bootstrap secret", () => {
  const s = sandbox();
  try {
    s.make("alpha");
    autoRegisterVaults({ dir: s.vaults, write: true });
    const minted = mintToken(["alpha"], { label: "by hand" });
    writeTokens(minted.store);

    bootstrap({ vaultsDir: s.vaults, autoRegister: true, secret: SECRET, log: () => {} });

    const { tokens } = readTokens();
    assert.equal(tokens.length, 2, "the hand-minted credential is still there");
    assert.ok(tokens.some((t) => t.hash === hashToken(minted.plaintext)));
    assert.ok(tokens.some((t) => t.hash === hashToken(SECRET)));
  } finally { s.cleanup(); }
});

test("envFlag reads the spellings people actually use", () => {
  for (const yes of ["1", "true", "TRUE", "yes", "on", " on "]) assert.equal(envFlag(yes), true, yes);
  for (const no of ["0", "false", "no", "off", "", undefined, null]) assert.equal(envFlag(no), false, String(no));
});
