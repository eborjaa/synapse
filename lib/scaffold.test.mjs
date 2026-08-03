// scaffold.test.mjs — generated notes must satisfy the schema the linter enforces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build, wireInbound, slugify, AUTHORABLE_TYPES } from "./scaffold.mjs";
import { requiredFields } from "./schema.mjs";

const manifest = {
  roles: {
    CONSTRAINS: { field: "applies_rules", direction: "forward" },
    USES: { field: ["invokes_skills", "uses_tools"], direction: "forward" },
    DELEGATES: { field: "delegates_to", direction: "forward" },
    REFERENCES: { field: "references_docs", direction: "forward", endpointTypes: ["doc"] },
    BINDS: { field: "related", direction: "reverse", endpointTypes: ["note", "plan", "project"] },
    ATTACHES: { field: "related", direction: "both", endpointTypes: ["person", "decision", "tool"] },
    NAVIGATES: { field: "related", direction: "both", endpointTypes: ["hub"] },
  },
};

const fm = (content) => content.slice(0, content.indexOf("\n---", 4));

test("slugify produces kebab-case ids", () => {
  assert.equal(slugify("Zone 2 Pacing!"), "zone-2-pacing");
  assert.equal(slugify("--already-kebab--"), "already-kebab");
});

test("build hub: path, prefix and type tag", () => {
  const out = build({ kind: "hub", slug: "climbing", manifest });
  assert.equal(out.id, "hub-climbing");
  assert.equal(out.path, "hub/hub-climbing.md");
  assert.match(fm(out.content), /^type: hub$/m);
  assert.match(fm(out.content), /- type\/hub/);
});

test("build: an explicit prefix is not doubled", () => {
  assert.equal(build({ kind: "hub", slug: "hub-climbing", manifest }).id, "hub-climbing");
  assert.equal(build({ kind: "note", slug: "rule-x", type: "rule", manifest }).id, "rule-x");
});

test("build agent: every lint-required field is present", () => {
  const out = build({ kind: "agent", slug: "scribe", purpose: "Draft notes", manifest });
  assert.equal(out.path, "agents/agent-scribe.md");
  for (const f of requiredFields("agent")) {
    assert.match(fm(out.content), new RegExp(`^${f}:`, "m"), `missing ${f}`);
  }
});

test("build agent: links land in the field their target type requires", () => {
  const out = build({
    kind: "agent", slug: "scribe", purpose: "x",
    links: ["rule-canary", "tool-git", "skill-maintain-synapse", "agent-curator", "doc-vision"],
    manifest,
  });
  const head = fm(out.content);
  assert.match(head, /^applies_rules: \["\[\[rule-canary\]\]"\]$/m);
  assert.match(head, /^uses_tools: \["\[\[tool-git\]\]"\]$/m);
  assert.match(head, /^invokes_skills: \["\[\[skill-maintain-synapse\]\]"\]$/m);
  assert.match(head, /^delegates_to: \["\[\[agent-curator\]\]"\]$/m);
  assert.match(head, /^references_docs: \["\[\[doc-vision\]\]"\]$/m);
});

test("build note: a hub link goes to related, not a role field", () => {
  const out = build({ kind: "note", slug: "zone2", type: "note", hub: "hub-health", manifest });
  assert.equal(out.path, "notes/note-zone2.md");
  assert.match(fm(out.content), /^related: \["\[\[hub-health\]\]"\]$/m);
});

test("build note: a supplied body replaces the stub and keeps ## Related wiring", () => {
  const out = build({
    kind: "note", slug: "with-body", type: "note", hub: "hub-health",
    body: "## P1 — thing\n\nprose here.", manifest,
  });
  assert.match(out.content, /## P1 — thing\n\nprose here\./);       // author's body verbatim
  assert.match(out.content, /## Related\n\[\[hub-health\]\]/);       // hub wiring still appended
  assert.doesNotMatch(out.content, /# With body\n\n-\n/);            // stub placeholder gone
});

test("build note: a body with its own ## Related is not double-wired", () => {
  const out = build({
    kind: "note", slug: "own-related", type: "note", hub: "hub-health",
    body: "Text.\n\n## Related\n[[note-elsewhere]]", manifest,
  });
  assert.equal((out.content.match(/## Related/g) || []).length, 1);
});

test("build note: no body still yields the per-type stub", () => {
  const out = build({ kind: "note", slug: "no-body", type: "note", hub: "hub-health", manifest });
  assert.match(out.content, /# No body\n\n-\n/);
});

test("build note: unknown type is rejected", () => {
  assert.throws(() => build({ kind: "note", slug: "x", type: "nonsense", manifest }), /unknown type/);
  assert.ok(AUTHORABLE_TYPES.includes("rule"));
  assert.ok(!AUTHORABLE_TYPES.includes("summary"), "generated record types are not authorable");
});

test("build handover: dated id, no frontmatter (not a typed artifact)", () => {
  const out = build({ kind: "handover", slug: "continue", plan: "plan-x", date: "2026-07-31", manifest });
  assert.equal(out.path, "inbox/handovers/2026-07-31-continue.md");
  assert.ok(!out.content.startsWith("---"));
  assert.match(out.content, /\[\[plan-x\]\]/);
});

test("build: an empty name is refused", () => {
  assert.throws(() => build({ kind: "hub", slug: "  ", manifest }), /name is required/);
});

const AGENT = `---
id: agent-x
type: agent
applies_rules: ["[[rule-a]]"]
---

# X
`;

test("wireInbound appends to an existing inline list", () => {
  const { content, changed } = wireInbound(AGENT, "applies_rules", "rule-b");
  assert.equal(changed, true);
  assert.match(content, /^applies_rules: \["\[\[rule-a\]\]", "\[\[rule-b\]\]"\]$/m);
  assert.match(content, /# X/, "body is preserved");
});

test("wireInbound is idempotent", () => {
  const once = wireInbound(AGENT, "applies_rules", "rule-b").content;
  const twice = wireInbound(once, "applies_rules", "rule-b");
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once);
});

test("wireInbound creates a missing field", () => {
  const { content, changed } = wireInbound(AGENT, "uses_tools", "tool-git");
  assert.equal(changed, true);
  assert.match(content, /^uses_tools: \["\[\[tool-git\]\]"\]$/m);
});

test("wireInbound refuses to corrupt a block list", () => {
  const block = `---\nid: a\ntype: agent\napplies_rules:\n  - "[[rule-a]]"\n---\n\nbody\n`;
  assert.throws(() => wireInbound(block, "applies_rules", "rule-b"), /not an inline/);
});

test("wireInbound refuses a note with no frontmatter", () => {
  assert.throws(() => wireInbound("# just a body\n", "applies_rules", "rule-b"), /no frontmatter/);
});
