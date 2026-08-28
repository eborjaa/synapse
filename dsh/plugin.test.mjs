// plugin.test.mjs — Cordis will actually load this module. Pin the contract it demands.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Config, apply, inject, name } from "./plugin.mjs";

test("Config is a Standard Schema, so Cordis resolveConfig can load this plugin", () => {
  // Cordis fiber.ts: `runtime.Config["~standard"].validate(config)`. A JSON-Schema
  // object (`{ type: "object", properties: … }`) has no `~standard` and throws
  // before apply() ever runs — which is how this first shipped.
  assert.equal(typeof Config["~standard"]?.validate, "function");

  const result = Config["~standard"].validate({ surface: "orchestrator" });
  assert.equal("then" in result, false, "Cordis rejects async Config validation");
  assert.equal(result.issues, undefined);
  assert.equal(result.value.surface, "orchestrator");
  assert.equal(result.value.idleMs, 300_000);
});

test("an empty config still supplies the documented defaults", () => {
  const result = Config["~standard"].validate({});
  assert.equal(result.issues, undefined);
  assert.equal(result.value.surface, "orchestrator");
  assert.equal(result.value.idleMs, 300_000);
  assert.equal(result.value.transport, "stdio");
});

test("Config accepts the container HTTP transport", () => {
  const result = Config["~standard"].validate({
    transport: "http",
    httpUrl: "http://127.0.0.1:3000/mcp",
  });
  assert.equal(result.issues, undefined);
  assert.equal(result.value.transport, "http");
  assert.equal(result.value.httpUrl, "http://127.0.0.1:3000/mcp");
});

test("the plugin exports the Cordis wiring shape", () => {
  assert.equal(name, "synapse-vault-router");
  assert.deepEqual(inject, ["tools"]);
  assert.equal(typeof apply, "function");
});

test("apply() listens for agent/created and agent/disposed, and unwinds the pool on dispose", () => {
  const events = new Map();
  const ctx = {
    on(event, handler) {
      const list = events.get(event) || [];
      list.push(handler);
      events.set(event, list);
      return () => {};
    },
  };

  apply(ctx, { surface: "orchestrator", idleMs: 0 });

  assert.equal((events.get("agent/created") || []).length, 1);
  assert.equal((events.get("agent/disposed") || []).length, 1);
  assert.equal((events.get("dispose") || []).length, 1);
});
