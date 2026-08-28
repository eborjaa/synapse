// session-tools.test.mjs — a session gets its OWN vault's tools, and nothing when there is no vault.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { realpathSync } from "node:fs";
import { addVault, writeRegistry, readRegistry } from "../lib/vaults.mjs";
import { bindSessionTools, toolName } from "./session-tools.mjs";

const MANIFEST = JSON.stringify({
  repo: "t", logLabel: "t", vaultRoot: ".", skipDirs: [], targetTypes: ["hub"], roles: {},
  referenceRoles: [], profiles: {}, tokenBudgets: {}, excerptChars: {}, typePriority: ["note"],
  trailers: {}, invariants: [],
});

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "syn-st-home-"));
  const prev = process.env.SYNAPSE_HOME;
  process.env.SYNAPSE_HOME = home;
  const made = [home];
  return {
    vault(name) {
      const d = mkdtempSync(join(tmpdir(), `syn-st-${name}-`));
      mkdirSync(join(d, "_meta", "tools"), { recursive: true });
      writeFileSync(join(d, "_meta", "tools", "context.manifest.json"), MANIFEST);
      made.push(d);
      return d;
    },
    plain(name) {
      const d = mkdtempSync(join(tmpdir(), `syn-st-${name}-`));
      made.push(d);
      return d;
    },
    register(...dirs) {
      let reg = readRegistry();
      for (const d of dirs) reg = addVault(d, reg).reg;
      writeRegistry(reg);
    },
    clean() {
      if (prev === undefined) delete process.env.SYNAPSE_HOME; else process.env.SYNAPSE_HOME = prev;
      for (const d of made) rmSync(d, { recursive: true, force: true });
    },
  };
}

/** A pool whose clients report a per-vault tool list, so "each vault its own tools" is observable. */
function fakePool(byRoot) {
  const released = [];
  const calls = [];
  return {
    released,
    calls,
    async acquire(root) {
      // The real pool canonicalizes its key; mirror that so a test keyed on realpath matches.
      const names = byRoot[realpathSync(root)] || byRoot[root] || byRoot.default || [];
      return {
        client: {
          async listTools() {
            return { tools: names.map((n) => ({ name: n, description: `${n} desc`, inputSchema: { type: "object" } })) };
          },
          async callTool(req) {
            calls.push({ root, name: req.name, arguments: req.arguments });
            return { content: [{ type: "text", text: `${root}:${req.name}` }] };
          },
        },
        release() { released.push(root); },
      };
    },
  };
}

function collector() {
  const registered = new Map();
  return {
    registered,
    register(def) {
      registered.set(def.name, def);
      return () => registered.delete(def.name);
    },
  };
}

test("a session in a vault gets THAT vault's tools", async () => {
  const s = sandbox();
  try {
    const v = s.vault("alpha");
    s.register(v);
    const id = readRegistry().vaults[0].id;

    const pool = fakePool({ default: ["synapse_render", "synapse_brief"] });
    const c = collector();
    const bound = await bindSessionTools({ cwd: join(v, "notes"), pool, register: c.register });

    assert.equal(bound.bound, true);
    assert.equal(bound.vaultId, id);
    assert.deepEqual(bound.tools.sort(), [toolName("synapse_brief"), toolName("synapse_render")].sort());
    assert.equal(c.registered.size, 2);
    const sample = c.registered.get(toolName("synapse_brief"));
    assert.equal(typeof sample.output?.render, "function", "DSH tools.register requires output.render");
    assert.equal(sample.timeoutMs, 180_000);

    await bound.dispose();
    assert.equal(c.registered.size, 0, "disposal unregisters this session's tools");
    assert.equal(pool.released.length, 1, "and returns the vault to the pool");
  } finally { s.clean(); }
});

test("two vaults publishing DIFFERENT tools each get their own — the reason this is per session", async () => {
  const s = sandbox();
  try {
    const a = s.vault("with-plugin");
    const b = s.vault("plain");
    s.register(a, b);

    // The real case: one vault carries _meta/mcp-plugins/, so its list is longer. Registering one
    // list globally would show its extra tool everywhere, or hide it everywhere.
    const pool = fakePool({
      [realpathSync(a)]: ["synapse_render", "vault_special"],
      [realpathSync(b)]: ["synapse_render"],
    });

    const ca = collector();
    const cb = collector();
    const boundA = await bindSessionTools({ cwd: a, pool, register: ca.register });
    const boundB = await bindSessionTools({ cwd: b, pool, register: cb.register });

    assert.ok(ca.registered.has(toolName("vault_special")), "the plugin vault keeps its extra tool");
    assert.equal(cb.registered.has(toolName("vault_special")), false, "the plain vault must not see it");
    assert.ok(cb.registered.has(toolName("synapse_render")));

    await boundA.dispose();
    await boundB.dispose();
  } finally { s.clean(); }
});

test("a tool call reaches the session's own vault, with no vault argument anywhere", async () => {
  const s = sandbox();
  try {
    const v = s.vault("routed");
    s.register(v);
    const pool = fakePool({ default: ["synapse_render"] });
    const c = collector();
    const bound = await bindSessionTools({ cwd: v, pool, register: c.register });

    const def = c.registered.get(toolName("synapse_render"));
    // The tool's own schema is the vault's, untouched — no vault field was added for a caller to set.
    assert.deepEqual(def.parameters, { type: "object" });

    await def.execute({ agent: "agent-oracle" }, { signal: undefined });
    assert.equal(pool.calls.length, 1);
    assert.equal(pool.calls[0].name, "synapse_render", "the raw name goes on the wire, not the prefixed one");
    assert.deepEqual(pool.calls[0].arguments, { agent: "agent-oracle" });

    await bound.dispose();
  } finally { s.clean(); }
});

test("no vault means NO tools — never a fallback to some default vault", async () => {
  const s = sandbox();
  try {
    s.register(s.vault("registered-elsewhere"));
    const pool = fakePool({ default: ["synapse_render"] });

    for (const cwd of [s.plain("outside"), undefined, "", "   "]) {
      const c = collector();
      const lines = [];
      const bound = await bindSessionTools({ cwd, pool, register: c.register, log: (l) => lines.push(l) });
      assert.equal(bound.bound, false, `${JSON.stringify(cwd)} must not bind`);
      assert.equal(c.registered.size, 0);
      assert.equal(lines.length, 1, "and must say why, once");
    }
    assert.equal(pool.released.length, 0, "nothing was acquired, so nothing to release");
  } finally { s.clean(); }
});

test("an UNREGISTERED vault refuses with the command that fixes it", async () => {
  const s = sandbox();
  try {
    const stray = s.vault("stray");   // real vault, deliberately not registered
    const pool = fakePool({ default: ["synapse_render"] });
    const c = collector();
    const lines = [];
    const bound = await bindSessionTools({ cwd: stray, pool, register: c.register, log: (l) => lines.push(l) });

    assert.equal(bound.bound, false);
    assert.equal(c.registered.size, 0);
    assert.match(lines[0], /synapse vaults add/);
  } finally { s.clean(); }
});

test("a vault whose process cannot be read registers nothing and releases it", async () => {
  const s = sandbox();
  try {
    const v = s.vault("broken");
    s.register(v);
    const released = [];
    const pool = {
      async acquire(root) {
        return {
          client: { async listTools() { throw new Error("child died during handshake"); } },
          release() { released.push(root); },
        };
      },
    };
    const c = collector();
    const lines = [];
    const bound = await bindSessionTools({ cwd: v, pool, register: c.register, log: (l) => lines.push(l) });

    assert.equal(bound.bound, false);
    assert.equal(c.registered.size, 0, "half a tool set is worse than none");
    assert.equal(released.length, 1, "a failed bind must not leak its pool reference");
    assert.match(lines[0], /could not read its tool list/);
  } finally { s.clean(); }
});
