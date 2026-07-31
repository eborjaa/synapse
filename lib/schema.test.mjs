// schema.test.mjs — the note-shape schema, and the link-field rules the scaffolders depend on.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PREFIX_TYPE, REQUIRED, typeForId, requiredFields, knownTypes,
  rolesFromManifest, fieldForLink,
} from "./schema.mjs";

// Mirrors the shape of _meta/tools/context.manifest.json `roles`.
const manifest = {
  roles: {
    CONSTRAINS: { field: "applies_rules", direction: "forward", mandatoryFull: true },
    USES: { field: ["invokes_skills", "uses_tools"], direction: "forward" },
    DELEGATES: { field: "delegates_to", direction: "forward" },
    REFERENCES: { field: "references_docs", direction: "forward", endpointTypes: ["doc"] },
    BINDS: {
      field: "related", direction: "reverse", reverseName: "members",
      endpointTypes: ["note", "journal", "project", "plan", "contact", "account", "summary"],
    },
    ATTACHES: {
      field: "related", direction: "both",
      endpointTypes: ["person", "decision", "tool", "glossary"],
    },
    NAVIGATES: { field: "related", direction: "both", endpointTypes: ["hub"] },
  },
};

test("typeForId derives type from the filename prefix", () => {
  assert.equal(typeForId("hub-career"), "hub");
  assert.equal(typeForId("rule-agent-memory-vs-vault"), "rule");
  assert.equal(typeForId("note-buzz-bot-runtime-gotchas-2026-07"), "note");
  assert.equal(typeForId("nonsense-thing"), null);
});

test("requiredFields merges common + per-type", () => {
  assert.deepEqual(requiredFields("note"), ["id", "title", "tags"]);
  assert.deepEqual(requiredFields("agent"), ["id", "title", "tags", "purpose", "invokes_skills"]);
  // every per-type entry stays reachable
  for (const t of Object.keys(REQUIRED)) {
    for (const f of REQUIRED[t]) assert.ok(requiredFields(t).includes(f), `${t} missing ${f}`);
  }
});

test("knownTypes covers every PREFIX_TYPE value", () => {
  const types = knownTypes();
  for (const v of Object.values(PREFIX_TYPE)) assert.ok(types.includes(v));
});

test("rolesFromManifest normalizes single and multi-field roles", () => {
  const { fieldsForRole, roleForTargetType } = rolesFromManifest(manifest);
  assert.deepEqual(fieldsForRole("CONSTRAINS"), ["applies_rules"]);
  assert.deepEqual(fieldsForRole("USES"), ["invokes_skills", "uses_tools"]);
  assert.deepEqual(fieldsForRole("NOPE"), []);
  assert.equal(roleForTargetType("hub"), "NAVIGATES");
  assert.equal(roleForTargetType("doc"), "REFERENCES");
});

test("fieldForLink: an agent declares forward edges by target type", () => {
  const f = (targetType) => fieldForLink({ sourceType: "agent", targetType, manifest });
  assert.equal(f("rule"), "applies_rules");
  assert.equal(f("skill"), "invokes_skills");
  assert.equal(f("tool"), "uses_tools");
  assert.equal(f("agent"), "delegates_to");
});

test("fieldForLink: the SAME target resolves differently by source type", () => {
  // The distinction conventions §3 draws in prose: an agent USES a tool; a note ATTACHES one.
  assert.equal(fieldForLink({ sourceType: "agent", targetType: "tool", manifest }), "uses_tools");
  assert.equal(fieldForLink({ sourceType: "note", targetType: "tool", manifest }), "related");
});

test("fieldForLink: docs are cited via references_docs from any source", () => {
  assert.equal(fieldForLink({ sourceType: "note", targetType: "doc", manifest }), "references_docs");
  assert.equal(fieldForLink({ sourceType: "hub", targetType: "doc", manifest }), "references_docs");
});

test("fieldForLink: hubs/notes fall through to related", () => {
  assert.equal(fieldForLink({ sourceType: "note", targetType: "hub", manifest }), "related");
  assert.equal(fieldForLink({ sourceType: "hub", targetType: "note", manifest }), "related");
  assert.equal(fieldForLink({ sourceType: "note", targetType: "person", manifest }), "related");
  // unknown target types still produce a legal field rather than undefined
  assert.equal(fieldForLink({ sourceType: "note", targetType: "mystery", manifest }), "related");
});
