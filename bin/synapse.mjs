#!/usr/bin/env node
// synapse — CLI dispatcher. Routes `synapse <cmd> [args…]` to the lib tool, forwarding argv.
//
//   synapse render <id> …              render a briefing (the engine)
//   synapse augment <id> … --task "…"  render + semantic recall
//   synapse lint [--strict]            mechanical vault health-check
//   synapse embeddings [--all]         (re)build the embeddings cache
//   synapse embeddings-status          is the embeddings cache current with the corpus?
//   synapse index                      rebuild Markdown → SQL projections
//   synapse views                      regenerate SQL → Markdown derived views
//   synapse migrate [--status]         apply pending SQL migrations
//   synapse setup [--write]            probe/provision Ollama + embedding model
//   synapse install [--write]          wire the agents.sh CLI + editor dirs + harness skills
//   synapse skills [--write]           one SKILL.md per vault agent (/synapse-<agent> in the harness)
//   synapse journal "slug"             scaffold today's journal entry
//   synapse --help
//
// Each subcommand is a standalone lib/*.mjs run in-process via dynamic import; argv is rewritten so the
// tool sees its own flags unchanged. Locating the consumer vault is each tool's job (lib/vault-root.mjs).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib");

const CMDS = {
  render: "render.mjs",
  augment: "augment.mjs",
  lint: "lint.mjs",
  embeddings: "gen-embeddings.mjs",
  "embeddings-status": "index-freshness.mjs", // NOTE: the EMBEDDINGS cache, not `synapse index` (SQL projections)
  index: "gen-index.mjs",
  views: "gen-views.mjs",
  migrate: "apply-migrations.mjs",
  setup: "setup.mjs",
  install: "install.mjs",
  journal: "journal-new.mjs",
  new: "new-note.mjs",
  "mcp-config": "mcp-config.mjs",
  skills: "skills.mjs", // one harness SKILL.md per agent THIS vault defines (/synapse-<agent>)
  init: "init.mjs",
  "spawn-emit": "spawn-emit.mjs", // doer side of durable-spawn (append a status line)
  "handover-task": "note-as-task.mjs", // resolve a note (a handover) into a task string
  man: "man.mjs", // the full manual (launcher grammar + subcommands + memory tools)
};

const [cmd, ...rest] = process.argv.slice(2);

// `synapse --version` — the first thing anyone reaches for after an upgrade to check it landed.
if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  const { createRequire } = await import("node:module");
  console.log(createRequire(import.meta.url)("../package.json").version);
  process.exit(0);
}

if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(`synapse — context-vault engine (@eborja/synapse)

usage: synapse <command> [args…]

  --version              the engine version currently installed here

commands:
  render <id> …          render a role-based briefing (see: synapse render --help)
  augment <id> … --task  render + semantic recall (needs Ollama; degrades gracefully)
  lint [--strict]        mechanical vault health-check
  embeddings [--all]     (re)build the local embeddings cache
  embeddings-status      is that cache current? [--json] [--refresh] [--force] [--fast]
  handover-task <ref>    print a note (a handover) as a task string [--plain]
  index                  rebuild Markdown → SQL projections (notes / note_links / plans)
  views                  regenerate SQL → Markdown derived views (contacts / accounts / summaries)
  migrate [--status]     apply pending migrations/NNNN-*.sql (the only DB writer)
  setup [--write]        probe/provision the semantic runtime (Ollama + embedding model)
  install [--write]      wire the agents.sh CLI + editor dirs + harness skills (dry-run
                         without --write)
  journal "slug"         scaffold journal/<date>-<slug>.md for a work-session log
  man                    the FULL manual — launcher grammar, subcommands, memory tools, env
  new <kind> <name>      scaffold a wired note: hub | agent | note | handover
                         (dry-run; --write to create — see: synapse new --help)
  init [dir] [--write]   scaffold a new vault from the notes this package ships
  mcp-config [--write]   generate .mcp.json / .cursor/mcp.json for THIS vault
                         (points at the vault's own synapse-mcp bin; plugins auto-discovered)
  skills [--write]       generate one harness SKILL.md per agent THIS vault defines, so
                         /synapse-<agent> works for your own roster (see: synapse skills --help)

Shell-only subcommands (agents · hubs · profiles · models · bedrock · reload · gate)
and the agent launchers (curator · oracle · reconciler · ingester) live in the sourced
CLI (agents.sh) — run 'synapse install --write' once, then 'synapse help'.

Locate the vault via $SYNAPSE_VAULT or by running inside a vault that has
  _meta/tools/context.manifest.json          (flat layout)
  context-vault/_meta/tools/context.manifest.json  (nested layout)`);
  process.exit(cmd ? 0 : 2);
}

const file = CMDS[cmd];
if (!file) {
  console.error(`synapse: unknown command "${cmd}". Run 'synapse --help'.`);
  process.exit(2);
}

// Rewrite argv so the delegated tool sees `node <tool> <rest…>` and its own arg parsing works unchanged.
process.argv = [process.argv[0], join(LIB, file), ...rest];
await import(join(LIB, file));
