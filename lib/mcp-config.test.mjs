// mcp-config.test.mjs — the config GENERATION logic (shared by `synapse mcp-config` and `synapse install`).
// Focus: per-client shapes, env, and the native-Ollama seeding rules the opencode MCP fix depends on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpTargets, applyMcpTargets } from "./mcp-config.mjs";

function tmpVault() {
  const root = mkdtempSync(join(tmpdir(), "syn-mcpcfg-"));
  return { root, vaultDir: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const pick = (targets, label) => targets.find((t) => t.label === label).cfg;

test("client=all builds one target per CLI, each with the right shape", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    const { targets } = buildMcpTargets({ root, vaultDir });
    assert.deepEqual(targets.map((t) => t.label).sort(), ["Claude Code", "Cursor", "opencode"]);
    // Claude: mcpServers.synapse.type === "stdio"
    assert.equal(pick(targets, "Claude Code").mcpServers.synapse.type, "stdio");
    // Cursor: mcpServers.synapse, no `type`
    assert.ok(pick(targets, "Cursor").mcpServers.synapse.command);
    // opencode: `mcp` (not mcpServers), command is an ARRAY, env is `environment`
    const oc = pick(targets, "opencode");
    assert.ok(Array.isArray(oc.mcp.synapse.command));
    assert.equal(oc.mcp.synapse.type, "local");
    assert.ok(oc.mcp.synapse.environment.SYNAPSE_VAULT);
  } finally { cleanup(); }
});

test("client filter + surface/env are threaded through", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    const { targets } = buildMcpTargets({ root, vaultDir, client: "opencode", surface: "orchestrator", extraEnv: { ZEPHYR_MCP_DISABLE: "1" } });
    assert.equal(targets.length, 1);
    const env = targets[0].cfg.mcp.synapse.environment;
    assert.equal(env.SYNAPSE_MCP_SURFACE, "orchestrator");
    assert.equal(env.ZEPHYR_MCP_DISABLE, "1");
    assert.equal(env.NODE_OPTIONS, "--experimental-sqlite");
  } finally { cleanup(); }
});

test("opencode gets the NATIVE ollama provider (/api endpoint) when the vault has none", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    const oc = pick(buildMcpTargets({ root, vaultDir, client: "opencode" }).targets, "opencode");
    assert.equal(oc.provider.ollama.npm, "ollama-ai-provider-v2");
    assert.match(oc.provider.ollama.options.baseURL, /\/api$/);
    assert.doesNotMatch(oc.provider.ollama.options.baseURL, /\/v1/); // NOT the tool-call-dropping /v1 path
  } finally { cleanup(); }
});

test("an existing ollama provider is NOT clobbered (merge-not-overwrite)", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    // A user already configured a cloud/custom ollama provider + a model pair.
    writeFileSync(join(root, "opencode.json"), JSON.stringify({
      model: "ollama/my-model", small_model: "ollama/my-small",
      provider: { ollama: { npm: "custom", options: { baseURL: "https://remote:1234/v1" } } },
    }));
    const oc = pick(buildMcpTargets({ root, vaultDir, client: "opencode" }).targets, "opencode");
    assert.equal(oc.provider.ollama.npm, "custom");                   // provider preserved
    assert.equal(oc.provider.ollama.options.baseURL, "https://remote:1234/v1");
    assert.equal(oc.model, "ollama/my-model");                        // model pair preserved
    assert.equal(oc.small_model, "ollama/my-small");
    assert.ok(oc.mcp.synapse);                                        // …and synapse still wired in
  } finally { cleanup(); }
});

test("applyMcpTargets: dry-run writes nothing; write is idempotent", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    const { targets } = buildMcpTargets({ root, vaultDir, client: "claude" });
    const noop = () => {};
    // dry-run
    assert.equal(applyMcpTargets(targets, { root, write: false, log: noop }), 0);
    assert.ok(!existsSync(join(root, ".mcp.json")));
    // write
    assert.equal(applyMcpTargets(targets, { root, write: true, log: noop }), 1);
    assert.ok(existsSync(join(root, ".mcp.json")));
    // re-write is idempotent (0 changed, same bytes)
    const before = readFileSync(join(root, ".mcp.json"), "utf8");
    assert.equal(applyMcpTargets(targets, { root, write: true, log: noop }), 0);
    assert.equal(readFileSync(join(root, ".mcp.json"), "utf8"), before);
  } finally { cleanup(); }
});
