#!/usr/bin/env node
// install.mjs — one-step setup for the @eborja/synapse context-vault CLI.
//
// The vault lives in the consumer repo; the fiddly part is wiring the shell + AI tool to it. This does
// that.
//
//   synapse install          # show what it would add (safe, prints only)
//   synapse install --write  # apply it (idempotent)
//
// --write does three idempotent things:
//   1) sources the package's agents.sh in your shell rc → short agent commands (spec-author, qa-lead, …)
//      plus the vault-* helpers, multi-CLI dispatch, and per-prompt auto-reload. Nothing else to wire.
//   2) adds the REPO ROOT to ~/.claude/settings.json permissions.additionalDirectories
//      (so Claude Code reaches the vault when launched from outside the repo)
//   3) appends a vault pointer to ~/.claude/CLAUDE.md
//
// It also runs a non-fatal capability probe (is `cursor-agent` on PATH?) and prints the exact next
// commands.
//
// DE-BRANDING NOTES:
//   - The vault + repo root are located via resolveVault() (REPO = the resolved `root`), NOT a fixed
//     "N-up from __dirname" path.
//   - The vault-override env var is SYNAPSE_VAULT; the rc marker is `# @eborja/synapse vault agent commands`.
//   - agents.sh SHIPS IN THE PACKAGE now: sourced from its installed location — resolved via
//     import.meta.resolve('@eborja/synapse/agents.sh'), else the sibling `../agents.sh` next to this file.
//   - The log label (where a run line is printed) is manifest.logLabel (default "synapse").
//
// Zero dependencies. Idempotent — safe to re-run. The heavy lifting lives in agents.sh, which
// self-registers its completion + auto-reload hook when sourced — the installer just wires it in.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { resolveVault } from "./vault-root.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { root: REPO, vaultDir: VAULT, manifest: MANIFEST } = resolveVault();
const LABEL = MANIFEST.logLabel || "synapse";
const write = process.argv.includes("--write");

// Resolve the package's agents.sh: prefer the package export, fall back to the sibling next to this file
// (agents.sh ships at the package root, one level up from lib/).
function resolveAgentsSh() {
  try {
    const u = import.meta.resolve("@eborja/synapse/agents.sh");
    if (u) return fileURLToPath(u);
  } catch { /* not resolvable in this context — fall through */ }
  return join(HERE, "..", "agents.sh");
}
const agentsSh = resolveAgentsSh();

const SH_MARKER = "# @eborja/synapse vault agent commands";
// agents.sh resolves the vault per-call from $PWD (directory-agnostic). We still bake the absolute
// SYNAPSE_VAULT here as a SAFETY NET — the fallback for shells / direnv setups where self-detection
// comes back empty. (The `source "<abs path>"` is mandatory: a shell rc can't source a relative path
// reliably at startup.)
const sourceLine = `export SYNAPSE_VAULT="${VAULT}"; source "${agentsSh}"  ${SH_MARKER}`;

const renderMjs = join(HERE, "render.mjs");

const claudeDir    = join(homedir(), ".claude");
const settingsPath = join(claudeDir, "settings.json");
const claudeMdPath = join(claudeDir, "CLAUDE.md");
const skillsDir    = join(REPO, ".claude", "skills");

const POINTER = `# @eborja/synapse context vault
The synapse context-vault lives at \`${VAULT}\`. When I name an agent (e.g. "use agent-spec-author"),
run \`node "${renderMjs}" <agent-id> [<target-id>] --profile <lean|standard|fat>\` to get the bundled
briefing instead of reading files ad-hoc. If I name a domain too, add its \`hub-<domain>\`.
Executable skills, if present, are auto-discovered from \`${skillsDir}\`.`;

function rcFile() {
  const shell = process.env.SHELL || "";
  if (shell.includes("bash")) {
    const bp = join(homedir(), ".bash_profile");
    return process.platform === "darwin" && existsSync(bp) ? bp : join(homedir(), ".bashrc");
  }
  return join(homedir(), ".zshrc"); // zsh default (macOS)
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

const cursorReady = hasCursorAgent();

console.log(`\n📦 @eborja/synapse context vault\n   vault: ${VAULT}\n   repo:  ${REPO}\n   agents.sh: ${agentsSh}\n`);

if (!write) {
  console.log("Dry-run — re-run with --write to apply all three:\n");
  console.log(`1) Shell commands — source agents.sh in ${rcFile()}:`);
  console.log(`     ${sourceLine}`);
  console.log(`   → gives you: one command per agent, the vault-* helpers, --cli claude|opencode|cursor,`);
  console.log(`     --model <TAB>, and per-prompt auto-reload of agents.sh.\n`);
  console.log(`2) Claude Code reach — add the repo to ~/.claude/settings.json:`);
  console.log("   " + JSON.stringify({ permissions: { additionalDirectories: [REPO] } }));
  console.log(`\n3) Session pointer — append to ~/.claude/CLAUDE.md:\n`);
  console.log(POINTER.split("\n").map((l) => "   " + l).join("\n"));
  console.log(`\nCapability check:`);
  console.log(`   cursor-agent (for --cli cursor / --model): ${cursorReady ? "✓ found on PATH" : "✗ not found — the Claude path works; install it later for the Cursor/Bedrock model picker"}`);
  console.log(`\n→ Re-run with --write to apply.\n`);
  process.exit(0);
}

// --- apply (idempotent) ---
if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

// 1) shell rc
const rc = rcFile();
const rcText = existsSync(rc) ? readFileSync(rc, "utf8") : "";
if (rcText.includes(sourceLine)) {
  console.log(`✓ ${rc} already sources the agent commands (current) — no change`);
} else if (rcText.includes(SH_MARKER) || rcText.includes("# @eborjaa/synapse vault agent commands")) {
  // an outdated agent-commands line exists — replace it in place (self-heal)
  const updated = rcText.split("\n").map((l) =>
    (l.includes(SH_MARKER) || l.includes("# @eborjaa/synapse vault agent commands")) ? sourceLine : l
  ).join("\n");
  writeFileSync(rc, updated);
  console.log(`✓ updated the (outdated) agent-commands line in ${rc}`);
} else {
  appendFileSync(rc, (rcText && !rcText.endsWith("\n") ? "\n" : "") + "\n" + sourceLine + "\n");
  console.log(`✓ added agent commands to ${rc} (sources agents.sh)`);
}

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
