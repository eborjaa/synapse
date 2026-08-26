// four-harness-e2e.test.mjs — Epic 6 in the suite: one run, four harnesses, isolation per harness.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runFourHarnessE2e } from "./four-harness-e2e.mjs";

test("Epic 6: each harness connects, matches the tool list, reaches its vault, and cannot reach another", async () => {
  const report = await runFourHarnessE2e();
  for (const h of report.harnesses) {
    assert.equal(h.connect.ok, true, `${h.id} connect: ${h.connect.detail}`);
    assert.equal(h.list.ok, true, `${h.id} tool list: ${h.list.detail}`);
    assert.equal(h.reaches.ok, true, `${h.id} own vault: ${h.reaches.detail}`);
    assert.equal(h.isolated.ok, true, `${h.id} isolation: ${h.isolated.detail}`);
  }
  assert.equal(report.passed, true);
});
