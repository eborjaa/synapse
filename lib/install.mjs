#!/usr/bin/env node
// install.mjs — one-step setup for the @eborja/synapse context-vault CLI.
//
// The vault lives in the consumer repo; the fiddly part is wiring the shell + AI tool to it. This does
// that.
//
//   synapse install            # show what it would add (safe, prints only)
//   synapse install --write    # apply it (idempotent)
//   synapse install --write --force-rc   # ALSO rewrite a shell-rc line you hand-edited
//
// --write does five idempotent things:
//   1) sources the package's agents.sh in your shell rc → short agent commands (spec-author, qa-lead, …)
//      plus the vault-* helpers, multi-CLI dispatch, and per-prompt auto-reload. Nothing else to wire.
//   2) adds the REPO ROOT to ~/.claude/settings.json permissions.additionalDirectories
//      (so Claude Code reaches the vault when launched from outside the repo)
//   3) appends a vault pointer to ~/.claude/CLAUDE.md
//   4) generates the MCP client configs (.mcp.json / .cursor/mcp.json / opencode.json) so the synapse
//      MCP tools work in Claude Code, Cursor, AND opencode out of the box — same as `synapse mcp-config
//      --write` (the standalone command stays, for regenerating with a different --surface / --client).
//   5) generates one harness SKILL.md per agent THIS vault defines, so /synapse-<agent> works for the
//      vault's own roster — same as `synapse skills --write`.
//
// It also runs a non-fatal capability probe (is `cursor-agent` on PATH?) and prints the exact next
// commands.
//
// DE-BRANDING NOTES:
//   - The vault + repo root are located via resolveVault() (REPO = the resolved `root`), NOT a fixed
//     "N-up from __dirname" path.
//   - The rc marker is `# @eborja/synapse vault agent commands`; the rc carries a NON-EXPORTED
//     SYNAPSE_VAULT_FALLBACK (see the long note above buildRcLine — this is load-bearing).
//   - agents.sh SHIPS IN THE PACKAGE now: sourced from its installed location — resolved via
//     import.meta.resolve('@eborja/synapse/agents.sh'), else the sibling `../agents.sh` next to this file.
//   - The log label (where a run line is printed) is manifest.logLabel (default "synapse").
//
// Zero dependencies. Idempotent — safe to re-run. The heavy lifting lives in agents.sh, which
// self-registers its completion + auto-reload hook when sourced — the installer just wires it in.
//
// This module is BOTH a CLI (guarded by isMain at the bottom) and a library: the shell-rc planner
// (buildRcLine / classifyRcLine / planRcUpdate) is pure and exported so lib/install.test.mjs can pin
// the contract without ever touching a real ~/.zshrc. Everything that touches HOME lives in main().

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { resolveVault } from "./vault-root.mjs";
import { buildMcpTargets, applyMcpTargets, MCP_SURFACES } from "./mcp-config.mjs";
import { buildSkillTargets, applySkillTargets } from "./skills.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── the shell-rc line ─────────────────────────────────────────────────────────

export const SH_MARKER = "# @eborja/synapse vault agent commands";
// The npm scope was renamed (@eborjaa → @eborja) in 4a70bc7; rc lines written before that carry the old
// marker and must still be recognized, or install appends a SECOND line next to the old one forever.
export const SH_MARKER_LEGACY = "# @eborjaa/synapse vault agent commands";
export const RC_MARKERS = [SH_MARKER, SH_MARKER_LEGACY];

// The variable the rc line sets. NON-EXPORTED, and deliberately NOT `SYNAPSE_VAULT`.
//
// WHY THIS IS NOT `export SYNAPSE_VAULT=` (the bug this shape exists to prevent):
// Until 1.1.x the rc line read `export SYNAPSE_VAULT="<vault>"; source "<agents.sh>"`. That is a GLOBAL
// pin: it is exported, it is evaluated at the top of every interactive shell, and every synapse process
// on the machine inherits it. Three failures fell out of that, all of them silent:
//   1. Multi-vault redirection. Running `synapse install --write` from vault B rewrote the pin to B, so
//      every shell — including ones working in vault A — carried B in its environment.
//   2. Env-wins paths got the wrong tree. `resolveVault({preferCwd:false})` (the MCP server) and any
//      bare `node lib/<tool>.mjs` treat $SYNAPSE_VAULT as authoritative intent. An rc-baked pin is not
//      intent; it is the residue of whichever install ran last.
//   3. It was unfixable by hand. The self-heal below REPLACED any marked line with the freshly generated
//      one, so deleting the export by hand survived exactly until the next install.
// `SYNAPSE_VAULT_FALLBACK` keeps the safety net that motivated the export — a vault to fall back on for
// shells / direnv setups where cwd self-detection comes back empty — while removing every one of those
// three failure modes: it is not exported (no child process inherits it, so nothing that reads
// $SYNAPSE_VAULT is affected), and agents.sh consults it only AFTER the $PWD ancestor walk and after an
// explicit $SYNAPSE_VAULT the user set themselves. cwd always wins; an explicit export still wins over
// the rc. See `__mx_vault` in agents.sh.
export const RC_FALLBACK_VAR = "SYNAPSE_VAULT_FALLBACK";

// The canonical line. The `source "<abs path>"` is mandatory: a shell rc cannot source a relative path
// reliably at startup, and agents.sh may live in any vault's node_modules/@eborja/synapse/.
export function buildRcLine({ vaultDir, agentsSh }) {
  return `${RC_FALLBACK_VAR}="${vaultDir}"; source "${agentsSh}"  ${SH_MARKER}`;
}

// Every shape THIS installer has ever generated, newest first. Anything else carrying a marker is a
// HAND-EDIT and is never rewritten without --force-rc — that is the whole point (see planRcUpdate).
const MARKER_RE = "# @eborjaa?/synapse vault agent commands";
const GENERATED_SHAPES = [
  {
    generation: "fallback",       // current: non-exported fallback, cwd still wins
    re: new RegExp(`^${RC_FALLBACK_VAR}="([^"]*)";\\s*source\\s+"([^"]*)"\\s*${MARKER_RE}$`),
  },
  {
    generation: "global-export",  // ≤1.1.x: the global pin this fix removes (migrated on sight)
    re: new RegExp(`^export\\s+SYNAPSE_VAULT="([^"]*)";\\s*source\\s+"([^"]*)"\\s*${MARKER_RE}$`),
  },
];

// Classify one rc line that carries a marker. Returns the generation plus the two paths it encodes, or
// generation:"hand-edited" for anything we did not write — including the shape a user lands on when they
// delete the export by hand (`source "…/agents.sh"  # marker`). Treating THAT as ours would re-clobber
// the exact edit this fix exists to protect, so a bare source line is deliberately NOT a known shape.
export function classifyRcLine(line) {
  const t = line.trim();
  for (const { generation, re } of GENERATED_SHAPES) {
    const m = t.match(re);
    if (m) return { generation, vaultDir: m[1], agentsSh: m[2] };
  }
  return { generation: "hand-edited", vaultDir: null, agentsSh: null };
}

// Pull the agents.sh path out of any `source "…"` / `. "…"` line (quoted or not). Used only to warn
// about an rc that sources TWO different vaults' agents.sh — the second wins outright, so the first is
// dead weight the user almost certainly did not intend.
function agentsShIn(line) {
  const t = line.trim();
  if (t.startsWith("#")) return null;                       // a commented-out line is not sourcing anything
  const m = t.match(/(?:^|[;&|]\s*|\s)(?:source|\.)\s+(?:"([^"]*agents\.sh)"|'([^']*agents\.sh)'|(\S*agents\.sh))(?:\s|$|;)/);
  return m ? (m[1] || m[2] || m[3]) : null;
}

// Plan the shell-rc edit WITHOUT touching the filesystem. Pure: rcText in, full replacement text out.
// The dry run and --write call this with identical inputs, so what `synapse install` prints is exactly
// what `synapse install --write` does — there is no second code path to drift.
//
// The contract, in one place:
//   • no marked line            → append ours.
//   • marked line == ours       → nothing to do.
//   • marked line is a shape WE generated (incl. the old global export) → rewrite it in place. This is
//     the upgrade path (agents.sh moves when node_modules moves) and the migration path (the export is
//     dropped). Reported explicitly, never silently.
//   • marked line is anything else → the user edited it. KEEP IT. Print the line we would have written
//     and stop, exactly like `synapse skills` keeps a hand-authored SKILL.md. `--force-rc` overrides.
//   • several marked lines we generated → collapse to one, in the first one's position. Sourcing
//     agents.sh twice is never useful; the last source wins and the earlier one only costs startup time.
//     Never collapse across a hand-edited line — that would be guessing (rule-synapse-fail-loudly).
export function planRcUpdate({ rcText = "", vaultDir, agentsSh, force = false, rcPath = "your shell rc" } = {}) {
  const line = buildRcLine({ vaultDir, agentsSh });
  const notes = [];
  const warnings = [];
  const lines = rcText.split("\n");

  const marked = [];
  lines.forEach((raw, i) => {
    if (RC_MARKERS.some((m) => raw.includes(m))) marked.push({ i, raw, ...classifyRcLine(raw) });
  });
  const handEdited = marked.filter((m) => m.generation === "hand-edited");

  // Warn about an rc that sources more than one agents.sh, whatever we end up doing to our own line.
  // (The user's real rc had two: one from synapse-vault, one from synapse-framework.)
  const sourced = new Set();
  for (const raw of lines) {
    const p = agentsShIn(raw);
    if (p) sourced.add(p);
  }
  const foreign = [...sourced].filter((p) => p !== agentsSh);

  // ── the hand-edit guard ──
  // Any marked line we did not write means the user has an opinion about this line. We do not overwrite
  // an opinion; we surface ours and let them decide. Nothing else in the rc is touched either — a second
  // (generated) marked line next to a hand-edited one is a judgement call, so it is escalated, not fixed.
  if (handEdited.length && !force) {
    warnings.push(
      `${rcPath} line ${handEdited[0].i + 1} carries the synapse marker but is NOT a line this installer `
      + `wrote — treating it as YOUR edit and leaving it exactly as-is.`,
    );
    warnings.push(`    yours: ${handEdited[0].raw.trim()}`);
    warnings.push(`    ours:  ${line}`);
    warnings.push(`    Adopt ours with 'synapse install --write --force-rc', or merge it by hand. Your`);
    warnings.push(`    line keeps working: agents.sh resolves the vault from $PWD on every call.`);
    if (foreign.length) {
      warnings.push(
        `    Heads up — this rc sources ${sourced.size} different agents.sh files `
        + `(${[...sourced].join(", ")}). The LAST one sourced wins; the others do nothing.`,
      );
    }
    return { line, action: "kept-hand-edit", changed: false, nextText: null, notes, warnings };
  }

  // ── nothing marked yet → append ──
  if (!marked.length) {
    const nextText = rcText + (rcText && !rcText.endsWith("\n") ? "\n" : "") + "\n" + line + "\n";
    notes.push(`added agent commands to ${rcPath} (sources agents.sh; no global export)`);
    if (foreign.length) {
      warnings.push(
        `${rcPath} already sources a DIFFERENT agents.sh (${foreign.join(", ")}). Two sourced copies `
        + `means the last one wins — remove the stale line by hand if it is left over from another vault.`,
      );
    }
    return { line, action: "append", changed: true, nextText, notes, warnings };
  }

  // ── rewrite ours in place, collapsing any duplicates onto the first ──
  const keep = marked[0].i;
  const drop = new Set(marked.slice(1).map((m) => m.i));
  const nextLines = [];
  lines.forEach((raw, i) => {
    if (i === keep) nextLines.push(line);
    else if (!drop.has(i)) nextLines.push(raw);
  });
  const nextText = nextLines.join("\n");

  if (nextText === rcText) {
    notes.push(`${rcPath} already sources the agent commands (current) — no change`);
    if (foreign.length) {
      warnings.push(
        `${rcPath} ALSO sources ${foreign.join(", ")}. Sourcing two vaults' agents.sh is redundant — the `
        + `last one wins. Remove the stale line by hand (install will not touch a line it did not write).`,
      );
    }
    return { line, action: "current", changed: false, nextText: null, notes, warnings };
  }

  // Report the migration loudly. A user who never saw this message would have no idea their global pin
  // just disappeared — and their ALREADY-RUNNING shells still carry the exported value.
  const hadExport = marked.some((m) => m.generation === "global-export") || (force && handEdited.some((m) => /export\s+SYNAPSE_VAULT=/.test(m.raw)));
  const prior = marked.find((m) => m.vaultDir);
  notes.push(`updated the agent-commands line in ${rcPath}`);
  if (hadExport) {
    notes.push(`REMOVED the global 'export SYNAPSE_VAULT=' pin from ${rcPath} — it overrode per-directory`);
    notes.push(`  vault detection in every shell on this machine. Replaced with a NON-exported`);
    notes.push(`  ${RC_FALLBACK_VAR} that agents.sh consults only when $PWD is not inside any vault.`);
    notes.push(`  Already-open shells still have the old value exported: run 'unset SYNAPSE_VAULT' in`);
    notes.push(`  each, or just open a new terminal.`);
  }
  if (prior && prior.vaultDir !== vaultDir) {
    notes.push(`out-of-vault fallback re-pointed: ${prior.vaultDir} → ${vaultDir}`);
    notes.push(`  (this only decides which vault answers when your cwd is inside NO vault; standing in a`);
    notes.push(`   vault always wins, so this cannot redirect another vault's commands.)`);
  }
  if (drop.size) {
    warnings.push(`collapsed ${drop.size + 1} synapse rc line(s) into one (lines ${marked.map((m) => m.i + 1).join(", ")}):`);
    for (const m of marked.slice(1)) warnings.push(`    dropped: ${m.raw.trim()}`);
  }
  if (force && handEdited.length) {
    warnings.push(`--force-rc: overwrote ${handEdited.length} hand-edited line(s) as you asked.`);
  }
  const foreignAfter = foreign.filter((p) => !marked.some((m) => m.agentsSh === p));
  if (foreignAfter.length) {
    warnings.push(
      `${rcPath} ALSO sources ${foreignAfter.join(", ")} from an unmarked line — install will not touch a `
      + `line it did not write, but the last source wins. Remove the stale one by hand.`,
    );
  }
  return { line, action: "heal", changed: true, nextText, notes, warnings };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function rcFile() {
  const shell = process.env.SHELL || "";
  if (shell.includes("bash")) {
    const bp = join(homedir(), ".bash_profile");
    return process.platform === "darwin" && existsSync(bp) ? bp : join(homedir(), ".bashrc");
  }
  return join(homedir(), ".zshrc"); // zsh default (macOS)
}

// Resolve the package's agents.sh: prefer the package export, fall back to the sibling next to this file
// (agents.sh ships at the package root, one level up from lib/).
function resolveAgentsSh() {
  try {
    const u = import.meta.resolve("@eborja/synapse/agents.sh");
    if (u) return fileURLToPath(u);
  } catch { /* not resolvable in this context — fall through */ }
  return join(HERE, "..", "agents.sh");
}

// Non-fatal capability probe: is the Cursor CLI available for the `--cli cursor` / `--model` path?
function hasCursorAgent() {
  try {
    execSync("command -v cursor-agent", { stdio: "ignore", shell: process.env.SHELL || "/bin/sh" });
    return true;
  } catch {
    return false;
  }
}

function main(argv = process.argv.slice(2)) {
  // Prefer the vault we're standing in — a stale $SYNAPSE_VAULT from a previous install must
  // not re-pin the wrong tree when the user intentionally runs install from another vault.
  const { root: REPO, vaultDir: VAULT, manifest: MANIFEST } = resolveVault({ preferCwd: true });
  const LABEL = MANIFEST.logLabel || "synapse";
  const write = argv.includes("--write");
  // --force-rc: adopt our generated line even over a hand-edited one. Opt-in ONLY — the default is to
  // keep what the user wrote, because the previous unconditional self-heal is what made a deliberate
  // hand-edit impossible to keep across installs.
  const forceRc = argv.includes("--force-rc");

  // --surface picks how many MCP tools the server exposes. Omitted, buildMcpTargets KEEPS whatever this
  // vault is already wired to — `install` must never silently downgrade a vault raised to `orchestrator`.
  const surface = (() => {
    const i = argv.indexOf("--surface");
    const v = i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
    if (v && !MCP_SURFACES.includes(v)) {
      console.error(`install: --surface must be ${MCP_SURFACES.join("|")}`);
      process.exit(2);
    }
    return v;
  })();

  const agentsSh = resolveAgentsSh();

  const claudeDir    = join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const claudeMdPath = join(claudeDir, "CLAUDE.md");
  const skillsDir    = join(REPO, ".claude", "skills");

  const POINTER = `# @eborja/synapse context vault
The synapse context-vault lives at \`${VAULT}\`. When I name an agent (e.g. "use agent-curator"),
run \`synapse render <agent-id> [<target-id>] --profile <lean|standard|fat>\` to get the bundled
briefing instead of reading files ad-hoc. If I name a domain too, add its \`hub-<domain>\`.
Executable skills, if present, are auto-discovered from \`${skillsDir}\`.`;

  const cursorReady = hasCursorAgent();
  const rc = rcFile();
  const rcText = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  // ONE plan, computed once, used by BOTH the dry run and --write. The dry run cannot drift from what
  // --write does because there is nothing to drift from.
  const rcPlan = planRcUpdate({ rcText, vaultDir: VAULT, agentsSh, force: forceRc, rcPath: rc });

  console.log(`\n📦 @eborja/synapse context vault\n   vault: ${VAULT}\n   repo:  ${REPO}\n   agents.sh: ${agentsSh}\n`);

  if (!write) {
    console.log("Dry-run — re-run with --write to apply all five:\n");
    console.log(`1) Shell commands — source agents.sh in ${rc}:`);
    console.log(`     ${rcPlan.line}`);
    console.log(`   → gives you: one command per agent, the vault-* helpers, --cli claude|opencode|cursor,`);
    console.log(`     --model <TAB>, and per-prompt auto-reload of agents.sh.`);
    console.log(`   → ${RC_FALLBACK_VAR} is NOT exported: it answers only when your cwd is inside no vault,`);
    console.log(`     so installing from another vault can never redirect this one.`);
    console.log(`   plan: ${{
      append: "append this line (no synapse line in your rc yet)",
      heal:   "rewrite the existing synapse line in place",
      current: "nothing to do — your rc already has exactly this line",
      "kept-hand-edit": "KEEP your hand-edited line — nothing written (see the warning below)",
    }[rcPlan.action]}`);
    for (const n of rcPlan.notes)    console.log(`   · ${n}`);
    for (const w of rcPlan.warnings) console.log(`   ⚠ ${w}`);
    console.log("");
    console.log(`2) Claude Code reach — add the repo to ~/.claude/settings.json:`);
    console.log("   " + JSON.stringify({ permissions: { additionalDirectories: [REPO] } }));
    console.log(`\n3) Session pointer — append to ~/.claude/CLAUDE.md:\n`);
    console.log(POINTER.split("\n").map((l) => "   " + l).join("\n"));
    console.log(`\n4) MCP client configs — write .mcp.json / .cursor/mcp.json / opencode.json:`);
    try {
      const { targets, surface: sfc, surfaceSource } = buildMcpTargets({ root: REPO, vaultDir: VAULT, surface });
      console.log(`   ${targets.map((t) => relative(REPO, t.path)).join(", ")}`);
      console.log(`   surface: ${sfc} (${surfaceSource}) — change it with --surface skeleton|standard|full|orchestrator`);
      console.log(`   → the synapse MCP tools work in Claude Code, Cursor, and opencode (opencode also`);
      console.log(`     gets the native Ollama provider so its tool calls actually fire).`);
    } catch (e) {
      console.log(`   (skipped in preview: ${e.message})`);
    }
    console.log(`\n5) Harness skills — one <vault>/.dsh/skills/synapse-<agent>/SKILL.md per agent you define:`);
    try {
      const { targets, warnings } = buildSkillTargets({ root: REPO, vaultDir: VAULT });
      const rows = applySkillTargets(targets, { root: REPO, write: false });
      console.log(`   ${rows.length ? rows.map((r) => "/" + r.name).join(", ") : "(no agents/ yet)"}`);
      console.log(`   → /synapse-<agent> in the DeepSeek Harness loads that role's procedure. Hand-authored`);
      console.log(`     skills are never overwritten (see: synapse skills --help).`);
      for (const w of warnings) console.log(`   ⚠ ${w}`);
    } catch (e) {
      console.log(`   (skipped in preview: ${e.message})`);
    }
    console.log(`\nCapability check:`);
    console.log(`   cursor-agent (for --cli cursor / --model): ${cursorReady ? "✓ found on PATH" : "✗ not found — the Claude path works; install it later for the Cursor/Bedrock model picker"}`);
    console.log(`\n→ Re-run with --write to apply.\n`);
    return 0;
  }

  // --- apply (idempotent) ---
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

  // 1) shell rc — exactly the plan printed by the dry run.
  if (rcPlan.nextText !== null) writeFileSync(rc, rcPlan.nextText);
  for (const n of rcPlan.notes)    console.log(`${rcPlan.changed ? "✓" : "·"} ${n}`);
  for (const w of rcPlan.warnings) console.log(`⚠ ${w}`);

  // 2) settings.json additionalDirectories
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); }
    catch (e) { console.error(`✗ ${settingsPath} is not valid JSON — fix or edit manually (${e.message})`); process.exit(1); }
  }
  settings.permissions ??= {};
  const dirs = (settings.permissions.additionalDirectories ??= []);
  if (dirs.includes(REPO)) {
    console.log(`✓ settings.json already lists the repo — no change`);
  } else {
    dirs.push(REPO);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log(`✓ added repo to ${settingsPath} → permissions.additionalDirectories`);
  }

  // 3) CLAUDE.md pointer
  const md = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8") : "";
  if (md.includes("# @eborja/synapse context vault") || md.includes("# @eborjaa/synapse context vault")) {
    console.log(`✓ ~/.claude/CLAUDE.md already has the vault pointer — no change`);
  } else {
    appendFileSync(claudeMdPath, (md && !md.endsWith("\n") ? "\n" : "") + "\n" + POINTER + "\n");
    console.log(`✓ appended the vault pointer to ${claudeMdPath}`);
  }

  // 4) MCP client configs (.mcp.json / .cursor/mcp.json / opencode.json) — same generation as
  //    `synapse mcp-config --write`, so the synapse MCP tools work in all three CLIs out of the box.
  console.log(`\n[${LABEL} install] MCP client configs:`);
  try {
    const { targets, warnings, surface: sfc, surfaceSource } = buildMcpTargets({ root: REPO, vaultDir: VAULT, surface });
    console.log(`  surface: ${sfc} (${surfaceSource})`);
    const changed = applyMcpTargets(targets, { root: REPO, write: true, log: (m) => console.log(m) });
    if (!changed) console.log(`  (all current — no change)`);
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  } catch (e) {
    console.log(`  ✗ could not generate MCP configs: ${e.message}`);
    console.log(`    run 'synapse mcp-config --write' manually.`);
  }

  // 5) Harness skills — one SKILL.md per agent THIS vault defines, so /synapse-<agent> works for a
  //    vault's own roster and not just the four this package happens to ship (decision-0011).
  console.log(`\n[${LABEL} install] Harness skills (.dsh/skills/):`);
  try {
    const { targets, warnings } = buildSkillTargets({ root: REPO, vaultDir: VAULT });
    const rows = applySkillTargets(targets, { root: REPO, write: true });
    const changed = rows.filter((r) => ["created", "updated"].includes(r.status));
    for (const r of changed) console.log(`  ✓ ${r.status} /${r.name} → ${r.rel}`);
    const kept = rows.filter((r) => r.status === "kept");
    if (kept.length) console.log(`  · kept ${kept.length} hand-authored skill(s): ${kept.map((k) => "/" + k.name).join(", ")}`);
    if (!changed.length && !kept.length) console.log(`  (all current — no change)`);
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  } catch (e) {
    console.log(`  ✗ could not generate harness skills: ${e.message}`);
    console.log(`    run 'synapse skills --write' manually.`);
  }

  console.log(`\n[${LABEL} install] Done. Run 'exec $SHELL' (or open a new terminal), then:`);
  console.log(`   synapse agents        # every agent command + purpose + default profile`);
  console.log(`   synapse hubs          # the hub targets (or: vault-hubs)`);
  console.log(`   vault-reload          # force re-source agents.sh (it also auto-reloads each prompt)`);
  console.log(`\nLaunch syntax: <agent> [<target>] [lean|standard|fat] [--cli claude|opencode|cursor] [--model <id>] ["task"]`);
  if (!cursorReady) {
    console.log(`\nNote: 'cursor-agent' isn't on your PATH yet — the default Claude path works now;`);
    console.log(`      install the Cursor CLI later to unlock '--cli cursor' + '--model <TAB>'.`);
  }
  console.log("");
  return 0;
}

// Run the CLI only when invoked directly (synapse install) — NOT when imported by the test suite.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
