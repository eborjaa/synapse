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
import { join } from "node:path";
import {
  readRegistry, writeRegistry, addVault, removeVault, idFor,
  planSync, applySync, registryPath, rosterDir, synapseHome,
} from "./vaults.mjs";

const MANIFEST = JSON.stringify({
  repo: "t", logLabel: "t", vaultRoot: ".", skipDirs: [], targetTypes: ["hub"], roles: {},
  referenceRoles: [], profiles: {}, tokenBudgets: {}, excerptChars: {}, typePriority: ["note"],
  trailers: {}, invariants: [],
});

/** A temp $SYNAPSE_HOME plus a factory for temp vaults, so no test ever reads a real HOME. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "syn-home-"));
  const prev = process.env.SYNAPSE_HOME;
  process.env.SYNAPSE_HOME = home;
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
      for (const d of made) rmSync(d, { recursive: true, force: true });
    },
  };
}

test("$SYNAPSE_HOME redirects the registry, so nothing touches a real home", () => {
  const s = sandbox();
  try {
    assert.equal(synapseHome(), s.home);
    assert.equal(registryPath(), join(s.home, "vaults.json"));
    assert.equal(rosterDir("alpha"), join(s.home, "skills", "alpha"));
  } finally { s.clean(); }
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
