#!/usr/bin/env node
// install.mjs — one-step setup for the Synapse CLI (PATH + optional shell completion).
//
//   node _meta/tools/install.mjs           # dry-run
//   node _meta/tools/install.mjs --write    # apply (idempotent — safe to re-run)
//
// --write does three things ONCE (never needed again when agents.sh changes):
//   1) ensures ~/synapse/bin/ has _dispatch + symlinks (self-locating — no baked vault path)
//   2) adds ~/synapse/bin to PATH in your shell rc
//   3) sources bin/synapse-env.sh for TAB-completion in interactive shells
//   + wires Claude Code / OpenCode pointers (idempotent)
//
// Every bin/* command re-sources the live agents.sh, so script updates apply immediately.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, symlinkSync, chmodSync, unlinkSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const here  = dirname(fileURLToPath(import.meta.url));
const VAULT = resolve(here, "..", "..");
const REPO  = resolve(VAULT, "..");
const BIN   = join(REPO, "bin");
const write = process.argv.includes("--write");

const SH_MARKER   = "# Synapse vault agent commands";
const PATH_MARKER = "# Synapse bin PATH";
const envSh       = join(BIN, "synapse-env.sh");
const dispatch    = join(BIN, "_dispatch");

const VAULT_COMMANDS = [
  "vault-agents", "vault-mocs", "vault-profiles", "vault-models",
  "vault-cursor-models", "vault-reload", "vault-gate", "vault-bedrock",
];

function detectShell() {
  const shell = (process.env.SHELL || process.argv[0] || "").split("/").pop();
  if (shell === "fish") return "fish";
  if (shell === "bash") return "bash";
  if (shell === "zsh")  return "zsh";
  return null;
}

function discoverAgentNames() {
  const names = new Set();
  for (const dir of [join(REPO, "synapse-framework"), join(REPO, "synapse-vault")]) {
    const agentsDir = join(dir, "agents");
    if (!existsSync(agentsDir)) continue;
    for (const f of readdirSync(agentsDir)) {
      const m = f.match(/^agent-(.+)\.md$/);
      if (m) names.add(m[1]);
    }
  }
  return [...names].sort();
}

function ensureBinLinks() {
  const results = [];
  if (!existsSync(dispatch)) {
    if (write) {
      console.error(`✗ missing ${dispatch} — commit synapse/bin/_dispatch first`);
      process.exit(1);
    }
    return results;
  }
  if (write) chmodSync(dispatch, 0o755);

  const commands = [...discoverAgentNames(), ...VAULT_COMMANDS];
  for (const name of commands) {
    const link = join(BIN, name);
    if (write) {
      try {
        if (existsSync(link)) unlinkSync(link);
      } catch { /* ignore */ }
      try {
        symlinkSync("_dispatch", link);
        results.push({ name, action: "linked" });
      } catch (e) {
        if (e.code === "EEXIST") results.push({ name, action: "exists" });
        else throw e;
      }
    } else {
      results.push({ name, action: existsSync(link) ? "exists" : "would link" });
    }
  }
  return results;
}

const shell = detectShell();
const shellCfg = shell ? {
  zsh:  { rc: join(homedir(), ".zshrc"),  path: `export PATH="$PATH:${BIN}"  ${PATH_MARKER}`, source: `source "${envSh}"  ${SH_MARKER}` },
  bash: { rc: join(homedir(), ".bashrc"), path: `export PATH="$PATH:${BIN}"  ${PATH_MARKER}`, source: `source "${envSh}"  ${SH_MARKER}` },
  fish: { rc: join(homedir(), ".config/fish/config.fish"), path: `fish_add_path ${BIN}  ${PATH_MARKER}`, source: `source ${envSh}  ${SH_MARKER}` },
}[shell] : null;

const claudeDir    = join(homedir(), ".claude");
const settingsPath = join(claudeDir, "settings.json");
const claudeMdPath = join(claudeDir, "CLAUDE.md");
const POINTER_MARKER = "# Synapse context vault";

function hasBinary(name) {
  try { execSync(`command -v ${name}`, { stdio: "ignore", shell: process.env.SHELL || "/bin/sh" }); return true; }
  catch { return false; }
}

console.log(`\nSynapse CLI install\n   repo:  ${REPO}\n   bin:   ${BIN}\n   shell: ${shell || "(unknown)"}\n`);

if (!write) {
  console.log("Dry-run — re-run with --write to apply:\n");
  console.log(`1) bin/ dispatch (already in repo) + symlinks for:`);
  for (const n of [...discoverAgentNames(), ...VAULT_COMMANDS]) console.log(`     ${n} → _dispatch`);
  console.log(`\n2) Shell PATH — add to ${shellCfg?.rc || "~/.zshrc"}:`);
  console.log(`     ${shellCfg?.path || `export PATH="$PATH:${BIN}"`}`);
  console.log(`3) Shell completion — source in rc:`);
  console.log(`     ${shellCfg?.source || `source "${envSh}"`}`);
  console.log(`\n   → bin/* re-sources agents.sh every call — no reinstall when scripts change.`);
  console.log(`   → vault resolves from $PWD; outside any vault → synapse-vault.\n`);
  process.exit(0);
}

if (!existsSync(BIN)) mkdirSync(BIN, { recursive: true });
for (const { name, action } of ensureBinLinks()) {
  console.log(`ok  bin/${name} ${action}`);
}

if (shellCfg) {
  const rcText = existsSync(shellCfg.rc) ? readFileSync(shellCfg.rc, "utf8") : "";
  if (rcText.includes(PATH_MARKER)) {
    console.log(`ok  ${shellCfg.rc} already has PATH — no change`);
  } else {
    appendFileSync(shellCfg.rc, (rcText && !rcText.endsWith("\n") ? "\n" : "") + "\n" + shellCfg.path + "\n");
    console.log(`ok  added PATH to ${shellCfg.rc}`);
  }
  const srcLine = shellCfg.source;
  if (rcText.includes(SH_MARKER)) {
    // self-heal outdated source lines
    if (!rcText.includes(srcLine) && rcText.includes(SH_MARKER)) {
      const updated = rcText.split("\n").map((l) => (l.includes(SH_MARKER) ? srcLine : l)).join("\n");
      writeFileSync(shellCfg.rc, updated);
      console.log(`ok  updated synapse-env source line in ${shellCfg.rc}`);
    } else {
      console.log(`ok  ${shellCfg.rc} already sources synapse-env — no change`);
    }
  } else {
    appendFileSync(shellCfg.rc, (readFileSync(shellCfg.rc, "utf8").endsWith("\n") ? "" : "\n") + "\n" + srcLine + "\n");
    console.log(`ok  added synapse-env source to ${shellCfg.rc}`);
  }
} else {
  console.log(`warn could not detect shell — add manually:\n     export PATH="$PATH:${BIN}"\n     source "${envSh}"`);
}

// Claude / OpenCode pointers (unchanged, idempotent)
const fwVault = join(REPO, "synapse-framework");
const pvVault = join(REPO, "synapse-vault");
const POINTER = `${POINTER_MARKER}
Synapse vaults: framework \`${fwVault}\`, private \`${pvVault}\`.
Render a briefing: node "<vault>/_meta/tools/render.mjs" <agent-id> [<target>] --profile <lean|standard|fat>
Shell agents (from anywhere): curator, reconciler, … — vault auto-resolves from cwd; default outside → synapse-vault.`;

if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
let settings = {};
if (existsSync(settingsPath)) {
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); }
  catch (e) { console.error(`✗ invalid ${settingsPath}: ${e.message}`); process.exit(1); }
}
settings.permissions ??= {};
const dirs = (settings.permissions.additionalDirectories ??= []);
let added = 0;
for (const d of [REPO, fwVault, pvVault]) {
  if (existsSync(d) && !dirs.includes(d)) { dirs.push(d); added++; }
}
if (added) {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`ok  added repo paths to ${settingsPath}`);
} else {
  console.log(`ok  settings.json already lists repo paths`);
}

const cMd = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8") : "";
if (!cMd.includes(POINTER_MARKER)) {
  appendFileSync(claudeMdPath, (cMd && !cMd.endsWith("\n") ? "\n" : "") + "\n" + POINTER + "\n");
  console.log(`ok  appended pointer to ${claudeMdPath}`);
} else {
  console.log(`ok  CLAUDE.md already has pointer`);
}

console.log(`\nDone. Open a new terminal (or exec $SHELL), then from ANY directory:`);
console.log(`   curator                    # uses synapse-vault (default outside a vault)`);
console.log(`   cd synapse-framework && curator   # uses framework`);
console.log(`   vault-agents`);
console.log(`\nScript updates apply immediately — no reinstall needed.`);
console.log(`Re-run install only when NEW agents are added (to create a symlink).`);
if (!hasBinary("cursor-agent")) console.log(`\nNote: install cursor-agent for --cli cursor`);
else console.log(`\ncursor-agent found — default model: auto (set SYNAPSE_CURSOR_MODEL to override)`);
console.log("");
