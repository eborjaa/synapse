// note-walk.mjs — the ONE corpus walker every note-scanning tool shares.
//
// Freshness (index-freshness.mjs) compares the corpus against what gen-embeddings.mjs indexed. If the
// two walked DIFFERENT file sets the comparison is meaningless — a file only one of them sees is either
// permanently "stale" (a rebuild that never clears it) or silently unindexed. So both import from here.
//
// HARD_SKIP is not consumer-configurable on purpose: `node_modules` and `db` are never part of a vault's
// authored corpus, and a vendored package that ships its own typed notes (this package ships an example
// vault) would otherwise be embedded into every consumer's index and surface as recall hits.
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directories never walked, regardless of manifest config. Dotdirs are skipped separately. */
export const HARD_SKIP = ["node_modules", "db"];

/** HARD_SKIP + the consumer's manifest.skipDirs. */
export function noteSkipSet(manifest) {
  return new Set([...HARD_SKIP, ...(manifest?.skipDirs || [])]);
}

/**
 * Every `.md` under `root`, skipping dotdirs and `skip`. Deterministic order (readdir is sorted so a
 * caller diffing two runs sees a stable list). Unreadable directories are skipped, never thrown.
 */
export function walkNoteFiles(root, skip = new Set()) {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch { return; }                                  // permission/TOCTOU — skip, never fail a scan
    for (const e of entries) {
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * Newest mtime (ms) across `files`, and its path. A file that vanished between the walk and the stat is
 * ignored rather than throwing — the caller is measuring freshness, not auditing the filesystem.
 */
export function maxMtime(files) {
  let ms = 0, path = null;
  for (const f of files) {
    let m;
    try { m = statSync(f).mtimeMs; } catch { continue; }
    if (m > ms) { ms = m; path = f; }
  }
  return { ms, path };
}
