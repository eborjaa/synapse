// durable-spawn / heartbeat.test.mjs
// Run: node --experimental-sqlite --test src/tools/durable-spawn/heartbeat.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";

import { heartbeat, waiting, done, failed, parseStatus } from "./heartbeat.mjs";
import { classify } from "./liveness.mjs";

function withFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), "durable-spawn-hb-"));
  const f = join(dir, "status.log");
  try { fn(f); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const T0 = "2026-07-31T02:00:00.000Z";
const ms = (iso) => Date.parse(iso);

test("emit + parse roundtrip: last heartbeat age is computed", () => {
  withFile((f) => {
    heartbeat(f, "stage-1", "count=10", T0);
    heartbeat(f, "stage-2", "count=20", "2026-07-31T02:01:00.000Z");
    const s = parseStatus(readFileSync(f, "utf8"), ms("2026-07-31T02:01:30.000Z"));
    assert.equal(s.terminalMarker, null);
    assert.equal(s.lastHeartbeatAgeMs, 30_000);
  });
});

test("WAITING opens a window; a later HEARTBEAT closes it", () => {
  withFile((f) => {
    waiting(f, "training", 30, T0);
    let s = parseStatus(readFileSync(f, "utf8"), ms("2026-07-31T02:05:00.000Z"));
    assert.equal(s.waiting.etaMs, 30 * 60_000);
    assert.equal(s.waiting.ageMs, 5 * 60_000);
    heartbeat(f, "resumed", "ok", "2026-07-31T02:06:00.000Z");
    s = parseStatus(readFileSync(f, "utf8"), ms("2026-07-31T02:07:00.000Z"));
    assert.equal(s.waiting, null, "a heartbeat closes the WAITING window");
  });
});

test("DONE / FAILED become the terminal marker", () => {
  withFile((f) => {
    heartbeat(f, "s", "x", T0);
    done(f, "loaded 36 relations", "2026-07-31T02:02:00.000Z");
    assert.equal(parseStatus(readFileSync(f, "utf8"), ms(T0)).terminalMarker, "DONE");
  });
  withFile((f) => {
    failed(f, "relay 500", T0);
    assert.equal(parseStatus(readFileSync(f, "utf8"), ms(T0)).terminalMarker, "FAILED");
  });
});

test("parsing tolerates partial/garbage lines", () => {
  const text = "HEARTBEAT not-a-date stage m\ngarbage\nHEARTBEAT " + T0 + " s c\n\n";
  const s = parseStatus(text, ms(T0) + 1000);
  assert.equal(s.lastHeartbeatAgeMs, 1000, "the one well-formed heartbeat is used");
});

test("INTEGRATION: a stale heartbeat from a real file never classifies as death", () => {
  withFile((f) => {
    heartbeat(f, "stuck", "x", T0);
    const facts = parseStatus(readFileSync(f, "utf8"), ms(T0) + 60 * 60_000); // 1h stale
    const verdict = classify({ registryState: "running", leaseLive: true, ...facts });
    assert.equal(verdict.state, "hang-suspected");
    assert.equal(verdict.action, "escalate-human");
  });
});

test("INTEGRATION: within a parsed WAITING window, classify says waiting", () => {
  withFile((f) => {
    waiting(f, "inference", 20, T0);
    const facts = parseStatus(readFileSync(f, "utf8"), ms(T0) + 5 * 60_000);
    const verdict = classify({ registryState: "running", leaseLive: true, ...facts });
    assert.equal(verdict.state, "waiting");
  });
});
