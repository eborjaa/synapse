// vault-for-cwd.mjs — which registered vault does this working directory belong to?
//
// The question a harness asks when it has a session's folder and needs the vault behind it. It exists
// because DSH has no per-folder config layer: Claude Code, Cursor and opencode each read a file that
// Synapse writes INSIDE the vault, so "which vault" is answered by which folder you opened. DSH resolves
// skills per session from `session.header.cwd` but registers MCP tools once per process, so something
// has to close that gap, and this is the half that decides.
//
// THE REGISTRY IS THE AUTHORITY, NOT THE FILESYSTEM. A directory that merely looks like a vault is not
// one: answering from an unregistered manifest would let any checkout, backup or someone else's clone
// become a live vault by being stood in. That is the "silently redirected the wrong vault" failure that
// motivated dropping the global vault pin ([[decision-0012-no-global-vault-pin]]), and it is worse here
// because a harness would then read it with the caller's full tool surface.
//
// Which is why an unregistered vault is a DISTINCT answer rather than a null: the caller can say
// "you are standing in a vault; run `synapse vaults add` to use it" instead of "no vault here", which
// is the difference between a fixable message and a mystery.

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { readRegistry } from "./vaults.mjs";

/** Resolve symlinks so two spellings of one directory are one key. Falls back for paths that are gone. */
export function canonical(path) {
  try { return realpathSync(resolve(path)); }
  catch { return resolve(path); }
}

const looksLikeVault = (dir) => existsSync(join(dir, "_meta", "tools", "context.manifest.json"));

/**
 * Walk up from `cwd` and return the first registered vault that contains it.
 *
 * @returns one of:
 *   `{ found: true,  vault }`                    — a registered vault, its entry from the registry
 *   `{ found: false, reason: "unregistered", root }` — a real vault, not in the registry (fixable)
 *   `{ found: false, reason: "outside" }`        — not inside any vault at all
 *
 * Deepest match wins, so a vault nested inside another resolves to the inner one — the same "nearest
 * ancestor" rule every project-root walk uses, and the only one that does not surprise.
 */
export function vaultForCwd(cwd, { reg = null } = {}) {
  if (typeof cwd !== "string" || !cwd.trim()) return { found: false, reason: "outside" };
  const registry = reg || readRegistry();

  // Canonicalize BOTH sides. A registry recorded through a symlink (/tmp -> /private/tmp on macOS is
  // the everyday case) would otherwise never match a session's realpath'd cwd, and the vault would be
  // invisible for a reason no one can see.
  const byRoot = new Map();
  for (const v of registry.vaults || []) byRoot.set(canonical(v.root), v);

  let dir = resolve(cwd);
  let unregistered = null;
  for (;;) {
    // Canonicalize at EVERY level, not once at the start. `realpath` fails on a path that does not
    // exist yet, so a session whose cwd names a directory that has since been removed — or one below a
    // symlinked ancestor — would otherwise walk up through uncanonical parents and match nothing,
    // making the vault invisible for a reason no one can see from the outside.
    const key = canonical(dir);
    const hit = byRoot.get(key);
    if (hit) return { found: true, vault: hit };
    // Remember the nearest thing that IS a vault, so the refusal can name it. Do not return yet: a
    // registered ancestor further up is still the better answer.
    if (unregistered === null && looksLikeVault(key)) unregistered = key;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return unregistered
    ? { found: false, reason: "unregistered", root: unregistered }
    : { found: false, reason: "outside" };
}

/** A message that tells the human what to do, not merely that something failed. */
export function explainNoVault(result, cwd) {
  if (result.reason === "unregistered") {
    return `${cwd} is inside a Synapse vault (${result.root}) that is not registered on this machine. `
      + `Run: synapse vaults add ${result.root}`;
  }
  return `${cwd} is not inside any Synapse vault. Open a vault directory, or register one with `
    + `synapse vaults add <path>.`;
}
