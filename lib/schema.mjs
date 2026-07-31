// schema.mjs — the note-shape schema, shared by the linter and the scaffolders.
//
// Single source of truth for: which filename prefix implies which `type:`, which frontmatter fields
// each type requires, and which frontmatter field a link must sit in for the engine to traverse it.
// `lint.mjs` DETECTS violations of this schema; `scaffold.mjs` GENERATES notes that satisfy it by
// construction. Both import from here so the two can never disagree
// ([[rule-synapse-single-source-of-truth]]).
//
// The role↔field mapping is NOT hardcoded — it is derived from the consumer's
// `_meta/tools/context.manifest.json` `roles` block, so a vault that renames or adds a role keeps
// working. See [[rule-synapse-edges-by-role]] and `_meta/conventions.md` §3.

// filename-prefix → expected `type:` (for Synapse every prefix equals its type — no aliasing).
export const PREFIX_TYPE = {
  hub: "hub", note: "note", journal: "journal", contact: "contact", account: "account",
  summary: "summary", plan: "plan", project: "project", person: "person", decision: "decision",
  rule: "rule", agent: "agent", skill: "skill", tool: "tool", doc: "doc", loop: "loop",
  glossary: "glossary", recipe: "recipe",
};

// per-type required frontmatter fields (id/title/tags required on every type, checked by the linter).
export const REQUIRED = {
  agent: ["purpose", "invokes_skills"],
  loop: ["owner_agent", "goal", "exit_condition"],
  contact: ["generated", "source"],
  account: ["generated", "source"],
  summary: ["generated", "source"],
};

// Required on EVERY typed note, regardless of type.
export const REQUIRED_COMMON = ["id", "title", "tags"];

/** The `type:` a note id implies, from its filename prefix. Null when the prefix is unknown. */
export function typeForId(id) {
  return PREFIX_TYPE[String(id).split("-")[0]] ?? null;
}

/** Every frontmatter field a note of `type` must carry (common + per-type). */
export function requiredFields(type) {
  return [...REQUIRED_COMMON, ...(REQUIRED[type] || [])];
}

/** Valid note types (the values of PREFIX_TYPE, deduped). */
export function knownTypes() {
  return [...new Set(Object.values(PREFIX_TYPE))].sort();
}

/**
 * Read the manifest's `roles` block into lookup helpers.
 *
 *   roles: { CONSTRAINS: { field: "applies_rules", … },
 *            USES:       { field: ["invokes_skills", "uses_tools"], … },
 *            BINDS:      { field: "related", endpointTypes: ["note", …] }, … }
 */
export function rolesFromManifest(manifest) {
  const roles = manifest?.roles || {};

  /** Field name(s) a role writes into, always as an array. */
  const fieldsForRole = (role) => {
    const f = roles[role]?.field;
    return f == null ? [] : Array.isArray(f) ? f : [f];
  };

  /** The role whose `endpointTypes` claims this target type (BINDS / ATTACHES / NAVIGATES / REFERENCES). */
  const roleForTargetType = (targetType) => {
    for (const [name, def] of Object.entries(roles)) {
      if (Array.isArray(def.endpointTypes) && def.endpointTypes.includes(targetType)) return name;
    }
    return null;
  };

  return { roles, fieldsForRole, roleForTargetType };
}

// Agent-only forward edges: an agent declares these explicitly, by TARGET type.
// (`_meta/conventions.md` §3: rules → applies_rules · skills/tools → invokes_skills/uses_tools ·
//  agents → delegates_to.) Any other source type links the same target through `related` instead.
const AGENT_FORWARD_ROLE = { rule: "CONSTRAINS", skill: "USES", tool: "USES", agent: "DELEGATES" };
// Which of USES's two fields a target type belongs in.
const USES_FIELD = { skill: "invokes_skills", tool: "uses_tools" };

/**
 * The frontmatter field a link must sit in, given BOTH endpoints.
 *
 * The source type matters: an `agent` cites a `tool` via `uses_tools` (role USES), while a `note`
 * cites that same tool via `related` (role ATTACHES). Putting it in the wrong field means the engine
 * never traverses the edge — the note renders, but the link is invisible to briefings, and the target
 * shows up as an orphan in `synapse lint`.
 *
 * Returns a field name (e.g. "applies_rules", "related"), defaulting to "related".
 */
export function fieldForLink({ sourceType, targetType, manifest }) {
  const { fieldsForRole, roleForTargetType } = rolesFromManifest(manifest);

  if (sourceType === "agent") {
    const role = AGENT_FORWARD_ROLE[targetType];
    if (role === "USES") {
      const want = USES_FIELD[targetType];
      return fieldsForRole("USES").includes(want) ? want : (fieldsForRole("USES")[0] ?? "related");
    }
    if (role) return fieldsForRole(role)[0] ?? "related";
  }

  // Docs are cited through references_docs from ANY source type.
  if (targetType === "doc") {
    const role = roleForTargetType("doc");
    if (role) return fieldsForRole(role)[0] ?? "related";
  }

  // Everything else resolves by the target's type (BINDS / ATTACHES / NAVIGATES) — all `related`.
  const role = roleForTargetType(targetType);
  return (role && fieldsForRole(role)[0]) || "related";
}
