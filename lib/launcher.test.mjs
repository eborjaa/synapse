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

// The launcher is a SOURCED interactive tool; its supported shells are bash and zsh, and they must
// behave identically. Every grammar case here runs under bash (default); a cross-shell block at the end
// re-runs the invariants under EACH available shell and asserts the argv is byte-identical.
const SHELLS = ["bash", "zsh"].filter((sh) => spawnSync("command", ["-v", sh], { shell: true }).status === 0);

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
function tester(argline, shell = "bash") {
  // cd INTO the vault (no SYNAPSE_VAULT export): verbs register from the cwd vault, which also exercises
  // the cwd-first resolution the launcher relies on.
  const script = `
export SYNAPSE_NO_REFRESH=1 SYNAPSE_NO_FETCH=1 SYNAPSE_SEMANTIC=off
unset SYNAPSE_VAULT
. ${JSON.stringify(AGENTS_SH)} >/dev/null 2>&1
tester ${argline} --cli print`;
  const r = spawnSync(shell, ["-c", script], { cwd: VAULT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

// ── the three runtime sinks: assert the exact argv each --cli builds (SYNAPSE_PRINT_LAUNCH seam) ──────
// Every runtime bug we hit was an argv-shape bug (opencode --file swallowing the task, a flag leaking,
// the task dropped). The binaries can't run in CI, but the SHAPE is what breaks — so we pin it.
function launchArgv(cli, argline, shell = "bash") {
  const script = `export SYNAPSE_PRINT_LAUNCH=1 SYNAPSE_NO_REFRESH=1 SYNAPSE_NO_FETCH=1 SYNAPSE_SEMANTIC=off
unset SYNAPSE_VAULT
. ${JSON.stringify(AGENTS_SH)} >/dev/null 2>&1
tester ${argline} --cli ${cli}`;
  const r = spawnSync(shell, ["-c", script], { cwd: VAULT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // __mx_exec prints the argv to STDOUT; status banners (⏳/🚀) go to STDERR. Read stdout ONLY — mixing
  // in stderr appends the banners after the argv and breaks end-anchored ($) matches. The launch line is
  // the sole stdout content, and may span physical lines when the task (e.g. a handover) is multi-line.
  const i = r.stdout.indexOf("LAUNCH:");
  return i === -1 ? "" : r.stdout.slice(i).trimEnd();
}

// opencode's briefing is injected as an AGENT DEFINITION (.opencode/agents/<name>.md) whose BODY is the
// system prompt — the same shape as the cursor .mdc rules file. Attaching it with `--file` instead made
// the model treat it as "a document someone handed me" and it never adopted the role:
//   "looks like the file that was read is a briefing for a QA Lead… are you setting me up against
//    the role I'm playing?"
test("[cli:opencode] launches the TUI (root command), not one-shot `run`", () => {
  const a = launchArgv("opencode", `"fix the grid"`);
  assert.match(a, /\[opencode\] \[[^\]]+\] \[--agent\]/, "root command with the project dir, not `run`");
  assert.doesNotMatch(a, /\[opencode\] \[run\]/, "`opencode run` is one-shot and exits — it closed the session");
});

test("[cli:opencode] the briefing is the agent IDENTITY via --agent, never a --file attachment", () => {
  const a = launchArgv("opencode", `"fix the grid"`);
  assert.match(a, /\[--agent\] \[synapse-tester\]/, "a generated opencode agent carries the briefing as its system prompt");
  assert.doesNotMatch(a, /\[--file\]/, "--file makes the briefing a document to read, not the agent's identity");
});

test("[cli:opencode] the task seeds the first message via --prompt", () => {
  const a = launchArgv("opencode", `"fix the grid"`);
  assert.match(a, /\[--prompt\] \[fix the grid\]$/, "task is the seeded prompt");
});

test("[cli:opencode] --handover becomes the seeded prompt too", () => {
  const a = launchArgv("opencode", `--handover demo-handover`);
  assert.match(a, /\[--agent\] \[synapse-tester\]/);
  assert.match(a, /\[--prompt\] \[Continue from the handover note[\s\S]*/, "the resolved handover is the seeded prompt");
});

// opencode's auto-approve flag is `--auto`. `--dangerously-skip-permissions` is a CLAUDE CODE flag;
// passing it to opencode was a no-op, so auto/bypass silently behaved like manual.
test("[cli:opencode] uses opencode's own --auto, never claude's --dangerously-skip-permissions", () => {
  const a = launchArgv("opencode", `"fix the grid"`);
  assert.match(a, /\[--auto\]/, "opencode's real auto-approve flag");
  assert.doesNotMatch(a, /dangerously-skip-permissions/, "that flag belongs to claude, not opencode");
});

// Guard the inverse: claude must NOT receive opencode's flags.
test("[cli:claude] does not receive opencode-only flags", () => {
  const a = launchArgv("claude", `"fix the grid"`);
  assert.doesNotMatch(a, /\[--interactive\]|\[--file\]|\[--auto\]/, "claude has its own flag vocabulary");
});

test("[cli:claude] briefing is the system-prompt file, task after -- (not swallowed by a flag)", () => {
  const a = launchArgv("claude", `"fix the grid"`);
  assert.match(a, /\[--append-system-prompt-file\] \[[^\]]*synapse\.[^\]]*\]/, "briefing as the appended system prompt");
  assert.match(a, /\[--\] \[fix the grid\]$/, "task is the terminal positional after --");
});

test("[cli:cursor] task is the trailing message, vault added, briefing via rules file", () => {
  const a = launchArgv("cursor", `"fix the grid"`);
  assert.match(a, /\[cursor-agent\]/);
  assert.match(a, /\[--add-dir\] \[[^\]]+\]/, "vault dir attached");
  assert.match(a, /\[fix the grid\]$/, "task is the trailing positional");
});

test("[cli:all] a task with spaces stays ONE argv token (never re-split)", () => {
  for (const cli of ["opencode", "claude", "cursor"]) {
    const a = launchArgv(cli, `"two word task"`);
    assert.match(a, /\[two word task\]/, `${cli}: the task must survive as a single token`);
  }
});

test("[cli:all] no task → no stray empty task token", () => {
  for (const cli of ["opencode", "claude", "cursor"]) {
    const a = launchArgv(cli, `moc-thing`);
    assert.doesNotMatch(a, /\[\]/, `${cli}: an empty task must not appear as []`);
  }
});


// ── cross-shell: bash and zsh must behave IDENTICALLY (the launcher is sourced from either) ──────────
// Re-run the invariants under each available shell and assert the argv matches bash byte-for-byte
// (modulo the per-run temp path, which we mask). Catches a shell-specific parse/quoting divergence.
const maskTmp = (s) => s.replace(/\/[^ \]]*synapse\.[A-Za-z0-9]+/g, "<brief>").replace(/\/[^ \]]*tmp\.[A-Za-z0-9]+/g, "<vault>");

for (const shell of SHELLS) {
  test(`[shell:${shell}] the launcher loads and the grammar holds`, () => {
    const bare = tester(`"hi there"`, shell);
    assert.match(bare.stderr, /roots=agent-tester\b/, `${shell}: bare task → agent-only roots`);
    assert.match(bare.stdout, /hi there\s*$/, `${shell}: task reaches the prompt`);
    const both = tester(`moc-thing "do it"`, shell);
    assert.match(both.stderr, /roots=agent-tester\+moc-thing/, `${shell}: target fuses`);
  });

  test(`[shell:${shell}] each CLI builds the SAME argv as bash`, () => {
    for (const [cli, argline] of [["opencode", `"fix the grid"`], ["claude", `"fix the grid"`], ["cursor", `"fix the grid"`], ["opencode", `moc-thing`]]) {
      const ref = maskTmp(launchArgv(cli, argline, "bash"));
      const got = maskTmp(launchArgv(cli, argline, shell));
      assert.equal(got, ref, `${shell} vs bash diverged for --cli ${cli} ${argline}`);
    }
  });
}

test("[shell] both bash and zsh are actually present and tested (not silently skipped)", () => {
  assert.ok(SHELLS.includes("bash"), "bash must be available for the launcher");
  assert.ok(SHELLS.includes("zsh"), "zsh must be available (the primary interactive shell)");
});
