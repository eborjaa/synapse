#!/usr/bin/env node
// install.mjs — one-step setup for the Synapse context-vault CLI + OpenCode wiring.
//
// The vault lives in-repo; the fiddly part is wiring the shell + the OpenCode runtime to it.
//
//   node _meta/tools/install.mjs           # dry-run: print what it WOULD add (safe, prints only)
//   node _meta/tools/install.mjs --write    # apply it (idempotent — safe to re-run)
//
// --write does two idempotent things:
//   1) sources _meta/tools/agents.sh in your shell rc, baking in the absolute vault path
//      → short agent commands (curator, reconciler, ingester, …)
//   2) appends a short Synapse pointer to your OpenCode global instructions
//      (~/.config/opencode/AGENTS.md if that dir exists, else the repo-root AGENTS.md),
//      telling the runtime to render a briefing on demand instead of reading files ad-hoc.
//
// Zero dependencies. Does NOT touch any model config or secrets — your endpoint/model/key live in
// ~/.config/opencode/opencode.json, which this script never reads or writes. No API key anywhere.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

const here  = dirname(fileURLToPath(import.meta.url));
const VAULT = resolve(here, "..", "..");              // _meta/tools -> vault root
const write = process.argv.includes("--write");

const agentsSh   = join(VAULT, "_meta", "tools", "agents.sh");
const SH_MARKER  = "# Synapse vault agent commands";
// agents.sh resolves the vault per-call from $PWD (directory-agnostic) and self-detects its
// own "home" vault at source time, so no path is hardcoded in normal use. We still bake the
// absolute SYNAPSE_VAULT here as a SAFETY NET — the fallback for shells / direnv setups where
// self-detection (%x / BASH_SOURCE) comes back empty. (The `source "<abs path>"` is mandatory:
// a shell rc can't source a relative path reliably at startup.)
const sourceLine = `export SYNAPSE_VAULT="${VAULT}"; source "${agentsSh}"  ${SH_MARKER}`;

// OpenCode reads ~/.config/opencode/AGENTS.md (global) and the repo-root AGENTS.md (project).
// Prefer the global one if its dir exists; otherwise fall back to the in-repo project file.
const ocDir         = join(homedir(), ".config", "opencode");
const ocAgentsMd    = join(ocDir, "AGENTS.md");
const repoAgentsMd  = join(VAULT, "AGENTS.md");
const agentsMdPath  = existsSync(ocDir) ? ocAgentsMd : repoAgentsMd;

const POINTER_MARKER = "# Synapse context vault";
const POINTER = `${POINTER_MARKER}
The Synapse vault lives at \`${VAULT}\`. When asked to act as a named agent (e.g. "act as agent-curator"),
render its bundled briefing instead of reading files ad-hoc:
    node "${VAULT}/_meta/tools/render.mjs" <agent-id> [<target-id>] --profile <lean|standard|fat>
The briefing carries the agent's rules, tools, skills, and conventions. Launch agents with:
    opencode run -m <model> --dir "${VAULT}" "<rendered briefing>"
Model + endpoint come from ~/.config/opencode/opencode.json (local Ollama over Tailscale — no API key).
Canary: address the user by name at least once every turn.`;

function rcFile() {
  const shell = process.env.SHELL || "";
  if (shell.includes("bash")) {
    const bp = join(homedir(), ".bash_profile");
    return process.platform === "darwin" && existsSync(bp) ? bp : join(homedir(), ".bashrc");
  }
  return join(homedir(), ".zshrc"); // zsh default (macOS)
}

console.log(`\nSynapse context vault\n   vault: ${VAULT}\n`);

if (!write) {
  console.log("Dry-run — re-run with --write to apply both:\n");
  console.log(`1) Shell commands — source agents.sh in ${rcFile()}:`);
  console.log(`     ${sourceLine}\n`);
  console.log(`2) OpenCode pointer — append to ${agentsMdPath}:\n`);
  console.log(POINTER.split("\n").map((l) => "   " + l).join("\n"));
  console.log(`\n-> Re-run with --write to apply.\n`);
  process.exit(0);
}

// --- apply (idempotent) ---

// 1) shell rc
const rc = rcFile();
const rcText = existsSync(rc) ? readFileSync(rc, "utf8") : "";
if (rcText.includes(sourceLine)) {
  console.log(`ok  ${rc} already sources the agent commands (current) — no change`);
} else if (rcText.includes(SH_MARKER)) {
  // an outdated agent-commands line exists — replace it in place (self-heal)
  const updated = rcText.split("\n").map((l) => (l.includes(SH_MARKER) ? sourceLine : l)).join("\n");
  writeFileSync(rc, updated);
  console.log(`ok  updated the (outdated) agent-commands line in ${rc}`);
} else {
  appendFileSync(rc, (rcText && !rcText.endsWith("\n") ? "\n" : "") + "\n" + sourceLine + "\n");
  console.log(`ok  added agent commands to ${rc} (sources agents.sh)`);
}

// 2) OpenCode AGENTS.md pointer
if (agentsMdPath === ocAgentsMd && !existsSync(ocDir)) mkdirSync(ocDir, { recursive: true });
const md = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, "utf8") : "";
if (md.includes(POINTER_MARKER)) {
  console.log(`ok  ${agentsMdPath} already has the Synapse pointer — no change`);
} else {
  appendFileSync(agentsMdPath, (md && !md.endsWith("\n") ? "\n" : "") + "\n" + POINTER + "\n");
  console.log(`ok  appended the Synapse pointer to ${agentsMdPath}`);
}

console.log(`\nDone. Run 'exec $SHELL' (or open a new terminal), then 'vault-agents' to see your commands.\n`);
