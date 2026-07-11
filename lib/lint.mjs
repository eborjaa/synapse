#!/usr/bin/env node
// lint.mjs — synapse context-vault linter (manifest-driven, package-agnostic).
//
//   synapse lint [--strict]
//
// The mechanical HEALTH-CHECK half: it DETECTS problems; an agent HEALS them. Severity tiers:
//   ERROR    — always fails: missing type/id/title/tags, prefix↔type mismatch, missing #type tag,
//              a note under a generated-view dir missing `generated: true`, a broken `migration:` path,
//              a git-invisible typed note, inline secrets.
//   WARNING  — fails only under --strict: broken/unresolved [[wikilinks]], unbalanced code fences.
//   ADVISORY — never fails: orphans (no inbound links), oversize notes (>600 tok ≈ split candidate).
//
// A "vault artifact" = any .md with a `type:` frontmatter field. Files without frontmatter are ignored.
// ROOT is the resolved vault root (via resolveVault(); flat or nested); manifest.skipDirs are skipped.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveVault } from "./vault-root.mjs";

const { root: ROOT, manifest: MANIFEST } = resolveVault();
const SKIP = new Set(MANIFEST.skipDirs || []);
const LABEL = MANIFEST.logLabel || "synapse";
const strict = process.argv.includes("--strict");

// filename-prefix → expected `type:` (for Synapse every prefix equals its type — no aliasing).
const PREFIX_TYPE = {
  moc: "moc", note: "note", journal: "journal", contact: "contact", account: "account",
  summary: "summary", plan: "plan", project: "project", person: "person", decision: "decision",
  rule: "rule", agent: "agent", skill: "skill", tool: "tool", doc: "doc", loop: "loop",
  glossary: "glossary", recipe: "recipe",
};
// per-type required frontmatter fields (id/title/tags required on every type, checked below).
const REQUIRED = {
  agent: ["purpose", "invokes_skills"],
  loop: ["owner_agent", "goal", "exit_condition"],
  contact: ["generated", "source"],
  account: ["generated", "source"],
  summary: ["generated", "source"],
};
// notes living under these directories are generated projections (DB → Markdown) and must say so.
const GEN_DIRS = ["/contacts/", "/accounts/", "/finances/", "/health/", "/places/"];

const errors = [], warnings = [], advisories = [];

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

const allFiles = walk(ROOT);
const ids = new Set(allFiles.map((f) => basename(f, ".md")));

const linkRe = /\[\[([^\]#|]+)(?:[#|][^\]]*)?\]\]/g;
const linksOf = (t) => [...t.matchAll(linkRe)].map((m) => m[1].trim())
  .filter((x) => !x.includes("...") && !x.includes("<"));

const parse = (text) => {
  const fmEnd = text.indexOf("\n---", 4);
  const fm = fmEnd > 0 ? text.slice(0, fmEnd) : "";
  const body = fmEnd > 0 ? text.slice(fmEnd + 4) : text;
  const type = (fm.match(/^type:\s*(.+)$/m) || [])[1]?.trim() || null;
  return { fm, body, type };
};

// Vault artifacts = .md with a type: frontmatter field.
const noteFiles = allFiles.filter((f) => parse(readFileSync(f, "utf8")).type);

// ---- git-invisibility (ERROR) ----
// walk() enumerates the FILESYSTEM and never consults git, so a typed note can lint clean on disk
// while being .gitignore'd — invisible to git, uncommittable, and its inbound wikilinks dangle the
// moment a committed note points at it. Tie the linter's view back to git's.
if (noteFiles.length) {
  try {
    const ignored = execFileSync("git", ["check-ignore", "--stdin"],
      { cwd: ROOT, input: noteFiles.join("\n"), encoding: "utf8" });
    for (const p of ignored.split("\n").map((s) => s.trim()).filter(Boolean))
      errors.push(`${basename(p, ".md")}: typed note is git-ignored (${p}) — invisible to git & uncommittable; anchor the offending .gitignore pattern`);
  } catch (e) {
    // `git check-ignore --stdin` exits 1 when NOTHING is ignored — that is the healthy case, not a failure.
    if (e.status !== 1) warnings.push(`lint: could not verify note git-visibility (git check-ignore exit ${e.status ?? "?"}) — is this a git work tree?`);
  }
}

// inbound link tally (over artifacts) for orphan detection
const inbound = new Map();
for (const f of noteFiles) for (const l of linksOf(readFileSync(f, "utf8")))
  inbound.set(l, (inbound.get(l) || 0) + 1);

// ---- broken wikilinks (WARNING) ----
// _meta docs (conventions, recipe) contain illustrative placeholder links — exclude them.
for (const f of noteFiles) {
  if (f.includes("/_meta/")) continue;
  const id = basename(f, ".md");
  for (const l of linksOf(readFileSync(f, "utf8")))
    if (!ids.has(l)) warnings.push(`${id}: unresolved wikilink [[${l}]]`);
}

const secretRe = /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|passwd|secret|token)\s*[:=]\s*["']?[A-Za-z0-9\/+_-]{12,})/i;

for (const f of noteFiles) {
  const text = readFileSync(f, "utf8");
  const id = basename(f, ".md");
  const { fm, body, type } = parse(text);

  // 1. triple-type consistency (prefix → type, and a #type/<type> tag present)
  const prefix = id.split("-")[0];
  if (!type) errors.push(`${id}: missing type:`);
  else {
    if (PREFIX_TYPE[prefix] && PREFIX_TYPE[prefix] !== type)
      errors.push(`${id}: prefix "${prefix}" implies type "${PREFIX_TYPE[prefix]}" but type: is "${type}"`);
    if (!new RegExp(`type/${type}(\\s|$)`, "m").test(fm))
      errors.push(`${id}: missing "#type/${type}" tag`);
  }

  // 2. schema — common header + per-type required fields
  for (const k of ["id", "title"]) if (!new RegExp(`^${k}:`, "m").test(fm))
    errors.push(`${id}: missing required field "${k}"`);
  if (!/^tags:/m.test(fm)) errors.push(`${id}: missing tags`);
  for (const k of (REQUIRED[type] || [])) if (!new RegExp(`^${k}:`, "m").test(fm))
    errors.push(`${id}: ${type} missing required field "${k}"`);

  // 3. relationship sanity
  if (type === "agent" && !/invokes_skills:/.test(fm))
    errors.push(`${id}: agent missing invokes_skills`);

  // 4. generated-projection guard — a note under a generated-view dir must carry `generated: true`
  //    (SQL → Markdown views are never hand-authored; a missing marker is a hand-edit smell).
  if (GEN_DIRS.some((d) => f.includes(d)) && !/^generated:\s*true\s*$/m.test(fm))
    errors.push(`${id}: lives under a generated-view dir but is missing "generated: true" (hand-edit smell)`);

  // 4b. migration path reality — every `migration:` path must exist on disk (relative to package root)
  const migM = fm.match(/^migration:\s*"?([^"\n]+)"?\s*$/m);
  if (migM && !existsSync(join(ROOT, migM[1].trim())))
    errors.push(`${id}: migration path missing on disk: ${migM[1].trim()}`);

  // 5. inline secrets
  if (secretRe.test(body)) errors.push(`${id}: possible inline secret`);

  // 6. orphan (ADVISORY) — no inbound links. Agents are entry points (exempt).
  if (type !== "agent" && !(inbound.get(id) > 0)) advisories.push(`${id}: orphan (no inbound links)`);

  // 7. size (ADVISORY) — ~tokens = chars/4
  const tok = Math.ceil(text.length / 4);
  if (tok > 600) advisories.push(`${id}: ~${tok} tokens (>600 — split candidate)`);
}

// 8. code-fence hygiene (WARNING) — authored vault notes only
for (const f of noteFiles) {
  const id = basename(f, ".md");
  const fences = (readFileSync(f, "utf8").match(/^```/gm) || []).length;
  if (fences % 2 !== 0) warnings.push(`${id}: unbalanced \`\`\` code fences (${fences} — must be even)`);
}

console.log(`[${LABEL} lint] ${noteFiles.length} vault artifacts scanned (of ${allFiles.length} .md under package)`);
const show = (label, arr) => { if (arr.length) { console.log(`\n${label} (${arr.length}):`); for (const x of arr) console.log("  " + x); } };
show("ERRORS", errors);
show("WARNINGS", warnings);
show("ADVISORIES", advisories);
const fail = errors.length > 0 || (strict && warnings.length > 0);
if (!fail) console.log(`\nclean${warnings.length ? " (errors=0; warnings tracked)" : ""}${advisories.length ? `; ${advisories.length} advisory` : ""}`);
process.exitCode = fail ? 1 : 0;
