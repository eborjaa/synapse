#!/usr/bin/env node
// client-config.test.mjs — the CONTRACT TEST for ClientConfigPort.
//
// This file runs EVERY registered adapter through the same assertions. That is the point of a contract
// test and the reason it is not merged into lib/mcp-config.test.mjs: adding a fifth harness must not
// also require someone to remember to write its guard tests. Register the adapter, and it is tested
// here automatically — or it fails here, which is the outcome we want.
//
// The two guards below existed only as inline behavior before the port extraction, and both are the
// kind of thing a refactor loses silently:
//   • foreign servers survive  — a vault's .mcp.json routinely holds github/postgres rows a human added
//   • a surface is never downgraded — regeneration is what the upgrade path tells people to run

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { definePort, registry, assertImplements } from "./port.mjs";
import { ClientConfigPort, clientConfigAdapters, readConfig } from "./client-config.mjs";

const ADAPTERS = clientConfigAdapters.all();
const COMMAND = "/opt/synapse/bin/synapse-mcp";
const ENV = { SYNAPSE_VAULT: "/v", SYNAPSE_MCP_SURFACE: "full", NODE_OPTIONS: "--experimental-sqlite" };

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "syn-ccp-"));
  return { d, clean: () => rmSync(d, { recursive: true, force: true }) };
}
const call = (a, root, prev, env = ENV, warn = () => {}) =>
  a.merge({ root, path: a.configPath(root), prev, command: COMMAND, env, warn });

// ── the port itself ───────────────────────────────────────────────────────────

test("every registered adapter satisfies the port shape", () => {
  assert.ok(ADAPTERS.length >= 3, "expected at least claude, cursor and opencode");
  for (const a of ADAPTERS) assert.doesNotThrow(() => ClientConfigPort.assert(a), `${a.id} failed`);
});

test("a registry rejects two adapters answering to one id", () => {
  const P = definePort({ name: "P", methods: ["go"], contract: "x" });
  const one = { id: "dup", go() {} };
  assert.throws(() => registry(P, [one, { ...one }]), /duplicate adapter id "dup"/);
});

test("an unknown adapter id throws naming what IS available", () => {
  assert.throws(() => clientConfigAdapters.get("emacs"), /no adapter "emacs".*claude/s);
});

test("a missing method is caught at registration, naming the port and the contract", () => {
  const P = definePort({ name: "RosterPort", methods: ["targets"], contract: "targets() is pure" });
  assert.throws(() => assertImplements(P, { id: "broken" }), /RosterPort: adapter broken is missing method `targets\(\)`[\s\S]*contract: targets\(\) is pure/);
});

// ── the behavioral contract, run against EVERY adapter ────────────────────────

for (const a of ADAPTERS) {
  test(`[${a.id}] merge() is pure — it writes nothing to disk`, () => {
    const { d, clean } = tmp();
    try {
      call(a, d, null);
      assert.equal(readConfig(a.configPath(d)), null, "merge() must not create its own config file");
    } finally { clean(); }
  });

  test(`[${a.id}] merge() is idempotent — feeding its own output back changes nothing`, () => {
    const { d, clean } = tmp();
    try {
      const once = call(a, d, null);
      const twice = call(a, d, once);
      assert.deepEqual(twice, once);
    } finally { clean(); }
  });

  test(`[${a.id}] the surface round-trips through readSurface()`, () => {
    const { d, clean } = tmp();
    try {
      const cfg = call(a, d, null, { ...ENV, SYNAPSE_MCP_SURFACE: "orchestrator" });
      assert.equal(a.readSurface(cfg), "orchestrator",
        "readSurface() must read back what merge() wrote, or existingSurface() silently downgrades a vault");
    } finally { clean(); }
  });

  test(`[${a.id}] the env round-trips through readEnv()`, () => {
    const { d, clean } = tmp();
    try {
      const cfg = call(a, d, null);
      assert.deepEqual(a.readEnv(cfg), ENV);
    } finally { clean(); }
  });

  test(`[${a.id}] a foreign entry already in the file survives regeneration`, () => {
    const { d, clean } = tmp();
    try {
      // Build a prior config in this adapter's own shape, carrying one server that is not ours.
      const mine = call(a, d, null);
      const key = mine.mcpServers ? "mcpServers" : "mcp";
      const prev = { ...mine, [key]: { ...mine[key], github: { command: "gh-mcp" } } };
      const next = call(a, d, prev);
      assert.ok(next[key].github, `${a.id} dropped a foreign server — only the \`synapse\` key is ours`);
      assert.equal(next[key].github.command, "gh-mcp");
    } finally { clean(); }
  });

  test(`[${a.id}] an unrelated top-level key the user set is preserved`, () => {
    const { d, clean } = tmp();
    try {
      const next = call(a, d, { ...call(a, d, null), theirOwnKey: { keep: true } });
      assert.deepEqual(next.theirOwnKey, { keep: true });
    } finally { clean(); }
  });

  test(`[${a.id}] an unparseable existing file warns instead of being silently replaced`, () => {
    const { d, clean } = tmp();
    try {
      const warnings = [];
      // `undefined` is readConfig's signal for "present but not JSON".
      call(a, d, undefined, ENV, (m) => warnings.push(m));
      // opencode rebuilds the whole file by design and has no foreign-server merge to protect, so it is
      // the one adapter with nothing to warn about here. The others must say so out loud.
      if (a.id !== "opencode") {
        assert.ok(warnings.some((w) => /not valid JSON/.test(w)),
          `${a.id} replaced an unreadable config without warning`);
      }
    } finally { clean(); }
  });

  test(`[${a.id}] configPath() is inside the vault root and stable`, () => {
    const { d, clean } = tmp();
    try {
      const p = a.configPath(d);
      assert.ok(p.startsWith(d), `${a.id} writes outside the vault root: ${p}`);
      assert.equal(p, a.configPath(d), "configPath() must be deterministic");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "{}");   // the directory it names must be creatable
    } finally { clean(); }
  });
}
