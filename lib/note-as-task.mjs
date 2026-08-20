#!/usr/bin/env node
// note-as-task.mjs — turn a NOTE into a task string. The "boot an agent FROM a handover" primitive.
//
//   synapse handover-task <ref>            # a handover: strip frontmatter + prepend the successor protocol
//   synapse handover-task <ref> --plain    # any note as a task, no protocol prepend (like --prompt-file)
//
// A handover note IS the task — "read this, confirm the locked decisions, resume from Next actions".
// The engine already renders + augments a task; the only thing missing from synapse (vs the REL
// launcher's `--handover`) was a user-friendly way to say "use THIS note as the task". This is it,
// kept as a tiny pure lib so the CLI flag, the launcher flag, and the MCP tool all share one behavior.
//
// Resolution mirrors the REL launcher: try the ref as a path (as-is / cwd-relative / vault-relative)
// FIRST — so a note anywhere, including a skipDir like journal/ or inbox/, resolves — then, for a
// handover, fall back to a fuzzy slug match inside inbox/handovers/.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVault } from "./vault-root.mjs";

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

/** {status: "unique"|"none"|"ambiguous", path?, matches?} — never throws. */
export function resolveNoteRef(ref, { vaultDir, handover = true, cwd = process.cwd() } = {}) {
  const handoverDir = join(vaultDir, "inbox", "handovers");
  const direct = [
    ref,
    isAbsolute(ref) ? null : join(cwd, ref),
    isAbsolute(ref) ? null : join(vaultDir, ref),
  ];
  if (handover) direct.push(join(handoverDir, ref), join(handoverDir, `${ref}.md`));
  for (const p of direct) {
    if (p && existsSync(p) && !isDir(p)) return { status: "unique", path: p };
  }
  if (!handover || !existsSync(handoverDir)) return { status: "none" };

  // fuzzy: a slug matched against inbox/handovers/*.md (the REL convention).
  const needle = ref.toLowerCase().replace(/\.md$/, "");
  const hits = readdirSync(handoverDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md" && f.toLowerCase().includes(needle))
    .sort();
  if (hits.length === 1) return { status: "unique", path: join(handoverDir, hits[0]) };
  if (hits.length > 1) return { status: "ambiguous", matches: hits };
  return { status: "none" };
}

function isDir(p) { try { return readdirSync(p) && true; } catch { return false; } }

const SUCCESSOR_PROTOCOL = (rel) =>
  `Continue from the handover note \`${rel}\`. Read it FIRST, confirm the locked decisions, and resume `
  + `from "Next actions" — do NOT re-litigate settled choices. Reconcile every deliverable against the `
  + `current vault before executing (the vault wins if it disagrees with this note).`;

/**
 * The note's body as a task. Frontmatter is stripped (it is id/tags/owner metadata — no task signal, and
 * it would eat into augment's recall-query budget). For a handover the successor protocol is prepended.
 */
export function taskFromNote(path, { vaultDir, handover = true } = {}) {
  const raw = readFileSync(path, "utf8");
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  if (!handover) return body;
  const rel = vaultDir && path.startsWith(vaultDir) ? relative(vaultDir, path) : path;
  return `${SUCCESSOR_PROTOCOL(rel)}\n\n${body}`;
}

/** One call: ref → { ok, task } | { ok:false, reason }. */
export function noteAsTask(ref, opts = {}) {
  const r = resolveNoteRef(ref, opts);
  if (r.status === "ambiguous") return { ok: false, reason: `ambiguous: ${r.matches.join(", ")}` };
  if (r.status !== "unique") return { ok: false, reason: `not found: ${ref}` };
  return { ok: true, path: r.path, task: taskFromNote(r.path, opts) };
}

// ===================================================================== CLI
if (IS_MAIN) {
  const args = process.argv.slice(2);
  const plain = args.includes("--plain");
  const ref = args.find((a) => !a.startsWith("--"));
  if (!ref) {
    console.error("usage: synapse handover-task <ref> [--plain]");
    process.exit(2);
  }
  const { vaultDir } = resolveVault();
  const r = noteAsTask(ref, { vaultDir, handover: !plain });
  if (!r.ok) { console.error(`[handover-task] ${r.reason}`); process.exit(1); }
  process.stdout.write(r.task);   // stdout = the task ONLY, so `$( … )` captures it cleanly
  process.exit(0);
}
