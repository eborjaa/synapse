// render.test.mjs — self-contained golden tests for the synapse engine.
//
//   node --test lib/render.test.mjs
//
// Each test builds a throwaway vault in a temp dir (both nested + flat layouts), runs render.mjs as a
// child, and asserts on its stdout/stderr. No dependency on any consumer's notes — so these pass in the
// package repo AND in any consumer that has synapse installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const RENDER = join(dirname(fileURLToPath(import.meta.url)), "render.mjs");

const MANIFEST = {
  repo: "test", logLabel: "synapse", vaultRoot: ".",
  skipDirs: ["node_modules", ".git"],
  autoUpgrade: { moc: "standard" }, dropTagsAtLean: ["status/draft"],
  roles: {
    CONSTRAINS: { field: "applies_rules", direction: "forward", mandatoryFull: true },
    USES: { field: ["invokes_skills", "uses_tools"], direction: "forward" },
    DELEGATES: { field: "delegates_to", direction: "forward" },
    BINDS: { field: "related", direction: "reverse", reverseName: "members", endpointTypes: ["workflow"] },
    ATTACHES: { field: "related", direction: "both", endpointTypes: ["glossary"] },
    NAVIGATES: { field: "related", direction: "forward", endpointTypes: ["moc"] },
  },
  referenceRoles: ["ATTACHES", "NAVIGATES"],
  profiles: {
    lean: { roles: ["CONSTRAINS", "USES", "DELEGATES"], pointerRoles: ["DELEGATES"], depth: { BINDS: 0 } },
    standard: { roles: ["CONSTRAINS", "USES", "DELEGATES", "BINDS", "ATTACHES", "NAVIGATES"], pointerRoles: [], depth: { NAVIGATES: 1, BINDS: 1 } },
    fat: { roles: ["CONSTRAINS", "USES", "DELEGATES", "BINDS", "ATTACHES", "NAVIGATES"], depth: { NAVIGATES: 99, BINDS: 99 }, transitive: true },
  },
  tokenBudgets: { lean: 4000, standard: 15000, fat: 30000 },
  excerptChars: { lean: 40, standard: 4000, fat: 0 },
  typePriority: ["agent", "moc", "rule", "skill", "workflow", "glossary"],
  trailers: { canary: true, handover: false },
  invariants: [],
};

function note(id, type, extraFm = "", body = "body of " + id) {
  return `---\nid: ${id}\ntype: ${type}\ntitle: ${id}\ntags:\n  - type/${type}\n${extraFm}---\n${body}\n`;
}

// Build a vault; layout = "nested" | "flat". Returns { root, cleanup }.
function makeVault(layout) {
  const root = mkdtempSync(join(tmpdir(), "syn-test-"));
  const vaultDir = layout === "nested" ? join(root, "context-vault") : root;
  const toolsDir = join(vaultDir, "_meta", "tools");
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, "context.manifest.json"), JSON.stringify(MANIFEST));
  const dir = (d) => { const p = join(vaultDir, d); mkdirSync(p, { recursive: true }); return p; };
  writeFileSync(join(dir("agents"), "agent-a.md"), note("agent-a", "agent",
    "purpose: x\napplies_rules: [[rule-r]]\ninvokes_skills: [[skill-s]]\ndelegates_to: [[agent-b]]\n"));
  writeFileSync(join(dir("agents"), "agent-b.md"), note("agent-b", "agent", "purpose: doer\nshort_purpose: does the work\n"));
  writeFileSync(join(dir("rules"), "rule-r.md"), note("rule-r", "rule", "", "R".repeat(300)));
  writeFileSync(join(dir("skills"), "skill-s.md"), note("skill-s", "skill", "", "S".repeat(300)));
  writeFileSync(join(dir("moc"), "moc-m.md"), note("moc-m", "moc"));
  writeFileSync(join(dir("flows"), "workflow-w.md"), note("workflow-w", "workflow", "related: [[moc-m]]\n"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function render(root, args) {
  // Hermetic: strip any ambient SYNAPSE_VAULT so resolution comes from `cwd` (the temp vault), and
  // pin VAULT_USER so the canary trailer is deterministic regardless of the host's git config.
  const env = { ...process.env, VAULT_USER: "Tester" };
  delete env.SYNAPSE_VAULT;
  const r = spawnSync(process.execPath, [RENDER, ...args], { cwd: root, encoding: "utf8", env });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

for (const layout of ["nested", "flat"]) {
  test(`[${layout}] lean closure: rule full, skill+delegate reached, delegate is a pointer`, () => {
    const v = makeVault(layout);
    try {
      const { stdout, stderr } = render(v.root, ["agent-a", "--profile", "lean"]);
      assert.match(stderr, /roots=agent-a profile=lean/);
      assert.match(stdout, /<!-- agent-a \(agent\) -->/);
      assert.match(stdout, /<!-- rule-r \(rule\) -->/);          // CONSTRAINS reached
      assert.match(stdout, /R{300}/);                            // guardrail rule is FULL (not excerpted)
      assert.match(stdout, /<!-- agent-b \(agent\) -->\n→ does the work/); // DELEGATES → pointer
    } finally { v.cleanup(); }
  });

  test(`[${layout}] excerpt: a non-mandatory body over excerptChars is truncated with ellipsis`, () => {
    const v = makeVault(layout);
    try {
      const { stdout } = render(v.root, ["agent-a", "--profile", "lean"]);
      // skill-s (USES, non-mandatory, 300 chars) with lean excerptChars=40 → truncated + " …"
      const m = stdout.match(/<!-- skill-s \(skill\) -->\n(S+) …/);
      assert.ok(m, "skill body should be excerpted with an ellipsis");
      assert.ok(m[1].length <= 40, "excerpt should respect the char cap");
    } finally { v.cleanup(); }
  });

  test(`[${layout}] standard: MOC pulls its workflow member via reverse BINDS`, () => {
    const v = makeVault(layout);
    try {
      const { stdout, stderr } = render(v.root, ["moc-m", "--dry-run"]);
      assert.match(stderr, /profile=standard/);                  // auto-upgrade lean→standard for a moc
      assert.match(stderr, /workflow-w \(workflow\)/);            // member reached
    } finally { v.cleanup(); }
  });

  test(`[${layout}] canary trailer resolves the configured user name`, () => {
    const v = makeVault(layout);
    try {
      const { stdout } = render(v.root, ["agent-a", "--profile", "lean"]);
      assert.match(stdout, /Address the user by name \("Tester"\)/);
    } finally { v.cleanup(); }
  });

  test(`[${layout}] unknown id exits non-zero`, () => {
    const v = makeVault(layout);
    try {
      const { status } = render(v.root, ["no-such-note"]);
      assert.notEqual(status, 0);
    } finally { v.cleanup(); }
  });
}
