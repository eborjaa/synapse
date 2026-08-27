// The dual-era guarantee, asserted against a real server process over raw JSON-RPC.
//
// This is the promise 1.x exists to keep: ONE binary answers both MCP eras, so Claude Code gets the
// stateless 2026-07-28 path while Cursor, opencode and DeepSeek Harness — all still legacy-only —
// keep working untouched. See [[decision-0010-mcp-2026-07-28-dual-era]].

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "server.mjs");
const VAULT = join(HERE, "..");
const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";

const modernMeta = () => ({
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "dual-era-test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

/** One server process, a list of requests, the matching responses. */
function talk(requests, { surface = "skeleton", timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-sqlite", SERVER], {
      cwd: VAULT,
      env: { ...process.env, SYNAPSE_VAULT: VAULT, SYNAPSE_MCP_SURFACE: surface },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const byId = new Map();
    let buf = "", done = false;
    const finish = (e, v) => { if (done) return; done = true; clearTimeout(t); try { child.kill(); } catch {} e ? reject(e) : resolve(v); };
    const t = setTimeout(() => finish(new Error("timed out")), timeoutMs);
    child.on("error", finish);
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null) byId.set(m.id, m);
        if (byId.size >= requests.length) finish(null, byId);
      }
    });
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

test("LEGACY era: the initialize handshake still works", async () => {
  const got = await talk([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "t", version: "1" } } },
  ]);
  const r = got.get(1);
  assert.equal(r.error, undefined, `initialize errored: ${JSON.stringify(r.error)}`);
  assert.equal(r.result.protocolVersion, LEGACY);
  assert.equal(r.result.serverInfo.name, "synapse");
  assert.ok(r.result.instructions?.length > 100, "instructions must survive into the legacy handshake");
});

test("MODERN era: server/discover advertises 2026-07-28 with cache hints", async () => {
  const got = await talk([
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: modernMeta() } },
  ]);
  const r = got.get(1);
  assert.equal(r.error, undefined, `server/discover errored: ${JSON.stringify(r.error)}`);
  assert.deepEqual(r.result.supportedVersions, [MODERN]);
  assert.equal(r.result.resultType, "complete");
  assert.equal(typeof r.result.ttlMs, "number");
  assert.ok(["private", "public"].includes(r.result.cacheScope), `unexpected cacheScope ${r.result.cacheScope}`);
  assert.ok(r.result.instructions?.length > 100, "instructions must survive into discover too");
});

test("MODERN era: tools/list works with NO handshake", async () => {
  const got = await talk([
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta() } },
  ], { surface: "orchestrator" });
  const r = got.get(1);
  assert.equal(r.error, undefined, `tools/list errored: ${JSON.stringify(r.error)}`);
  const names = r.result.tools.map((t) => t.name);
  assert.equal(names.length, 27, `orchestrator should expose 27 tools, got ${names.length}`);
  assert.ok(names.includes("synapse_claim_and_brief"));
  assert.equal(typeof r.result.ttlMs, "number", "a modern list result must carry ttlMs");
});

test("both eras expose the SAME tools — dual-era must not mean two surfaces", async () => {
  const legacy = await talk([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ], { surface: "full" });
  const modern = await talk([
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta() } },
  ], { surface: "full" });

  const a = legacy.get(2).result.tools.map((t) => t.name).sort();
  const b = modern.get(1).result.tools.map((t) => t.name).sort();
  assert.deepEqual(b, a, "the two eras disagree about which tools exist");
});

test("a connection is pinned to ONE era — discover after initialize is rejected", async () => {
  // Not a bug: serveStdio classifies the opening message and never re-negotiates. Pinning this so a
  // future change to era handling cannot silently make a connection bi-modal.
  const got = await talk([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: modernMeta() } },
  ]);
  assert.equal(got.get(1).error, undefined, "the legacy handshake should still succeed");
  assert.ok(got.get(2).error, "server/discover on a legacy-pinned connection must fail");
  assert.equal(got.get(2).error.code, -32601);
});

test("an unsupported modern revision is refused with the supported list", async () => {
  const got = await talk([
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { ...modernMeta(), "io.modelcontextprotocol/protocolVersion": "1999-01-01" } } },
  ]);
  const r = got.get(1);
  assert.ok(r.error, "a bogus revision must be refused, not served");
  assert.ok(JSON.stringify(r.error).includes(MODERN), `the error should name what IS supported: ${JSON.stringify(r.error)}`);
});
