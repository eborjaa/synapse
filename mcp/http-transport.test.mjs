// http-transport.test.mjs — Epic 2 acceptance: one network server, many credential-bound vaults.
//
// Every story is exercised against a REAL loopback listener. The transport parity check also speaks
// raw JSON-RPC to the existing stdio server through mcp/conformance.mjs, so "same tools" is a wire
// assertion on both transports rather than two calls to an in-memory registry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { assertSafeHttpBindHost, toolTransportAdapters } from "../lib/ports/index.mjs";
import {
  VAULT_CREDENTIAL_REFUSAL, mintToken, readTokens, revokeToken, writeTokens,
} from "../lib/ports/vault-tokens.mjs";
import { addVault, writeRegistry } from "../lib/vaults.mjs";
import { buildServer } from "./build-server.mjs";
import { modernMeta, probe } from "./conformance.mjs";

const MANIFEST = {
  repo: "http-test",
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
  const dir = mkdtempSync(join(tmpdir(), `syn-http-${tag}-`));
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
  const home = mkdtempSync(join(tmpdir(), "syn-http-home-"));
  const previousHome = process.env.SYNAPSE_HOME;
  process.env.SYNAPSE_HOME = home;
  const vaults = ["alpha", "bravo", "gone", "revoked"].map(makeVault);

  let reg = { version: 1, vaults: [] };
  for (const vault of vaults) {
    const added = addVault(vault.dir, reg);
    reg = added.reg;
    vault.id = added.entry.id;
  }
  writeRegistry(reg);

  let store = { version: 1, tokens: [] };
  for (const vault of vaults) {
    const minted = mintToken(vault.id, {
      label: vault.tag === "revoked" ? "revoke-me" : vault.tag,
      store,
      reg,
    });
    store = minted.store;
    vault.token = minted.plaintext;
  }
  writeTokens(store);

  return {
    home,
    alpha: vaults[0],
    bravo: vaults[1],
    gone: vaults[2],
    revoked: vaults[3],
    clean() {
      if (previousHome === undefined) delete process.env.SYNAPSE_HOME;
      else process.env.SYNAPSE_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
      for (const vault of vaults) rmSync(vault.dir, { recursive: true, force: true });
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
  return { status: response.status, text, body, headers: response.headers };
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
      params: { ...params, _meta: modernMeta() },
    }),
  });
  return replyOf(response);
}

async function legacyRpc(url, token, method, params = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  return replyOf(response);
}

const toolNames = (reply) => (reply.body?.result?.tools || []).map((tool) => tool.name).sort();
const refusalFingerprint = (reply) => ({
  status: reply.status,
  body: reply.text,
  challenge: reply.headers.get("www-authenticate"),
});

test("Epic 2 — one loopback server serves many credential-bound vaults", async (t) => {
  const s = sandbox();
  const http = toolTransportAdapters.get("http");
  let live = null;
  try {
    await t.test("local-only guard: wildcard listeners are refused before a socket opens", async () => {
      for (const host of ["0.0.0.0", "0", "::", "[::]", "::0"]) {
        await assert.rejects(
          http.serve(buildServer, { host, port: 0, surface: "skeleton" }),
          /refuses wildcard bind address/,
        );
      }
      assert.equal(assertSafeHttpBindHost("[::1]"), "::1", "bracketed loopback is normalized for listen()");
    });

    live = await http.serve(buildServer, {
      host: "127.0.0.1",
      port: 0,
      surface: "skeleton",
      plugins: [],
    });
    assert.equal(live.address.address, "127.0.0.1");

    await t.test(
      "US-2.1 + US-2.4: two concurrent HTTP clients and stdio get one factory's identical tool list",
      async () => {
        const [alpha, bravo, legacyHttp, stdio] = await Promise.all([
          rpc(live.url, s.alpha.token, "tools/list"),
          rpc(live.url, s.bravo.token, "tools/list"),
          legacyRpc(live.url, s.alpha.token, "tools/list"),
          probe("skeleton", { vault: s.alpha.dir }),
        ]);
        assert.equal(alpha.status, 200);
        assert.equal(bravo.status, 200);
        assert.equal(legacyHttp.status, 200);

        const expected = stdio.tools.map((tool) => tool.name).sort();
        assert.deepEqual(toolNames(alpha), expected, "HTTP client A matches the live stdio catalogue");
        assert.deepEqual(toolNames(bravo), expected, "HTTP client B matches the live stdio catalogue");
        assert.deepEqual(toolNames(legacyHttp), expected, "HTTP's legacy era uses the same catalogue too");
        assert.deepEqual(
          toolTransportAdapters.all().map((adapter) => adapter.id).sort(),
          ["http", "stdio"],
          "the same ToolTransportPort registry owns both serving paths",
        );
      },
    );

    await t.test(
      "US-2.2: credential A wins even when model-authored arguments name vault B",
      async () => {
        const reply = await rpc(live.url, s.alpha.token, "tools/call", {
          name: "synapse_list_agents",
          arguments: {
            vault: s.bravo.dir,
            vaultDir: s.bravo.dir,
            vaultId: s.bravo.id,
          },
        });
        assert.equal(reply.status, 200, reply.text);
        const answer = reply.body?.result?.content?.[0]?.text || "";
        assert.match(answer, /agent-alpha-only/);
        assert.doesNotMatch(answer, /agent-bravo-only|private to bravo/);
      },
    );

    await t.test(
      "US-2.3: missing, unknown, revoked, and gone credentials attach no vault; oracle cases match",
      async () => {
        const unknown = await rpc(live.url, "syn_unknown", "tools/list");

        rmSync(s.gone.dir, { recursive: true, force: true });
        const gone = await rpc(live.url, s.gone.token, "tools/list");
        assert.deepEqual(
          refusalFingerprint(gone),
          refusalFingerprint(unknown),
          "unknown token and known token for a gone vault must be indistinguishable",
        );

        const revokedStore = revokeToken("revoke-me", readTokens()).store;
        writeTokens(revokedStore);
        const revoked = await rpc(live.url, s.revoked.token, "tools/list");
        const missing = await rpc(live.url, null, "tools/list");
        for (const reply of [unknown, gone, revoked, missing]) {
          assert.equal(reply.status, 401);
          assert.equal(reply.body?.error_description, VAULT_CREDENTIAL_REFUSAL);
          assert.equal(reply.body?.result, undefined, "a refusal carries no MCP result and no vault");
          for (const vault of [s.alpha, s.bravo, s.gone, s.revoked]) {
            assert.doesNotMatch(reply.text, new RegExp(vault.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            assert.ok(!reply.text.includes(vault.dir), "a refusal must not disclose a vault path");
          }
        }
      },
    );
  } finally {
    if (live) await live.close();
    s.clean();
  }
});
