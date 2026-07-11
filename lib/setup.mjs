#!/usr/bin/env node
// setup.mjs — provision the RUNTIME prerequisites for synapse's semantic tools (augment/embeddings).
//
//   synapse setup             # probe; on a TTY, offer to install Ollama / pull the model (opt-in, default No)
//   synapse setup --write     # non-interactive: auto-accept (install Ollama if missing, pull the model)
//   synapse setup --yes       # alias for auto-accept prompts (same as --write for the accept decision)
//   synapse setup --no-input  # force advisory-only: never prompt, just print remediation (CI default)
//
// This is the "runtime prerequisites" step, distinct from `synapse install` (which wires your SHELL +
// editor to the vault) and from `npm install` (which installs the package CODE). The deterministic core
// — render / lint / journal / traceability — needs NONE of this; only augment + embeddings use Ollama.
//
// Philosophy (matches the rest of synapse): opt-in + idempotent, fail loudly, never SILENTLY mutate the
// system. On an interactive TTY it PROMPTS before installing Ollama or pulling the model (default No);
// off a TTY (CI, pipes) or with --no-input it stays advisory — printing the exact commands, exit non-zero.
// --write / --yes auto-accept. Ollama itself is installed via its own platform command; we never sudo.

import { execSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveEmbedModel, resolveOllamaBase } from "./gen-embeddings.mjs";

const autoYes = process.argv.includes("--write") || process.argv.includes("--yes") || process.argv.includes("-y");
const noInput = process.argv.includes("--no-input");
const base = resolveOllamaBase();
const model = resolveEmbedModel();

const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => console.log(`  ✗ ${m}`);
const info = (m) => console.log(`    ${m}`);

// Interactive only when: stdin is a TTY, not piped, and --no-input wasn't passed. --write/--yes skips the
// prompt by auto-accepting. Off a TTY we never block (CI-safe) — we print remediation and exit non-zero.
const interactive = process.stdin.isTTY && !noInput;
async function confirm(question) {
  if (autoYes) return true;          // --write / --yes → accept without asking
  if (!interactive) return false;    // non-TTY / --no-input → advisory (don't act)
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await new Promise((res) => rl.question(`    ${question} [y/N] `, res))).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally { rl.close(); }
}

console.log(`\n🔌 synapse setup — semantic-tool runtime prerequisites`);
console.log(`   Ollama base: ${base}`);
console.log(`   embed model: ${model}\n`);

let ollamaOnPath = false;
try { execSync("command -v ollama", { stdio: "ignore", shell: process.env.SHELL || "/bin/sh" }); ollamaOnPath = true; } catch { /* not found */ }

function ollamaInstall() {
  // Returns { cmd, run } for the current platform — `run` executes it inheriting stdio.
  if (process.platform === "darwin") return { cmd: "brew install ollama", run: () => spawnSync("brew", ["install", "ollama"], { stdio: "inherit" }) };
  if (process.platform === "linux") return { cmd: "curl -fsSL https://ollama.com/install.sh | sh", run: () => spawnSync("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], { stdio: "inherit" }) };
  return { cmd: "see https://ollama.com/download", run: null };
}

async function serverReachable() {
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// ── probe ───────────────────────────────────────────────────────────────────
let tags = await serverReachable();
let modelPresent = false;

if (ollamaOnPath) ok("Ollama CLI found on PATH");
else no("Ollama CLI not on PATH");
if (tags) ok(`Ollama server reachable at ${base}`);
else no(`Ollama server not reachable at ${base}`);

// ── act: install Ollama if absent ────────────────────────────────────────────
if (!ollamaOnPath && !tags) {
  const { cmd, run } = ollamaInstall();
  console.log("");
  if (run && await confirm(`Ollama is not installed. Install it now via \`${cmd}\`?`)) {
    console.log(`\n→ Installing Ollama…`);
    const r = run();
    if (r.status === 0) { ok("Ollama installed"); ollamaOnPath = true; }
    else no(`install failed (exit ${r.status ?? r.error?.message}) — run manually: ${cmd}`);
    // A fresh install may need the server started; re-probe.
    tags = await serverReachable();
    if (!tags) info(`start the server if needed: 'ollama serve' (or launch the Ollama app), then re-run 'synapse setup'`);
  } else {
    console.log(`→ Install Ollama, then re-run 'synapse setup':`);
    info(cmd);
    info(`(override the URL with $SYNAPSE_OLLAMA_URL / model with $SYNAPSE_EMBED_MODEL)`);
  }
} else if (ollamaOnPath && !tags) {
  // Installed but the server isn't answering — the fix is to start it, not to reinstall.
  console.log(`\n→ Ollama is installed but the server isn't reachable at ${base}. Start it and re-run 'synapse setup':`);
  info(`ollama serve   (or launch the Ollama app; override the URL with $SYNAPSE_OLLAMA_URL)`);
}

// ── probe model (now that the server may be up) ──────────────────────────────
if (tags) {
  const names = (tags.models || []).map((m) => m.name || m.model || "");
  modelPresent = names.some((n) => n === model || n.startsWith(model + ":") || n.split(":")[0] === model);
  if (modelPresent) ok(`embedding model "${model}" is pulled`);
  else no(`embedding model "${model}" is NOT pulled`);
}

// ── act: pull the model if absent ────────────────────────────────────────────
if (tags && !modelPresent) {
  console.log("");
  if (await confirm(`Pull the embedding model "${model}" now (a few minutes)?`)) {
    console.log(`\n→ Pulling "${model}"…`);
    const r = spawnSync("ollama", ["pull", model], { stdio: "inherit" });
    if (r.status === 0) { ok(`pulled "${model}"`); modelPresent = true; }
    else no(`'ollama pull ${model}' failed (exit ${r.status ?? r.error?.message}) — run it manually`);
  } else {
    console.log(`→ To pull the model later:`);
    info(`ollama pull ${model}`);
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────
const go = !!tags && modelPresent;
console.log(`\n${go ? "✅ GO" : "⚠️  NOT READY"} — semantic recall (augment) & embeddings ${go ? "are ready to use." : "are unavailable until the above is resolved."}`);
if (!go) console.log(`   (The deterministic tools — render / lint / journal / traceability — work regardless.)`);
console.log("");
process.exit(go ? 0 : 1);
