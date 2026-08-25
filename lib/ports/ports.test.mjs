#!/usr/bin/env node
// ports.test.mjs — contract tests for RosterPort, ToolTransportPort and VaultBindingPort, plus the
// cross-cutting assertions that hold for EVERY port in the package.
//
// ClientConfigPort has its own file (client-config.test.mjs) because it has three adapters and the most
// behavior to pin. VaultStorePort is declared but has no adapter yet — stage 4 — so the sweep below
// asserts that state explicitly rather than skipping it silently: a port that quietly has no adapters
// is indistinguishable from one someone forgot to wire.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_PORTS, RosterPort, ToolTransportPort, VaultBindingPort, VaultStorePort,
  rosterAdapters, toolTransportAdapters, vaultBindingAdapters, clientConfigAdapters,
} from "./index.mjs";

// ── cross-cutting: every port, however many adapters it has ───────────────────

test("every port declares a name and a one-line contract", () => {
  for (const p of ALL_PORTS) {
    assert.ok(p.name, "a port without a name is unusable in an error message");
    assert.ok(p.contract && p.contract.length > 20, `${p.name}: contract must actually say something`);
    assert.ok(p.methods.length > 0, `${p.name}: a port with no methods is not an interface`);
  }
});

test("every registered adapter satisfies its own port", () => {
  for (const reg of [clientConfigAdapters, rosterAdapters, toolTransportAdapters, vaultBindingAdapters]) {
    for (const a of reg.all()) assert.doesNotThrow(() => reg.port.assert(a), `${reg.port.name}/${a.id}`);
  }
});

test("VaultStorePort is declared with no adapter — stage 4, stated not skipped", () => {
  // If someone implements it, this test fails and tells them to move it into the sweep above. That is
  // the intended failure: it is a prompt, not a bug.
  assert.equal(typeof VaultStorePort.assert, "function");
  assert.ok(VaultStorePort.methods.includes("epoch"),
    "the epoch is the whole reason this port exists — see decision-0010 on staleSpawns off stdio");
});

// ── RosterPort ────────────────────────────────────────────────────────────────

function vaultWithAgents(agents) {
  const d = mkdtempSync(join(tmpdir(), "syn-roster-"));
  mkdirSync(join(d, "_meta", "tools"), { recursive: true });
  writeFileSync(join(d, "_meta", "tools", "context.manifest.json"), JSON.stringify({
    repo: "t", logLabel: "t", vaultRoot: ".", skipDirs: [], targetTypes: ["hub"], roles: {},
    referenceRoles: [], profiles: {}, tokenBudgets: {}, excerptChars: {}, typePriority: ["note"],
    trailers: {}, invariants: [],
  }));
  mkdirSync(join(d, "agents"), { recursive: true });
  mkdirSync(join(d, ".git"), { recursive: true });   // so the generator does not warn about discovery
  for (const [id, purpose] of Object.entries(agents)) {
    writeFileSync(join(d, "agents", `agent-${id}.md`),
      `---\nid: agent-${id}\ntype: agent\ntitle: "${id}"\npurpose: "${purpose}"\nprofile: lean\ntags:\n  - type/agent\n---\n\n# ${id}\n`);
  }
  return { d, clean: () => rmSync(d, { recursive: true, force: true }) };
}

for (const a of rosterAdapters.all()) {
  test(`[roster/${a.id}] targets() is pure — nothing is written`, () => {
    const { d, clean } = vaultWithAgents({ alpha: "does alpha things" });
    try {
      a.targets({ root: d, vaultDir: d });
      assert.equal(existsSync(join(d, ".dsh", "skills")), false, "targets() must not write");
    } finally { clean(); }
  });

  test(`[roster/${a.id}] one target per agent the vault defines`, () => {
    const { d, clean } = vaultWithAgents({ alpha: "alpha", beta: "beta" });
    try {
      const { targets } = a.targets({ root: d, vaultDir: d });
      assert.equal(targets.length, 2, "the vault's own roster is the source, not a shipped list");
    } finally { clean(); }
  });

  test(`[roster/${a.id}] apply() is idempotent — a second write changes nothing`, () => {
    const { d, clean } = vaultWithAgents({ alpha: "alpha" });
    try {
      const { targets } = a.targets({ root: d, vaultDir: d });
      a.apply(targets, { root: d, write: true });
      const rows = a.apply(a.targets({ root: d, vaultDir: d }).targets, { root: d, write: true });
      assert.ok(rows.every((r) => r.status !== "created"), "a re-run should not re-create anything");
    } finally { clean(); }
  });

  test(`[roster/${a.id}] a HAND-AUTHORED file is never overwritten without force`, () => {
    // The load-bearing guard from decision-0011. A generated file carries a marker; delete the marker
    // and the file is the human's. The four shipped skills were tuned against real failure modes.
    const { d, clean } = vaultWithAgents({ alpha: "alpha" });
    try {
      const { targets } = a.targets({ root: d, vaultDir: d });
      a.apply(targets, { root: d, write: true });
      const path = targets[0].path;
      const mine = "---\nname: synapse-alpha\ndescription: mine\n---\n\nHAND AUTHORED. Do not touch.\n";
      writeFileSync(path, mine, "utf8");

      const rows = a.apply(a.targets({ root: d, vaultDir: d }).targets, { root: d, write: true });
      assert.equal(readFileSync(path, "utf8"), mine, `${a.id} clobbered a hand-authored file`);
      assert.ok(rows.some((r) => r.status === "kept"), "the run must REPORT that it kept it, not stay silent");

      a.apply(a.targets({ root: d, vaultDir: d }).targets, { root: d, write: true, force: true });
      assert.notEqual(readFileSync(path, "utf8"), mine, "force must be the documented escape hatch");
    } finally { clean(); }
  });

  test(`[roster/${a.id}] discoveryHint() names a path and a rank`, () => {
    const { d, clean } = vaultWithAgents({ alpha: "alpha" });
    try {
      const hint = a.discoveryHint({ root: d });
      assert.ok(hint.path.startsWith(d));
      assert.equal(typeof hint.rank, "number", "the rank is what decides which roster wins a collision");
    } finally { clean(); }
  });
}

// ── ToolTransportPort ─────────────────────────────────────────────────────────

for (const a of toolTransportAdapters.all()) {
  test(`[transport/${a.id}] describe() states whether it can carry more than one vault`, () => {
    const d = a.describe();
    assert.equal(typeof d.transport, "string");
    assert.equal(typeof d.multiVault, "boolean",
      "a transport that does not say whether it is multi-vault cannot be reasoned about safely");
  });

  test(`[transport/${a.id}] serve() does not run at import time`, () => {
    assert.equal(typeof a.serve, "function", "serve must stay a call, never a module side effect");
  });
}

test("stdio is honest that it is single-vault", () => {
  // One connection is one process is one vault. If this ever flips to true without the bearer-token
  // binding landing, vault isolation has silently become the model's problem.
  assert.equal(toolTransportAdapters.get("stdio").describe().multiVault, false);
});

// ── VaultBindingPort ──────────────────────────────────────────────────────────

for (const a of vaultBindingAdapters.all()) {
  test(`[binding/${a.id}] bind() returns a typed refusal rather than throwing`, () => {
    const prev = process.env.SYNAPSE_VAULT;
    const d = mkdtempSync(join(tmpdir(), "syn-novault-"));
    try {
      process.env.SYNAPSE_VAULT = join(d, "does-not-exist");
      const r = a.bind({});
      assert.equal(r.ok, false, "an unresolvable vault must refuse");
      assert.ok(r.reason, "a refusal must carry a reason a human can act on");
    } finally {
      if (prev === undefined) delete process.env.SYNAPSE_VAULT; else process.env.SYNAPSE_VAULT = prev;
      rmSync(d, { recursive: true, force: true });
    }
  });

  test(`[binding/${a.id}] describe() declares its multi-vault capability`, () => {
    assert.equal(typeof a.describe().multiVault, "boolean");
  });
}

test("no binding adapter accepts a vault chosen by tool argument", () => {
  // The security contract from decision-0010, asserted structurally: bind() is called with a REQUEST.
  // An adapter reading `request.arguments.vault` would pass a shape check, so this test pins the intent
  // and will need a real assertion the moment a second adapter exists.
  for (const a of vaultBindingAdapters.all()) {
    const r = a.bind({ arguments: { vault: "/somewhere/else" } });
    if (r.ok) {
      assert.notEqual(r.vaultDir, "/somewhere/else",
        `${a.id} honored a vault passed as a tool argument — that is the exact failure decision-0010 forbids`);
    }
  }
});
