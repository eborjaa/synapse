#!/usr/bin/env node
// four-harness-e2e.mjs — Epic 6: each harness connects, its tool list matches, it reaches its
// bound vault, and it cannot reach another. Run once, offline, no API key.
//
// The four harnesses are Claude Code, Cursor, opencode, and the DeepSeek Harness. Claude / Cursor /
// opencode bind by a config file Synapse writes *inside* the vault; DSH has no such file, so it binds
// through @eborja/synapse/dsh-plugin. This rig drives those actual wiring paths — the generated
// command + env + cwd for the first three, the session-cwd plugin for DSH — and speaks the MCP
// handshake the harness itself speaks (modern 2026-07-28 for Claude Code, legacy initialize for the
// other three). Assertions are on the handshake and the tool list, never model output.
//
// We do not wrap the four CLI binaries in containers. Those CLIs are built for interactive use and
// several need an API key to do more than inspect config. The handover said: if a CLI cannot be
// driven headlessly, fall back and label that harness's result weaker. Config-spawn is that fallback
// for Claude / Cursor / opencode; it is still the child those CLIs would launch. DSH is the plugin.
//
//   node --experimental-sqlite mcp/four-harness-e2e.mjs
//   node --experimental-sqlite --test mcp/four-harness-e2e.test.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildMcpTargets, applyMcpTargets } from "../lib/mcp-config.mjs";
import { addVault, writeRegistry } from "../lib/vaults.mjs";
import { bindSessionTools, toolName } from "../dsh/session-tools.mjs";
import { createVaultPool } from "../dsh/vault-pool.mjs";
import { modernMeta } from "./conformance.mjs";

const SURFACE = "orchestrator";
const EXPECTED_TOOLS = 26;
const HARNESSES = [
  { id: "claude",   label: "Claude Code",         era: "modern" },
  { id: "cursor",   label: "Cursor CLI",          era: "legacy" },
  { id: "opencode", label: "opencode",            era: "legacy" },
  { id: "dsh",      label: "DeepSeek Harness",    era: "legacy" },
];

const MANIFEST = {
  repo: "epic6", logLabel: "synapse", vaultRoot: ".", skipDirs: ["node_modules", "inbox"],
  roles: { NAVIGATES: { field: "related", direction: "forward", endpointTypes: ["hub"] } },
  profiles: { lean: { roles: [], depth: {} }, standard: { roles: [], depth: {} }, fat: { roles: [], depth: {} } },
  tokenBudgets: { lean: 4000, standard: 15000, fat: 30000 },
  excerptChars: { lean: 40, standard: 4000, fat: 0 },
  typePriority: ["agent", "hub"], trailers: { canary: false }, invariants: [],
};

function makeVault(tag) {
  const dir = mkdtempSync(join(tmpdir(), `syn-e6-${tag}-`));
  const put = (rel, content) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  put("_meta/tools/context.manifest.json", `${JSON.stringify(MANIFEST, null, 2)}\n`);
  put(
    `agents/agent-${tag}-only.md`,
    `---\nid: agent-${tag}-only\ntype: agent\ntitle: "${tag} only"\n`
      + `purpose: "private to ${tag}"\naddressable: true\nautonomous: false\n`
      + `tags:\n  - type/agent\n---\n\n# ${tag}\n`,
  );
  return { tag, dir };
}

/** Speak one JSON-RPC session to a stdio child. Node-side timer — macOS has no `timeout(1)`. */
function rpcSession({ command, args, cwd, env, era, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const want = new Map();
    let buf = "";
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    child.on("error", (e) => finish(e));
    child.stderr?.on("data", () => { /* keep the pipe from filling; ready line is noise here */ });

    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const request = (id, method, params) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${method} #${id} timed out`)), timeoutMs);
      want.set(id, (msg) => { clearTimeout(t); res(msg); });
      send({ jsonrpc: "2.0", id, method, params });
    });

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
      const meta = era === "modern" ? { _meta: modernMeta() } : {};
      if (era === "modern") {
        const discover = await request(1, "server/discover", meta);
        if (discover.error) throw new Error(`server/discover: ${JSON.stringify(discover.error)}`);
      } else {
        const init = await request(1, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "epic6-four-harness", version: "1" },
        });
        if (init.error) throw new Error(`initialize: ${JSON.stringify(init.error)}`);
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
      }
      const list = await request(2, "tools/list", era === "modern" ? meta : {});
      if (list.error) throw new Error(`tools/list: ${JSON.stringify(list.error)}`);
      const call = await request(3, "tools/call", {
        name: "synapse_list_agents",
        arguments: {},
        ...(era === "modern" ? meta : {}),
      });
      if (call.error) throw new Error(`tools/call list_agents: ${JSON.stringify(call.error)}`);
      const attack = await request(4, "tools/call", {
        name: "synapse_list_agents",
        arguments: { vault: "SHOULD-NOT-BIND", vaultId: "SHOULD-NOT-BIND" },
        ...(era === "modern" ? meta : {}),
      });
      finish(null, {
        tools: (list.result?.tools ?? []).map((t) => t.name).sort(),
        agents: String(call.result?.content?.[0]?.text || call.result?.content || ""),
        agentsUnderAttack: String(attack.result?.content?.[0]?.text || attack.result?.content || ""),
      });
    })().catch((e) => finish(e));
  });
}

function spawnSpec(harnessId, cfg, vaultRoot) {
  if (harnessId === "opencode") {
    const row = cfg.mcp.synapse;
    const argv = row.command;
    return { command: argv[0], args: argv.slice(1), env: row.environment, cwd: vaultRoot };
  }
  const row = cfg.mcpServers.synapse;
  return { command: row.command, args: row.args || [], env: row.env, cwd: vaultRoot };
}

async function driveStdio(harness, own, other) {
  const built = buildMcpTargets({
    root: own.dir,
    vaultDir: own.dir,
    surface: SURFACE,
    client: harness.id,
  });
  applyMcpTargets(built.targets, { root: own.dir, write: true, log: () => {} });
  const spec = spawnSpec(harness.id, built.targets[0].cfg, own.dir);
  const session = await rpcSession({ ...spec, era: harness.era });
  return { ...session, strength: "config-spawn" };
}

async function driveDsh(own, other, pool) {
  const registered = new Map();
  const bound = await bindSessionTools({
    cwd: own.dir,
    pool,
    register: (def) => {
      registered.set(def.name, def);
      return () => registered.delete(def.name);
    },
  });
  try {
    if (!bound.bound) throw new Error(`DSH plugin registered nothing for ${own.dir}`);
    const list = bound.tools.slice().sort();
    const agentsTool = registered.get(toolName("synapse_list_agents"));
    const agents = String((await agentsTool.execute({}, {}))?.content?.[0]?.text || "");
    const agentsUnderAttack = String(
      (await agentsTool.execute({ vault: other.dir, vaultId: other.tag }, {}))?.content?.[0]?.text || "",
    );
    return { tools: list.map((n) => n.replace(/^mcp__synapse__/, "")), agents, agentsUnderAttack, strength: "plugin" };
  } finally {
    await bound.dispose();
  }
}

function check(session, own, others) {
  const connect = { ok: session.tools.length > 0, detail: `${session.tools.length} tools` };
  const list = {
    ok: session.tools.length === EXPECTED_TOOLS && session.tools.includes("synapse_list_agents"),
    detail: `got ${session.tools.length}, expected ${EXPECTED_TOOLS}`,
  };
  const reaches = {
    ok: session.agents.includes(`agent-${own.tag}-only`) || session.agents.includes(`${own.tag} only`),
    detail: session.agents.slice(0, 120),
  };
  const leaks = others.filter(
    (v) => session.agents.includes(`agent-${v.tag}-only`) || session.agentsUnderAttack.includes(`agent-${v.tag}-only`),
  );
  const isolated = {
    ok: leaks.length === 0,
    detail: leaks.length ? `saw ${leaks.map((v) => v.tag).join(",")}` : "no other vault visible, including via tool arguments",
  };
  return { connect, list, reaches, isolated, strength: session.strength };
}

/**
 * Run the four-harness matrix. Returns a report; does not throw on a failed assertion
 * (the test file does). Always cleans the temp vaults.
 */
export async function runFourHarnessE2e() {
  const previousHome = process.env.SYNAPSE_HOME;
  const home = mkdtempSync(join(tmpdir(), "syn-e6-home-"));
  process.env.SYNAPSE_HOME = home;

  const vaults = HARNESSES.map((h) => makeVault(h.id));
  let reg = { version: 1, vaults: [] };
  for (const v of vaults) {
    const added = addVault(v.dir, reg);
    reg = added.reg;
    v.id = added.entry.id;
  }
  writeRegistry(reg);

  const pool = createVaultPool({ surface: SURFACE, idleMs: 0 });
  const harnesses = [];
  try {
    for (let i = 0; i < HARNESSES.length; i++) {
      const harness = HARNESSES[i];
      const own = vaults[i];
      const others = vaults.filter((_, j) => j !== i);
      let session;
      try {
        session = harness.id === "dsh"
          ? await driveDsh(own, others[0], pool)
          : await driveStdio(harness, own, others[0]);
        harnesses.push({ id: harness.id, label: harness.label, era: harness.era, ...check(session, own, others) });
      } catch (error) {
        harnesses.push({
          id: harness.id,
          label: harness.label,
          era: harness.era,
          connect: { ok: false, detail: error.message },
          list: { ok: false, detail: error.message },
          reaches: { ok: false, detail: error.message },
          isolated: { ok: false, detail: error.message },
          strength: "failed",
        });
      }
    }
  } finally {
    await pool.disposeAll();
    if (previousHome === undefined) delete process.env.SYNAPSE_HOME;
    else process.env.SYNAPSE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    for (const v of vaults) rmSync(v.dir, { recursive: true, force: true });
  }

  const passed = harnesses.every((h) => h.connect.ok && h.list.ok && h.reaches.ok && h.isolated.ok);
  return { passed, expectedTools: EXPECTED_TOOLS, harnesses };
}

export function formatReport(report) {
  const rows = report.harnesses.map((h) => {
    const cell = (a) => (a.ok ? "PASS" : "FAIL");
    return `${h.label.padEnd(22)} connect=${cell(h.connect)}  list=${cell(h.list)}  own-vault=${cell(h.reaches)}  isolated=${cell(h.isolated)}  (${h.strength}, ${h.era})`;
  });
  return [`Epic 6 four-harness e2e — ${report.passed ? "PASS" : "FAIL"}`, ...rows].join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const report = await runFourHarnessE2e();
  process.stdout.write(`${formatReport(report)}\n`);
  process.exit(report.passed ? 0 : 1);
}
