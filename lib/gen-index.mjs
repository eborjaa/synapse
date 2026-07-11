#!/usr/bin/env node
// gen-index.mjs — rebuild the Markdown → SQL projections (the .md index + plans table).
//
//   node _meta/tools/gen-index.mjs
//
// Markdown is canonical for knowledge; `notes`, `note_links`, `plans` are a GENERATED cache of the vault
// ([[rule-derived-views-are-generated]]). This is a full idempotent rebuild: in one transaction it clears
// the three tables and repopulates them by walking every .md with a `type:` frontmatter field under ROOT
// (skipping manifest.skipDirs + dotdirs, exactly like render.mjs/lint.mjs). Opens db/synapse.db read-write —
// but only touches the three generated projection tables, never canonical record rows.
//
// ROOT = the vault root (2 up from _meta/tools/). Determinism: same vault → same rows.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveVault } from "./vault-root.mjs";

const { vaultDir: ROOT, manifest: MANIFEST } = resolveVault();
const DB_PATH = join(ROOT, "db", "synapse.db");
const SKIP = new Set(MANIFEST.skipDirs || []);

if (!existsSync(DB_PATH)) {
  console.error(`[gen-index] db not found at ${DB_PATH} — run apply-migrations.mjs first.`);
  process.exit(1);
}

// ---- walk (mirror render.mjs/lint.mjs: skip dotdirs + manifest.skipDirs) ----
function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// Every field referenced by any role (wikilink extraction is scoped to these — same as render.mjs).
const ROLE_FIELDS = new Set();
for (const r of Object.values(MANIFEST.roles)) for (const f of r.fields) ROLE_FIELDS.add(f);

const wikiRe = /\[\[([^\]]+)\]\]/g;
// Extract [[basename]] tokens from one frontmatter field's value only (mirrors render.mjs linksInField).
function linksInField(fm, field) {
  const re = new RegExp(`^${field}:[ \\t]*(.*)$`, "m");
  const m = fm.match(re);
  if (!m) return [];
  let val = m[1];
  if (val.includes("[") && !val.includes("]")) {
    const after = fm.slice(fm.indexOf(m[0]) + m[0].length);
    for (const line of after.split("\n")) {
      val += "\n" + line;
      if (line.includes("]")) break;
    }
  }
  const out = [];
  let w;
  while ((w = wikiRe.exec(val)) !== null) {
    const tok = w[1].split("|")[0].split("#")[0].trim();
    if (!tok || tok.includes("...") || tok.includes("<")) continue;
    out.push(tok);
  }
  return out;
}

// raw → frontmatter/body split (kept like render.mjs/lint.mjs).
function parse(raw) {
  const end = raw.indexOf("\n---", 4);
  const fm = end > 0 ? raw.slice(0, end) : "";
  const body = (end > 0 ? raw.slice(end + 4) : raw).trim();
  const type = (fm.match(/^type:\s*(.+)$/m) || [])[1]?.trim() || null;
  const title = (fm.match(/^title:\s*(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, "") || null;
  // tags: every `area/x | type/x | status/x | …` token (block- or flow-style), like render.mjs.
  const tags = [...fm.matchAll(/-?\s*([a-z][a-z0-9]*\/[a-z0-9.\-]+)/g)].map((m) => m[1]);
  const generated = /^generated:\s*true\b/m.test(fm) ? 1 : 0;
  const fields = {};
  for (const f of ROLE_FIELDS) fields[f] = linksInField(fm, f);
  // plan-only scalar fields
  const scalar = (k) => {
    const m = fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") || null : null;
  };
  return { type, title, tags, generated, fields, scalar, fm, body };
}

// ---- build index of every typed note (basename → record) ----
const index = new Map();
for (const f of walk(ROOT)) {
  const rec = parse(readFileSync(f, "utf8"));
  if (!rec.type) continue; // a vault artifact = a .md with a type: field
  const id = basename(f, ".md");
  rec.id = id;
  rec.path = relative(ROOT, f);
  rec.chars = readFileSync(f, "utf8").length;
  rec.mtime = statSync(f).mtime.toISOString();
  // status from a status/<x> tag
  const st = rec.tags.find((t) => t.startsWith("status/"));
  rec.status = st ? st.slice("status/".length) : null;
  // tags column = only the type/… , area/… , status/… tags, as a JSON array
  rec.indexTags = rec.tags.filter((t) => /^(type|area|status)\//.test(t));
  index.set(id, rec);
}

// ---- role resolution (mirror render.mjs: a link reaches the role whose fields include `field`
//      and whose endpointTypes is absent OR includes the dst note's type:). Fall back to the first
//      role using that field when dst is unknown. ----
const ROLE_ENTRIES = Object.entries(MANIFEST.roles); // [name, {fields, endpointTypes?, …}]
function resolveRole(field, dstType) {
  const usingField = ROLE_ENTRIES.filter(([, r]) => r.fields.includes(field));
  if (!usingField.length) return null;
  // dst exists & has a type → role whose endpointTypes is absent OR includes that type
  if (dstType) {
    const hit = usingField.find(([, r]) => !r.endpointTypes || r.endpointTypes.includes(dstType));
    if (hit) return hit[0];
  }
  // dst unknown (broken link) → first role using that field
  return usingField[0][0];
}

// ---- open DB read-write & rebuild in one transaction ----
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON;");

let noteCount = 0, linkCount = 0, planCount = 0;
try {
  db.exec("BEGIN");
  db.exec("DELETE FROM notes; DELETE FROM note_links; DELETE FROM plans;");

  const insNote = db.prepare(
    `INSERT INTO notes (id, type, title, path, status, tags, tokens, generated, mtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insLink = db.prepare(
    `INSERT INTO note_links (src, dst, field, role) VALUES (?, ?, ?, ?)`
  );
  const insPlan = db.prepare(
    `INSERT INTO plans (slug, title, status, priority, due_on, project_slug, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       title=excluded.title, status=excluded.status, priority=excluded.priority,
       due_on=excluded.due_on, project_slug=excluded.project_slug, updated_at=excluded.updated_at`
  );

  for (const rec of index.values()) {
    insNote.run(
      rec.id,
      rec.type,
      rec.title,
      rec.path,
      rec.status,
      JSON.stringify(rec.indexTags),
      Math.ceil(rec.chars / 4),
      rec.generated,
      rec.mtime
    );
    noteCount++;

    // links: one row per frontmatter wikilink in any role field
    for (const field of ROLE_FIELDS) {
      for (const dst of rec.fields[field] || []) {
        const dstType = index.get(dst)?.type || null;
        const role = resolveRole(field, dstType);
        if (!role) continue;
        insLink.run(rec.id, dst, field, role);
        linkCount++;
      }
    }

    // plans: one upsert per type:plan note. `project:` is not a role field, so read it directly:
    // accept a [[wikilink]] or a plain slug.
    if (rec.type === "plan") {
      const projLink = linksInField(rec.fm, "project")[0]; // [[…]] form, if any
      const projScalar = rec.scalar("project");            // plain string form
      const projectSlug = projLink || (projScalar && projScalar.replace(/^\[\[|\]\]$/g, "")) || null;
      insPlan.run(
        rec.id,
        rec.title || rec.id,
        rec.status,
        rec.scalar("priority"),
        rec.scalar("due"),
        projectSlug,
        rec.scalar("updated")
      );
      planCount++;
    }
  }

  db.exec("COMMIT");
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  console.error(`[gen-index] FAILED — rolled back. ${e.message}`);
  process.exit(1);
}

console.log(`[gen-index] rebuilt: ${noteCount} notes, ${linkCount} note_links, ${planCount} plans`);
