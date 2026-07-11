---
id: tool-opencode
type: tool
title: OpenCode — the local, config-driven agent runtime
tags:
  - type/tool
  - area/meta
  - status/active
---

# tool-opencode

The **agent runtime**. OpenCode (`opencode-ai`) is the headless harness that runs the Synapse agents
against local models, keeping the whole core loop private and vendor-neutral
([[decision-0004-opencode-local-ollama-runtime]]).

## What it is
A config-driven CLI runtime (`~/.config/opencode/opencode.json`) pointed at a local model server — Ollama
over Tailscale, an OpenAI-compatible endpoint — so there is **no API key, no cloud, no subscription** in
the core loop. Model choice is one line of config, which is how the system stays LLM-agnostic: swap
models without touching the vault.

## How it is used in Synapse
An agent is launched headlessly with a deterministic briefing piped from the render engine
([[tool-render]]):

```sh
opencode run -m ollama/qwen3.6-256k --dir . \
  "$(synapse render agent-curator loop-maintain-synapse --profile standard)"
```

The nightly maintenance loop ([[loop-maintain-synapse]]) drives the curator this way from cron/launchd.
Crucially, agents run under OpenCode's **permission config** (read freely; edits and shell gated) plus
the human-gated PR — never blanket `--dangerously-skip-permissions`, which would be unsafe for a
finances-bearing vault. Detection runs read-only (Plan); only the autofix step edits (Build).

## Related
[[decision-0004-opencode-local-ollama-runtime]] · [[doc-agent-architecture]] · [[tool-render]] · [[loop-maintain-synapse]]
