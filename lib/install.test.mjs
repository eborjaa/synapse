// install.test.mjs — the shell-rc contract of `synapse install`.
//
// This file exists because of a bug that was hand-patched, by hand, more than once: install wrote
// `export SYNAPSE_VAULT="<vault>"` into the user's rc, so (a) every shell on the machine carried a
// GLOBAL pin to whichever vault was installed from last, and (b) the self-heal branch replaced ANY
// marked line with the freshly generated one — so deleting the export by hand survived exactly until
// the next `synapse install --write`. There was no test on any of it.
//
// Everything here drives the PURE planner (planRcUpdate) with rc text in / rc text out, so nothing
// touches a real ~/.zshrc. The last block runs agents.sh under bash+zsh to prove the shell side of the
// contract: the non-exported fallback is consulted, and $PWD still beats it.
//
//   node --test lib/install.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildRcLine, classifyRcLine, planRcUpdate, SH_MARKER, SH_MARKER_LEGACY, RC_FALLBACK_VAR } from "./install.mjs";

const A = { vaultDir: "/home/u/vault-a", agentsSh: "/home/u/vault-a/node_modules/@eborja/synapse/agents.sh" };
const B = { vaultDir: "/home/u/vault-b", agentsSh: "/home/u/vault-b/node_modules/@eborja/synapse/agents.sh" };
const lineA = buildRcLine(A);
const lineB = buildRcLine(B);
// The exact shape shipped up to 1.1.x — the bug being migrated away from.
const legacyLine = (v) => `export SYNAPSE_VAULT="${v.vaultDir}"; source "${v.agentsSh}"  ${SH_MARKER}`;
const plan = (rcText, v, opts = {}) => planRcUpdate({ rcText, ...v, rcPath: "RC", ...opts });
const allText = (p) => [...p.notes, ...p.warnings].join("\n");

// ── requirement 1: no global export, ever ────────────────────────────────────

test("the generated line NEVER contains a global export", () => {
  assert.doesNotMatch(lineA, /export/, `install must not write an export: ${lineA}`);
  assert.match(lineA, new RegExp(`^${RC_FALLBACK_VAR}="`), "the fallback var is what gets set");
  assert.ok(lineA.includes(`source "${A.agentsSh}"`), "and agents.sh is still sourced by absolute path");
  assert.ok(lineA.endsWith(SH_MARKER), "the marker stays last so the line stays greppable");
});

test("no rc outcome — append, heal, or migrate — ever emits `export SYNAPSE_VAULT=`", () => {
  const rcs = [
    "",                                                  // fresh rc
    "# stuff\n",                                         // rc with unrelated content
    `# stuff\n${legacyLine(A)}\n`,                        // the bad global export
    `# stuff\n${lineA}\n`,                                // already current
    `${legacyLine(A)}\n${legacyLine(B)}\n`,               // two bad lines from two vaults
  ];
  for (const rcText of rcs) {
    for (const v of [A, B]) {
      const p = plan(rcText, v);
      if (p.nextText === null) continue;
      assert.doesNotMatch(p.nextText, /export\s+SYNAPSE_VAULT=/,
        `an export survived into the rc for input ${JSON.stringify(rcText)}`);
    }
  }
});

// ── requirement 2: re-running from another vault does not redirect ───────────

test("installing from vault B rewrites only the fallback, and says so", () => {
  const rcText = `# top\n${lineA}\n# bottom\n`;
  const p = plan(rcText, B);
  assert.equal(p.action, "heal");
  assert.equal(p.nextText, `# top\n${lineB}\n# bottom\n`);
  assert.match(allText(p), /fallback re-pointed/, "a vault swap must be reported, never silent");
  assert.match(allText(p), /standing in a\n?\s*vault always wins/,
    "and it must say why this cannot redirect vault A");
});

test("the plan is idempotent — the second run from the same vault is a no-op", () => {
  const once = plan("# top\n", A);
  const twice = plan(once.nextText, A);
  assert.equal(twice.action, "current");
  assert.equal(twice.changed, false);
  assert.equal(twice.nextText, null, "a no-op must not rewrite the file at all");
});

// ── requirement 3: a hand-edit is never clobbered ────────────────────────────

test("a hand-edited marked line is KEPT — this is the exact edit the old self-heal undid", () => {
  // What a user lands on after deleting the export by hand: a bare source line, marker intact.
  const handEdit = `source "${A.agentsSh}"  ${SH_MARKER}`;
  const rcText = `# NO global SYNAPSE_VAULT pin — on purpose.\n${handEdit}\n`;
  const p = plan(rcText, B);
  assert.equal(p.action, "kept-hand-edit");
  assert.equal(p.changed, false);
  assert.equal(p.nextText, null, "not one byte may be written when the user has edited the line");
  assert.match(allText(p), /NOT a line this installer/);
  assert.match(allText(p), /--force-rc/, "the escape hatch must be named in the warning");
  assert.ok(allText(p).includes(handEdit), "their line is echoed back");
  assert.ok(allText(p).includes(lineB), "and so is ours, so they can merge it by hand");
});

test("classifyRcLine: a bare `source` line is a HAND-EDIT, not a shape we generated", () => {
  assert.equal(classifyRcLine(`source "/x/agents.sh"  ${SH_MARKER}`).generation, "hand-edited");
  assert.equal(classifyRcLine(legacyLine(A)).generation, "global-export");
  assert.equal(classifyRcLine(lineA).generation, "fallback");
  assert.equal(classifyRcLine(lineA).vaultDir, A.vaultDir);
  // The pre-rename scope must still be recognized, or install appends a second line forever.
  assert.equal(classifyRcLine(`${RC_FALLBACK_VAR}="/v"; source "/s.sh"  ${SH_MARKER_LEGACY}`).generation, "fallback");
});

test("--force-rc is the ONLY way a hand-edited line gets rewritten", () => {
  const handEdit = `source "${A.agentsSh}" && echo hi  ${SH_MARKER}`;
  const rcText = `${handEdit}\n`;
  assert.equal(plan(rcText, A).action, "kept-hand-edit");
  const forced = plan(rcText, A, { force: true });
  assert.equal(forced.action, "heal");
  assert.equal(forced.nextText, `${lineA}\n`);
  assert.match(allText(forced), /--force-rc: overwrote/, "an override must announce itself");
});

// ── requirement 4: the bad export is healed, visibly ─────────────────────────

test("an existing global export is migrated away and reported in full", () => {
  const rcText = `export PATH=/x:$PATH\n${legacyLine(A)}\nalias ll='ls -l'\n`;
  const p = plan(rcText, A);
  assert.equal(p.action, "heal");
  assert.equal(p.nextText, `export PATH=/x:$PATH\n${lineA}\nalias ll='ls -l'\n`);
  assert.doesNotMatch(p.nextText, /export\s+SYNAPSE_VAULT=/);
  const said = allText(p);
  assert.match(said, /REMOVED the global 'export SYNAPSE_VAULT=' pin/);
  assert.match(said, /unset SYNAPSE_VAULT/, "open shells still carry it — the user has to be told");
  assert.match(said, /NON-exported/);
});

test("healing touches ONLY the marked line — the rest of the rc is byte-identical", () => {
  const before = `# a\nexport FOO=1\n\n${legacyLine(A)}\n\n# trailing comment\n`;
  const p = plan(before, A);
  const strip = (t) => t.split("\n").filter((l) => !l.includes(SH_MARKER)).join("\n");
  assert.equal(strip(p.nextText), strip(before));
});

// ── requirement 6: duplicate agents.sh sources are surfaced ──────────────────

test("two marked lines from two vaults collapse to one, loudly", () => {
  // The real-world rc that triggered this fix: line 121 from one vault, line 133 from another.
  const rcText = `# a\n${legacyLine(A)}\n# b\n${legacyLine(B)}\n`;
  const p = plan(rcText, B);
  assert.equal(p.action, "heal");
  assert.equal(p.nextText, `# a\n${lineB}\n# b\n`, "the survivor keeps the FIRST line's position");
  assert.equal((p.nextText.match(/agents\.sh/g) || []).length, 1, "exactly one agents.sh source remains");
  assert.match(allText(p), /collapsed 2 synapse rc line\(s\) into one \(lines 2, 4\)/);
  assert.ok(allText(p).includes(legacyLine(B)), "the dropped line is quoted so the change is auditable");
});

test("an UNMARKED source of another vault's agents.sh is warned about, not touched", () => {
  const foreign = `source "${A.agentsSh}"`;
  const rcText = `${foreign}\n${lineB}\n`;
  const p = plan(rcText, B);
  assert.equal(p.action, "current", "our own line is already right");
  assert.match(allText(p), /ALSO sources/);
  assert.ok(allText(p).includes(A.agentsSh));
  assert.match(allText(p), /last one wins/);
});

test("a commented-out source line is not mistaken for a live one", () => {
  const p = plan(`# source "${A.agentsSh}"\n${lineB}\n`, B);
  assert.equal(p.action, "current");
  assert.equal(p.warnings.length, 0, `a comment must not raise a duplicate warning: ${allText(p)}`);
});

// ── requirement 5: the dry run shows exactly what --write does ───────────────

test("dry-run and --write share ONE plan — the printed line is the written line", () => {
  const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
  const vault = mkdtempSync(join(tmpdir(), "syn-install-"));
  const home = mkdtempSync(join(tmpdir(), "syn-home-"));
  try {
    mkdirSync(join(vault, "_meta", "tools"), { recursive: true });
    mkdirSync(join(vault, "agents"), { recursive: true });
    writeFileSync(join(vault, "_meta", "tools", "context.manifest.json"), JSON.stringify({
      repo: "t", logLabel: "synapse", vaultRoot: ".", skipDirs: ["node_modules"],
      roles: {}, profiles: {}, tokenBudgets: {}, excerptChars: {}, typePriority: [], trailers: {}, invariants: [],
    }));
    writeFileSync(join(home, ".zshrc"), "# pre-existing\n");
    const run = (extra = []) => spawnSync(process.execPath, [join(PKG, "lib", "install.mjs"), ...extra], {
      cwd: vault, encoding: "utf8",
      env: { ...process.env, HOME: home, SHELL: "/bin/zsh", SYNAPSE_VAULT: "", SYNAPSE_VAULT_FALLBACK: "" },
    });

    const dry = run();
    assert.equal(dry.status, 0, dry.stderr);
    const shown = dry.stdout.split("\n").find((l) => l.includes(SH_MARKER));
    assert.ok(shown, `dry-run must print the rc line:\n${dry.stdout}`);
    assert.doesNotMatch(dry.stdout, /export SYNAPSE_VAULT=/, "not even the preview may show an export");
    assert.match(dry.stdout, /plan: append this line/);
    assert.equal(spawnSync("grep", ["-c", SH_MARKER, join(home, ".zshrc")]).status, 1,
      "a dry run must write nothing");

    const wrote = run(["--write"]);
    assert.equal(wrote.status, 0, wrote.stderr);
    const rcNow = spawnSync("cat", [join(home, ".zshrc")], { encoding: "utf8" }).stdout;
    const written = rcNow.split("\n").find((l) => l.includes(SH_MARKER));
    assert.equal(written, shown.trim(), "the line --write applied must be the line the dry run printed");
    assert.doesNotMatch(rcNow, /export\s+SYNAPSE_VAULT=/);
    assert.ok(rcNow.startsWith("# pre-existing\n"), "the user's rc content is preserved");

    // Re-running is a clean no-op: same line, still exactly once.
    assert.equal(run(["--write"]).status, 0);
    const rcAgain = spawnSync("cat", [join(home, ".zshrc")], { encoding: "utf8" }).stdout;
    assert.equal(rcAgain, rcNow, "a second --write must not change a single byte");
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── the shell half: agents.sh honors the fallback, but $PWD still wins ───────

const SHELLS = ["bash", "zsh"].filter((sh) => spawnSync("command", ["-v", sh], { shell: true }).status === 0);

function makeVault(tag) {
  // realpath: on macOS $TMPDIR is /var/... which is a symlink to /private/var. The shell's $PWD walk
  // reports the resolved path, so an unresolved expectation fails for a reason that has nothing to do
  // with the code under test.
  const d = realpathSync(mkdtempSync(join(tmpdir(), `syn-vault-${tag}-`)));
  mkdirSync(join(d, "agents"), { recursive: true });
  mkdirSync(join(d, "_meta", "tools"), { recursive: true });
  writeFileSync(join(d, "_meta", "tools", "context.manifest.json"), "{}");
  return d;
}

for (const sh of SHELLS) {
  test(`[${sh}] __mx_vault: $PWD wins over the rc fallback, which wins over nothing`, () => {
    const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
    const vA = makeVault("a");
    const vB = makeVault("b");
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "syn-outside-")));
    try {
      // Exactly what the rc line does: a NON-exported fallback, then source.
      const boot = `SYNAPSE_VAULT_FALLBACK=${JSON.stringify(vB)}\nunset SYNAPSE_VAULT\n. ${JSON.stringify(join(PKG, "agents.sh"))} >/dev/null 2>&1\n`;
      const ask = (cwd) => spawnSync(sh, ["-c", `${boot}__mx_vault`], { cwd, encoding: "utf8" }).stdout.trim();

      assert.equal(ask(vA), vA, "standing in vault A must resolve A, not the rc fallback");
      assert.equal(ask(outside), vB, "outside any vault, the fallback is the safety net");

      // The fallback must not be exported — a child process must not inherit it, or it is a global pin
      // by another name.
      const leaked = spawnSync(sh, ["-c", `${boot}${sh} -c 'echo "[\${SYNAPSE_VAULT_FALLBACK:-}][\${SYNAPSE_VAULT:-}]"'`],
        { cwd: outside, encoding: "utf8" }).stdout.trim();
      assert.equal(leaked, "[][]", `neither var may reach a child process; got ${leaked}`);

      // Backward compatibility: a user who DOES export SYNAPSE_VAULT still outranks the rc fallback.
      const explicit = spawnSync(sh, ["-c", `${boot}export SYNAPSE_VAULT=${JSON.stringify(vA)}\n__mx_vault`],
        { cwd: outside, encoding: "utf8" }).stdout.trim();
      assert.equal(explicit, vA, "an explicit export must still beat the installer's fallback");
    } finally {
      for (const d of [vA, vB, outside]) rmSync(d, { recursive: true, force: true });
    }
  });
}
