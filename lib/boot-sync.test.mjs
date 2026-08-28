// boot-sync.test.mjs — core start regenerates rosters + /synapse-<agent> onto the shared volumes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootSync } from "./boot-sync.mjs";
import { addVault, writeRegistry } from "./vaults.mjs";

const MANIFEST = JSON.stringify({
  repo: "t", logLabel: "t", vaultRoot: ".", skipDirs: [], targetTypes: ["hub"], roles: {},
  referenceRoles: [], profiles: {}, tokenBudgets: {}, excerptChars: {}, typePriority: ["note"],
  trailers: {}, invariants: [],
});

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "syn-boot-home-"));
  const prev = process.env.SYNAPSE_HOME;
  const prevSkills = process.env.SYNAPSE_SKILLS_ROOT;
  process.env.SYNAPSE_HOME = home;
  delete process.env.SYNAPSE_SKILLS_ROOT;
  const made = [home];
  return {
    home,
    vault() {
      const d = mkdtempSync(join(tmpdir(), "syn-boot-v-"));
      mkdirSync(join(d, "_meta", "tools"), { recursive: true });
      mkdirSync(join(d, "agents"), { recursive: true });
      mkdirSync(join(d, ".git"), { recursive: true });
      writeFileSync(join(d, "_meta", "tools", "context.manifest.json"), MANIFEST);
      writeFileSync(join(d, "agents", "agent-oracle.md"), `---
id: agent-oracle
type: agent
title: Oracle
tags:
  - type/agent
  - area/testing
purpose: "Answer questions"
profile: standard
autonomous: false
addressable: true
uses_tools: []
applies_rules: []
delegates_to: []
outputs: []
invokes_skills: []
---

body
`);
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

test("an empty registry is a no-op, not a crash", () => {
  const s = sandbox();
  try {
    const out = bootSync({ log: () => {} });
    assert.equal(out.vaults, 0);
    assert.equal(out.skillsWritten, 0);
    assert.equal(out.errors.length, 0);
  } finally { s.clean(); }
});

test("a registered vault gets /synapse-oracle on the shared disk", () => {
  const s = sandbox();
  try {
    const root = s.vault();
    writeRegistry(addVault(root).reg);
    const out = bootSync({ log: () => {} });
    assert.equal(out.vaults, 1);
    assert.ok(out.skillsWritten >= 1, "at least the oracle skill is written");
    assert.ok(
      existsSync(join(root, ".dsh", "skills", "synapse-oracle", "SKILL.md")),
      "DSH discovers /synapse-oracle from the vault folder",
    );
    const index = JSON.parse(readFileSync(join(s.home, "skills", "index.json"), "utf8"));
    assert.equal(index.vaults.length, 1);
    assert.equal(index.vaults[0].root, root);
    assert.equal(JSON.stringify(index).includes("token"), false);
  } finally { s.clean(); }
});

test("a missing vault root does not block the rest", () => {
  const s = sandbox();
  try {
    const live = s.vault();
    const { reg } = addVault(live);
    reg.vaults.push({
      id: "gone",
      root: join(tmpdir(), "syn-boot-does-not-exist"),
      vaultDir: join(tmpdir(), "syn-boot-does-not-exist"),
      layout: "flat",
      addedAt: new Date().toISOString(),
    });
    writeRegistry(reg);
    const out = bootSync({ log: () => {} });
    assert.equal(out.vaults, 2);
    assert.ok(out.errors.some((e) => e.startsWith("gone:")));
    assert.ok(existsSync(join(live, ".dsh", "skills", "synapse-oracle", "SKILL.md")));
  } finally { s.clean(); }
});
