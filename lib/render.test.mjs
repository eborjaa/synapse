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
  autoUpgrade: { hub: "standard" }, dropTagsAtLean: ["status/draft"],
  roles: {
    CONSTRAINS: { field: "applies_rules", direction: "forward", mandatoryFull: true },
    USES: { field: ["invokes_skills", "uses_tools"], direction: "forward" },
    DELEGATES: { field: "delegates_to", direction: "forward" },
    BINDS: { field: "related", direction: "reverse", reverseName: "members", endpointTypes: ["workflow"] },
    ATTACHES: { field: "related", direction: "both", endpointTypes: ["glossary"] },
    NAVIGATES: { field: "related", direction: "forward", endpointTypes: ["hub"] },
  },
  referenceRoles: ["ATTACHES", "NAVIGATES"],
  profiles: {
    lean: { roles: ["CONSTRAINS", "USES", "DELEGATES"], pointerRoles: ["DELEGATES"], depth: { BINDS: 0 } },
    standard: { roles: ["CONSTRAINS", "USES", "DELEGATES", "BINDS", "ATTACHES", "NAVIGATES"], pointerRoles: [], depth: { NAVIGATES: 1, BINDS: 1 } },
    fat: { roles: ["CONSTRAINS", "USES", "DELEGATES", "BINDS", "ATTACHES", "NAVIGATES"], depth: { NAVIGATES: 99, BINDS: 99 }, transitive: true },
  },
  tokenBudgets: { lean: 4000, standard: 15000, fat: 30000 },
  excerptChars: { lean: 40, standard: 4000, fat: 0 },
  typePriority: ["agent", "hub", "rule", "skill", "workflow", "glossary"],
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
  writeFileSync(join(dir("hub"), "hub-m.md"), note("hub-m", "hub"));
  writeFileSync(join(dir("flows"), "workflow-w.md"), note("workflow-w", "workflow", "related: [[hub-m]]\n"));
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

  test(`[${layout}] standard: hub pulls its workflow member via reverse BINDS`, () => {
    const v = makeVault(layout);
    try {
      const { stdout, stderr } = render(v.root, ["hub-m", "--dry-run"]);
      assert.match(stderr, /profile=standard/);                  // auto-upgrade lean→standard for a hub
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

// ── on-demand notes: a trigger in the briefing, the payload one call away ────────────────────────────
// Motivating measurement (rel-context-eb, 2026-08-19): one formatting rule was 5,937 rendered tokens —
// larger than most agents' entire briefing — and it plus its siblings pushed ALL of an agent's rules out
// of every render. Such a rule is a template: needed at the instant it applies, not carried always.

function makeOnDemandVault({ budget = 15000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "syn-od-"));
  const toolsDir = join(root, "_meta", "tools");
  mkdirSync(toolsDir, { recursive: true });
  const m = structuredClone(MANIFEST);
  m.tokenBudgets = { lean: budget, standard: budget, fat: budget };
  writeFileSync(join(toolsDir, "context.manifest.json"), JSON.stringify(m));
  const dir = (d) => { const p = join(root, d); mkdirSync(p, { recursive: true }); return p; };
  writeFileSync(join(dir("agents"), "agent-a.md"), note("agent-a", "agent",
    "purpose: x\napplies_rules: [[rule-loaded]], [[rule-template]]\ninvokes_skills: [[skill-big]]\n"));
  // a NON-mandatory note, so a tight budget has something it is allowed to drop
  writeFileSync(join(dir("skills"), "skill-big.md"), note("skill-big", "skill", "", "SKILL-BODY " + "s".repeat(8000)));
  writeFileSync(join(dir("rules"), "rule-loaded.md"), note("rule-loaded", "rule", "", "NORMATIVE-BODY " + "n".repeat(200)));
  writeFileSync(join(dir("rules"), "rule-template.md"), note("rule-template", "rule",
    'on_demand: true\ntrigger: "before posting a Zephyr execution comment"\n',
    "TEMPLATE-BODY " + "t".repeat(20000)));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("[on-demand] the trigger is rendered, the payload is NOT", () => {
  const v = makeOnDemandVault();
  try {
    const { stdout } = render(v.root, ["agent-a", "--profile", "standard"]);
    assert.doesNotMatch(stdout, /TEMPLATE-BODY/, "the 20k-char payload must not be inlined");
    assert.match(stdout, /before posting a Zephyr execution comment/, "the trigger IS carried");
    assert.match(stdout, /NOT LOADED — fetch this before you act/);
    assert.match(stdout, /synapse_brief\(note: "rule-template"\)/, "and how to get it");
    assert.match(stdout, /NORMATIVE-BODY/, "an ordinary rule is unaffected");
  } finally { v.cleanup(); }
});

test("[on-demand] every trigger is also collected into one 'Fetch before you act' checklist", () => {
  const v = makeOnDemandVault();
  try {
    const { stdout } = render(v.root, ["agent-a", "--profile", "standard"]);
    assert.match(stdout, /## Fetch before you act/);
    const section = stdout.slice(stdout.indexOf("## Fetch before you act"));
    assert.match(section, /- \*\*before posting a Zephyr execution comment\*\* → `synapse_brief\(note: "rule-template"\)`/);
  } finally { v.cleanup(); }
});

test("[on-demand] asking for the note BY ID renders it in full — that is how you read it", () => {
  const v = makeOnDemandVault();
  try {
    const { stdout } = render(v.root, ["rule-template", "--profile", "standard"]);
    assert.match(stdout, /TEMPLATE-BODY/, "an explicit request is the fetch");
    assert.doesNotMatch(stdout, /NOT LOADED/);
  } finally { v.cleanup(); }
});

// on_demand deliberately outranks mandatoryFull: "always included" and "always inlined" are different
// claims. The guardrail still reaches the agent — as a trigger it cannot miss — without its template.
test("[on-demand] a mandatoryFull rule marked on_demand is still a pointer", () => {
  const v = makeOnDemandVault();
  try {
    const { stdout } = render(v.root, ["agent-a", "--profile", "lean"]);
    assert.doesNotMatch(stdout, /TEMPLATE-BODY/);
    assert.match(stdout, /before posting a Zephyr execution comment/);
  } finally { v.cleanup(); }
});

test("[on-demand] the trigger survives a budget that drops everything else", () => {
  const v = makeOnDemandVault({ budget: 60 });   // absurdly small on purpose
  try {
    const { stdout, stderr } = render(v.root, ["agent-a", "--profile", "standard"]);
    assert.match(stderr, /budget-trimmed/, "the budget really is biting");
    assert.match(stdout, /before posting a Zephyr execution comment/,
      "a trigger costs ~35 tokens and must never be the thing that gets cut");
  } finally { v.cleanup(); }
});

test("[on-demand] a vault with no on-demand notes gains no section (no empty scaffolding)", () => {
  const v = makeVault("flat");
  try {
    const { stdout } = render(v.root, ["agent-a", "--profile", "standard"]);
    assert.doesNotMatch(stdout, /Fetch before you act/);
  } finally { v.cleanup(); }
});

// REGRESSION (rel-context-eb, 2026-08-19): an on-demand note linked from a RULE — which is itself only
// a depth-1 hop from the agent — never reached the briefing, because each role's BFS starts at the root
// ids, not at notes those roles pulled in. And the first fix keyed off manifest.referenceRoles, which
// this vault does not set. The trigger must ride along with whatever pulled its parent, on ANY vault.
test("[on-demand] a trigger linked from a rule reaches the briefing (sticky, no referenceRoles needed)", () => {
  const root = mkdtempSync(join(tmpdir(), "syn-od-sticky-"));
  try {
    const toolsDir = join(root, "_meta", "tools");
    mkdirSync(toolsDir, { recursive: true });
    const m = structuredClone(MANIFEST);
    delete m.referenceRoles;                       // the eb vault omits it — the fix must not need it
    writeFileSync(join(toolsDir, "context.manifest.json"), JSON.stringify(m));
    const dir = (d) => { const p = join(root, d); mkdirSync(p, { recursive: true }); return p; };
    writeFileSync(join(dir("agents"), "agent-a.md"), note("agent-a", "agent",
      "purpose: x\napplies_rules: [[rule-r]]\n"));
    // the rule (depth-1 from the agent) is what references the on-demand template
    writeFileSync(join(dir("rules"), "rule-r.md"), note("rule-r", "rule",
      'related: ["[[doc-template]]"]\n', "the binding rule"));
    writeFileSync(join(dir("docs"), "doc-template.md"), note("doc-template", "doc",
      'on_demand: true\ntrigger: "before writing a report"\n', "HEAVY-TEMPLATE " + "x".repeat(9000)));

    const { stdout } = render(root, ["agent-a", "--profile", "standard"]);
    assert.doesNotMatch(stdout, /HEAVY-TEMPLATE/, "the payload stays out");
    assert.match(stdout, /before writing a report/, "the trigger, reached via the rule, comes through");
    assert.match(stdout, /synapse_brief\(note: "doc-template"\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
