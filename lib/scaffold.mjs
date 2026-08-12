// scaffold.mjs — generate correctly-wired vault notes.
//
// The counterpart to lint.mjs: the linter DETECTS schema violations, this GENERATES notes that
// cannot commit them. Both read the same lib/schema.mjs, so a rule added there is enforced and
// satisfied in one place ([[rule-synapse-single-source-of-truth]]).
//
// `build()` is PURE — it returns { id, path, content } and never touches the filesystem, so the CLI
// can dry-run it and the MCP tools can propose without writing ([[rule-synapse-human-gated-push]]).
//
// Why this exists: link placement is subtle. A link only reaches a briefing if it sits in the field
// whose role the manifest traverses to that target's type — a rule cited from `related` instead of
// `applies_rules` renders fine, lints as an orphan, and is invisible to the agent it governs.

import { readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { typeForId, requiredFields, knownTypes, fieldForLink } from "./schema.mjs";

/** Where a note of each type lives, relative to the vault. */
export const DIR_FOR_TYPE = {
  hub: "hub", agent: "agents", note: "notes", rule: "rules", tool: "tools",
  doc: "docs", plan: "plans", project: "projects", decision: "decisions",
  skill: "skills", loop: "loops", person: "people", glossary: "glossary",
  recipe: "recipes", journal: "journal",
};

/** Types `synapse new note` accepts (records are generated from SQL, never scaffolded). */
export const AUTHORABLE_TYPES = knownTypes().filter(
  (t) => !["contact", "account", "summary", "hub", "agent", "journal"].includes(t),
);

export const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const titleize = (s) => {
  const t = String(s).replace(/-/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Every note basename already in the vault — ids must be globally unique (conventions §1). */
export function existingIds(root, skipDirs = []) {
  const skip = new Set(["node_modules", ".git", ...skipDirs]);
  const out = new Set();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.add(basename(e.name, ".md"));
    }
  };
  walk(root);
  return out;
}

const yamlList = (items) => `[${items.map((v) => `"${v}"`).join(", ")}]`;
const wikiList = (ids) => yamlList(ids.map((i) => `[[${i}]]`));

/**
 * Group link ids by the frontmatter field they belong in, per the manifest roles map.
 * Unknown/unresolvable targets fall back to `related`, which is always legal.
 */
function groupLinks(ids, sourceType, manifest, idType) {
  const byField = new Map();
  for (const id of ids) {
    const targetType = idType?.(id) ?? typeForId(id);
    const field = fieldForLink({ sourceType, targetType, manifest });
    if (!byField.has(field)) byField.set(field, []);
    byField.get(field).push(id);
  }
  return byField;
}

/**
 * Build a note.
 *
 *   build({ kind: "hub",   slug: "climbing", parent: "hub-synapse", manifest })
 *   build({ kind: "agent", slug: "scribe",   purpose: "…", links: ["rule-canary"], manifest })
 *   build({ kind: "agent", slug: "scribe",   addressable: true, manifest })   // runnable by Cortex
 *   build({ kind: "note",  slug: "x", type: "rule", hub: "hub-projects", manifest })
 *   build({ kind: "handover", slug: "continue-gate-6", plan: "plan-x", manifest })
 *
 * Returns { id, type, path, content } — path is vault-relative.
 */
export function build({
  kind, slug, type, title, tags = [], links = [], hub, parent, purpose, plan, body,
  addressable = false,
  manifest = {}, date = new Date().toISOString().slice(0, 10),
} = {}) {
  const s = slugify(slug || "");
  if (!s) throw new Error("a name is required (kebab-case)");

  if (kind === "handover") {
    const id = `${date}-${s}`;
    const body = handoverBody({ id, plan, links });
    return { id, type: "handover", path: join("inbox", "handovers", `${id}.md`), content: body };
  }

  const noteType = kind === "hub" ? "hub" : kind === "agent" ? "agent" : (type || "note");
  if (!knownTypes().includes(noteType)) {
    throw new Error(`unknown type "${noteType}" — one of: ${AUTHORABLE_TYPES.join(", ")}`);
  }
  // The prefix must imply the type, or lint errors immediately (conventions §1).
  const id = s.startsWith(`${noteType}-`) ? s : `${noteType}-${s}`;
  const dir = DIR_FOR_TYPE[noteType] || "notes";
  const heading = title || titleize(id.replace(new RegExp(`^${noteType}-`), ""));

  const allLinks = [...links];
  if (hub) allLinks.push(hub);
  if (parent) allLinks.push(parent);

  const byField = groupLinks(allLinks, noteType, manifest);
  const tagList = [`type/${noteType}`, ...tags, "status/active"];

  const fm = [`id: ${id}`, `type: ${noteType}`, `title: ${heading}`];
  // `addressable: true` is what makes an agent RUNNABLE — Cortex derives its roster by scanning
  // agents/ for this flag (cortex lib/config.sh: "STANDING — DERIVED from the vault's `addressable:
  // true` roster"). Without it the note is a well-formed agent that no operator will ever start, and
  // nothing warns you: lint passes, render works, and `cortex start` simply never mentions it.
  if (noteType === "agent" && addressable) fm.push("addressable: true");
  fm.push("tags:");
  for (const t of [...new Set(tagList)]) fm.push(`  - ${t}`);

  // Per-type required fields, straight from the schema — never a hand-maintained list.
  const req = requiredFields(noteType);
  if (req.includes("purpose")) fm.push(`purpose: ${purpose || "TODO — one sentence: what this agent is for"}`);
  if (req.includes("invokes_skills")) {
    const skills = (byField.get("invokes_skills") || []);
    fm.push(`invokes_skills: ${skills.length ? wikiList(skills) : "[]"}`);
    byField.delete("invokes_skills");
  }
  for (const [field, ids] of byField) fm.push(`${field}: ${wikiList(ids)}`);
  // Any remaining required field we did not fill gets an explicit TODO rather than silent omission.
  for (const k of req) {
    if (["id", "title", "tags", "purpose", "invokes_skills"].includes(k)) continue;
    if (!fm.some((l) => l.startsWith(`${k}:`))) fm.push(`${k}: TODO`);
  }

  const bodyText = body != null && String(body).trim()
    ? customBody(String(body), { hub, parent })
    : bodyFor(noteType, { id, hub, parent, purpose });
  const content = `---\n${fm.join("\n")}\n---\n\n# ${heading}\n\n${bodyText}`;
  return { id, type: noteType, path: join(dir, `${id}.md`), content };
}

/**
 * Add `[[id]]` to a frontmatter list field of an EXISTING note, idempotently.
 *
 * This is what actually prevents orphans. A rule/tool/skill is only reachable once an agent cites it
 * in applies_rules/uses_tools/invokes_skills — and that edge lives in the AGENT's file. Creating the
 * new note alone leaves it valid but invisible; `synapse lint` calls that an orphan.
 *
 * Returns { content, changed }. Never reorders or reformats anything else.
 */
export function wireInbound(content, field, id) {
  const link = `[[${id}]]`;
  const end = content.indexOf("\n---", 4);
  if (!content.startsWith("---") || end < 0) throw new Error("note has no frontmatter block");
  const fm = content.slice(0, end);
  const rest = content.slice(end);

  const inline = new RegExp(`^(${field}:\\s*)\\[(.*)\\]\\s*$`, "m");
  const m = fm.match(inline);
  if (m) {
    if (m[2].includes(link)) return { content, changed: false }; // already wired
    const inner = m[2].trim();
    const next = `${m[1]}[${inner ? `${inner}, ` : ""}"${link}"]`;
    return { content: fm.replace(inline, next) + rest, changed: true };
  }
  if (new RegExp(`^${field}:`, "m").test(fm)) {
    // Present but not an inline array (e.g. a block list) — refuse rather than corrupt it.
    throw new Error(`"${field}" is not an inline [..] list; add ${link} by hand`);
  }
  return { content: `${fm}\n${field}: ["${link}"]${rest}`, changed: true };
}

/**
 * Caller-supplied body. Preserves the author's Markdown verbatim, but still appends the
 * `## Related` wiring for hub/parent so a hand-written note is no less linked than a scaffolded
 * one — skipped when the author already wrote their own `## Related` section.
 */
function customBody(body, { hub, parent }) {
  const trimmed = body.trim();
  if (/^##\s+Related\b/m.test(trimmed)) return `${trimmed}\n`;
  const rels = [hub, parent].filter(Boolean);
  const relBlock = rels.length ? `\n\n## Related\n${rels.map((i) => `[[${i}]]`).join(" · ")}\n` : "\n";
  return `${trimmed}${relBlock}`;
}

function bodyFor(type, { hub, parent, purpose }) {
  const rel = (ids) => {
    const list = ids.filter(Boolean);
    return list.length ? `\n## Related\n${list.map((i) => `[[${i}]]`).join(" · ")}\n` : "";
  };
  switch (type) {
    case "hub":
      return `One-line scope: what belongs in this domain and what does not.\n\n`
        + `## What lives here\n-\n\n## How to work this domain\n-\n\n`
        + `## Members\nNotes that link here in \`related\` roll up automatically — do not hand-list them.\n`
        + rel([parent]);
    case "agent":
      return `${purpose || "TODO — what this agent is for"}\n\n`
        + `## What you do\n-\n\n## Boundaries — fail loudly\n- Never guess; escalate instead.\n`
        + `\n## Related\n`;
    case "rule":
      return `**Rule:** TODO — state it in one sentence, imperative.\n\n`
        + `## Why\n-\n\n## Consequences\n-\n` + rel([hub]);
    case "tool":
      return `## What it is\n-\n\n## How it is used in Synapse\n-\n` + rel([hub]);
    case "doc":
      return `## Purpose\n-\n\n## Detail\n-\n` + rel([hub]);
    case "plan":
      return `## Goal\n-\n\n## Steps\n1.\n\n## Verification\n-\n` + rel([hub]);
    case "project":
      return `## Status\n-\n\n## Scope\n-\n\n## Next\n- [ ]\n` + rel([hub]);
    case "decision":
      return `## Context\n-\n\n## Decision\n-\n\n## Consequences\n-\n` + rel([hub]);
    default:
      return `-\n` + rel([hub]);
  }
}

function handoverBody({ id, plan, links }) {
  const refs = [plan, ...links].filter(Boolean);
  return `# ${id.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " ")}\n\n`
    + (plan ? `**Full plan (inherit first):** [[${plan}]]\n\n` : "")
    + `## Goal\n-\n\n## What was done\n-\n\n## What's left (do in order)\n1.\n\n`
    + `## Open escalations\nNone.\n\n`
    + (refs.length ? `## Related\n${refs.map((r) => `[[${r}]]`).join(" · ")}\n` : "");
}
