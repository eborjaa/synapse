// skills.test.mjs — the harness-skill GENERATION logic (shared by `synapse skills` and `synapse install`).
// Focus: that the roster is read from THIS vault's agents/ (decision-0008's contract, and the whole point
// of the command), that hand-authored skills survive a regeneration, and that the emitted frontmatter
// satisfies the rules DSH actually enforces at load.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSkillTargets, applySkillTargets, parseAgentFrontmatter, buildBody, buildDescription,
  sanitizeDescription, shippedSkill, shippedAgentMatches, skillRelevantFields,
  GENERATED_MARKER, DEFAULT_MAX_DESCRIPTION, SHIPPED_SKILLS_DIR, SHIPPED_AGENTS_DIR,
} from "./skills.mjs";

// The name regex DSH validates against; a skill failing it is dropped at load with only a warning.
const DSH_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function tmpVault(agents = {}) {
  const root = mkdtempSync(join(tmpdir(), "syn-skills-"));
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true }); // a real vault is a repo — see the .git test below
  for (const [file, body] of Object.entries(agents)) writeFileSync(join(root, "agents", file), body);
  return { root, vaultDir: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const agentMd = ({ id, title = "T", purpose = "Do a thing", profile = "standard", tools = [], rules = [], delegates = [], outputs = [], addressable = false, area = "testing" }) => `---
id: ${id}
type: agent
title: ${title}
tags:
  - type/agent
  - area/${area}
purpose: "${purpose}"
profile: ${profile}
autonomous: false
addressable: ${addressable}
uses_tools: ${JSON.stringify(tools)}
applies_rules: ${JSON.stringify(rules)}
delegates_to: ${JSON.stringify(delegates)}
outputs: ${JSON.stringify(outputs)}
invokes_skills: []
---

body
`;

const frontmatterOf = (s) => s.match(/^---\n([\s\S]*?)\n---/)[1];
const fmValue = (s, k) => (frontmatterOf(s).split("\n").find((l) => l.startsWith(k + ":")) || "").slice(k.length + 1).trim();

test("the roster comes from THIS vault's agents/, not a shipped list", () => {
  const { root, vaultDir, cleanup } = tmpVault({
    "agent-spec-author.md": agentMd({ id: "agent-spec-author" }),
    "agent-qa-lead.md": agentMd({ id: "agent-qa-lead" }),
    "not-an-agent.md": "---\nid: nope\n---\n",
  });
  try {
    const { targets, warnings } = buildSkillTargets({ root, vaultDir });
    assert.deepEqual(targets.map((t) => t.name), ["synapse-qa-lead", "synapse-spec-author"]);
    assert.deepEqual(warnings, []);
    for (const t of targets) assert.ok(DSH_NAME_RE.test(t.name), `${t.name} must satisfy DSH's name rule`);
  } finally { cleanup(); }
});

test("--agent filters to one, matching with or without the agent- prefix", () => {
  const { root, vaultDir, cleanup } = tmpVault({
    "agent-a.md": agentMd({ id: "agent-a" }), "agent-b.md": agentMd({ id: "agent-b" }),
  });
  try {
    assert.deepEqual(buildSkillTargets({ root, vaultDir, agent: "a" }).targets.map((t) => t.name), ["synapse-a"]);
    assert.deepEqual(buildSkillTargets({ root, vaultDir, agent: "agent-b" }).targets.map((t) => t.name), ["synapse-b"]);
    assert.match(buildSkillTargets({ root, vaultDir, agent: "ghost" }).warnings.join(" "), /no agent matched/);
  } finally { cleanup(); }
});

test("an id that cannot make a valid DSH skill name is skipped LOUDLY, not silently renamed", () => {
  const { root, vaultDir, cleanup } = tmpVault({ "agent-QA_Lead.md": agentMd({ id: "agent-QA_Lead" }) });
  try {
    const { targets, warnings } = buildSkillTargets({ root, vaultDir });
    assert.equal(targets.length, 0);
    assert.match(warnings.join(" "), /not a valid skill name/);
  } finally { cleanup(); }
});

test("an agent with no purpose and no title is skipped — description is the only routing signal", () => {
  const { root, vaultDir, cleanup } = tmpVault({ "agent-bare.md": "---\nid: agent-bare\ntype: agent\n---\n" });
  try {
    const { targets, warnings } = buildSkillTargets({ root, vaultDir });
    assert.equal(targets.length, 0);
    assert.match(warnings.join(" "), /only routing signal/);
  } finally { cleanup(); }
});

test("a HAND-AUTHORED skill is kept without --force and overwritten with it", () => {
  // Deliberately an agent the package ships nothing for, so this exercises the GENERATED path.
  const { root, vaultDir, cleanup } = tmpVault({ "agent-qa-lead.md": agentMd({ id: "agent-qa-lead" }) });
  try {
    const { targets } = buildSkillTargets({ root, vaultDir });
    mkdirSync(join(targets[0].path, ".."), { recursive: true });
    writeFileSync(targets[0].path, "---\nname: synapse-qa-lead\ndescription: tuned by hand\n---\nkeep me\n");

    const kept = applySkillTargets(targets, { root, write: true });
    assert.equal(kept[0].status, "kept");
    assert.match(readFileSync(targets[0].path, "utf8"), /keep me/);

    const forced = applySkillTargets(targets, { root, write: true, force: true });
    assert.equal(forced[0].status, "overwritten");
    assert.ok(readFileSync(targets[0].path, "utf8").includes(GENERATED_MARKER));
  } finally { cleanup(); }
});

test("regenerating a generated skill is idempotent, and a drifted one is updated", () => {
  const { root, vaultDir, cleanup } = tmpVault({ "agent-a.md": agentMd({ id: "agent-a" }) });
  try {
    const { targets } = buildSkillTargets({ root, vaultDir });
    assert.equal(applySkillTargets(targets, { root, write: true })[0].status, "created");
    assert.equal(applySkillTargets(targets, { root, write: true })[0].status, "unchanged");
    writeFileSync(targets[0].path, readFileSync(targets[0].path, "utf8") + "\ndrift\n");
    assert.equal(applySkillTargets(targets, { root, write: true })[0].status, "updated");
  } finally { cleanup(); }
});

test("a dry run writes nothing", () => {
  const { root, vaultDir, cleanup } = tmpVault({ "agent-a.md": agentMd({ id: "agent-a" }) });
  try {
    const { targets } = buildSkillTargets({ root, vaultDir });
    assert.equal(applySkillTargets(targets, { root, write: false })[0].status, "created");
    assert.equal(existsSync(targets[0].path), false);
  } finally { cleanup(); }
});

test("a READ-ONLY agent (no tool-lint/tool-git) gets 'never mutate' and no lint/log step", () => {
  const body = buildBody(parseAgentFrontmatter(agentMd({ id: "agent-oracle", tools: ["[[tool-render]]"] })));
  assert.match(body, /\*\*Never mutate\.\*\*/);
  assert.doesNotMatch(body, /synapse_lint/);
  assert.doesNotMatch(body, /synapse_log/);
  assert.doesNotMatch(body, /Propose, do not push/);
});

test("a MUTATING agent gets verify + record + the propose-don't-push boundary", () => {
  const body = buildBody(parseAgentFrontmatter(agentMd({ id: "agent-curator", tools: ["[[tool-lint]]", "[[tool-git]]"] })));
  assert.match(body, /synapse_lint/);
  assert.match(body, /synapse_log/);
  assert.match(body, /Propose, do not push/);
  assert.doesNotMatch(body, /\*\*Never mutate\.\*\*/);
});

test("the delegation spine appears only when delegates_to is set, and names the real targets", () => {
  const withD = buildBody(parseAgentFrontmatter(agentMd({ id: "agent-curator", delegates: ["[[agent-reconciler]]", "[[agent-ingester]]"] })));
  assert.match(withD, /## Delegating/);
  assert.match(withD, /You delegate to: `reconciler`, `ingester`\./);
  // The three-call shape is the failure this spine exists to prevent: claim != spawn.
  assert.match(withD, /does \*not\* start a worker/);
  assert.match(withD, /run_in_background: false/);
  assert.match(withD, /refused: "held"/);

  assert.doesNotMatch(buildBody(parseAgentFrontmatter(agentMd({ id: "agent-reconciler" }))), /## Delegating/);
});

test("addressable adds the publish-to-thread duty; a non-addressable agent gets none", () => {
  assert.match(buildBody(parseAgentFrontmatter(agentMd({ id: "agent-a", addressable: true }))), /You are addressable/);
  assert.doesNotMatch(buildBody(parseAgentFrontmatter(agentMd({ id: "agent-a", addressable: false }))), /You are addressable/);
});

test("the brief step carries the agent's own short id and declared profile", () => {
  const body = buildBody(parseAgentFrontmatter(agentMd({ id: "agent-qa-lead", profile: "lean" })));
  assert.match(body, /agent: "qa-lead"/);
  assert.match(body, /profile: "lean"/);
});

test("frontmatter opens on line 1, is exactly name+description, and survives a hostile purpose", () => {
  // ": " and quotes turn a plain YAML scalar into a mapping; a newline splits the block entirely.
  const nasty = 'Answer questions: cite every claim, "always", and never mutate';
  const body = buildBody(parseAgentFrontmatter(agentMd({ id: "agent-a", purpose: nasty })));
  assert.ok(body.startsWith("---\n"), "frontmatter must open on line 1 or DSH drops the skill");
  assert.deepEqual(frontmatterOf(body).split("\n").length, 2);
  assert.equal(fmValue(body, "name"), "synapse-a");
  const desc = fmValue(body, "description");
  assert.ok(desc.startsWith('"') && desc.endsWith('"'));
  assert.doesNotMatch(desc.slice(1, -1), /: |"/);
  assert.match(sanitizeDescription("a: b"), /a — b/);
});

test("the marker lives in the BODY, not frontmatter — DSH drops a skill on a bad frontmatter value", () => {
  const body = buildBody(parseAgentFrontmatter(agentMd({ id: "agent-a" })));
  assert.ok(body.includes(GENERATED_MARKER));
  assert.ok(!frontmatterOf(body).includes(GENERATED_MARKER));
});

test("a long purpose is capped but the trigger sentence always survives intact", () => {
  const purpose = "word ".repeat(400).trim();
  const desc = buildDescription(parseAgentFrontmatter(agentMd({ id: "agent-a", purpose, area: "retrieval" })));
  assert.ok(desc.length < purpose.length);
  assert.ok(desc.includes("…"));
  assert.match(desc, /Use when a task names a, agent-a, or concerns retrieval in the Synapse vault\.$/);
  assert.ok(buildDescription(parseAgentFrontmatter(agentMd({ id: "agent-a", purpose })), { maxDescription: 40 }).length
    < desc.length);
  assert.ok(DEFAULT_MAX_DESCRIPTION > 0);
});

test("frontmatter parses BOTH the inline-array form agent files use and a YAML block list", () => {
  const inline = parseAgentFrontmatter(`---\nid: agent-a\ndelegates_to: ["[[agent-b]]", "[[agent-c]]"]\n---\n`);
  assert.deepEqual(inline.delegates_to, ["[[agent-b]]", "[[agent-c]]"]);
  const block = parseAgentFrontmatter(`---\nid: agent-a\ntags:\n  - type/agent\n  - area/x\n---\n`);
  assert.deepEqual(block.tags, ["type/agent", "area/x"]);
  assert.deepEqual(parseAgentFrontmatter(`---\nid: agent-a\noutputs:\n---\n`).outputs, []);
  assert.deepEqual(parseAgentFrontmatter("no frontmatter here"), {});
});

test("the default target is the REPO ROOT's .dsh/skills, not vaultDir — DSH resolves it from .git", () => {
  // Nested layout: content lives in root/context-vault, but DSH walks up for .git and lands on root.
  const root = mkdtempSync(join(tmpdir(), "syn-skills-nested-"));
  try {
    const vaultDir = join(root, "context-vault");
    mkdirSync(join(vaultDir, "agents"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(vaultDir, "agents", "agent-a.md"), agentMd({ id: "agent-a" }));

    const { targets, warnings } = buildSkillTargets({ root, vaultDir });
    assert.equal(targets[0].path, join(root, ".dsh", "skills", "synapse-a", "SKILL.md"));
    assert.ok(!targets[0].path.includes("context-vault"), "must NOT write under vaultDir");
    assert.deepEqual(warnings, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("no .git above the target warns — DSH would fall back to its launch directory", () => {
  const { root, vaultDir, cleanup } = tmpVault({ "agent-a.md": agentMd({ id: "agent-a" }) });
  rmSync(join(root, ".git"), { recursive: true, force: true });
  try {
    assert.match(buildSkillTargets({ root, vaultDir }).warnings.join(" "), /not a git repository/);
    // An explicit --out is the user's call; do not second-guess it.
    assert.deepEqual(buildSkillTargets({ root, vaultDir, outDir: join(root, "elsewhere") }).warnings, []);
  } finally { cleanup(); }
});

test("a skill THIS package hand-authored is installed verbatim, never generated over", () => {
  // DSH ranks the project root (100) ABOVE the user root (400) that dsh-synapse symlinks the shipped
  // skills into, so generating over a shipped name would shadow the tuned version with a generic one.
  // The vault's agent must still BE the shipped one — see the divergence test below.
  const pristine = readFileSync(join(SHIPPED_AGENTS_DIR, "agent-oracle.md"), "utf8");
  const { root, vaultDir, cleanup } = tmpVault({ "agent-oracle.md": pristine });
  try {
    const tuned = readFileSync(join(SHIPPED_SKILLS_DIR, "synapse-oracle", "SKILL.md"), "utf8");
    const { targets } = buildSkillTargets({ root, vaultDir });
    assert.equal(targets[0].origin, "shipped");
    assert.equal(targets[0].content, tuned);
    assert.ok(!targets[0].content.includes(GENERATED_MARKER), "a shipped skill carries no generated marker");

    // …and once installed it reads as hand-authored, so a later run leaves it alone.
    applySkillTargets(targets, { root, write: true });
    assert.equal(applySkillTargets(targets, { root, write: true })[0].status, "kept");
  } finally { cleanup(); }
});

test("a vault that EDITED a shipped agent gets ITS definition, not the package's skill", () => {
  // The nightmare case: you customised agent-oracle. The shipped skill states the SHIPPED oracle's
  // profile, delegation and boundaries — handing it over would describe an agent you no longer have.
  const custom = readFileSync(join(SHIPPED_AGENTS_DIR, "agent-oracle.md"), "utf8")
    .replace(/^profile: .*$/m, "profile: fat")
    .replace(/^delegates_to: .*$/m, "delegates_to: []")
    .replace(/^purpose: .*$/m, 'purpose: "MY oracle — answers only about coffee"');
  const { root, vaultDir, cleanup } = tmpVault({ "agent-oracle.md": custom });
  try {
    const { targets, warnings } = buildSkillTargets({ root, vaultDir });
    assert.equal(targets[0].origin, "generated");
    assert.match(warnings.join(" "), /generated from YOUR definition/);
    assert.match(targets[0].content, /profile: "fat"/);
    assert.match(targets[0].content, /MY oracle/);
    assert.doesNotMatch(targets[0].content, /## Delegating/);   // theirs delegates to nothing
  } finally { cleanup(); }
});

test("an UNMODIFIED shipped agent still gets the hand-tuned skill", () => {
  const pristine = readFileSync(join(SHIPPED_AGENTS_DIR, "agent-oracle.md"), "utf8");
  const { root, vaultDir, cleanup } = tmpVault({ "agent-oracle.md": pristine });
  try {
    const { targets, warnings } = buildSkillTargets({ root, vaultDir });
    assert.equal(targets[0].origin, "shipped");
    assert.doesNotMatch(warnings.join(" "), /generated from YOUR definition/);
  } finally { cleanup(); }
});

test("editing only an agent's BODY still yields the shipped skill — the skill reads frontmatter", () => {
  const bodyEdited = readFileSync(join(SHIPPED_AGENTS_DIR, "agent-oracle.md"), "utf8")
    + "\n\n## My own notes\n\nSome prose I added.\n";
  const { root, vaultDir, cleanup } = tmpVault({ "agent-oracle.md": bodyEdited });
  try {
    assert.equal(buildSkillTargets({ root, vaultDir }).targets[0].origin, "shipped");
  } finally { cleanup(); }
});

test("shippedAgentMatches compares only the fields the template reads", () => {
  const fm = parseAgentFrontmatter(readFileSync(join(SHIPPED_AGENTS_DIR, "agent-oracle.md"), "utf8"));
  assert.equal(shippedAgentMatches("agent-oracle", fm), true);
  assert.equal(shippedAgentMatches("agent-oracle", { ...fm, profile: "fat" }), false);
  assert.equal(shippedAgentMatches("agent-nonexistent", fm), false);
  // `id` and `related` are not read by the template, so they must not count as divergence.
  assert.equal(skillRelevantFields({ ...fm, related: ["x"] }), skillRelevantFields(fm));
});

test("a fat agent is not told to escalate to fat", () => {
  const fat = buildBody(parseAgentFrontmatter(agentMd({ id: "agent-a", profile: "fat" })));
  assert.match(fat, /profile: "fat"/);
  assert.doesNotMatch(fat, /Escalate to/);
  assert.match(buildBody(parseAgentFrontmatter(agentMd({ id: "agent-a", profile: "lean" }))), /Escalate to/);
});

test("an agent the package ships nothing for is generated from the template", () => {
  const { root, vaultDir, cleanup } = tmpVault({ "agent-qa-lead.md": agentMd({ id: "agent-qa-lead" }) });
  try {
    const { targets } = buildSkillTargets({ root, vaultDir });
    assert.equal(targets[0].origin, "generated");
    assert.ok(targets[0].content.includes(GENERATED_MARKER));
  } finally { cleanup(); }
});

test("shippedSkill never returns the very file it is about to write", () => {
  const self = join(SHIPPED_SKILLS_DIR, "synapse-oracle", "SKILL.md");
  assert.equal(shippedSkill("synapse-oracle", self), null);
  assert.ok(shippedSkill("synapse-oracle", "/somewhere/else/SKILL.md") !== null);
  assert.equal(shippedSkill("synapse-nonexistent", "/somewhere/else/SKILL.md"), null);
});

test("a vault with no agents/ directory warns instead of throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "syn-skills-empty-"));
  try {
    const { targets, warnings } = buildSkillTargets({ root, vaultDir: root });
    assert.equal(targets.length, 0);
    assert.match(warnings.join(" "), /no agents\/ directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
