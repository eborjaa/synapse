// mcp-config.test.mjs — the config GENERATION logic (shared by `synapse mcp-config` and `synapse install`).
// Focus: per-client shapes, env, and the AGNOSTIC provider policy (never clobber; seed only a vacuum;
// advise on /v1). Provider-outcome tests use the PURE helpers so they don't depend on the test machine's
// global ~/.config/opencode/opencode.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpTargets, applyMcpTargets, nativeOllamaProvider, providerUsesV1 } from "./mcp-config.mjs";

function tmpVault() {
  const root = mkdtempSync(join(tmpdir(), "syn-mcpcfg-"));
  return { root, vaultDir: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const pick = (targets, label) => targets.find((t) => t.label === label).cfg;
// Run fn with SYNAPSE_OLLAMA_URL forced to a known value (or unset), so provider tests are deterministic.
function withOllamaUrl(val, fn) {
  const prev = process.env.SYNAPSE_OLLAMA_URL;
  if (val === undefined) delete process.env.SYNAPSE_OLLAMA_URL; else process.env.SYNAPSE_OLLAMA_URL = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.SYNAPSE_OLLAMA_URL; else process.env.SYNAPSE_OLLAMA_URL = prev;
  }
}

test("client=all builds one target per CLI, each with the right shape", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    const { targets } = buildMcpTargets({ root, vaultDir });
    assert.deepEqual(targets.map((t) => t.label).sort(), ["Claude Code", "Cursor", "opencode"]);
    assert.equal(pick(targets, "Claude Code").mcpServers.synapse.type, "stdio");
    assert.ok(pick(targets, "Cursor").mcpServers.synapse.command);
    const oc = pick(targets, "opencode");
    assert.ok(Array.isArray(oc.mcp.synapse.command));   // opencode: `mcp`, command ARRAY, env `environment`
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

test("AGNOSTIC: a provider the user set per-vault is NEVER clobbered (only advised if on /v1)", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    // A user's own custom/cloud provider + model pair — synapse must leave it exactly as-is.
    writeFileSync(join(root, "opencode.json"), JSON.stringify({
      model: "ollama/my-model", small_model: "ollama/my-small",
      provider: { ollama: { npm: "custom", options: { baseURL: "https://remote:1234/v1" } } },
    }));
    const { targets, warnings } = buildMcpTargets({ root, vaultDir, client: "opencode" });
    const oc = pick(targets, "opencode");
    assert.equal(oc.provider.ollama.npm, "custom");                   // provider preserved verbatim
    assert.equal(oc.provider.ollama.options.baseURL, "https://remote:1234/v1");
    assert.equal(oc.model, "ollama/my-model");                        // model pair preserved
    assert.equal(oc.small_model, "ollama/my-small");
    assert.ok(oc.mcp.synapse);                                        // …and synapse still wired in
    // …but because it is on /v1, an ADVISORY is emitted (never a mutation).
    assert.ok(warnings.some((w) => /\/v1/.test(w) && /ollama-ai-provider-v2/.test(w)), "expected a /v1 advisory");
  } finally { cleanup(); }
});

test("AGNOSTIC: an existing NATIVE (/api) per-vault provider draws no warning", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    writeFileSync(join(root, "opencode.json"), JSON.stringify({
      provider: { ollama: { npm: "ollama-ai-provider-v2", options: { baseURL: "http://host:11434/api" } } },
    }));
    const { warnings } = buildMcpTargets({ root, vaultDir, client: "opencode" });
    assert.equal(warnings.length, 0);
  } finally { cleanup(); }
});

test("nativeOllamaProvider (the vacuum seed): native npm, /api, localhost by default", () => {
  withOllamaUrl(undefined, () => {
    const p = nativeOllamaProvider();
    assert.equal(p.npm, "ollama-ai-provider-v2");
    assert.equal(p.options.baseURL, "http://localhost:11434/api");  // localhost is correct ONLY in a vacuum
  });
});

test("nativeOllamaProvider: SYNAPSE_OLLAMA_URL sets the host; path normalized to /api", () => {
  assert.equal(nativeOllamaProvider({ ollamaUrlOverride: "http://box:11434/v1" }).options.baseURL, "http://box:11434/api");
  assert.equal(nativeOllamaProvider({ ollamaUrlOverride: "http://box:11434" }).options.baseURL, "http://box:11434/api");
  assert.equal(nativeOllamaProvider({ ollamaUrlOverride: "http://box:11434/api" }).options.baseURL, "http://box:11434/api"); // idempotent
});

test("providerUsesV1 detects the tool-call-dropping path", () => {
  assert.equal(providerUsesV1({ npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://x/api" } }), true); // by npm
  assert.equal(providerUsesV1({ npm: "custom", options: { baseURL: "http://x:1/v1" } }), true);                    // by /v1 baseURL
  assert.equal(providerUsesV1({ npm: "ollama-ai-provider-v2", options: { baseURL: "http://x:1/api" } }), false);
  assert.equal(providerUsesV1(null), false);
});

test("applyMcpTargets: dry-run writes nothing; write is idempotent", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    const { targets } = buildMcpTargets({ root, vaultDir, client: "claude" });
    const noop = () => {};
    assert.equal(applyMcpTargets(targets, { root, write: false, log: noop }), 0);   // dry-run
    assert.ok(!existsSync(join(root, ".mcp.json")));
    assert.equal(applyMcpTargets(targets, { root, write: true, log: noop }), 1);    // write
    assert.ok(existsSync(join(root, ".mcp.json")));
    const before = readFileSync(join(root, ".mcp.json"), "utf8");
    assert.equal(applyMcpTargets(targets, { root, write: true, log: noop }), 0);    // idempotent
    assert.equal(readFileSync(join(root, ".mcp.json"), "utf8"), before);
  } finally { cleanup(); }
});
