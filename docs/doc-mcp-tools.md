---
id: doc-mcp-tools
type: doc
title: "MCP tools reference — every synapse_* tool, by surface"
tags:
  - type/doc
  - area/runtime
  - status/active
references_docs: ["[[conventions]]", "[[doc-agent-memory]]", "[[doc-cli-reference]]"]
related: ["[[hub-synapse]]", "[[decision-0010-mcp-2026-07-28-dual-era]]"]
---

# MCP tools reference

Synapse exposes its engine as an MCP server (`synapse-mcp`; wire a vault with `synapse mcp-config
--write`). **The SURFACE decides what a caller can do** — set it with `SYNAPSE_MCP_SURFACE` in the MCP
client config (`.mcp.json`). Each surface is a superset of the one before:

```
skeleton  ⊂  standard  ⊂  full  ⊂  orchestrator
```

A read-only agent on `standard` literally cannot see the authoring/delegation tools — they are not
registered, not merely discouraged. Every tool returns TEXT and does not start a chat session. The MCP
server is config-pinned to its vault (`$SYNAPSE_VAULT` from `.mcp.json`, `preferCwd:false`), unlike the
cwd-first CLI (see [[doc-agent-memory]] §5).

## skeleton — discovery + raw render
| Tool | Does |
|---|---|
| `synapse_list_agents` | list agent ids |
| `synapse_list_hubs` | list hub/moc ids (valid targets) |
| `synapse_render` | deterministic role-based briefing for `ids` (no semantics) |

## standard — read-only briefing, recall, and memory (adds to skeleton)
| Tool | Does |
|---|---|
| `synapse_brief` | briefing TEXT for an `agent` (+ optional `hub`, `task`); **or** `note:"<id>"` to FETCH one note in full (the on-demand "Fetch before you act" path) |
| `synapse_augment` | render + semantic recall over a task (labeled, non-authoritative suggestions) |
| `synapse_recall` | the DELTA for the CURRENT subtask — relevant notes + triggered on-demand rules + prior work; a built-in gate says "nothing new" when nothing is relevant. Call on every topic shift |
| `synapse_history` | search episodic memory (what was already done); keyword — empty = not RECORDED, not "never happened" |
| `synapse_log` | record work you did yourself (a fact about a run; authors no vault content) |
| `synapse_embeddings_status` | is the semantic index current? reports `staleCount` |
| `synapse_embeddings_rebuild` | start a DETACHED re-embed (returns immediately; poll `_status`) |
| `synapse_lint` | mechanical vault health-check (read-only) |

## full — authoring + handover (adds to standard; PROPOSE by default)
| Tool | Does |
|---|---|
| `synapse_create_hub` / `_agent` / `_note` / `_handover` | scaffold a wired note; writes only with `write:true`; a new rule/tool needs `used_by:[<agent>]` or it lints as an orphan |
| `synapse_handover_list` / `_read` / `_resolve` | browse `inbox/handovers/` |
| `synapse_handover_write` | write a handover note — **human-triggered only** |
| `synapse_resume_from_handover` | resolve a handover (path anywhere or fuzzy slug), strip frontmatter, prepend the successor protocol, and brief the agent via augment (the note text is the recall query) |

## orchestrator — dedup-safe delegation (adds to full)
| Tool | Does |
|---|---|
| `synapse_claim_and_brief` | THE default delegation path: atomically claim a `job` (a live or near-identical one is REFUSED) and return the doer's briefing + `{spawnId, owner, token}`. YOU launch with your own harness; opens an episode. Build `job` from stable ids (`agent:TICKET:suite:branch`), never prose |
| `synapse_spawn` | specialist: synapse launches a DETACHED doer that outlives your session (poll `_status`) — only when work must survive the session or there is no harness |
| `synapse_spawn_status` / `_list` | observe running spawns; classify liveness |
| `synapse_spawn_renew` / `_release` | extend / release a lease. `_release` closes the episode with `summary` + `refs` |

## Standing MEMORY brief
Every read surface's `instructions` carry a short standing brief so an agent knows WHEN to reach for the
tools: call `synapse_recall` on a topic shift, fetch an on-demand note when its trigger matches, check
`synapse_history` before repeating work. Tools are inert without it. See [[doc-agent-memory]].

## Consumer plugins
A vault may add its own tools by dropping `_meta/mcp-plugins/*.mjs` (auto-discovered) or via
`SYNAPSE_MCP_PLUGINS`. They register last and can extend any surface.

## Protocol era
This surface currently speaks the **legacy** MCP protocol (`2025-11-25`) over stdio. Adopting the
`2026-07-28` stateless standard is planned as a **dual-era** server — never modern-only, because three of
the four clients we support cannot fall forward. See [[decision-0010-mcp-2026-07-28-dual-era]].

## Related
[[hub-synapse]] · [[doc-agent-memory]] · [[doc-cli-reference]] · [[doc-runtime-wiring]] · [[decision-0010-mcp-2026-07-28-dual-era]]
