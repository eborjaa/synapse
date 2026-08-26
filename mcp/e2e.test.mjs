// e2e.test.mjs — the whole memory stack driven THROUGH the MCP tool handlers (not the libs), across a
// full delegation lifecycle plus adversarial inputs. Unit tests prove each piece; this proves the WIRING
// and that hostile input never throws. Deterministic: the semantic layer degrades to a skip on a vault
// with no index, so every assertion here holds without Ollama.
//   node --experimental-sqlite --test mcp/e2e.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { vaultStore } from "../lib/ports/vault-store.mjs";
import { createVaultContext } from "./vault-context.mjs";
import { registerEpisodeTools } from "./tools/episodes.mjs";
import { registerSpawnTools } from "./tools/spawn.mjs";
import { join, dirname } from "node:path";

const M = {
  repo: "t", logLabel: "synapse", vaultRoot: ".", skipDirs: ["node_modules", "inbox"],
  roles: {
    CONSTRAINS: { field: "applies_rules", direction: "forward", mandatoryFull: true },
    USES: { field: ["invokes_skills", "uses_tools"], direction: "forward" },
    NAVIGATES: { field: "related", direction: "forward", endpointTypes: ["hub", "moc"] },
    ATTACHES: { field: "related", direction: "forward", endpointTypes: ["doc", "rule"] },
  },
  profiles: {
    lean: { roles: ["CONSTRAINS", "USES"], depth: {} },
    standard: { roles: ["CONSTRAINS", "USES", "NAVIGATES", "ATTACHES"], depth: { NAVIGATES: 1, ATTACHES: 1 } },
    fat: { roles: ["CONSTRAINS", "USES", "NAVIGATES", "ATTACHES"], depth: {}, transitive: true },
  },
  tokenBudgets: { lean: 4000, standard: 15000, fat: 30000 },
  excerptChars: { lean: 40, standard: 4000, fat: 0 },
  typePriority: ["agent", "hub", "rule", "doc"], trailers: { canary: false }, invariants: [],
};
const note = (id, type, fm = "", body = "body-" + id) =>
  `---\nid: ${id}\ntype: ${type}\ntitle: ${id}\ntags:\n  - type/${type}\n${fm}---\n${body}\n`;

async function harness() {
  const VAULT = mkdtempSync(join(tmpdir(), "e2e-"));
  mkdirSync(join(VAULT, "_meta", "tools"), { recursive: true });
  writeFileSync(join(VAULT, "_meta", "tools", "context.manifest.json"), JSON.stringify(M));
  const put = (rel, c) => { const p = join(VAULT, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
  put("agents/agent-lead.md", note("agent-lead", "agent", "purpose: lead\napplies_rules: [[rule-zephyr]]\n"));
  put("agents/agent-doer.md", note("agent-doer", "agent", "purpose: doer\nshort_purpose: does\n"));
  put("rules/rule-zephyr.md", note("rule-zephyr", "rule",
    'on_demand: true\ntrigger: "before posting a Zephyr execution comment"\n', "rule body"));
  put("notes/note-sensors.md", note("note-sensors", "note", "", "sensors grid regression notes"));
  process.env.SYNAPSE_VAULT = VAULT;

  // THE PER-MODULE CACHE-BUST THAT USED TO LIVE HERE IS GONE, and its absence is the point.
  //
  // It existed because mcp/vault.mjs resolved VAULT at ITS module load and was never busted, so every
  // harness in this process shared one vault path — the FIRST temp vault's. Re-importing the tool
  // modules under a fresh URL was the only way to get a second harness that was not quietly answering
  // from the first harness's vault. Now the vault is an argument, so a second harness is just a second
  // argument, and the tool modules are imported once like any other module.
  //
  // The store reset stays, and is a different concern: vaultStore caches a handle per vaultDir for the
  // life of the process, and an open handle outlives the rmSync of its file. Each harness gets a fresh
  // temp dir, so this is belt-and-braces rather than load-bearing — but it keeps the test honest if a
  // future harness ever reuses a path.
  vaultStore._reset();
  const H = {};
  const server = { registerTool: (n, _s, fn) => { H[n] = fn; } };
  const vault = createVaultContext({ root: VAULT, vaultDir: VAULT, manifest: M });
  registerEpisodeTools(server, vault);
  registerSpawnTools(server, vault, { launch: () => ({ pid: 111 }), render: async () => ({ ok: true, briefing: "# briefing\n" }) });
  const call = async (n, a) => JSON.parse((await H[n](a)).content[0].text);
  return { call, cleanup: () => rmSync(VAULT, { recursive: true, force: true }) };
}

test("[e2e] full delegation loop: claim → release → history → recall → re-claim sees the prior run", async () => {
  const { call, cleanup } = await harness();
  try {
    const job = "spec-builder:REL-100:sensors";
    const c = await call("synapse_claim_and_brief", { agent: "doer", task: "migrate the sensors grid spec", job, force: true });
    assert.ok(c.episodeId && c.owner && typeof c.token === "number", "claim returns the handles");

    await call("synapse_spawn_release", { job, owner: c.owner, token: c.token, spawnId: c.spawnId, episodeId: c.episodeId, summary: "migrated 12 specs, parked REL-38837", refs: ["PR#9"] });

    const hist = await call("synapse_history", { query: "sensors grid" });
    assert.match(JSON.stringify(hist), /migrated 12/, "history finds the released work");

    const rec = await call("synapse_recall", { task: "migrate the sensors grid spec" });
    assert.ok(rec.priorWork.some((p) => /migrated 12/.test(p.summary || "")), "recall folds it in as priorWork");

    const re = await call("synapse_claim_and_brief", { agent: "doer", task: "redo it", job, force: true });
    assert.ok(re.ok, "a repeat is not blocked");
    assert.match(re.priorRun.summary || "", /migrated 12/, "but the prior run is surfaced");
  } finally { cleanup(); }
});

test("[e2e] recall gate: relevant task triggers the rule; irrelevant task returns 'nothing new'", async () => {
  const { call, cleanup } = await harness();
  try {
    const hit = await call("synapse_recall", { task: "I need to post the Zephyr execution comment" });
    assert.ok(hit.applicableRules.some((r) => r.id === "rule-zephyr"));
    const miss = await call("synapse_recall", { task: "compute the factorial of nineteen" });
    assert.equal(miss.applicableRules.length, 0);
    assert.match(miss.guidance, /Nothing new/);
  } finally { cleanup(); }
});

test("[e2e] the lease is the hard gate: a second live claim on one job is refused", async () => {
  const { call, cleanup } = await harness();
  try {
    const job = "spec-builder:REL-200:report";
    const c1 = await call("synapse_claim_and_brief", { agent: "doer", task: "flip report specs", job, force: true });
    const c2 = await call("synapse_claim_and_brief", { agent: "doer", task: "flip report specs", job, force: true });
    assert.ok(c2.refused === "held" || c2.ok === false, "the live lease refuses the second claim");
    await call("synapse_spawn_release", { job, owner: c1.owner, token: c1.token, spawnId: c1.spawnId, episodeId: c1.episodeId, summary: "done" });
  } finally { cleanup(); }
});

test("[e2e] misuse is reported, never thrown: releasing a job that was never claimed", async () => {
  const { call, cleanup } = await harness();
  try {
    const r = await call("synapse_spawn_release", { job: "never", owner: "x", token: 1 });
    assert.equal(r.released, false);
  } finally { cleanup(); }
});

test("[e2e] adversarial inputs never throw (SQL, FTS operators, unicode, empty, huge)", async () => {
  const { call, cleanup } = await harness();
  try {
    const inputs = [
      "", "?!.,;()", "'; DROP TABLE episode; --", 'NEAR AND OR * "quoted" (paren) ^caret',
      "測試 sensors グリッド 🎯 régression", "sensors ".repeat(20000),
    ];
    for (const task of inputs) {
      await assert.doesNotReject(() => call("synapse_recall", { task }), `recall on ${JSON.stringify(task.slice(0, 20))}`);
      await assert.doesNotReject(() => call("synapse_history", { query: task }), `history on ${JSON.stringify(task.slice(0, 20))}`);
      if (task) await assert.doesNotReject(() => call("synapse_log", { task, summary: "x" }), `log on ${JSON.stringify(task.slice(0, 20))}`);
    }
  } finally { cleanup(); }
});
