#!/usr/bin/env node
// install.mjs — one-step setup for the Synapse context-vault CLI + OpenCode wiring.
//
// The vault lives in-repo; the fiddly part is wiring the shell + the OpenCode runtime to it.
//
//   node _meta/tools/install.mjs           # dry-run: print what it WOULD add (safe, prints only)
//   node _meta/tools/install.mjs --write    # apply it (idempotent — safe to re-run)
//
// --write does three things:
//   1) generates standalone launcher scripts in _meta/tools/bin/ (shell-agnostic)
//   2) adds that bin/ dir to your PATH via the correct shell rc file
//   3) appends a short Synapse pointer to your OpenCode global instructions
//      (~/.config/opencode/AGENTS.md if that dir exists, else the repo-root AGENTS.md),
//      telling the runtime to render a briefing on demand instead of reading files ad-hoc.
//
// Zero dependencies. Does NOT touch any model config or secrets — your endpoint/model/key live in
// ~/.config/opencode/opencode.json, which this script never reads or writes. No API key anywhere.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

const here  = dirname(fileURLToPath(import.meta.url));
const VAULT = resolve(here, "..", "..");              // _meta/tools -> vault root
const BIN   = join(VAULT, "_meta", "tools", "bin");
const write = process.argv.includes("--write");

// Shell detection — $SHELL is the login shell; fallback to $0 if needed.
function detectShell() {
  const shell = (process.env.SHELL || process.argv[0] || "").split("/").pop();
  if (shell === "fish") return "fish";
  if (shell === "bash") return "bash";
  if (shell === "zsh")  return "zsh";
  return null;
}

const SHELL_CONFIGS = {
  fish: {
    rcFile:     () => join(homedir(), ".config/fish/config.fish"),
    pathLine:   `set -gx PATH $PATH ${BIN}  # Synapse vault PATH`,
    pathMarker: "# Synapse vault PATH",
  },
  bash: {
    rcFile:     () => join(homedir(), ".bashrc"),
    pathLine:   `export PATH="$PATH:${BIN}"  # Synapse vault PATH`,
    pathMarker: "# Synapse vault PATH",
  },
  zsh: {
    rcFile:     () => join(homedir(), ".zshrc"),
    pathLine:   `export PATH="$PATH:${BIN}"  # Synapse vault PATH`,
    pathMarker: "# Synapse vault PATH",
  },
};

const POINTER_MARKER = "# Synapse context vault";
const POINTER = `${POINTER_MARKER}
The Synapse vault lives at \`${VAULT}\`. When asked to act as a named agent (e.g. "act as agent-curator"),
render its bundled briefing instead of reading files ad-hoc:
    node "${VAULT}/_meta/tools/render.mjs" <agent-id> [<target-id>] --profile <lean|standard|fat>
The briefing carries the agent's rules, tools, skills, and conventions. Launch agents with:
    opencode run -m <model> --dir "${VAULT}" "<rendered briefing>"
Model and endpoint come from ~/.config/opencode/opencode.json (local Ollama over Tailscale — no API key).
Canary: address the user by name at least once every turn.`;

const ocDir         = join(homedir(), ".config", "opencode");
const ocAgentsMd    = join(ocDir, "AGENTS.md");
const repoAgentsMd  = join(VAULT, "AGENTS.md");
const agentsMdPath  = existsSync(ocDir) ? ocAgentsMd : repoAgentsMd;

// Generate launcher scripts from .tmpl files, substituting the vault path.
// Idempotent: only writes if the content would change.
function generateLaunchers() {
  const tmplDir = BIN;
  if (!existsSync(tmplDir)) mkdirSync(tmplDir, { recursive: true });

  const templates = readdirSync(tmplDir).filter((f) => f.endsWith(".tmpl"));
  if (templates.length === 0) return [];

  const results = [];
  for (const tmpl of templates) {
    const name  = tmpl.replace(/\.tmpl$/, "");
    const path  = join(tmplDir, name);
    const text  = readFileSync(join(tmplDir, tmpl), "utf8")
                    .replace(/@@VAULT_PATH@@/g, VAULT);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (existing !== text) {
      if (write) {
        writeFileSync(path, text);
        chmodSync(path, 0o755);
      }
      results.push({ name, action: existing === null ? "created" : "updated" });
    } else {
      results.push({ name, action: "current" });
    }
  }
  return results;
}

// ── main ──────────────────────────────────────────────────────────────────────

const shell = detectShell();
const shellCfg = shell ? SHELL_CONFIGS[shell] : null;

console.log(`\nSynapse context vault\n   vault: ${VAULT}\n   shell: ${shell || "(unknown)"}\n`);

if (!write) {
  console.log("Dry-run — re-run with --write to apply:\n");
  if (shellCfg) {
    console.log(`1) Shell PATH — add to ${shellCfg.rcFile()}:`);
    console.log(`     ${shellCfg.pathLine}\n`);
  } else {
    console.log("1) Shell PATH — could not detect your shell ($SHELL="
      + `${process.env.SHELL}). Manually add to your shell rc:`);
    console.log(`     export PATH="$PATH:${BIN}"\n`);
  }
  console.log(`2) OpenCode pointer — append to ${agentsMdPath}:`);
  console.log(POINTER.split("\n").map((l) => "   " + l).join("\n"));
  console.log(`\n-> Re-run with --write to apply.\n`);
  process.exit(0);
}

// --- apply (idempotent) ---

// 1) generate launcher scripts
const tmplDir = BIN;
if (!existsSync(tmplDir)) mkdirSync(tmplDir, { recursive: true });
const templates = readdirSync(tmplDir).filter((f) => f.endsWith(".tmpl"));
if (templates.length > 0) {
  const results = generateLaunchers();
  for (const { name, action } of results) {
    console.log(`ok  bin/${name} ${action}`);
  }
} else {
  console.log(`ok  no bin/*.tmpl found — skipping launcher generation`);
}

// 2) shell rc — PATH line
if (shellCfg) {
  const rc = shellCfg.rcFile();
  const rcText = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  if (rcText.includes(shellCfg.pathMarker)) {
    console.log(`ok  ${rc} already has the PATH line — no change`);
  } else {
    appendFileSync(rc, (rcText && !rcText.endsWith("\n") ? "\n" : "") + "\n" + shellCfg.pathLine + "\n");
    console.log(`ok  added PATH line to ${rc}`);
  }
} else {
  console.log(`warn could not detect shell — skipped rc update. Manually add to your shell rc:`);
  console.log(`     export PATH="$PATH:${BIN}"`);
}

// 3) OpenCode AGENTS.md pointer
if (agentsMdPath === ocAgentsMd && !existsSync(ocDir)) mkdirSync(ocDir, { recursive: true });
const md = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, "utf8") : "";
if (md.includes(POINTER_MARKER)) {
  console.log(`ok  ${agentsMdPath} already has the Synapse pointer — no change`);
} else {
  appendFileSync(agentsMdPath, (md && !md.endsWith("\n") ? "\n" : "") + "\n" + POINTER + "\n");
  console.log(`ok  appended the Synapse pointer to ${agentsMdPath}`);
}

console.log(`\nDone. ${templates.length > 0 ? `Open a new terminal (or 'exec $SHELL'), then:\n\n  vault-agents   # verify all commands are on PATH\n  curator        # try the curator agent\n` : ""}`);
