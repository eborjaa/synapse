// vault-root.mjs — resolve the CONSUMER vault root from wherever synapse is installed.
//
// synapse ships as an npm package (@eborja/synapse). Its tools therefore live in
// node_modules/@eborja/synapse/, NOT inside the consumer's vault — so the legacy "N-up from
// __dirname" strategy is wrong here. Instead we locate the consumer's vault by finding the
// nearest ancestor of the working directory that carries a context.manifest.json, and we
// auto-detect whether the vault uses the NESTED layout (context-vault/_meta/tools/) or the
// FLAT layout (_meta/tools/ at the repo root).
//
// Resolution order (first hit wins):
//   1. $SYNAPSE_VAULT  — explicit override (the vault root, the context-vault dir, or the dir
//      containing the manifest; all normalize to the vault root).
//   2. ancestor walk from process.cwd() upward: first dir D with
//        D/context-vault/_meta/tools/context.manifest.json  (nested)  OR
//        D/_meta/tools/context.manifest.json                (flat).
//   3. fail loudly (throws) — never silently guess a root.

import { existsSync, statSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MANIFEST = "context.manifest.json";

// Given a candidate dir, return a hit descriptor if it holds a manifest under either layout, else null.
function probe(dir) {
  const nested = join(dir, "context-vault", "_meta", "tools", MANIFEST);
  if (existsSync(nested)) {
    return {
      root: dir, layout: "nested", manifestPath: nested,
      toolsDir: dirname(nested), metaDir: join(dir, "context-vault", "_meta"),
      vaultDir: join(dir, "context-vault"),
    };
  }
  const flat = join(dir, "_meta", "tools", MANIFEST);
  if (existsSync(flat)) {
    return {
      root: dir, layout: "flat", manifestPath: flat,
      toolsDir: dirname(flat), metaDir: join(dir, "_meta"),
      vaultDir: dir,
    };
  }
  return null;
}

function resolveOverride(p) {
  const abs = resolve(p);
  if (!existsSync(abs)) throw new Error(`$SYNAPSE_VAULT points at a path that does not exist: ${abs}`);
  const asDir = statSync(abs).isDirectory() ? abs : dirname(abs);
  for (const cand of [asDir, dirname(asDir), dirname(dirname(asDir))]) {
    const hit = probe(cand);
    if (hit) return hit;
  }
  throw new Error(
    `$SYNAPSE_VAULT is set to ${abs} but no ${MANIFEST} was found under it ` +
    `(looked for context-vault/_meta/tools/${MANIFEST} or _meta/tools/${MANIFEST}).`,
  );
}

function walkUp(start) {
  let dir = resolve(start);
  for (;;) {
    const hit = probe(dir);
    if (hit) return hit;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Resolve the consumer vault. Returns:
//   { root, vaultDir, metaDir, toolsDir, manifestPath, layout, manifest? }
// root     = package/repo root (spans content + _meta) — the walk anchor for the note index.
// vaultDir = where note content lives (root/context-vault for nested; root for flat).
//
// preferCwd: when true, walk from cwd first and only fall back to $SYNAPSE_VAULT if cwd is
// not inside a vault. Used by `synapse install` so a stale rc override cannot re-pin the
// wrong vault when you intentionally run install from another vault.
export function resolveVault({ cwd = process.cwd(), readManifest = true, preferCwd = false } = {}) {
  let hit = null;
  if (preferCwd) {
    hit = walkUp(cwd) || (process.env.SYNAPSE_VAULT ? resolveOverride(process.env.SYNAPSE_VAULT) : null);
  } else {
    hit = process.env.SYNAPSE_VAULT ? resolveOverride(process.env.SYNAPSE_VAULT) : walkUp(cwd);
  }
  if (!hit) {
    throw new Error(
      `synapse: could not locate a vault. Run inside a vault (a dir whose ` +
      `context-vault/_meta/tools/${MANIFEST} or _meta/tools/${MANIFEST} exists), ` +
      `or set $SYNAPSE_VAULT to the vault root.`,
    );
  }
  if (readManifest) hit.manifest = JSON.parse(readFileSync(hit.manifestPath, "utf8"));
  return hit;
}
