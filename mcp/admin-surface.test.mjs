// admin-surface.test.mjs — Epic 3: privileged operations are a separate catalogue.
//
//   US-3.1  an everyday session has no credential/vault-registration tools at all (absence, not refusal)
//   US-3.2  an admin-scoped credential gets register/list/mint/revoke/sync, and mutations hit the transcript
//
// The security boundary is the catalogue. If mint were registered and the handler said "no", a prompt
// injection would still have a tool to call. These tests fail if any everyday surface lists an admin
// tool, and they fail if an admin-scoped HTTP bearer does not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { toolTransportAdapters } from "../lib/ports/index.mjs";
import { mintToken, writeTokens } from "../lib/ports/vault-tokens.mjs";
import { addVault, writeRegistry } from "../lib/vaults.mjs";
import { MCP_SURFACES } from "../lib/mcp-config.mjs";
import { buildServer, EVERYDAY_SURFACES } from "./build-server.mjs";
import { ADMIN_TOOL_NAMES } from "./tools/admin.mjs";

const MANIFEST = {
  repo: "admin-test",
  logLabel: "synapse",
  vaultRoot: ".",
  skipDirs: ["node_modules", "inbox"],
  roles: {
    CONSTRAINS: { field: "applies_rules", direction: "forward", mandatoryFull: true },
    USES: { field: ["invokes_skills", "uses_tools"], direction: "forward" },
    NAVIGATES: { field: "related", direction: "forward", endpointTypes: ["hub", "moc"] },
  },
  profiles: {
    lean: { roles: [], depth: {} },
    standard: { roles: [], depth: {} },
    fat: { roles: [], depth: {} },
  },
  tokenBudgets: { lean: 4000, standard: 15000, fat: 30000 },
  excerptChars: { lean: 40, standard: 4000, fat: 0 },
  typePriority: ["agent", "hub"],
  trailers: { canary: false },
  invariants: [],
};

function makeVault(tag) {
  const dir = mkdtempSync(join(tmpdir(), `syn-admin-${tag}-`));
  const put = (rel, content) => {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
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

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "syn-admin-home-"));
  const previousHome = process.env.SYNAPSE_HOME;
  process.env.SYNAPSE_HOME = home;
  const vaults = ["alpha", "bravo"].map(makeVault);

  let reg = { version: 1, vaults: [] };
  for (const vault of vaults) {
    const added = addVault(vault.dir, reg);
    reg = added.reg;
    vault.id = added.entry.id;
  }
  writeRegistry(reg);

  let store = { version: 1, tokens: [] };
  const normal = mintToken(vaults[0].id, { store, label: "normal" });
  store = normal.store;
  vaults[0].token = normal.plaintext;
  const admin = mintToken(vaults[0].id, { store, label: "admin", scopes: ["admin"] });
  store = admin.store;
  vaults[0].adminToken = admin.plaintext;
  const bravo = mintToken(vaults[1].id, { store, label: "bravo" });
  store = bravo.store;
  vaults[1].token = bravo.plaintext;
  writeTokens(store);

  return {
    home,
    alpha: vaults[0],
    bravo: vaults[1],
    extra: [],
    clean() {
      if (previousHome === undefined) delete process.env.SYNAPSE_HOME;
      else process.env.SYNAPSE_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
      for (const vault of vaults) rmSync(vault.dir, { recursive: true, force: true });
      for (const dir of this.extra) rmSync(dir, { recursive: true, force: true });
    },
  };
}

let nextRpcId = 1;

async function replyOf(response) {
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data: ")).at(-1)?.slice(6) || ""
    : text;
  let body = null;
  try { body = JSON.parse(payload); } catch { /* assertion below will show the raw body */ }
  return { status: response.status, text, body };
}

async function rpc(url, token, method, params = {}) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
  };
  if (method === "tools/call" && typeof params.name === "string") headers["mcp-name"] = params.name;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextRpcId++,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "admin-surface-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return replyOf(response);
}

const toolNames = (reply) => (reply.body?.result?.tools || []).map((tool) => tool.name).sort();
const toolText = (reply) => reply.body?.result?.content?.[0]?.text || "";
const toolJson = (reply) => JSON.parse(toolText(reply));

test("generated stdio config never offers the admin surface", () => {
  assert.equal(MCP_SURFACES.includes("admin"), false);
});

test("US-3.1: every everyday factory catalogue excludes every credential tool", () => {
  for (const surface of EVERYDAY_SURFACES) {
    const names = Object.keys(buildServer({ surface })._registeredTools ?? {}).sort();
    for (const name of ADMIN_TOOL_NAMES) {
      assert.equal(names.includes(name), false, `${surface} registered ${name}`);
    }
  }
});

test("Epic 3 — admin is a credential-authorized HTTP catalogue", async (t) => {
  const s = sandbox();
  const http = toolTransportAdapters.get("http");
  let live = null;
  try {
    live = await http.serve(buildServer, {
      host: "127.0.0.1",
      port: 0,
      surface: "orchestrator",
      plugins: [],
    });

    await t.test("US-3.1: a normal bearer sees orchestrator tools and zero admin tools", async () => {
      const reply = await rpc(live.url, s.alpha.token, "tools/list");
      assert.equal(reply.status, 200, reply.text);
      const names = toolNames(reply);
      assert.equal(names.length, 27, `normal catalogue moved — ${names.join(", ")}`);
      for (const name of ADMIN_TOOL_NAMES) {
        assert.equal(names.includes(name), false, `normal session listed ${name}`);
      }
    });

    await t.test("a normal bearer cannot call an admin tool that is not on the catalogue", async () => {
      const listed = toolNames(await rpc(live.url, s.alpha.token, "tools/list"));
      assert.equal(listed.includes("synapse_admin_mint"), false);
      const reply = await rpc(live.url, s.alpha.token, "tools/call", {
        name: "synapse_admin_mint",
        arguments: { vaultId: s.bravo.id, admin: true },
      });
      const text = toolText(reply);
      assert.equal(text.includes("plaintext"), false);
      assert.ok(
        reply.body?.error || reply.body?.result?.isError,
        `calling a missing admin tool must fail, got ${reply.text}`,
      );
    });

    await t.test("US-3.2: an admin-scoped bearer gets the five admin tools on top of orchestrator", async () => {
      const reply = await rpc(live.url, s.alpha.adminToken, "tools/list");
      assert.equal(reply.status, 200, reply.text);
      const names = toolNames(reply);
      assert.equal(names.length, 32, `admin catalogue moved — ${names.join(", ")}`);
      for (const name of ADMIN_TOOL_NAMES) assert.ok(names.includes(name), `admin missing ${name}`);
      assert.ok(names.includes("synapse_claim_and_brief"));
    });

    await t.test("US-3.2: list/register/mint/revoke/sync report every mutation in the transcript", async () => {
      const listed = await rpc(live.url, s.alpha.adminToken, "tools/call", {
        name: "synapse_admin_list",
        arguments: {},
      });
      assert.equal(listed.status, 200, listed.text);
      const listBody = toolJson(listed);
      assert.ok(Array.isArray(listBody.vaults));
      assert.equal(JSON.stringify(listBody).includes(s.alpha.adminToken), false, "list must not return plaintext");

      const extra = makeVault("charlie");
      s.extra.push(extra.dir);
      const registered = await rpc(live.url, s.alpha.adminToken, "tools/call", {
        name: "synapse_admin_register",
        arguments: { path: extra.dir },
      });
      assert.equal(registered.status, 200, registered.text);
      const regBody = toolJson(registered);
      assert.equal(regBody.mutation, "vault.register");
      assert.equal(regBody.status, "registered");
      extra.id = regBody.vault.id;

      const minted = await rpc(live.url, s.alpha.adminToken, "tools/call", {
        name: "synapse_admin_mint",
        arguments: { vaultId: extra.id, label: "from-admin" },
      });
      assert.equal(minted.status, 200, minted.text);
      const mintBody = toolJson(minted);
      assert.equal(mintBody.mutation, "credential.mint");
      assert.equal(mintBody.status, "minted");
      assert.match(mintBody.plaintext, /^syn_/);
      assert.deepEqual(mintBody.scopes, []);

      const revoked = await rpc(live.url, s.alpha.adminToken, "tools/call", {
        name: "synapse_admin_revoke",
        arguments: { selector: "from-admin" },
      });
      assert.equal(revoked.status, 200, revoked.text);
      const revokeBody = toolJson(revoked);
      assert.equal(revokeBody.mutation, "credential.revoke");
      assert.equal(revokeBody.status, "revoked");
      // The whole grant is reported, not one id: a credential may reach several vaults now
      // ([[decision-0017-path-addressed-vaults]]), and naming one would understate what was revoked.
      assert.deepEqual(revokeBody.credential.vaultIds, [extra.id]);

      const planned = await rpc(live.url, s.alpha.adminToken, "tools/call", {
        name: "synapse_admin_sync",
        arguments: { write: false },
      });
      assert.equal(planned.status, 200, planned.text);
      const syncBody = toolJson(planned);
      assert.equal(syncBody.mutation, "vault.sync");
      assert.equal(syncBody.status, "planned");
      assert.equal(syncBody.write, false);
    });

    await live.close();
    live = await http.serve(buildServer, {
      host: "127.0.0.1",
      port: 0,
      surface: "admin",
      plugins: [],
    });

    await t.test("a process started as admin still withholds admin tools from a normal bearer", async () => {
      const reply = await rpc(live.url, s.alpha.token, "tools/list");
      assert.equal(reply.status, 200, reply.text);
      const names = toolNames(reply);
      assert.equal(names.length, 27);
      for (const name of ADMIN_TOOL_NAMES) {
        assert.equal(names.includes(name), false, `downgraded session listed ${name}`);
      }
    });
  } finally {
    if (live) await live.close();
    s.clean();
  }
});
