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
//   synapse vaults token <id…> [--label L] [--admin] # mint a bearer credential granting one or more vaults
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
// `sub` is imported as `subline`: main() destructures a local `sub` for the subcommand name,
// which would shadow it inside the CLI.
import { GLYPH, row, sub as subline, warnBlock, plural, wrap } from "./fmt.mjs";
import { mintToken, revokeToken, readTokens, writeTokens, tokensPath, grantedVaults } from "./ports/vault-tokens.mjs";

/** Everything machine-scoped synapse owns lives here. Overridable so tests never touch a real HOME. */
export function synapseHome() {
  return process.env.SYNAPSE_HOME || join(homedir(), ".synapse");
}
export const registryPath = () => join(synapseHome(), "vaults.json");

/**
 * The root every vault's generated roster hangs off.
 *
 * WHY this is separable from $SYNAPSE_HOME rather than always `<home>/skills`. The roster is the ONE
 * thing here that a second party reads: `dsh` mounts it read-only and discovers agents from files, with
 * no MCP call involved (US-4.5). In the container stack that makes it a shared volume, while
 * $SYNAPSE_HOME is core's private config volume holding `vaults.json` and `tokens.json` 0600. Pinned
 * together, the only way to hand dsh the rosters would be to mount the credential store next to them.
 * $SYNAPSE_SKILLS_ROOT splits the two so the sharing boundary matches the trust boundary.
 *
 * Unset — every host install — it is exactly the old path, so nothing moves.
 */
export function skillsRoot() {
  return process.env.SYNAPSE_SKILLS_ROOT || join(synapseHome(), "skills");
}

/** Where a registered vault's generated roster goes: one directory per vault, stable absolute path. */
export const rosterDir = (id) => join(skillsRoot(), id);

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
    // Result line FIRST, then that vault's warnings indented beneath it. The old order printed the
    // explanation before the thing it explained, which is why four vaults read as one wall of prose.
    if (p.missing || p.failed) {
      log(row(GLYPH.error, p.vault.id, p.vault.root));
      for (const l of warnBlock(p.warnings)) log(l);
      log("");
      results.push({ id: p.vault.id, changed: 0, skipped: true });
      continue;
    }
    const changed = applyMcpTargets(p.targets, { root: p.vault.root, write, log: () => {} });
    const glyph = changed ? (write ? GLYPH.wrote : GLYPH.change) : GLYPH.ok;
    const state = changed ? `${write ? "rewired" : "would rewire"} ${plural(changed, "file")}` : "already current";
    log(row(glyph, p.vault.id, state));
    log(subline(`${GLYPH.arrow} ${p.vault.root}`));
    for (const l of warnBlock(p.warnings)) log(l);
    log("");
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
    if (p.missing || p.failed) {
      log(row(GLYPH.error, p.vault.id, "unreachable"));
      for (const l of warnBlock(p.warnings)) log(l);
      log("");
      results.push({ id: p.vault.id, rows: [], skipped: true });
      continue;
    }
    const rows = p.adapter.apply(p.targets, { root: p.vault.root, write, force });
    const made = rows.filter((r) => r.status === "created" || r.status === "updated").length;
    const kept = rows.filter((r) => r.status === "kept").length;

    const bits = [plural(rows.length, "agent")];
    if (made) bits.push(`${made} ${write ? "written" : "to write"}`);
    if (kept) bits.push(`${kept} hand-authored kept`);
    log(row(made ? (write ? GLYPH.wrote : GLYPH.change) : GLYPH.ok, p.vault.id, bits.join(" · ")));
    log(subline(`${GLYPH.arrow} ${rosterDir(p.vault.id)}`));
    for (const l of warnBlock(p.warnings)) log(l);
    log("");
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
    console.log("");
    console.log(`📚  ${plural(reg.vaults.length, "vault")} registered`);
    console.log(`    ${registryPath()}`);
    console.log("");
    for (const v of reg.vaults) {
      const live = existsSync(v.root);
      console.log(row(live ? GLYPH.ok : GLYPH.error, v.id, live ? v.root : `${v.root}  — MISSING`));
      console.log(subline(`${GLYPH.arrow} roster: ${rosterDir(v.id)}`));
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
    console.log("");
    console.log(`${write ? "💾  Rewiring" : "🔍  Dry run —"} ${plural(plans.length, "vault")}${surface ? ` at surface ${surface}` : ""}`);
    if (!surface) console.log(`    each vault keeps the surface it is already wired to`);
    console.log("");
    const results = applySync(plans, { write });
    const changed = results.reduce((n, r) => n + r.changed, 0);
    console.log(changed
      ? (write ? `${GLYPH.wrote}  Done — ${plural(changed, "file")} rewritten.` : `${GLYPH.change}  ${plural(changed, "file")} would change.  Re-run with --write to apply.`)
      : `${GLYPH.ok}  Everything already current — nothing to do.`);
    console.log("");
    return 0;
  }

  if (sub === "roster") {
    const force = argv.includes("--force");
    const plans = planRosters({ harness: pick("harness") || "dsh" });
    if (!plans.length) { console.log("\nNo vaults registered — nothing to generate.\n"); return 0; }
    console.log("");
    console.log(`${write ? "💾  Generating" : "🔍  Dry run —"} agent rosters for ${plural(plans.length, "vault")}`);
    console.log("");
    const rr = applyRosters(plans, { write, force });
    const anyWarn = plans.some((p) => p.warnings.length);
    if (anyWarn) {
      for (const l of wrap("A customised agent is generated from your own definition instead of the "
        + "package's tuned skill. That is informational — nothing was skipped.", { indent: 4 })) console.log(l);
      console.log("");
    }
    console.log(write ? `${GLYPH.ok}  Done.` : `${GLYPH.change}  Re-run with --write to apply.`);
    console.log(`    Point a workspace at these with:  synapse vaults workspace <id> [<id>…]`);
    console.log("");
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
    // Every bare argument is a vault id, so one credential can grant several
    // ([[decision-0017-path-addressed-vaults]]). The value the human must then carry is the ADDRESS
    // per vault, not a second secret — so print those addresses rather than leaving them to be derived.
    // Collect bare arguments, SKIPPING the value that belongs to a value-taking flag. Filtering on
    // "does not start with --" alone reads `--label "my laptop"` as a vault named "my laptop", which
    // the single-id version never noticed because it only ever took the first bare argument.
    const VALUE_FLAGS = new Set(["--label"]);
    const ids = [];
    for (let i = 0; i < rest.length; i++) {
      if (VALUE_FLAGS.has(rest[i])) { i++; continue; }
      if (rest[i].startsWith("--")) continue;
      ids.push(rest[i]);
    }
    if (!ids.length) { console.error("vaults token: name at least one registered vault id"); return 2; }
    let out;
    try {
      out = mintToken(ids, {
        label: pick("label") || "",
        scopes: argv.includes("--admin") ? ["admin"] : [],
      });
    }
    catch (e) { console.error(`vaults token: ${e.message}`); return 1; }
    writeTokens(out.store);

    const many = out.vaultIds.length > 1;
    const kind = out.scopes.includes("admin") ? "an ADMIN " : "a ";
    console.log(`\nMinted ${kind}credential for ${out.vaultIds.join(", ")}. It is shown ONCE and is not recoverable:\n`);
    console.log(`  ${out.plaintext}\n`);
    console.log(`Send it as:  Authorization: Bearer ${out.plaintext.slice(0, 12)}…\n`);

    const base = `http://${process.env.SYNAPSE_MCP_HOST || "127.0.0.1"}:${process.env.SYNAPSE_MCP_PORT || 3000}${process.env.SYNAPSE_MCP_PATH || "/mcp"}`;
    if (many) {
      console.log(`The ADDRESS chooses which vault answers — this credential reaches these and no others:\n`);
      for (const id of out.vaultIds) console.log(`  ${id.padEnd(20)} ${base}/${id}`);
      // Said plainly because the failure is silent otherwise: a client pointed at the bare endpoint
      // with a multi-vault credential is refused, not quietly served whichever vault comes first.
      console.log(`\nA multi-vault credential MUST name its vault in the address. ${base} on its own is refused.\n`);
    } else {
      console.log(`It grants ${out.vaultIds[0]} and no other vault.`);
      console.log(`Address:  ${base}  (or ${base}/${out.vaultIds[0]})\n`);
    }
    return 0;
  }

  if (sub === "tokens") {
    const revoke = pick("revoke");
    if (revoke) {
      const { store, revoked } = revokeToken(revoke);
      if (!revoked) { console.error(`vaults tokens: nothing matching "${revoke}"`); return 1; }
      writeTokens(store);
      console.log(`revoked ${revoked.label || revoked.hash.slice(0, 12)} (granted ${grantedVaults(revoked).join(", ") || "nothing"})`);
      return 0;
    }
    const { tokens } = readTokens();
    if (!tokens.length) { console.log("\nNo credentials minted.\n"); return 0; }
    console.log(`\n${tokens.length} credential(s) — ${tokensPath()}\n`);
    for (const t of tokens) {
      const scopes = Array.isArray(t.scopes) && t.scopes.length ? ` [${t.scopes.join(",")}]` : "";
      const granted = grantedVaults(t).join(", ") || "(none)";
      console.log(`  ${(t.label || "(no label)").padEnd(24)} → ${granted.padEnd(20)} ${t.hash.slice(0, 12)}…${scopes}  ${t.createdAt}`);
    }
    console.log(`\nThe credentials themselves are not stored — only their hashes.\n`);
    return 0;
  }

  console.error(`synapse vaults: unknown subcommand "${sub}" (list | add | remove | sync | roster | workspace | token | tokens)`);
  return 2;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exit(main(process.argv.slice(2)));
