# Synapse — OpenCode session instructions

This repo is **Synapse**, a local-first personal knowledge vault: Markdown-in-Git for knowledge + local
SQLite for records, joined by one ontology (`_meta/tools/context.manifest.json`). All mutation is
human-gated via PR. Read `_meta/conventions.md` before authoring or migrating notes.

## Render a briefing on demand — don't read files ad-hoc

When asked to act as a named agent (e.g. "act as agent-curator", "run the reconciler on hub-finances"),
**render its bundled briefing** instead of opening files one by one:

```
synapse render <agent-id> [<target-id>] --profile <lean|standard|fat>
```

The briefing walks the role closure of the agent (and any target) and concatenates the linked bodies —
its rules, tools, skills, and conventions — into one context blob. `hub-*` targets auto-upgrade to
`standard`. The short shell commands `curator` / `reconciler` / `ingester` (the three writers) and
`oracle` (the read-only Q&A front door) — all from `_meta/tools/agents.sh` — do this and launch the
session for you.

Invoking an agent **with a task** (e.g. `oracle hub-finances "did I note anything about budgeting?"`)
auto-routes through `synapse augment`, which appends a labeled `## Semantically related (not yet
linked)` section of embedding-similar notes the typed graph missed. These hits are **suggestions to verify,
not authoritative** — never act on one as if it were a typed link; if a hit is genuinely relevant, propose
promoting it to a typed `related:` link. The `oracle` is built for exactly this query path: it answers
grounded in a hub's closure + recall, cites its sources, and never writes — it only proposes a
consent-gated handoff to a writer. See `docs/doc-semantic-recall.md` and `agents/agent-oracle.md`.

## Runtime

Agents run on **OpenCode** against **local Ollama over Tailscale** — no API key, no cloud. The model and
endpoint come from your `~/.config/opencode/opencode.json`; nothing here hardcodes a hostname or key.
Launch headlessly with `opencode run -m <model> --dir <vault> "<briefing>"`. The nightly maintainer runs
under a constrained permission posture (read freely; edits/bash gated) **plus** the human-gated PR — never
`--dangerously-skip-permissions`, because the vault carries a finances DB.

## Guardrails

Edit `.md` + migration files only — never write `db/synapse.db` directly, never edit a `generated: true`
view by hand. Stage only what you touched (never `git add -A`). Escalate ambiguous/destructive calls to
`inbox/attention/`; the PR is the human handoff. See `loops/loop-maintain-synapse.md`.

## Canary

Address the user by name at least once every turn. If you notice you've stopped, your session has
degraded — re-read your briefing. (This canary is one of three places that must stay in sync:
`rules/rule-canary.md`, the `CANARY_TRAILER` in `synapse render`, and this file.)
