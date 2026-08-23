#!/usr/bin/env node
// conformance.mjs — snapshot synapse-mcp's WIRE surface using raw JSON-RPC, no MCP SDK.
//
// Why raw: mcp/smoke.mjs drives the server through the v1 client, so it can only ever see what that
// SDK version speaks. This file talks the protocol directly, which makes it a fixed reference point
// while the SDK underneath us changes — the baseline that proves a refactor (or an SDK swap) did not
// move the wire.
//
//   node mcp/conformance.mjs --surface full            # human-readable
//   node mcp/conformance.mjs --surface full --json     # canonical JSON (stable key order)
//   node mcp/conformance.mjs --all --json > baseline.json
//
// Probes BOTH protocol eras against the same binary — legacy (2025-11-25, `initialize` handshake) and
// modern (2026-07-28, stateless, `server/discover`). That pair IS the dual-era guarantee, so it is the
// thing worth pinning: see [[decision-0010-mcp-2026-07-28-dual-era]].
//
// Canonical output: tools sorted by name, object keys sorted, volatile fields (version, absolute
// paths) elided — so two runs are byte-identical and `diff` is meaningful.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "server.mjs");
const VAULT = join(HERE, "..");
const SURFACES = ["skeleton", "standard", "full", "orchestrator"];
const MODERN_REVISION = "2026-07-28";

/** The modern era carries what the handshake used to, inline on every request. */
const modernMeta = () => ({
  "io.modelcontextprotocol/protocolVersion": MODERN_REVISION,
  "io.modelcontextprotocol/clientInfo": { name: "synapse-conformance", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

/** Speak raw JSON-RPC to one server process and return the captured wire surface. */
function probe(surface, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-sqlite", SERVER], {
      cwd: VAULT,
      env: { ...process.env, SYNAPSE_VAULT: VAULT, SYNAPSE_MCP_SURFACE: surface },
      stdio: ["pipe", "pipe", "ignore"],
    });

    const want = new Map();          // id -> resolver
    const out = {};
    let buf = "";
    let done = false;

    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`${surface}: timed out after ${timeoutMs}ms`)), timeoutMs);
    child.on("error", (e) => finish(e));
    child.on("exit", (code) => { if (!done) finish(new Error(`${surface}: server exited ${code} before replying`)); });

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    const request = (id, method, params) => new Promise((res) => { want.set(id, res); send({ jsonrpc: "2.0", id, method, params }); });

    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && want.has(msg.id)) { want.get(msg.id)(msg); want.delete(msg.id); }
      }
    });

    (async () => {
      const init = await request(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "synapse-conformance", version: "1" },
      });
      if (init.error) return finish(new Error(`${surface}: initialize failed — ${JSON.stringify(init.error)}`));

      out.initialize = {
        protocolVersion: init.result?.protocolVersion ?? null,
        serverName: init.result?.serverInfo?.name ?? null,
        capabilities: sortKeys(init.result?.capabilities ?? {}),
        // The instructions block is part of the contract — a model reads it. Hash it so a reword is
        // caught, without pinning several KB of prose into the baseline.
        instructionsBytes: (init.result?.instructions ?? "").length,
        instructionsHead: (init.result?.instructions ?? "").slice(0, 60),
      };

      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      const list = await request(2, "tools/list", {});
      if (list.error) return finish(new Error(`${surface}: tools/list failed — ${JSON.stringify(list.error)}`));

      out.tools = (list.result?.tools ?? [])
        .map((t) => ({
          name: t.name,
          descriptionBytes: (t.description ?? "").length,
          inputSchema: sortKeys(t.inputSchema ?? {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      out.toolCount = out.tools.length;

      finish(null, out);
    })().catch((e) => finish(e));
  });
}

/**
 * The modern era, in its OWN process. A connection is pinned to one era by its opening message
 * (serveStdio classifies it and never re-negotiates), so `server/discover` on a connection that
 * already sent `initialize` correctly answers "Method not found". Two eras, two processes.
 */
function probeModern(surface, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-sqlite", SERVER], {
      cwd: VAULT,
      env: { ...process.env, SYNAPSE_VAULT: VAULT, SYNAPSE_MCP_SURFACE: surface },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const want = new Map();
    let buf = "";
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(v); };
    const timer = setTimeout(() => finish({ served: false, error: { code: null, message: `timed out after ${timeoutMs}ms` } }), timeoutMs);
    child.on("error", (e) => finish({ served: false, error: { code: null, message: e.message } }));

    const request = (id, method, params) => new Promise((res) => {
      want.set(id, res);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && want.has(msg.id)) { want.get(msg.id)(msg); want.delete(msg.id); }
      }
    });

    (async () => {
      const discover = await request(1, "server/discover", { _meta: modernMeta() });
      if (discover.error) {
        return finish({ served: false, error: { code: discover.error.code, message: discover.error.message } });
      }
      const list = await request(2, "tools/list", { _meta: modernMeta() });
      finish({
        served: true,
        supportedVersions: discover.result?.supportedVersions ?? null,
        resultType: discover.result?.resultType ?? null,
        ttlMs: discover.result?.ttlMs ?? null,
        cacheScope: discover.result?.cacheScope ?? null,
        instructionsBytes: (discover.result?.instructions ?? "").length,
        toolsWithoutHandshake: list.error ? null : (list.result?.tools ?? []).map((x) => x.name).sort(),
        listTtlMs: list.result?.ttlMs ?? null,
        listCacheScope: list.result?.cacheScope ?? null,
      });
    })().catch((e) => finish({ served: false, error: { code: null, message: e.message } }));
  });
}

/** Deterministic key order, so the JSON is diffable. */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const all = args.includes("--all");
const one = (() => { const i = args.indexOf("--surface"); return i >= 0 ? args[i + 1] : null; })();
const targets = all ? SURFACES : [one ?? "full"];

const result = {};
for (const s of targets) {
  result[s] = await probe(s);
  result[s].modern = await probeModern(s);
}

if (asJson) {
  console.log(JSON.stringify(sortKeys(result), null, 2));
} else {
  for (const [s, r] of Object.entries(result)) {
    console.log(`\nsurface=${s}`);
    console.log(`  protocolVersion : ${r.initialize.protocolVersion}`);
    console.log(`  serverName      : ${r.initialize.serverName}`);
    console.log(`  capabilities    : ${JSON.stringify(r.initialize.capabilities)}`);
    console.log(`  instructions    : ${r.initialize.instructionsBytes} bytes — "${r.initialize.instructionsHead}…"`);
    console.log(`  tools (${r.toolCount}) : ${r.tools.map((t) => t.name).join(", ")}`);
    const m = r.modern;
    console.log(m.served
      ? `  modern era      : SERVED — ${JSON.stringify(m.supportedVersions)}, ${m.toolsWithoutHandshake?.length ?? 0} tools with no handshake (ttlMs=${m.listTtlMs}, cacheScope=${m.listCacheScope})`
      : `  modern era      : NOT served — ${m.error?.code} ${m.error?.message}`);
  }
  console.log();
}
