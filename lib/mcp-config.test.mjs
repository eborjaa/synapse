// mcp-config.test.mjs — the config GENERATION logic (shared by `synapse mcp-config` and `synapse install`).
// Focus: per-client shapes, env, and the AGNOSTIC provider policy (never clobber; seed only a vacuum;
// advise on /v1). Provider-outcome tests use the PURE helpers so they don't depend on the test machine's
// global ~/.config/opencode/opencode.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpTargets, applyMcpTargets, nativeOllamaProvider, providerUsesV1, existingSurface } from "./mcp-config.mjs";

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
    // A dry run WRITES nothing but now COUNTS what would change, so it can verify a wired vault.
    assert.equal(applyMcpTargets(targets, { root, write: false, log: noop }), 1);
    assert.ok(!existsSync(join(root, ".mcp.json")), "dry-run must not create the file");
    assert.equal(applyMcpTargets(targets, { root, write: true, log: noop }), 1);    // write
    assert.ok(existsSync(join(root, ".mcp.json")));
    const before = readFileSync(join(root, ".mcp.json"), "utf8");
    assert.equal(applyMcpTargets(targets, { root, write: true, log: noop }), 0);    // idempotent
    assert.equal(readFileSync(join(root, ".mcp.json"), "utf8"), before);
  } finally { cleanup(); }
});

test("regenerating PRESERVES other MCP servers a user already configured", () => {
  // A vault is a normal repo: its .mcp.json routinely holds github/postgres rows set up by hand.
  // Overwriting the file wholesale silently deleted them.
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: {
        github: { type: "stdio", command: "gh-mcp", args: ["serve"] },
        synapse: { type: "stdio", command: "stale-path", args: [] },
      },
    }));
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(join(root, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { figma: { command: "figma-mcp" } } }));

    const { targets, warnings } = buildMcpTargets({ root, vaultDir });
    const claude = pick(targets, "Claude Code");
    assert.deepEqual(Object.keys(claude.mcpServers).sort(), ["github", "synapse"]);
    assert.equal(claude.mcpServers.github.command, "gh-mcp", "a foreign server must survive untouched");
    assert.notEqual(claude.mcpServers.synapse.command, "stale-path", "ours is still regenerated");
    assert.deepEqual(Object.keys(pick(targets, "Cursor").mcpServers).sort(), ["figma", "synapse"]);
    assert.match(warnings.join(" "), /kept 1 other server\(s\) — github/);
    assert.match(warnings.join(" "), /kept 1 other server\(s\) — figma/);
  } finally { cleanup(); }
});

test("an unparseable existing config is REPLACED, but says so first", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    writeFileSync(join(root, ".mcp.json"), "{ this is not json");
    const { targets, warnings } = buildMcpTargets({ root, vaultDir, client: "claude" });
    assert.deepEqual(Object.keys(pick(targets, "Claude Code").mcpServers), ["synapse"]);
    assert.match(warnings.join(" "), /not valid JSON — it will be REPLACED/);
  } finally { cleanup(); }
});

test("a foreign server's OWN env is never polluted by synapse's env carry-over", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { github: { command: "gh-mcp", env: { GH_TOKEN: "secret" } } },
    }));
    const claude = pick(buildMcpTargets({ root, vaultDir, client: "claude" }).targets, "Claude Code");
    assert.deepEqual(claude.mcpServers.github.env, { GH_TOKEN: "secret" });
    assert.ok(!("GH_TOKEN" in claude.mcpServers.synapse.env), "another server's env is not ours to copy");
  } finally { cleanup(); }
});

test("a dry run reports whether anything WOULD change — it cannot always say 'apply me'", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    const { targets } = buildMcpTargets({ root, vaultDir });
    const quiet = () => {};
    assert.equal(applyMcpTargets(targets, { root, write: false, log: quiet }), targets.length,
      "nothing written yet → every target would change");
    applyMcpTargets(targets, { root, write: true, log: quiet });
    assert.equal(applyMcpTargets(targets, { root, write: false, log: quiet }), 0,
      "all current → a dry run must report zero, so it can be used to VERIFY a vault is wired");
  } finally { cleanup(); }
});

const surfaceOf = (t) => t.mcpServers.synapse.env.SYNAPSE_MCP_SURFACE;

test("regenerating KEEPS the surface a vault is already on — install must not downgrade it", () => {
  // The trap: raise a vault to orchestrator, then the documented upgrade step (`install --write`,
  // which passes no surface) silently reset it to `full`.
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    const raised = buildMcpTargets({ root, vaultDir, surface: "orchestrator" });
    assert.equal(raised.surface, "orchestrator");
    assert.equal(raised.surfaceSource, "--surface");
    applyMcpTargets(raised.targets, { root, write: true, log: () => {} });

    const plain = buildMcpTargets({ root, vaultDir });          // no surface — the upgrade path
    assert.equal(plain.surface, "orchestrator");
    assert.match(plain.surfaceSource, /kept/);
    assert.equal(surfaceOf(pick(plain.targets, "Claude Code")), "orchestrator");
  } finally { cleanup(); }
});

test("a fresh vault defaults to full, and an explicit --surface always wins", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    const fresh = buildMcpTargets({ root, vaultDir });
    assert.equal(fresh.surface, "full");
    assert.equal(fresh.surfaceSource, "default");
    applyMcpTargets(fresh.targets, { root, write: true, log: () => {} });
    // An explicit flag overrides what is on disk, in both directions.
    assert.equal(buildMcpTargets({ root, vaultDir, surface: "skeleton" }).surface, "skeleton");
  } finally { cleanup(); }
});

test("existingSurface reads the surface back, and reports client disagreement", () => {
  const { root, vaultDir, cleanup } = tmpVault();
  try {
    assert.deepEqual(existingSurface(root), { surface: null, found: [] });
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { synapse: { env: { SYNAPSE_MCP_SURFACE: "orchestrator" } } },
    }));
    assert.equal(existingSurface(root).surface, "orchestrator");

    writeFileSync(join(root, "opencode.json"), JSON.stringify({
      mcp: { synapse: { environment: { SYNAPSE_MCP_SURFACE: "standard" } } },
    }));
    assert.equal(existingSurface(root).surface, null, "disagreement must not be resolved by guessing");
    assert.match(buildMcpTargets({ root, vaultDir }).warnings.join(" "), /disagree on the MCP surface/);

    // A junk value is ignored rather than propagated into a config.
    writeFileSync(join(root, "opencode.json"), JSON.stringify({
      mcp: { synapse: { environment: { SYNAPSE_MCP_SURFACE: "bogus" } } },
    }));
    assert.equal(existingSurface(root).surface, "orchestrator");
  } finally { cleanup(); }
});
