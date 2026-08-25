#!/usr/bin/env node
// vaults.mjs — the vault REGISTRY: the list of vaults on this machine, and one command to rewire them.
//
//   synapse vaults                    # list what is registered, and whether each is currently wired
//   synapse vaults add [<path>]       # register a vault (default: the one you are standing in)
//   synapse vaults remove <id|path>   # forget one (never touches the vault itself)
//   synapse vaults sync               # dry-run: what rewiring every registered vault would change
//   synapse vaults sync --write       # do it
//   synapse vaults roster [--write]   # regenerate every registered vault's roster under $SYNAPSE_HOME
//   synapse vaults workspace <id…>    # the skill dirs a workspace should see, ready to paste
//   synapse vaults token <id> [--label L]  # mint a bearer credential binding ONE vault
//   synapse vaults tokens [--revoke L]     # list / revoke credentials
//
// WHY THIS EXISTS. Before this, "upgrade the engine" meant walking to each vault in turn and running
// `synapse mcp-config --write` there, remembering which ones exist. With four vaults that is four
// chances to forget one, and a forgotten vault is not obviously broken — it just keeps pointing at an
// older `synapse-mcp` until something behaves strangely. The registry turns "which vaults do I have"
// from something living in a person's head into a file, and `sync` turns N walks into one command.
//
// WHY NOT AUTO-DISCOVER BY SCANNING THE DISK. Two reasons, both learned from the surrounding code.
// A filesystem walk broad enough to find every vault is also broad enough to find archived copies,
// backups and someone else's checkout, and rewiring one of those is exactly the "silently redirected the
// wrong vault" failure that motivated dropping the global vault pin. And a scan has no way to express
// intent: a vault you deliberately keep unwired is indistinguishable from one you forgot. Registration
// is one explicit act; ambiguity is not worth the keystroke it saves.
//
// WHAT THIS FILE MAY AND MAY NOT WRITE. The registry itself lives OUTSIDE every repo, under
// $SYNAPSE_HOME (default ~/.synapse), because it describes the machine rather than any one vault and
// must never be committed. `sync` writes only generated client config, and only into vaults that are
// registered — an unregistered vault is never touched. Nothing here writes a vault's notes or its DB.
//
// This module is BOTH a CLI (isMain-guarded at the bottom) and a library, the same shape as
// lib/mcp-config.mjs — so `synapse install` and the tests can import the planner without spawning.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { resolveVault } from "./vault-root.mjs";
import { buildMcpTargets, applyMcpTargets, MCP_SURFACES } from "./mcp-config.mjs";
import { rosterAdapters } from "./ports/index.mjs";
import { mintToken, revokeToken, readTokens, writeTokens, tokensPath } from "./ports/vault-tokens.mjs";

/** Everything machine-scoped synapse owns lives here. Overridable so tests never touch a real HOME. */
export function synapseHome() {
  return process.env.SYNAPSE_HOME || join(homedir(), ".synapse");
}
export const registryPath = () => join(synapseHome(), "vaults.json");

/** Where a registered vault's generated roster goes: one directory per vault, stable absolute path. */
export const rosterDir = (id) => join(synapseHome(), "skills", id);

const EMPTY = { version: 1, vaults: [] };

/**
 * Read the registry. A missing file is an EMPTY registry, not an error — that is the first-run state.
 * A CORRUPT file is an error: silently starting over would drop every vault the user registered, and
 * the whole point of this file is that it is the thing they no longer have to remember.
 */
export function readRegistry() {
  const p = registryPath();
  if (!existsSync(p)) return { ...EMPTY, vaults: [] };
  let raw;
  try { raw = JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { throw new Error(`${p} is not valid JSON (${e.message}). Fix or move it aside — refusing to overwrite it.`); }
  if (!raw || !Array.isArray(raw.vaults)) throw new Error(`${p} has no "vaults" array — refusing to overwrite it.`);
  return { version: raw.version || 1, vaults: raw.vaults };
}

/** Write the registry atomically: a half-written registry is worse than none. */
export function writeRegistry(reg) {
  const p = registryPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, vaults: reg.vaults }, null, 2)}\n`, "utf8");
  renameSync(tmp, p);
  return p;
}

/**
 * Resolve a path to a real vault, or throw. Registration validates EAGERLY — a registry full of paths
 * that are not vaults would make `sync` fail halfway through, having already rewired some of them.
 */
export function describeVault(path) {
  const cwd = resolve(path || process.cwd());
  if (!existsSync(cwd)) throw new Error(`no such path: ${cwd}`);
  const r = resolveVault({ cwd, readManifest: true, preferCwd: true });

  // GUARD: resolveVault falls back to $SYNAPSE_VAULT when the cwd walk finds nothing, which is right
  // for a CLI ("brief me from wherever I am, else my configured vault") and badly wrong here. Without
  // this check, `synapse vaults add /some/random/dir` on a machine with $SYNAPSE_VAULT exported would
  // silently register THAT vault under this path's name — registering a vault the user never named,
  // and then rewiring it on the next sync. Registration must mean the path you pointed at, or nothing.
  const inside = cwd === r.root || cwd.startsWith(r.root.endsWith("/") ? r.root : `${r.root}/`);
  if (!inside) {
    throw new Error(
      `${cwd} is not inside a vault. (Resolution fell back to ${r.root}` +
      `${process.env.SYNAPSE_VAULT ? " via $SYNAPSE_VAULT" : ""} — refusing to register that under this path.)`,
    );
  }
  return { root: r.root, vaultDir: r.vaultDir, layout: r.layout };
}

/** A short stable id for a vault: its root's basename, suffixed only if that collides. */
export function idFor(root, taken = []) {
  const base = basename(root).replace(/[^a-zA-Z0-9._-]/g, "-") || "vault";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

/** Register a vault. Idempotent: re-adding a known root refreshes it rather than duplicating it. */
export function addVault(path, reg = readRegistry()) {
  const { root, vaultDir, layout } = describeVault(path);
  const existing = reg.vaults.find((v) => v.root === root);
  if (existing) {
    existing.vaultDir = vaultDir;    // the layout can change under a vault; the id must not
    existing.layout = layout;
    return { reg, entry: existing, added: false };
  }
  const entry = { id: idFor(root, reg.vaults.map((v) => v.id)), root, vaultDir, layout, addedAt: new Date().toISOString() };
  reg.vaults.push(entry);
  return { reg, entry, added: true };
}

/** Forget a vault by id or path. Removes the REGISTRY row only — never the vault, never its config. */
export function removeVault(idOrPath, reg = readRegistry()) {
  const abs = existsSync(idOrPath) ? resolve(idOrPath) : null;
  const i = reg.vaults.findIndex((v) => v.id === idOrPath || v.root === abs || v.root === idOrPath);
  if (i < 0) return { reg, removed: null };
  const [removed] = reg.vaults.splice(i, 1);
  return { reg, removed };
}

/**
 * Plan the rewire for every registered vault. PURE — reads config, writes nothing, so `sync` and
 * `sync --write` are driven by one identical plan and the preview cannot drift from what is applied
 * (the same rule lib/install.mjs's rc planner follows, for the same reason).
 *
 * `surface: null` keeps whatever each vault is already wired to. That is not a detail: passing one
 * surface to every vault is how a vault deliberately raised to `orchestrator` gets silently reset, and
 * `sync` is precisely the bulk operation where that would go unnoticed.
 */
export function planSync({ reg = readRegistry(), surface = null, client = "all" } = {}) {
  const plans = [];
  for (const v of reg.vaults) {
    if (!existsSync(v.root)) {
      plans.push({ vault: v, missing: true, targets: [], warnings: [`${v.root} no longer exists — 'synapse vaults remove ${v.id}' to forget it.`] });
      continue;
    }
    try {
      const { targets, warnings, surface: sfc, surfaceSource } = buildMcpTargets({
        root: v.root, vaultDir: v.vaultDir, surface, client,
      });
      plans.push({ vault: v, missing: false, targets, warnings, surface: sfc, surfaceSource });
    } catch (e) {
      // One unreadable vault must not abort the other three.
      plans.push({ vault: v, missing: false, targets: [], warnings: [`could not plan ${v.id}: ${e.message}`], failed: true });
    }
  }
  return plans;
}

/** Apply a plan. Returns per-vault change counts; never throws for one bad vault. */
export function applySync(plans, { write = false, log = console.log } = {}) {
  const results = [];
  for (const p of plans) {
    for (const w of p.warnings) log(`  ⚠ ${p.vault.id}: ${w}`);
    if (p.missing || p.failed) { results.push({ id: p.vault.id, changed: 0, skipped: true }); continue; }
    const changed = applyMcpTargets(p.targets, { root: p.vault.root, write, log: () => {} });
    log(`  ${write ? (changed ? "rewired  " : "current  ") : (changed ? "would fix" : "current  ")} ${p.vault.id.padEnd(20)} ${p.vault.root}${changed ? ` (${changed} file${changed === 1 ? "" : "s"})` : ""}`);
    results.push({ id: p.vault.id, changed, skipped: false });
  }
  return results;
}

/**
 * Plan each registered vault's roster into ITS OWN directory under $SYNAPSE_HOME.
 *
 * WHY A CENTRAL DIRECTORY PER VAULT, when generating into each vault's own repo root already works.
 * Both are real and this does not replace that one. Generating into `<repo>/.dsh/skills` wins the
 * harness's HIGHEST-ranked discovery root with no configuration at all — but that root is global to the
 * harness, so two vaults' rosters land in one namespace and the better rank silently decides which of
 * two same-named agents you get. One directory per vault, named by absolute path from a workspace's own
 * config, is what makes "this workspace sees THIS vault's agents and no others" expressible at all.
 *
 * The rank ordering is what makes it work: a per-workspace custom directory outranks the global user
 * root, so a workspace that names one wins over whatever else is installed machine-wide.
 */
export function planRosters({ reg = readRegistry(), harness = "dsh" } = {}) {
  const adapter = rosterAdapters.get(harness);
  const plans = [];
  for (const v of reg.vaults) {
    if (!existsSync(v.root)) {
      plans.push({ vault: v, adapter, missing: true, targets: [], warnings: [`${v.root} no longer exists.`] });
      continue;
    }
    try {
      const out = adapter.targets({ root: v.root, vaultDir: v.vaultDir, outDir: rosterDir(v.id) });
      plans.push({ vault: v, adapter, missing: false, targets: out.targets, warnings: out.warnings, skillsDir: out.skillsDir });
    } catch (e) {
      plans.push({ vault: v, adapter, missing: false, failed: true, targets: [], warnings: [`could not plan ${v.id}: ${e.message}`] });
    }
  }
  return plans;
}

/** Apply a roster plan. Hand-authored files are kept, never clobbered — the adapter enforces it. */
export function applyRosters(plans, { write = false, force = false, log = console.log } = {}) {
  const results = [];
  for (const p of plans) {
    for (const w of p.warnings) log(`  ⚠ ${p.vault.id}: ${w}`);
    if (p.missing || p.failed) { results.push({ id: p.vault.id, rows: [], skipped: true }); continue; }
    const rows = p.adapter.apply(p.targets, { root: p.vault.root, write, force });
    const made = rows.filter((r) => r.status === "created" || r.status === "updated").length;
    const kept = rows.filter((r) => r.status === "kept").length;
    log(`  ${p.vault.id.padEnd(20)} ${rows.length} skill(s)${made ? `, ${made} ${write ? "written" : "to write"}` : ""}${kept ? `, ${kept} hand-authored kept` : ""}`);
    log(`  ${" ".repeat(20)} → ${rosterDir(p.vault.id)}`);
    results.push({ id: p.vault.id, rows, skipped: false });
  }
  return results;
}

/**
 * The absolute skill directories a workspace should see, given the vault ids it is for.
 *
 * Returned rather than written: a harness profile lives outside every vault, and silently editing a
 * user's harness config is not this command's business. It prints what to paste.
 */
export function workspaceDirs(ids, reg = readRegistry()) {
  const unknown = ids.filter((id) => !reg.vaults.some((v) => v.id === id));
  if (unknown.length) {
    throw new Error(`no registered vault(s): ${unknown.join(", ")} (have: ${reg.vaults.map((v) => v.id).join(", ") || "none"})`);
  }
  return ids.map((id) => rosterDir(id));
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function main(argv) {
  const [sub, ...rest] = argv;
  const write = rest.includes("--write") || argv.includes("--write");
  const pick = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };

  if (!sub || sub === "list" || sub.startsWith("--")) {
    const reg = readRegistry();
    if (!reg.vaults.length) {
      console.log(`\nNo vaults registered yet (${registryPath()}).\n`);
      console.log(`  synapse vaults add        # register the vault you are standing in\n`);
      return 0;
    }
    console.log(`\n${reg.vaults.length} vault(s) registered — ${registryPath()}\n`);
    for (const v of reg.vaults) {
      const gone = existsSync(v.root) ? "" : "  ✗ MISSING";
      console.log(`  ${v.id.padEnd(20)} ${v.root}${gone}`);
      console.log(`  ${" ".repeat(20)} roster → ${rosterDir(v.id)}`);
    }
    console.log("");
    return 0;
  }

  if (sub === "add") {
    const target = rest.find((a) => !a.startsWith("--")) || process.cwd();
    let out;
    try { out = addVault(target); }
    catch (e) { console.error(`vaults add: ${e.message}`); return 2; }
    writeRegistry(out.reg);
    console.log(`${out.added ? "registered" : "refreshed "} ${out.entry.id}  ${out.entry.root}`);
    return 0;
  }

  if (sub === "remove" || sub === "forget") {
    const target = rest.find((a) => !a.startsWith("--"));
    if (!target) { console.error("vaults remove: need an id or path"); return 2; }
    const { reg, removed } = removeVault(target);
    if (!removed) { console.error(`vaults remove: no registered vault matching "${target}"`); return 1; }
    writeRegistry(reg);
    console.log(`forgot ${removed.id} (${removed.root}) — the vault itself was not touched`);
    return 0;
  }

  if (sub === "sync") {
    const surface = pick("surface");
    if (surface && !MCP_SURFACES.includes(surface)) {
      console.error(`vaults sync: --surface must be ${MCP_SURFACES.join("|")}`);
      return 2;
    }
    const client = pick("client") || "all";
    const plans = planSync({ surface, client });
    if (!plans.length) { console.log("\nNo vaults registered — nothing to sync.\n"); return 0; }
    console.log(`\n${write ? "Rewiring" : "Dry-run —"} ${plans.length} vault(s)${surface ? ` at surface ${surface}` : " (each keeps its own surface)"}:\n`);
    const results = applySync(plans, { write });
    const changed = results.reduce((n, r) => n + r.changed, 0);
    console.log(`\n${write ? `Done — ${changed} file(s) rewritten.` : `${changed} file(s) would change. Re-run with --write.`}\n`);
    return 0;
  }

  if (sub === "roster") {
    const force = argv.includes("--force");
    const plans = planRosters({ harness: pick("harness") || "dsh" });
    if (!plans.length) { console.log("\nNo vaults registered — nothing to generate.\n"); return 0; }
    console.log(`\n${write ? "Generating" : "Dry-run —"} rosters for ${plans.length} vault(s):\n`);
    applyRosters(plans, { write, force });
    console.log(`\n${write ? "Done." : "Re-run with --write."}  Point a workspace at these with:`);
    console.log(`  synapse vaults workspace <id> [<id>…]\n`);
    return 0;
  }

  if (sub === "workspace") {
    const ids = rest.filter((a) => !a.startsWith("--"));
    if (!ids.length) { console.error("vaults workspace: name at least one registered vault id"); return 2; }
    let dirs;
    try { dirs = workspaceDirs(ids); }
    catch (e) { console.error(`vaults workspace: ${e.message}`); return 1; }
    const missing = dirs.filter((d) => !existsSync(d));
    console.log(`\nSkill directories for a workspace covering: ${ids.join(", ")}\n`);
    console.log(JSON.stringify({ customSkillDirs: dirs }, null, 2));
    console.log(`\nThese are absolute paths at the per-workspace rank, which outranks the machine-wide`);
    console.log(`user root — so this workspace sees these rosters and not whatever else is installed.`);
    if (missing.length) {
      console.log(`\n  ⚠ not generated yet: ${missing.join(", ")}`);
      console.log(`    run 'synapse vaults roster --write' first.`);
    }
    console.log("");
    return 0;
  }

  if (sub === "token") {
    const id = rest.find((a) => !a.startsWith("--"));
    if (!id) { console.error("vaults token: name a registered vault id"); return 2; }
    let out;
    try { out = mintToken(id, { label: pick("label") || "" }); }
    catch (e) { console.error(`vaults token: ${e.message}`); return 1; }
    writeTokens(out.store);
    console.log(`\nMinted a credential for ${out.vaultId}. It is shown ONCE and is not recoverable:\n`);
    console.log(`  ${out.plaintext}\n`);
    console.log(`Send it as:  Authorization: Bearer ${out.plaintext.slice(0, 12)}…`);
    console.log(`It binds this credential to ${out.vaultId} and to no other vault.\n`);
    return 0;
  }

  if (sub === "tokens") {
    const revoke = pick("revoke");
    if (revoke) {
      const { store, revoked } = revokeToken(revoke);
      if (!revoked) { console.error(`vaults tokens: nothing matching "${revoke}"`); return 1; }
      writeTokens(store);
      console.log(`revoked ${revoked.label || revoked.hash.slice(0, 12)} (was bound to ${revoked.vaultId})`);
      return 0;
    }
    const { tokens } = readTokens();
    if (!tokens.length) { console.log("\nNo credentials minted.\n"); return 0; }
    console.log(`\n${tokens.length} credential(s) — ${tokensPath()}\n`);
    for (const t of tokens) {
      console.log(`  ${(t.label || "(no label)").padEnd(24)} → ${t.vaultId.padEnd(20)} ${t.hash.slice(0, 12)}…  ${t.createdAt}`);
    }
    console.log(`\nThe credentials themselves are not stored — only their hashes.\n`);
    return 0;
  }

  console.error(`synapse vaults: unknown subcommand "${sub}" (list | add | remove | sync | roster | workspace | token | tokens)`);
  return 2;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exit(main(process.argv.slice(2)));
