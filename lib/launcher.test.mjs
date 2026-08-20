// launcher.test.mjs — the sourced shell launcher (agents.sh) arg-parsing, driven end to end in bash.
// Three separate bugs shipped here because NOTHING tested the launcher: a bare task read as a note id,
// --profile leaking into the task, and --handover dropped behind a bare task. This pins the grammar.
//   node --test lib/launcher.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));   // package root (has agents.sh + lib/)
const AGENTS_SH = join(PKG, "agents.sh");

const MANIFEST = {
  repo: "t", logLabel: "synapse", vaultRoot: ".", skipDirs: ["node_modules"],
  roles: { CONSTRAINS: { field: "applies_rules", direction: "forward", mandatoryFull: true },
    NAVIGATES: { field: "related", direction: "forward", endpointTypes: ["moc", "hub"] } },
  profiles: { lean: { roles: ["CONSTRAINS"], depth: {} }, standard: { roles: ["CONSTRAINS", "NAVIGATES"], depth: { NAVIGATES: 1 } }, fat: { roles: ["CONSTRAINS", "NAVIGATES"], depth: { NAVIGATES: 9 } } },
  tokenBudgets: { lean: 4000, standard: 15000, fat: 30000 }, excerptChars: { lean: 40, standard: 4000, fat: 0 },
  typePriority: ["agent", "moc", "rule"], trailers: { canary: false }, invariants: [],
};
const note = (id, type, fm = "", body = "body-" + id) =>
  `---\nid: ${id}\ntype: ${type}\ntitle: ${id}\ntags:\n  - type/${type}\n${fm}---\n${body}\n`;

const VAULT = mkdtempSync(join(tmpdir(), "launch-t-"));
mkdirSync(join(VAULT, "_meta", "tools"), { recursive: true });
writeFileSync(join(VAULT, "_meta", "tools", "context.manifest.json"), JSON.stringify(MANIFEST));
const put = (rel, c) => { const p = join(VAULT, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
put("agents/agent-tester.md", note("agent-tester", "agent", "purpose: test\nshort_purpose: tests\n"));
put("moc/moc-thing.md", note("moc-thing", "moc"));
put("inbox/handovers/2026-01-01-demo-handover.md", note("h-demo", "journal", "", "HANDOVER-BODY: bake the widget"));
process.on("exit", () => { try { rmSync(VAULT, { recursive: true, force: true }); } catch {} });

// Run the launcher: source agents.sh in bash against the temp vault, invoke `tester <args>` in print mode.
function tester(argline) {
  // cd INTO the vault (no SYNAPSE_VAULT export): verbs register from the cwd vault, which also exercises
  // the cwd-first resolution the launcher relies on.
  const script = `
export SYNAPSE_NO_REFRESH=1 SYNAPSE_NO_FETCH=1 SYNAPSE_SEMANTIC=off
unset SYNAPSE_VAULT
source ${JSON.stringify(AGENTS_SH)} >/dev/null 2>&1
tester ${argline} --cli print`;
  const r = spawnSync("bash", ["-c", script], { cwd: VAULT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status };
}
const rootsOf = (r) => (r.stderr.match(/roots=(\S+)/) || [])[1] || "";
const tail = (r) => r.stdout.trim().split("\n").slice(-2).join("\n");

test("[launcher] bare task is the TASK, not a note id (roots = agent only)", () => {
  const r = tester(`"hi there"`);
  assert.equal(rootsOf(r), "agent-tester", `bare task must not become a target; got roots=${rootsOf(r)}`);
  assert.match(r.stdout, /hi there\s*$/, "the task is appended after the briefing");
  assert.doesNotMatch(r.stderr, /unknown artifact/);
});

test("[launcher] target + task: moc fuses AND the task survives", () => {
  const r = tester(`moc-thing "do the thing"`);
  assert.equal(rootsOf(r), "agent-tester+moc-thing");
  assert.match(r.stdout, /do the thing\s*$/);
});

test("[launcher] target only: moc fuses, no task tail", () => {
  const r = tester(`moc-thing`);
  assert.equal(rootsOf(r), "agent-tester+moc-thing");
  assert.doesNotMatch(tail(r), /^---$/m);
});

test("[launcher] --profile mid-args is consumed, never leaked into the task", () => {
  const r = tester(`"just a task" --profile fat`);
  assert.match(r.stderr, /profile=fat/);
  assert.equal(rootsOf(r), "agent-tester");
  assert.doesNotMatch(r.stdout, /--profile/, "the flag must not appear in the task text");
  assert.match(r.stdout, /just a task\s*$/);
});

test("[launcher] a typo'd moc target still errors clearly (not swallowed as a task)", () => {
  const r = tester(`moc-nonexistent`);
  assert.match(r.stderr + r.stdout, /unknown artifact/i, "a hub-/moc- typo surfaces render's error");
});

test("[launcher] --handover: the note becomes the task, protocol prepended", () => {
  const r = tester(`--handover inbox/handovers/2026-01-01-demo-handover.md`);
  assert.match(r.stdout, /Continue from the handover note/);
  assert.match(r.stdout, /HANDOVER-BODY: bake the widget/);
});

test("[launcher] --handover resolves by fuzzy slug too", () => {
  const r = tester(`--handover demo-handover`);
  assert.match(r.stdout, /HANDOVER-BODY: bake the widget/);
});

test("[launcher] handover + inline comment COMPOSE (neither dropped), target still fuses", () => {
  const r = tester(`moc-thing "also skip the VPN check" --handover demo-handover`);
  assert.equal(rootsOf(r), "agent-tester+moc-thing", "target fuses alongside a handover");
  assert.match(r.stdout, /HANDOVER-BODY: bake the widget/, "handover body present");
  assert.match(r.stdout, /Additional instruction for THIS launch/, "the compose header");
  assert.match(r.stdout, /also skip the VPN check/, "the inline comment kept");
});
