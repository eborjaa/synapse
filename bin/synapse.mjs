#!/usr/bin/env node
// synapse — CLI dispatcher. Routes `synapse <cmd> [args…]` to the lib tool, forwarding argv.
//
//   synapse render <id> …              render a briefing (the engine)
//   synapse augment <id> … --task "…"  render + semantic recall
//   synapse lint [--strict]            mechanical vault health-check
//   synapse embeddings [--all]         (re)build the embeddings cache
//   synapse index                      rebuild Markdown → SQL projections
//   synapse views                      regenerate SQL → Markdown derived views
//   synapse migrate [--status]         apply pending SQL migrations
//   synapse setup [--write]            probe/provision Ollama + embedding model
//   synapse install [--write]          wire the agents.sh CLI + editor dirs
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
  index: "gen-index.mjs",
  views: "gen-views.mjs",
  migrate: "apply-migrations.mjs",
  setup: "setup.mjs",
  install: "install.mjs",
  journal: "journal-new.mjs",
};

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(`synapse — context-vault engine (@eborjaa/synapse)

usage: synapse <command> [args…]

commands:
  render <id> …          render a role-based briefing (see: synapse render --help)
  augment <id> … --task  render + semantic recall (needs Ollama; degrades gracefully)
  lint [--strict]        mechanical vault health-check
  embeddings [--all]     (re)build the local embeddings cache
  index                  rebuild Markdown → SQL projections (notes / note_links / plans)
  views                  regenerate SQL → Markdown derived views (contacts / accounts / summaries)
  migrate [--status]     apply pending migrations/NNNN-*.sql (the only DB writer)
  setup [--write]        probe/provision the semantic runtime (Ollama + embedding model)
  install [--write]      wire the agents.sh CLI + editor dirs (dry-run without --write)
  journal "slug"         scaffold journal/<date>-<slug>.md for a work-session log

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
