// spawn.test.mjs — the synapse_spawn tool handlers, with launch + render stubbed so no real runtime or
// vault is needed. Run with: node --experimental-sqlite --test mcp/tools/spawn.test.mjs
//
// The hard-dedup / launch / status / list tests pass `force:true` to isolate the LEASE from the
// (env-dependent) semantic pre-check. A separate, tolerant test exercises the semantic net when a local
// Ollama is reachable and otherwise asserts its fail-open contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VAULT = mkdtempSync(join(tmpdir(), "synapse-spawn-test-"));
process.env.SYNAPSE_VAULT = VAULT;

const { registerSpawnTools } = await import("./spawn.mjs");

function harness() {
  const handlers = {};
  const server = { registerTool: (name, _schema, fn) => { handlers[name] = fn; } };
  const launched = [];
  const launch = ({ statusFile }) => {
    mkdirSync(join(statusFile, ".."), { recursive: true });
    writeFileSync(statusFile, `HEARTBEAT ${new Date().toISOString()} start ok\n`, "utf8");
    launched.push(statusFile);
    return { pid: 4242 };
  };
  const render = async () => ({ ok: true, briefing: "# stub briefing\ndo the thing\n" });
  registerSpawnTools(server, { launch, render });
  const call = async (name, args) => JSON.parse((await handlers[name](args)).content[0].text);
  return { call, launched };
}

test("synapse_spawn launches and records a doer", async () => {
  const { call, launched } = harness();
  const r = await call("synapse_spawn", { agent: "spec-builder", task: "flip the report specs", job: "spec-builder:REL-1:report", cli: "cursor", force: true });
  assert.equal(r.ok, true);
  assert.equal(r.job, "spec-builder:REL-1:report");
  assert.equal(r.pid, 4242);
  assert.equal(launched.length, 1);
});

test("a live job is REFUSED by the lease (hard dedup) — same job, force past the semantic net", async () => {
  const { call } = harness();
  const job = "spec-builder:REL-2:sensors";
  const first = await call("synapse_spawn", { agent: "spec-builder", task: "fix sensors", job, force: true });
  assert.equal(first.ok, true);
  const second = await call("synapse_spawn", { agent: "spec-builder", task: "fix sensors", job, force: true });
  assert.equal(second.refused, "held");
  assert.equal(second.job, job);
});

test("a DIFFERENT job runs concurrently", async () => {
  const { call } = harness();
  const a = await call("synapse_spawn", { agent: "spec-builder", task: "alpha work", job: "spec-builder:REL-3:a", force: true });
  const b = await call("synapse_spawn", { agent: "spec-builder", task: "beta work", job: "spec-builder:REL-3:b", force: true });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test("synapse_spawn_status classifies a fresh doer as alive", async () => {
  const { call } = harness();
  const s = await call("synapse_spawn", { agent: "spec-builder", task: "status probe", job: "spec-builder:REL-4:x", force: true });
  const st = await call("synapse_spawn_status", { spawnId: s.spawnId });
  assert.equal(st.job, "spec-builder:REL-4:x");
  assert.ok(["alive", "waiting"].includes(st.state), `unexpected state ${st.state}`);
});

test("synapse_spawn_list shows the running spawn + a stale array", async () => {
  const { call } = harness();
  await call("synapse_spawn", { agent: "spec-builder", task: "list probe", job: "spec-builder:REL-5:y", force: true });
  const list = await call("synapse_spawn_list", {});
  assert.ok(list.running.some((s) => s.job === "spec-builder:REL-5:y"));
  assert.ok(Array.isArray(list.staleFromPriorBoot));
});

test("render failure releases the lease so the job can be retried", async () => {
  const handlers = {};
  const server = { registerTool: (n, _s, fn) => { handlers[n] = fn; } };
  const stubLaunch = ({ statusFile }) => { mkdirSync(join(statusFile, ".."), { recursive: true }); writeFileSync(statusFile, "x\n"); return { pid: 2 }; };
  registerSpawnTools(server, { launch: stubLaunch, render: async () => ({ ok: false, error: "boom" }) });
  const call = async (n, a) => JSON.parse((await handlers[n](a)).content[0].text);
  const r1 = await call("synapse_spawn", { agent: "x", task: "t", job: "spec-builder:REL-6:z", force: true });
  assert.equal(r1.error, "render-failed");
  // Re-register with a working render; the lease must be free to re-acquire.
  registerSpawnTools(server, { launch: stubLaunch, render: async () => ({ ok: true, briefing: "b" }) });
  const r2 = await call("synapse_spawn", { agent: "x", task: "t", job: "spec-builder:REL-6:z", force: true });
  assert.equal(r2.ok, true);
});

test("synapse_claim_and_brief returns the briefing and launches NOTHING", async () => {
  const { call, launched } = harness();
  const r = await call("synapse_claim_and_brief", {
    agent: "spec-builder", task: "flip the report specs", job: "spec-builder:CB-1:report", force: true,
  });
  assert.equal(r.ok, true);
  assert.match(r.briefing, /stub briefing/);
  assert.ok(r.owner && r.token, "must return the lease handle so the caller can release it");
  assert.equal(launched.length, 0, "the caller launches — synapse must not");
});

test("claim_and_brief enforces dedup without launching (second claim refused)", async () => {
  const { call } = harness();
  const job = "spec-builder:CB-2:sensors";
  const a = await call("synapse_claim_and_brief", { agent: "spec-builder", task: "fix sensors", job, force: true });
  assert.equal(a.ok, true);
  const b = await call("synapse_claim_and_brief", { agent: "spec-builder", task: "fix sensors", job, force: true });
  assert.equal(b.refused, "held");
});

test("the gate is SHARED: a job claimed by claim_and_brief blocks synapse_spawn too", async () => {
  const { call, launched } = harness();
  const job = "spec-builder:CB-3:shared";
  const a = await call("synapse_claim_and_brief", { agent: "spec-builder", task: "shared job", job, force: true });
  assert.equal(a.ok, true);
  const b = await call("synapse_spawn", { agent: "spec-builder", task: "shared job", job, force: true });
  assert.equal(b.refused, "held", "dedup must hold across BOTH delegation paths");
  assert.equal(launched.length, 0, "the refused spawn must not have launched anything");
});

test("release frees a claim_and_brief job for re-claiming", async () => {
  const { call } = harness();
  const job = "spec-builder:CB-4:release";
  const a = await call("synapse_claim_and_brief", { agent: "spec-builder", task: "t", job, force: true });
  const rel = await call("synapse_spawn_release", { job, owner: a.owner, token: a.token, spawnId: a.spawnId });
  assert.equal(rel.released, true);
  const b = await call("synapse_claim_and_brief", { agent: "spec-builder", task: "t", job, force: true });
  assert.equal(b.ok, true, "after release the job is claimable again");
});

test("status reports a harness-native claim as such (no heartbeat channel)", async () => {
  const { call } = harness();
  const a = await call("synapse_claim_and_brief", { agent: "spec-builder", task: "t", job: "spec-builder:CB-5:via", force: true });
  const st = await call("synapse_spawn_status", { spawnId: a.spawnId });
  assert.match(st.via, /harness-native/);
  assert.ok(["alive", "waiting"].includes(st.state));
});

test("semantic pre-check: a paraphrase of a live task is caught (or fails open when Ollama is down)", async () => {
  const { call } = harness();
  const a = await call("synapse_spawn", {
    agent: "spec-builder", task: "flip the report delete specs from sanity to regression", job: "spec-builder:SEM:a", force: true,
  });
  assert.equal(a.ok, true);
  // Different JOB key, semantically-identical task, semantic net ENABLED (no force).
  const b = await call("synapse_spawn", {
    agent: "spec-builder", task: "change the report deletion tests from sanity into regression", job: "spec-builder:SEM:b",
  });
  // With a local Ollama, the paraphrase is refused; without one the net fails OPEN and the lease (a new
  // job key) lets it through. Both are correct — assert we did not crash and got a well-formed result.
  assert.ok(b.refused === "looks-like-duplicate" || b.ok === true, `unexpected: ${JSON.stringify(b)}`);
  if (b.refused === "looks-like-duplicate") assert.equal(b.similarJob, "spec-builder:SEM:a");
});

// ── episodic memory: written by the two calls a delegation cannot skip ──────────────────────────────
// The point of wiring capture into claim/release rather than a separate "please log it" tool: an agent
// that forgets to log still gets logged, because it cannot get a briefing without claiming.

test("claiming opens an episode and releasing closes it with the summary", async () => {
  const { call } = harness();
  const job = "spec-builder:REL-77:report";
  const claim = await call("synapse_claim_and_brief", { agent: "spec-builder", task: "migrate the report suite", job, force: true });
  assert.ok(claim.episodeId, "an episode id comes back with the claim");

  const rel = await call("synapse_spawn_release", {
    job, owner: claim.owner, token: claim.token, spawnId: claim.spawnId, episodeId: claim.episodeId,
    summary: "migrated 12 specs; parked 2 on REL-38837", refs: ["PR#41"],
  });
  assert.equal(rel.released, true);
  assert.equal(rel.episodeClosed, claim.episodeId);
});

test("releasing WITHOUT a summary says so — a run with no account of itself is near-useless", async () => {
  const { call } = harness();
  const job = "spec-builder:REL-78:report";
  const c = await call("synapse_claim_and_brief", { agent: "spec-builder", task: "t", job, force: true });
  const rel = await call("synapse_spawn_release", { job, owner: c.owner, token: c.token, spawnId: c.spawnId, episodeId: c.episodeId });
  assert.match(rel.note, /No summary recorded/);
});

test("re-claiming a job that already RAN surfaces the prior run instead of silently repeating it", async () => {
  const { call } = harness();
  const job = "debug-triager:REL-79:sensors";
  const first = await call("synapse_claim_and_brief", { agent: "debug-triager", task: "triage sensors flake", job, force: true });
  await call("synapse_spawn_release", {
    job, owner: first.owner, token: first.token, spawnId: first.spawnId, episodeId: first.episodeId,
    summary: "not a flake — a real app bug, filed REL-40001", refs: ["REL-40001"],
  });

  // The lease is free now, so this claim SUCCEEDS — history is a warning, not a second gate.
  const second = await call("synapse_claim_and_brief", { agent: "debug-triager", task: "triage sensors flake again", job, force: true });
  assert.equal(second.ok, true, "a deliberate re-run is legitimate and must not be blocked");
  assert.ok(second.priorRun, "but the earlier run is reported");
  assert.equal(second.priorRun.outcome, "done");
  assert.match(second.priorRun.summary, /REL-40001/);
  assert.deepEqual(second.priorRun.refs, ["REL-40001"]);
});

test("a FIRST-EVER claim carries no priorRun (no false memory)", async () => {
  const { call } = harness();
  const r = await call("synapse_claim_and_brief", { agent: "spec-builder", task: "brand new work", job: "spec-builder:REL-80:new", force: true });
  assert.equal(r.priorRun, undefined);
});
