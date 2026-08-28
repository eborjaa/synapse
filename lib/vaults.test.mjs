#!/usr/bin/env node
// vaults.test.mjs — the vault registry and the bulk rewire.
//
// The test that matters most here is "sync keeps each vault's OWN surface". A bulk operation is exactly
// where a silent downgrade goes unnoticed: rewiring one vault by hand, you would see the surface change;
// rewiring four at once, you would not. That test is the reason planSync defaults `surface` to null.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  readRegistry, writeRegistry, addVault, removeVault, idFor,
  planSync, applySync, registryPath, rosterDir, skillsRoot, synapseHome,
  planRosters, applyRosters, workspaceDirs, writeVaultIndex,
} from "./vaults.mjs";

const MANIFEST = JSON.stringify({
  repo: "t", logLabel: "t", vaultRoot: ".", skipDirs: [], targetTypes: ["hub"], roles: {},
  referenceRoles: [], profiles: {}, tokenBudgets: {}, excerptChars: {}, typePriority: ["note"],
  trailers: {}, invariants: [],
});

/**
 * A temp $SYNAPSE_HOME plus a factory for temp vaults, so no test ever reads a real HOME.
 *
 * $SYNAPSE_SKILLS_ROOT is CLEARED, not just restored: it is set in the container image, so a developer
 * who exported it — or ran the suite inside the stack — would otherwise see rosterDir() answer from the
 * ambient environment and the "roster lands under $SYNAPSE_HOME" assertions would fail for a reason
 * that has nothing to do with the code under test.
 */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "syn-home-"));
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
    clean() {
      if (prev === undefined) delete process.env.SYNAPSE_HOME; else process.env.SYNAPSE_HOME = prev;
      if (prevSkills === undefined) delete process.env.SYNAPSE_SKILLS_ROOT;
      else process.env.SYNAPSE_SKILLS_ROOT = prevSkills;
      for (const d of made) rmSync(d, { recursive: true, force: true });
    },
  };
}

test("$SYNAPSE_HOME redirects the registry, so nothing touches a real home", () => {
  const s = sandbox();
  try {
    assert.equal(synapseHome(), s.home);
    assert.equal(registryPath(), join(s.home, "vaults.json"));
    assert.equal(skillsRoot(), join(s.home, "skills"));
    assert.equal(rosterDir("alpha"), join(s.home, "skills", "alpha"));
  } finally { s.clean(); }
});

test("writeVaultIndex publishes id+root only — never tokens — onto the skills volume", () => {
  const s = sandbox();
  const shared = mkdtempSync(join(tmpdir(), "syn-idx-"));
  try {
    process.env.SYNAPSE_SKILLS_ROOT = shared;
    const root = s.vault("idx");
    writeRegistry(addVault(root).reg);
    const dest = writeVaultIndex();
    assert.equal(dest, join(shared, "index.json"));
    const body = JSON.parse(readFileSync(dest, "utf8"));
    assert.equal(body.vaults.length, 1);
    assert.equal(body.vaults[0].root, root);
    assert.ok(body.vaults[0].id);
    assert.equal("token" in body.vaults[0], false);
    assert.equal("secret" in body.vaults[0], false);
    assert.equal(JSON.stringify(body).includes("syn_"), false);
  } finally {
    rmSync(shared, { recursive: true, force: true });
    s.clean();
  }
});

test("US-4.5: $SYNAPSE_SKILLS_ROOT moves the roster plane off the config volume", () => {
  const s = sandbox();
  const shared = mkdtempSync(join(tmpdir(), "syn-skills-"));
  try {
    process.env.SYNAPSE_SKILLS_ROOT = shared;
    // The roster is the one thing a SECOND party reads — dsh mounts it read-only, no MCP involved. In
    // the stack that makes it a shared volume, while $SYNAPSE_HOME holds tokens.json 0600. Pinned
    // together, handing dsh the rosters would mean mounting the credential store beside them.
    assert.equal(skillsRoot(), shared);
    assert.equal(rosterDir("alpha"), join(shared, "alpha"));
    assert.equal(registryPath(), join(s.home, "vaults.json"), "the registry stays on the config volume");
  } finally {
    rmSync(shared, { recursive: true, force: true });
    s.clean();
  }
});

test("a first run reads an EMPTY registry rather than failing", () => {
  const s = sandbox();
  try {
    assert.deepEqual(readRegistry().vaults, []);
    assert.equal(existsSync(registryPath()), false, "reading must not create the file");
  } finally { s.clean(); }
});

test("a CORRUPT registry throws instead of silently starting over", () => {
  const s = sandbox();
  try {
    mkdirSync(s.home, { recursive: true });
    writeFileSync(registryPath(), "{not json");
    // Starting over would drop every vault the user registered — the one thing this file exists to hold.
    assert.throws(() => readRegistry(), /not valid JSON[\s\S]*refusing to overwrite/);
    writeFileSync(registryPath(), '{"version":1}');
    assert.throws(() => readRegistry(), /no "vaults" array/);
  } finally { s.clean(); }
});

test("add registers a vault, and re-adding the same root refreshes rather than duplicating", () => {
  const s = sandbox();
  try {
    const v = s.vault("alpha");
    const first = addVault(v);
    assert.equal(first.added, true);
    writeRegistry(first.reg);

    const again = addVault(v, readRegistry());
    assert.equal(again.added, false, "re-adding must not create a second row");
    assert.equal(again.reg.vaults.length, 1);
    assert.equal(again.entry.id, first.entry.id, "the id must be stable across re-adds");
  } finally { s.clean(); }
});

test("add refuses a path that is not a vault", () => {
  const s = sandbox();
  try {
    const notAVault = mkdtempSync(join(tmpdir(), "syn-plain-"));
    try {
      // Eager validation: a registry row that is not a vault would fail sync halfway through, after
      // some vaults had already been rewired.
      assert.throws(() => addVault(notAVault));
    } finally { rmSync(notAVault, { recursive: true, force: true }); }
    assert.throws(() => addVault(join(s.home, "nope")), /no such path/);
  } finally { s.clean(); }
});

test("ids collide gracefully instead of overwriting each other", () => {
  assert.equal(idFor("/a/shared", []), "shared");
  assert.equal(idFor("/b/shared", ["shared"]), "shared-2");
  assert.equal(idFor("/c/shared", ["shared", "shared-2"]), "shared-3");
});

test("remove forgets a row by id or by path, and never touches the vault", () => {
  const s = sandbox();
  try {
    const v = s.vault("beta");
    writeRegistry(addVault(v).reg);
    const id = readRegistry().vaults[0].id;

    const byId = removeVault(id, readRegistry());
    assert.equal(byId.removed.id, id);
    assert.equal(byId.reg.vaults.length, 0);
    assert.ok(existsSync(join(v, "_meta", "tools", "context.manifest.json")), "the vault must survive");

    writeRegistry(addVault(v).reg);
    assert.ok(removeVault(v, readRegistry()).removed, "removing by path must work too");
    assert.equal(removeVault("nothing-like-this", readRegistry()).removed, null);
  } finally { s.clean(); }
});

test("the registry is written atomically and leaves no temp file behind", () => {
  const s = sandbox();
  try {
    writeRegistry(addVault(s.vault("gamma")).reg);
    assert.ok(existsSync(registryPath()));
    assert.equal(existsSync(`${registryPath()}.tmp`), false);
    assert.equal(JSON.parse(readFileSync(registryPath(), "utf8")).version, 1);
  } finally { s.clean(); }
});

test("planSync is PURE — it writes nothing", () => {
  const s = sandbox();
  try {
    const v = s.vault("delta");
    writeRegistry(addVault(v).reg);
    const plans = planSync();
    assert.equal(plans.length, 1);
    assert.ok(plans[0].targets.length > 0);
    assert.equal(existsSync(join(v, ".mcp.json")), false, "planning must not write config");
  } finally { s.clean(); }
});

test("sync KEEPS each vault's own surface — a bulk rewire never downgrades one", () => {
  const s = sandbox();
  try {
    const plain = s.vault("plain");
    const raised = s.vault("raised");
    // `raised` was deliberately put on orchestrator. Regenerating is exactly what the upgrade path
    // tells people to run, so a sync that resets it to `full` is silent data loss.
    writeFileSync(join(raised, ".mcp.json"), JSON.stringify({
      mcpServers: { synapse: { type: "stdio", command: "x", args: [], env: { SYNAPSE_MCP_SURFACE: "orchestrator" } } },
    }));
    writeRegistry(addVault(raised, addVault(plain).reg).reg);

    // Key by root, not by id: mkdtemp appends a random suffix, so the id is not the friendly name.
    const bySurface = Object.fromEntries(planSync().map((p) => [p.vault.root, p.surface]));
    assert.equal(bySurface[raised], "orchestrator", "sync downgraded a deliberately raised vault");
    assert.equal(bySurface[plain], "full", "a vault with no prior config gets the default");
  } finally { s.clean(); }
});

test("an explicit --surface still applies to every vault when asked", () => {
  const s = sandbox();
  try {
    writeRegistry(addVault(s.vault("eps")).reg);
    assert.equal(planSync({ surface: "standard" })[0].surface, "standard");
  } finally { s.clean(); }
});

test("one missing or broken vault does not abort the others", () => {
  const s = sandbox();
  try {
    const good = s.vault("good");
    const doomed = s.vault("doomed");
    writeRegistry(addVault(doomed, addVault(good).reg).reg);
    rmSync(doomed, { recursive: true, force: true });

    const plans = planSync();
    const missing = plans.find((p) => p.vault.root === doomed);
    assert.equal(missing.missing, true);
    assert.match(missing.warnings[0], /no longer exists/);
    assert.equal(plans.find((p) => p.vault.root === good).targets.length > 0, true,
      "a dead row must not stop the healthy vaults from being planned");
  } finally { s.clean(); }
});

test("dry-run and --write are driven by the SAME plan, so the preview cannot drift", () => {
  const s = sandbox();
  try {
    const v = s.vault("zeta");
    writeRegistry(addVault(v).reg);

    const plans = planSync();
    const dry = applySync(plans, { write: false, log: () => {} });
    assert.equal(existsSync(join(v, ".mcp.json")), false, "dry-run must not write");

    const wet = applySync(planSync(), { write: true, log: () => {} });
    assert.deepEqual(wet.map((r) => r.changed), dry.map((r) => r.changed),
      "what --write changes must equal what the dry-run said it would");
    assert.ok(existsSync(join(v, ".mcp.json")));

    const again = applySync(planSync(), { write: true, log: () => {} });
    assert.equal(again[0].changed, 0, "a second sync is a no-op — the whole thing is idempotent");
  } finally { s.clean(); }
});

test("sync only ever touches REGISTERED vaults", () => {
  const s = sandbox();
  try {
    const registered = s.vault("in");
    const bystander = s.vault("out");
    writeRegistry(addVault(registered).reg);
    applySync(planSync(), { write: true, log: () => {} });
    assert.ok(existsSync(join(registered, ".mcp.json")));
    assert.equal(existsSync(join(bystander, ".mcp.json")), false,
      "an unregistered vault must never be written to");
  } finally { s.clean(); }
});

// ── stage 3: per-workspace rosters ────────────────────────────────────────────

/** Give a temp vault some agents, so it has a roster to generate. */
function withAgents(dir, ids) {
  mkdirSync(join(dir, "agents"), { recursive: true });
  for (const id of ids) {
    writeFileSync(join(dir, "agents", `agent-${id}.md`),
      `---\nid: agent-${id}\ntype: agent\ntitle: "${id}"\npurpose: "does ${id} things"\nprofile: lean\ntags:\n  - type/agent\n---\n\n# ${id}\n`);
  }
  return dir;
}

test("planRosters is PURE — it writes nothing", () => {
  const s = sandbox();
  try {
    const v = withAgents(s.vault("r1"), ["alpha"]);
    writeRegistry(addVault(v).reg);
    const plans = planRosters();
    assert.equal(plans[0].targets.length, 1);
    assert.equal(existsSync(rosterDir(readRegistry().vaults[0].id)), false, "planning must not write");
  } finally { s.clean(); }
});

test("each vault's roster lands in its OWN directory — this is the isolation claim", () => {
  const s = sandbox();
  try {
    // Both vaults define an agent with the SAME name. Under one shared directory the second would
    // overwrite the first and a workspace would silently get the wrong agent's procedure. That is the
    // collision this whole stage exists to remove.
    const a = withAgents(s.vault("teamA"), ["ingester"]);
    const b = withAgents(s.vault("teamB"), ["ingester"]);
    writeRegistry(addVault(b, addVault(a).reg).reg);

    applyRosters(planRosters(), { write: true, log: () => {} });

    const [idA, idB] = readRegistry().vaults.map((v) => v.id);
    assert.notEqual(idA, idB);
    const fileA = join(rosterDir(idA), "synapse-ingester", "SKILL.md");
    const fileB = join(rosterDir(idB), "synapse-ingester", "SKILL.md");
    assert.ok(existsSync(fileA) && existsSync(fileB), "both rosters must exist side by side");
    assert.notEqual(rosterDir(idA), rosterDir(idB), "two vaults must never share a roster directory");
  } finally { s.clean(); }
});

test("regenerating a roster is idempotent", () => {
  const s = sandbox();
  try {
    writeRegistry(addVault(withAgents(s.vault("r2"), ["alpha", "beta"])).reg);
    applyRosters(planRosters(), { write: true, log: () => {} });
    const second = applyRosters(planRosters(), { write: true, log: () => {} });
    assert.ok(second[0].rows.every((r) => r.status !== "created"), "a re-run must not re-create");
  } finally { s.clean(); }
});

test("a hand-authored skill in a generated roster survives regeneration", () => {
  const s = sandbox();
  try {
    writeRegistry(addVault(withAgents(s.vault("r3"), ["alpha"])).reg);
    applyRosters(planRosters(), { write: true, log: () => {} });
    const id = readRegistry().vaults[0].id;
    const path = join(rosterDir(id), "synapse-alpha", "SKILL.md");
    const mine = "---\nname: synapse-alpha\ndescription: mine\n---\n\nHAND AUTHORED.\n";
    writeFileSync(path, mine, "utf8");

    applyRosters(planRosters(), { write: true, log: () => {} });
    assert.equal(readFileSync(path, "utf8"), mine, "the bulk path must honor the same keep rule");
  } finally { s.clean(); }
});

test("US-4.5: rosters are WRITTEN under $SYNAPSE_SKILLS_ROOT, and nothing lands under the config volume", () => {
  const s = sandbox();
  const shared = mkdtempSync(join(tmpdir(), "syn-skills-write-"));
  try {
    process.env.SYNAPSE_SKILLS_ROOT = shared;
    writeRegistry(addVault(withAgents(s.vault("stack"), ["alpha"])).reg);
    applyRosters(planRosters(), { write: true, log: () => {} });

    const id = readRegistry().vaults[0].id;
    assert.ok(
      existsSync(join(shared, id, "synapse-alpha", "SKILL.md")),
      "the roster must land on the volume dsh mounts, not the one holding tokens.json",
    );
    assert.equal(
      existsSync(join(s.home, "skills")),
      false,
      "the old <home>/skills path must not be written as well — one roster plane, not two",
    );
  } finally {
    rmSync(shared, { recursive: true, force: true });
    s.clean();
  }
});

test("minting: a --label VALUE is never mistaken for a vault id", () => {
  const s = sandbox();
  try {
    const a = s.vault("mint-a");
    const b = s.vault("mint-b");
    writeRegistry(addVault(b, addVault(a).reg).reg);
    const [idA, idB] = readRegistry().vaults.map((v) => v.id);

    const run = (args) => execFileSync(
      process.execPath,
      ["--experimental-sqlite", fileURLToPath(new URL("./vaults.mjs", import.meta.url)), "token", ...args],
      { encoding: "utf8", env: { ...process.env, SYNAPSE_HOME: s.home } },
    );

    // The regression: filtering bare arguments on "does not start with --" reads the label's VALUE as
    // a vault id. It went unnoticed while only the first bare argument was ever used.
    const labelled = run([idA, "--label", "my laptop"]);
    assert.match(labelled, new RegExp(`Minted a credential for ${idA}\\.`));
    assert.doesNotMatch(labelled, /my laptop/, "the label must not appear as a granted vault");

    const both = run([idA, idB, "--label", "two vaults"]);
    assert.match(both, new RegExp(`Minted a credential for ${idA}, ${idB}`));
    // The address is the thing the human has to carry now, so it must be printed, per vault.
    assert.match(both, new RegExp(`${idA}\\s+http://[^\\s]*/mcp/${idA}`));
    assert.match(both, new RegExp(`${idB}\\s+http://[^\\s]*/mcp/${idB}`));
    assert.match(both, /MUST name its vault in the address/);

    const stored = JSON.parse(readFileSync(join(s.home, "tokens.json"), "utf8")).tokens;
    assert.deepEqual(stored.at(-1).vaultIds, [idA, idB]);
    assert.deepEqual(stored.at(-2).vaultIds, [idA], "the labelled single mint granted one vault only");
  } finally { s.clean(); }
});

test("workspaceDirs names absolute paths for the vaults asked for, and only those", () => {
  const s = sandbox();
  try {
    const a = withAgents(s.vault("wsA"), ["alpha"]);
    const b = withAgents(s.vault("wsB"), ["beta"]);
    writeRegistry(addVault(b, addVault(a).reg).reg);
    const [idA, idB] = readRegistry().vaults.map((v) => v.id);

    const dirs = workspaceDirs([idA]);
    assert.deepEqual(dirs, [rosterDir(idA)]);
    assert.ok(dirs.every((d) => d.startsWith("/")), "the harness accepts absolute paths only");
    assert.ok(!dirs.includes(rosterDir(idB)), "a workspace must not be handed a vault it did not ask for");

    assert.deepEqual(workspaceDirs([idA, idB]), [rosterDir(idA), rosterDir(idB)],
      "a workspace deliberately spanning two vaults is still expressible");
  } finally { s.clean(); }
});

test("workspaceDirs refuses an unknown vault id, naming what IS registered", () => {
  const s = sandbox();
  try {
    writeRegistry(addVault(withAgents(s.vault("known"), ["alpha"])).reg);
    assert.throws(() => workspaceDirs(["not-a-vault"]), /no registered vault\(s\): not-a-vault/);
  } finally { s.clean(); }
});

test("a missing vault does not abort roster generation for the rest", () => {
  const s = sandbox();
  try {
    const good = withAgents(s.vault("rgood"), ["alpha"]);
    const doomed = withAgents(s.vault("rdoomed"), ["beta"]);
    writeRegistry(addVault(doomed, addVault(good).reg).reg);
    rmSync(doomed, { recursive: true, force: true });

    const plans = planRosters();
    assert.equal(plans.find((p) => p.vault.root === doomed).missing, true);
    assert.equal(plans.find((p) => p.vault.root === good).targets.length, 1);
  } finally { s.clean(); }
});
