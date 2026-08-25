// The factory contract. These exist because the stateless MCP era (2026-07-28) invokes a server
// FACTORY per connection instead of connecting a pre-built singleton — so "building a server" must
// be a synchronous call with no side effects. Each test below pins one half of that contract.
// See [[decision-0010-mcp-2026-07-28-dual-era]].

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildServer, loadPlugins, discoverPluginPaths, resolveSurface, surfaceForRequest,
  INSTRUCTIONS, SURFACES, EVERYDAY_SURFACES,
} from "./build-server.mjs";
import { ADMIN_TOOL_NAMES } from "./tools/admin.mjs";

// Tool counts per surface, captured from the wire before the factory refactor (mcp/conformance.mjs).
// A change here means the surface moved — intended or not, it must be deliberate.
const EXPECTED_COUNTS = { skeleton: 3, standard: 11, full: 20, orchestrator: 26, admin: 31 };

/** The registered tool names, read off the server the factory returns. */
function toolNames(server) {
  // McpServer keeps registrations on the underlying object; prefer the public shape when present.
  const reg = server._registeredTools ?? server.registeredTools ?? {};
  return Object.keys(reg).sort();
}

test("buildServer is synchronous — it returns a server, not a promise", () => {
  const server = buildServer({ surface: "skeleton" });
  assert.equal(typeof server.connect, "function");
  assert.notEqual(typeof server?.then, "function", "factory must not be thenable");
});

test("each surface registers exactly the tools it advertises", () => {
  for (const surface of EVERYDAY_SURFACES) {
    const names = toolNames(buildServer({ surface }));
    assert.equal(names.length, EXPECTED_COUNTS[surface], `${surface}: tool count moved — ${names.join(", ")}`);
    for (const name of ADMIN_TOOL_NAMES) {
      assert.equal(names.includes(name), false, `${surface} must not register ${name}`);
    }
  }
  const admin = toolNames(buildServer({ surface: "admin", adminAuthorized: true }));
  assert.equal(admin.length, EXPECTED_COUNTS.admin, `admin: tool count moved — ${admin.join(", ")}`);
  for (const name of ADMIN_TOOL_NAMES) assert.ok(admin.includes(name), `admin missing ${name}`);
});

test("the surfaces nest — each one is a superset of the last", () => {
  const skeleton = new Set(toolNames(buildServer({ surface: "skeleton" })));
  const standard = new Set(toolNames(buildServer({ surface: "standard" })));
  const full = new Set(toolNames(buildServer({ surface: "full" })));
  const orchestrator = new Set(toolNames(buildServer({ surface: "orchestrator" })));
  const admin = new Set(toolNames(buildServer({ surface: "admin", adminAuthorized: true })));
  for (const t of skeleton) assert.ok(standard.has(t), `standard lost ${t}`);
  for (const t of standard) assert.ok(full.has(t), `full lost ${t}`);
  for (const t of full) assert.ok(orchestrator.has(t), `orchestrator lost ${t}`);
  for (const t of orchestrator) assert.ok(admin.has(t), `admin lost ${t}`);
  assert.ok(orchestrator.has("synapse_claim_and_brief"), "orchestrator must carry the delegation tools");
});

test("admin is credential-authorized, never a process flag", () => {
  assert.throws(
    () => buildServer({ surface: "admin" }),
    /admin-scoped bearer credential/,
  );
  assert.equal(surfaceForRequest("skeleton", true), "admin");
  assert.equal(surfaceForRequest("admin", false), "orchestrator");
  assert.equal(surfaceForRequest("standard", false), "standard");
  assert.equal(resolveSurface("admin"), "admin");
});

test("two builds are independent — no shared server instance", () => {
  const a = buildServer({ surface: "full" });
  const b = buildServer({ surface: "full" });
  assert.notEqual(a, b, "factory must mint a fresh server per call");
});

test("an unknown surface falls back to full rather than throwing", () => {
  assert.equal(resolveSurface("nonsense"), "full");
  assert.equal(resolveSurface(""), "full");
  assert.equal(resolveSurface("orchestrator"), "orchestrator");
});

test("every surface carries instructions", () => {
  for (const s of SURFACES) {
    assert.ok(INSTRUCTIONS[s]?.length > 100, `${s}: instructions missing or too short`);
  }
});

test("a plugin with an async register is REJECTED, not silently half-registered", () => {
  const asyncPlugin = { path: "/fake/async-plugin.mjs", name: "async-plugin.mjs", register: async () => {} };
  assert.throws(
    () => buildServer({ surface: "skeleton", plugins: [asyncPlugin] }),
    /async register\(\)/,
    "an async register must fail loudly — a per-connection factory cannot await it",
  );
});

test("a sync plugin registers, and lands on top of the surface", () => {
  const plugin = {
    path: "/fake/p.mjs",
    name: "p.mjs",
    register: (server) => {
      server.registerTool("plugin_probe", { description: "probe" }, async () => ({ content: [{ type: "text", text: "ok" }] }));
    },
  };
  const names = toolNames(buildServer({ surface: "skeleton", plugins: [plugin] }));
  assert.ok(names.includes("plugin_probe"), `plugin tool missing — got ${names.join(", ")}`);
  assert.equal(names.length, EXPECTED_COUNTS.skeleton + 1);
});

test("loadPlugins rejects a module that does not export register", async () => {
  const notAPlugin = new URL("./vault.mjs", import.meta.url).pathname;
  await assert.rejects(() => loadPlugins([notAPlugin]), /does not export register/);
});

test("discoverPluginPaths tolerates a vault with no plugins directory", () => {
  assert.deepEqual(discoverPluginPaths("/nonexistent-vault-path"), []);
});
