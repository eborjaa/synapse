// durable-spawn / liveness.test.mjs
// Run: node --experimental-sqlite --test src/tools/durable-spawn/liveness.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { classify, DEFAULT_THRESHOLDS } from "./liveness.mjs";

const T = DEFAULT_THRESHOLDS;

test("harness terminal signal => done/failed (primary channel)", () => {
  assert.equal(classify({ registryState: "done", leaseLive: true }).state, "done");
  assert.equal(classify({ registryState: "failed", leaseLive: true }).state, "failed");
  assert.equal(classify({ registryState: "running", leaseLive: true, terminalMarker: "FAILED" }).state, "failed");
});

test("expired lease => orphaned + re-lease (the only unsignalled-death window)", () => {
  const r = classify({ registryState: "running", leaseLive: false });
  assert.equal(r.state, "orphaned");
  assert.equal(r.action, "re-lease");
});

test("within a declared WAITING window => waiting, never death", () => {
  const r = classify({
    registryState: "running", leaseLive: true,
    lastHeartbeatAgeMs: 10 * 60_000, // very stale...
    waiting: { etaMs: 30 * 60_000, ageMs: 5 * 60_000 }, // ...but inside ETA
  });
  assert.equal(r.state, "waiting");
});

test("INVARIANT: stale heartbeat on a leased doer escalates to a human, never death", () => {
  const r = classify({
    registryState: "running", leaseLive: true,
    lastHeartbeatAgeMs: T.hangMs + 1, waiting: null,
  });
  assert.equal(r.state, "hang-suspected");
  assert.equal(r.action, "escalate-human");
  assert.notEqual(r.state, "failed");
  assert.notEqual(r.state, "done");
});

test("REVIEW: a huge self-reported ETA cannot mask a hang forever (ceiling)", () => {
  // Within the cap, an unbounded ETA is still honored...
  const within = classify({
    registryState: "running", leaseLive: true,
    lastHeartbeatAgeMs: 10 * 60_000,
    waiting: { etaMs: Number.MAX_SAFE_INTEGER, ageMs: T.maxWaitMs - 1 },
  });
  assert.equal(within.state, "waiting");
  // ...but past the cap it falls through to hang-suspected (escalate-human), never masked.
  const past = classify({
    registryState: "running", leaseLive: true,
    lastHeartbeatAgeMs: T.hangMs + 1,
    waiting: { etaMs: Number.MAX_SAFE_INTEGER, ageMs: T.maxWaitMs + 1 },
  });
  assert.equal(past.state, "hang-suspected");
  assert.equal(past.action, "escalate-human");
});

test("leased and fresh (or not yet heartbeated) => alive", () => {
  assert.equal(classify({ registryState: "running", leaseLive: true, lastHeartbeatAgeMs: 1000 }).state, "alive");
  assert.equal(classify({ registryState: "running", leaseLive: true, lastHeartbeatAgeMs: null }).state, "alive");
});

test("no input path can turn heartbeat staleness alone into 'failed'", () => {
  // Exhaustively: with a live lease, no terminal signal, and no WAITING, the
  // only non-alive verdict a stale heartbeat can produce is hang-suspected.
  for (const age of [0, T.hangMs, T.hangMs + 1, 10 * T.hangMs]) {
    const r = classify({ registryState: "running", leaseLive: true, lastHeartbeatAgeMs: age, waiting: null });
    assert.ok(r.state === "alive" || r.state === "hang-suspected", `age=${age} => ${r.state}`);
  }
});
