// vault-addressing.test.mjs — one credential, several vaults, the URL path chooses.
//
// Every assertion runs against a REAL loopback listener with real JSON-RPC, because the claim being
// made is about the wire: that `…/mcp/alpha` and `…/mcp/bravo`, presented with the SAME bearer, answer
// out of different vaults, and that no other combination answers at all
// ([[decision-0017-path-addressed-vaults]]).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { routeVaultPath, toolTransportAdapters } from "../lib/ports/index.mjs";
import { mintToken, writeTokens } from "../lib/ports/vault-tokens.mjs";
import { addVault, writeRegistry } from "../lib/vaults.mjs";
import { buildServer } from "./build-server.mjs";

const MANIFEST = {
  repo: "addr-test",
  logLabel: "synapse",
  vaultRoot: ".",
  skipDirs: ["node_modules", "inbox"],
  roles: {
    NAVIGATES: { field: "related", direction: "forward", endpointTypes: ["hub"] },
  },
  profiles: { lean: { roles: [], depth: {} }, standard: { roles: [], depth: {} }, fat: { roles: [], depth: {} } },
  tokenBudgets: { lean: 4000, standard: 15000, fat: 30000 },
  excerptChars: { lean: 40, standard: 4000, fat: 0 },
  typePriority: ["agent", "hub"],
  trailers: { canary: false },
  invariants: [],
};

function makeVault(tag) {
  const dir = mkdtempSync(join(tmpdir(), `syn-addr-${tag}-`));
  const put = (rel, content) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf8");
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

/** A temp $SYNAPSE_HOME with three vaults and one credential that grants only the first two. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "syn-addr-home-"));
  const previousHome = process.env.SYNAPSE_HOME;
  process.env.SYNAPSE_HOME = home;

  const vaults = ["alpha", "bravo", "ungranted"].map(makeVault);
  let reg = { version: 1, vaults: [] };
  for (const v of vaults) {
    const added = addVault(v.dir, reg);
    reg = added.reg;
    v.id = added.entry.id;
  }
  writeRegistry(reg);

  const both = mintToken([vaults[0].id, vaults[1].id], { label: "both", store: { version: 1, tokens: [] }, reg });
  const onlyAlpha = mintToken(vaults[0].id, { label: "alpha-only", store: both.store, reg });
  writeTokens(onlyAlpha.store);

  return {
    home,
    alpha: vaults[0],
    bravo: vaults[1],
    ungranted: vaults[2],
    bothToken: both.plaintext,
    alphaToken: onlyAlpha.plaintext,
    clean() {
      if (previousHome === undefined) delete process.env.SYNAPSE_HOME;
      else process.env.SYNAPSE_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
      for (const v of vaults) rmSync(v.dir, { recursive: true, force: true });
    },
  };
}

let nextId = 1;
async function call(url, token, method, params = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((l) => l.startsWith("data: ")).at(-1)?.slice(6) || ""
    : text;
  let body = null;
  try { body = JSON.parse(payload); } catch { /* asserted on below */ }
  return { status: response.status, text, body, headers: response.headers };
}

const agentsSeen = (reply) => String(reply.body?.result?.content?.[0]?.text || "");
const fingerprint = (reply) => ({
  status: reply.status,
  body: reply.text,
  challenge: reply.headers.get("www-authenticate"),
});

test("routeVaultPath separates 'not our endpoint' from 'no vault named'", () => {
  assert.deepEqual(routeVaultPath("/mcp", "/mcp"), { ok: true, vaultId: null });
  assert.deepEqual(routeVaultPath("/mcp/work", "/mcp"), { ok: true, vaultId: "work" });
  assert.equal(routeVaultPath("/mcp/work/extra", "/mcp").ok, false, "a vault id is ONE segment");
  assert.equal(routeVaultPath("/mcp-other", "/mcp").ok, false, "prefix is not a match");
  assert.equal(routeVaultPath("/", "/mcp").ok, false);
  assert.equal(routeVaultPath("/mcp/", "/mcp").ok, false, "a trailing slash names no vault");
  // Percent-encoding survives to the binding, where it simply matches no registered id.
  assert.deepEqual(routeVaultPath("/mcp/%2e%2e", "/mcp"), { ok: true, vaultId: ".." });
});

test("one credential, two addresses, two vaults", async (t) => {
  const s = sandbox();
  const http = toolTransportAdapters.get("http");
  let live = null;
  try {
    live = await http.serve(buildServer, {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      surface: "standard",
      plugins: [],
    });
    const base = live.url.replace(/\/mcp$/, "");
    const at = (vaultId) => (vaultId ? `${base}/mcp/${vaultId}` : `${base}/mcp`);

    await t.test("the SAME bearer answers from a different vault per address", async () => {
      const alpha = await call(at(s.alpha.id), s.bothToken, "tools/call", { name: "synapse_list_agents", arguments: {} });
      const bravo = await call(at(s.bravo.id), s.bothToken, "tools/call", { name: "synapse_list_agents", arguments: {} });

      assert.equal(alpha.status, 200, alpha.text);
      assert.equal(bravo.status, 200, bravo.text);

      assert.match(agentsSeen(alpha), /agent-alpha-only/);
      assert.doesNotMatch(agentsSeen(alpha), /agent-bravo-only/, "alpha's address must not see bravo");
      assert.match(agentsSeen(bravo), /agent-bravo-only/);
      assert.doesNotMatch(agentsSeen(bravo), /agent-alpha-only/, "bravo's address must not see alpha");
    });

    await t.test("a granted vault is unreachable from the wrong address, not merely unlisted", async () => {
      // The credential grants bravo. Asking alpha's address for it changes nothing: the address decides
      // which single vault this request is, and the grant only says which addresses are permitted.
      const reply = await call(at(s.alpha.id), s.bothToken, "tools/call", {
        name: "synapse_list_agents",
        arguments: { vault: s.bravo.dir, vaultId: s.bravo.id },
      });
      assert.equal(reply.status, 200, reply.text);
      assert.doesNotMatch(agentsSeen(reply), /agent-bravo-only/, "tool arguments still bind nothing");
    });

    await t.test("an ungranted vault refuses IDENTICALLY to an unknown credential", async () => {
      const ungranted = await call(at(s.ungranted.id), s.bothToken, "tools/list");
      const unknown = await call(at(s.alpha.id), "syn_not_a_real_token_at_all", "tools/list");
      const nonexistent = await call(at("no-such-vault-anywhere"), s.bothToken, "tools/list");

      assert.equal(ungranted.status, 401);
      // If these differed, the endpoint would tell an attacker which vault ids exist on the machine.
      assert.deepEqual(fingerprint(ungranted), fingerprint(unknown), "registered-but-not-granted vs unknown token");
      assert.deepEqual(fingerprint(ungranted), fingerprint(nonexistent), "registered-but-not-granted vs no such vault");
    });

    await t.test("a narrow credential cannot reach beyond its own vault", async () => {
      const own = await call(at(s.alpha.id), s.alphaToken, "tools/list");
      const other = await call(at(s.bravo.id), s.alphaToken, "tools/list");
      assert.equal(own.status, 200, own.text);
      assert.equal(other.status, 401, "the path narrows the grant; it can never widen it");
    });

    await t.test("the bare endpoint binds only an UNAMBIGUOUS credential", async () => {
      const single = await call(at(null), s.alphaToken, "tools/call", { name: "synapse_list_agents", arguments: {} });
      assert.equal(single.status, 200, "one grant needs no path — every existing client keeps working");
      assert.match(agentsSeen(single), /agent-alpha-only/);

      const ambiguous = await call(at(null), s.bothToken, "tools/list");
      assert.equal(ambiguous.status, 401, "a client that forgot its path must not get a silent default");
    });

    await t.test("a path that is not this endpoint is a 404, before any credential is considered", async () => {
      const deep = await fetch(`${base}/mcp/${s.alpha.id}/extra`, { method: "POST" });
      await deep.arrayBuffer();
      assert.equal(deep.status, 404);
      const elsewhere = await fetch(`${base}/mcp-other`, { method: "POST" });
      await elsewhere.arrayBuffer();
      assert.equal(elsewhere.status, 404);
    });
  } finally {
    if (live) await live.close();
    s.clean();
  }
});
