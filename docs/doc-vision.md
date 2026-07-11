---
id: doc-vision
type: doc
title: Synapse — vision, goals, and non-goals
tags:
  - type/doc
  - area/architecture
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# Synapse — vision

A **private, local-first personal knowledge system**: a second brain an LLM reads from and writes to,
where you own the data and an agent keeps it healthy. Knowledge lives as Markdown; records live as SQL;
one ontology joins them; every change is a reviewable diff.

## North star
One place that holds your **knowledge** (prose) and your **records** (structured data), that an LLM can
read for context and write to **through a reviewable gate** — running entirely on hardware you control.

## Goals
- **Local-first & private.** Local models (Ollama) + a local chat UI, reachable only over Tailscale. No
  public endpoint, no SaaS dependency for the core loop ([[doc-security-privacy]]).
- **Single source of truth.** One fact, one place: Markdown for knowledge, SQL for records; generated
  projections keep the two in sync without duplication ([[doc-storage-model]]).
- **Agent-maintained.** A steward agent keeps the graph schema-clean and the views current, proposing
  every change as a diff a human merges ([[doc-governance-model]]).
- **Capture-first.** Freeform capture (especially from a phone) lands in `inbox/`; an ingester routes
  prose to notes and records to rows, carrying provenance ([[doc-capture-pipeline]]).
- **LLM/data-agnostic & open-source-ready.** The pattern is portable across models and domains; the
  agent runtime is config-driven, not tied to one vendor.

## Non-goals
- **No public/cloud endpoint, ever.** Access is the Tailnet, full stop.
- **No unattended mutation.** The agent proposes; a human merges ([[rule-no-unprompted-actions]]).
- **Not a database app or a forms UI.** Capture is freeform; structure is derived.
- **Not tied to one model or vendor.**

## System context
Obsidian (author Markdown) · a private git repo (version history + the PR gate) · SQLite (records) · the
render engine (deterministic briefings) + linter (mechanical health) · a config-driven agent runtime
(the curator / reconciler / ingester) · Ollama + a local chat UI for read/query (RAG over Markdown +
read-only text-to-SQL) · Tailscale (the only access path).

## Related
[[conventions]] · [[doc-storage-model]] · [[doc-governance-model]] · [[doc-agent-architecture]] · [[doc-capture-pipeline]] · [[hub-synapse]]
