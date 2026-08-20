// man.test.mjs — `synapse man` is a self-contained manual; assert it runs and covers the key sections
// so the reference can't silently rot to an empty/partial print.
//   node --test lib/man.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MAN = join(dirname(fileURLToPath(import.meta.url)), "man.mjs");
const out = spawnSync(process.execPath, [MAN], { encoding: "utf8" });

test("synapse man runs and exits 0", () => { assert.equal(out.status, 0); });

test("synapse man covers every major section", () => {
  for (const section of ["LAUNCHER GRAMMAR", "synapse` CLI", "BOOT FROM A HANDOVER", "MEMORY & LIVE CONTEXT", "VAULT RESOLUTION"]) {
    assert.match(out.stdout, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing section: ${section}`);
  }
});

test("synapse man names the tools/flags an agent actually needs", () => {
  for (const token of ["--handover", "--profile", "synapse_recall", "synapse_history", "on_demand", "synapse_brief(note:", "SYNAPSE_VAULT"]) {
    assert.ok(out.stdout.includes(token), `manual should mention ${token}`);
  }
});
