// vault-for-cwd.test.mjs — the folder → vault decision, and the three answers it can give.
//
// The test that matters most is "an unregistered vault is refused, not adopted". Answering from a
// manifest just because it is on disk would make any backup, archived copy or someone else's clone a
// live vault by being stood in — with the caller's full tool surface pointed at it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addVault, writeRegistry, readRegistry } from "./vaults.mjs";
import { vaultForCwd, explainNoVault, canonical, readVaultDirectory } from "./vault-for-cwd.mjs";

const MANIFEST = JSON.stringify({
  repo: "t", logLabel: "t", vaultRoot: ".", skipDirs: [], targetTypes: ["hub"], roles: {},
  referenceRoles: [], profiles: {}, tokenBudgets: {}, excerptChars: {}, typePriority: ["note"],
  trailers: {}, invariants: [],
});

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "syn-cwd-home-"));
  const prev = process.env.SYNAPSE_HOME;
  const prevSkills = process.env.SYNAPSE_SKILLS_ROOT;
  process.env.SYNAPSE_HOME = home;
  delete process.env.SYNAPSE_SKILLS_ROOT;
  const made = [home];
  return {
    home,
    vault(name = "v") {
      const d = mkdtempSync(join(tmpdir(), `syn-${name}-`));
      mkdirSync(join(d, "_meta", "tools"), { recursive: true });
      writeFileSync(join(d, "_meta", "tools", "context.manifest.json"), MANIFEST);
      made.push(d);
      return d;
    },
    plain(name = "p") {
      const d = mkdtempSync(join(tmpdir(), `syn-${name}-`));
      made.push(d);
      return d;
    },
    register(...dirs) {
      let reg = readRegistry();
      for (const d of dirs) reg = addVault(d, reg).reg;
      writeRegistry(reg);
      return reg;
    },
    clean() {
      if (prev === undefined) delete process.env.SYNAPSE_HOME; else process.env.SYNAPSE_HOME = prev;
      if (prevSkills === undefined) delete process.env.SYNAPSE_SKILLS_ROOT;
      else process.env.SYNAPSE_SKILLS_ROOT = prevSkills;
      for (const d of made) rmSync(d, { recursive: true, force: true });
    },
  };
}

test("a folder inside a registered vault resolves to that vault", () => {
  const s = sandbox();
  try {
    const v = s.vault("alpha");
    s.register(v);
    const id = readRegistry().vaults[0].id;

    assert.equal(vaultForCwd(v).vault.id, id, "the vault root itself resolves");

    const deep = join(v, "notes", "sub", "deeper");
    mkdirSync(deep, { recursive: true });
    assert.equal(vaultForCwd(deep).vault.id, id, "any descendant resolves to the same vault");
  } finally { s.clean(); }
});

test("an UNREGISTERED vault is refused — and the refusal says how to fix it", () => {
  const s = sandbox();
  try {
    const stray = s.vault("stray");   // a real vault on disk, deliberately not registered
    const out = vaultForCwd(stray);

    assert.equal(out.found, false, "being on disk must not be enough to become live");
    assert.equal(out.reason, "unregistered");
    assert.equal(canonical(out.root), canonical(stray));

    const message = explainNoVault(out, stray);
    assert.match(message, /not registered/);
    assert.match(message, /synapse vaults add/, "a refusal that names the fix is the point");
  } finally { s.clean(); }
});

test("a folder outside every vault is 'outside', not a guess", () => {
  const s = sandbox();
  try {
    s.register(s.vault("alpha"));
    const out = vaultForCwd(s.plain("elsewhere"));
    assert.equal(out.found, false);
    assert.equal(out.reason, "outside");
    assert.match(explainNoVault(out, "/somewhere"), /not inside any Synapse vault/);

    for (const bad of ["", "   ", null, undefined, 42]) {
      assert.equal(vaultForCwd(bad).reason, "outside", `${JSON.stringify(bad)} must not resolve`);
    }
  } finally { s.clean(); }
});

test("symlinked paths resolve to the same vault as their real path", () => {
  const s = sandbox();
  try {
    const v = s.vault("real");
    s.register(v);
    const id = readRegistry().vaults[0].id;

    // The everyday case this protects: on macOS /tmp is a symlink to /private/tmp, so a registry
    // recorded one way and a session cwd canonicalized the other would never match.
    const linkHome = s.plain("links");
    const link = join(linkHome, "vault-link");
    symlinkSync(v, link);
    assert.equal(vaultForCwd(link).vault.id, id, "a symlink to the vault resolves to it");
  } finally { s.clean(); }
});

test("the NEAREST vault wins when one vault sits inside another", () => {
  const s = sandbox();
  try {
    const outer = s.vault("outer");
    const inner = join(outer, "projects", "inner");
    mkdirSync(join(inner, "_meta", "tools"), { recursive: true });
    writeFileSync(join(inner, "_meta", "tools", "context.manifest.json"), MANIFEST);
    s.register(outer, inner);

    const reg = readRegistry();
    const outerId = reg.vaults.find((x) => canonical(x.root) === canonical(outer)).id;
    const innerId = reg.vaults.find((x) => canonical(x.root) === canonical(inner)).id;
    assert.notEqual(outerId, innerId);

    assert.equal(vaultForCwd(inner).vault.id, innerId, "standing in the inner vault means the inner one");
    assert.equal(vaultForCwd(outer).vault.id, outerId);
  } finally { s.clean(); }
});

test("a REGISTERED ancestor beats an unregistered vault nearer the cwd", () => {
  const s = sandbox();
  try {
    const outer = s.vault("outer-reg");
    s.register(outer);
    const outerId = readRegistry().vaults[0].id;

    // A vault-shaped directory inside a registered vault — a vendored copy, a fixture, a test tree.
    const nested = join(outer, "fixtures", "looks-like-a-vault");
    mkdirSync(join(nested, "_meta", "tools"), { recursive: true });
    writeFileSync(join(nested, "_meta", "tools", "context.manifest.json"), MANIFEST);

    const out = vaultForCwd(nested);
    assert.equal(out.found, true, "an unregistered lookalike must not shadow a registered ancestor");
    assert.equal(out.vault.id, outerId);
  } finally { s.clean(); }
});

test("an empty host registry still resolves from the public skills index (the DSH container case)", () => {
  const s = sandbox();
  const skills = mkdtempSync(join(tmpdir(), "syn-cwd-skills-"));
  try {
    const v = s.vault("from-index");
    process.env.SYNAPSE_SKILLS_ROOT = skills;
    writeFileSync(join(skills, "index.json"), `${JSON.stringify({
      version: 1,
      vaults: [{ id: "from-index", root: v, vaultDir: v }],
    }, null, 2)}\n`);

    assert.deepEqual(readVaultDirectory().vaults.map((x) => x.id), ["from-index"]);
    const out = vaultForCwd(v);
    assert.equal(out.found, true);
    assert.equal(out.vault.id, "from-index");
  } finally {
    rmSync(skills, { recursive: true, force: true });
    s.clean();
  }
});

test("removing a vault from the registry makes its folder stop resolving", () => {
  const s = sandbox();
  try {
    const v = s.vault("temp");
    s.register(v);
    assert.equal(vaultForCwd(v).found, true);

    writeRegistry({ version: 1, vaults: [] });
    const out = vaultForCwd(v);
    assert.equal(out.found, false, "the registry is the authority, and it can revoke");
    assert.equal(out.reason, "unregistered");
  } finally { s.clean(); }
});
