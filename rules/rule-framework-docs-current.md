---
id: rule-framework-docs-current
type: rule
title: Keep the framework's top-level overview docs current in the same change
tags:
  - type/rule
  - area/governance
  - status/active
provenance: ["the framework's top-level docs are its public face; stale overviews are drift", "Emmanuel 2026-06-17"]
---

**Rule:** The framework's overview and how-to docs must be brought current in the **same change** as any
framework-wide modification: engine/`@eborja/synapse` package behavior, CLI (`synapse <sub>` / `vault-*`),
agents, rules, domain hubs, runtime, governance, the privacy gate, or anything else that alters how the
system is described to a reader. A framework-wide change that leaves these docs describing the *old*
reality is **drift** — and the curator's detection pass ([[loop-maintain-synapse]]) should flag it,
treating stale docs as a valid reconcile target, not an out-of-scope file.

**Why:** Unlike typed vault notes, `README.md` / `TUTORIAL.md` / `CHANGELOG.md` (and much of `docs/`) are
easy to leave behind — the linter does not assert their prose against reality. They are the **public face**
of the engine: how to install the npm package, run `synapse …`, and understand the vault. Stale commands
(`node _meta/tools/…`, old type names, missing subcommands) silently mislead. Because nothing mechanical
fully guards prose, the discipline is a rule agents and humans carry ([[doc-governance-model]]).

**How to apply:**
- When a change is **framework-wide**, update in the **same** commit/PR:
  - Always for broad changes: `README.md`, `TUTORIAL.md`, `AGENTS.md`
  - When CLI/package/install changes: `docs/doc-cli-reference.md`, `docs/doc-fork-and-extend.md`,
    `CHANGELOG.md`
  - When runtime/`--cli` changes: `docs/doc-runtime-wiring.md`
  - When the engine dialect changes: `_meta/context-engine-guide.md`, `_meta/conventions.md`, relevant
    `tools/tool-*.md`
- Prefer examples that use `synapse <cmd>` (packaged CLI); keep `vault-*` only as maintained equals.
- On a maintenance pass, the [[agent-curator]] **detects** overview-doc drift — phrasings that contradict
  the current agent roster, CLI, package model, governance, or domains — and treats it as a reconcile
  target (minimal in-place edit), not a file to skip ([[loop-maintain-synapse]]).
- Keep edits concise and in the existing voice — reconcile to the truth; escalate a from-scratch rewrite.
- Confirm touched vault-note wikilinks still resolve; `synapse lint --strict` with `errors=0` still gates
  the rest of the change.

Related: [[doc-governance-model]] · [[agent-curator]] · [[loop-maintain-synapse]] · [[doc-cli-reference]] · [[doc-fork-and-extend]]
