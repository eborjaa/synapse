---
id: doc-runtime-wiring
type: doc
title: Runtime wiring — OpenCode, local Ollama over Tailscale, and the vault
tags:
  - type/doc
  - area/runtime
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# Runtime wiring

How the Synapse agent runtime physically connects: **OpenCode** (the CLI) talks to **Ollama** running on a
local machine, reached over **Tailscale**, and is pointed at this **vault** — where it renders role-based
briefings, does RAG over the Markdown, and queries records through a read-only SQLite path. The decision
behind this is [[decision-0004-opencode-local-ollama-runtime]]; the schema it reads is [[conventions]].

```
   OpenCode (client)  ──── Tailscale (encrypted) ────▶  Ollama (server, on the LAN box)
        │                                                   running the local model on GPU
        ├─ --dir <vault> ─▶ Markdown-in-Git  (render briefings + read notes + semantic recall)
        ├─ embeddings (same Ollama) ─▶ note_vectors in db/synapse.db  (semantic recall, opt-in)
        └─ read-only query ─▶ SQLite db/synapse.db  (records: contacts, accounts, finances, …)
```

## The CLI is pluggable (`--cli`)

OpenCode is the **default** sink, not the only one. The shell CLI (packaged `agents.sh`, wired by
`synapse install`) renders the
same role-based briefing and then hands it to whichever runtime you pick with `--cli` (or
`export SYNAPSE_CLI=…`): **`opencode`** (local Ollama, below), **`claude`** (Claude Code, scoped to the repo
dir and seeded with the briefing — its own model, keys, and config), **`cursor`**, or **`clip`/`print`** (copy to
clipboard / write to stdout, to paste or pipe into any tool). The render + semantic pipeline is identical
for every sink; only the final hand-off differs — so you can maintain the **public engine** with a
powerful cloud CLI while a **private vault** stays on local OpenCode, using the same commands. Any host
privacy gate still applies to whichever CLI you launch ([[doc-deployment-gate]]).

> **Roadmap — out of scope for now.** First-class multi-CLI and external-API-key support — per-CLI model
> and permission config, an installer that wires more than OpenCode, and a connector for hosted APIs — is a
> documented future direction that would make Synapse a truly runtime-agnostic open template. The `--cli`
> selector is the minimal wiring toward it; the sections below describe the reference OpenCode runtime.

## OpenCode ↔ Ollama (over Tailscale)

The model and endpoint are **not** committed here — they live in the user's own
`~/.config/opencode/opencode.json`, which declares an OpenAI-compatible `ollama` provider whose
`baseURL` points at the local server's Tailscale hostname on the Ollama port, plus the model ids and
their context limits. The default model is `ollama/qwen3.6-256k` (a large-context local model); a larger
model is the heavy-reasoning fallback. The server box must be awake for any agent to run. There is **no
ANTHROPIC_API_KEY, no cloud endpoint, and no subscription** in the core loop — inference is fully local.
Do not hardcode the Tailnet hostname or any secret into committed files; reference the user's config.

## Vault: render briefings + RAG over Markdown

OpenCode is scoped to the vault with `--dir <vault>`. Agents do not read files ad-hoc: they render a
**role-based briefing** with the engine ([[tool-render]]) —
`synapse render <agent> [<target>] --profile <lean|standard|fat>` — which walks the manifest
role closure and concatenates the linked note bodies into one context blob. Beyond the briefing, the
model retrieves over the Markdown corpus (grep/read within `--dir`) as a lightweight RAG source. The
manifest ([[conventions]]) is the single ontology both the renderer and the linter ([[tool-lint]]) obey.

**Semantic RAG over Markdown is now built** as an opt-in second phase ([[doc-semantic-recall]]): `augment.mjs`
embeds the task, cosine-ranks notes the deterministic closure missed, and appends a labeled "semantically
related" section. The embeddings come from the **same local Ollama over Tailscale** shown above
([[tool-ollama-embeddings]]) — no new endpoint, no API key — and the vectors live in a generated
`note_vectors` table in `db/synapse.db`. The deterministic render stays pure; the augment is additive and
non-authoritative ([[rule-semantic-suggests-links-decide]]).

## The read-only SQLite query path

Records (contacts, accounts, finances, health, locations) are canonical in **SQLite** (`db/synapse.db`).
Agents reach them through a **read-only** query path (text-to-SQL over a read-only connection) and through
the regenerated Markdown derived views. They **never** write the DB. Any record change is proposed as a
**migration** in a PR and applied by a human-gated apply step — never executed inline
([[decision-0003-human-gated-mutation]]). This is why the maintainer is safe to run unattended.

## How agents launch

The packaged shell helpers (`agents.sh`, after `synapse install`) generate one command per
`agents/agent-*.md` (function name = id minus `agent-`): `curator`, `reconciler`, `ingester`, `oracle`.
Each renders the agent's briefing (and any target's) and launches the chosen `--cli`. Discovery:
`synapse agents` · `synapse hubs` · `synapse help`. The nightly maintainer
(`_meta/tools/maintain-synapse-cron.sh`) does the same headlessly for [[agent-curator]] running
[[loop-maintain-synapse]], via the executable command `.opencode/command/maintain-synapse.md`.

## Permission posture

The maintainer runs **without** `--dangerously-skip-permissions` — that would be unsafe for a
finances-bearing vault. Instead, two layers gate every mutation:

1. **OpenCode permission config** (in `opencode.json`): read tools allowed, but `edit` and `bash` set to
   `ask`/`deny` (e.g. allow `git`/`gh` and the read-only query, deny direct `db/synapse.db` writes). Read
   freely; act narrowly.
2. **Human-gated PR** ([[decision-0003-human-gated-mutation]]): the agent opens a branch + PR to `main`
   and stops. A human reviews and merges. The agent never force-pushes, never pushes to `main`, never
   self-merges.

Together they mean the worst case of an unattended nightly run is a reviewable PR, never a silent write.

## Open WebUI — optional, unconfirmed

A separate **Open WebUI** front-end (a browser chat/RAG UI over the same local Ollama) is an **optional,
not-yet-configured** add-on. It would be read-only with respect to the vault and is out of scope for the
core loop; whether to add it is unresolved and flagged in
[[decision-0004-opencode-local-ollama-runtime]].

## Related

[[decision-0004-opencode-local-ollama-runtime]] · [[decision-0003-human-gated-mutation]] · [[doc-agent-architecture]] · [[doc-maintainer-loop]] · [[doc-security-privacy]] · [[doc-semantic-recall]] · [[loop-maintain-synapse]] · [[tool-render]] · [[tool-lint]] · [[tool-ollama-embeddings]]
