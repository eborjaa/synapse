---
id: note-deepseek-harness-integration
type: note
title: DeepSeek Harness as a Synapse runtime — endpoint, MCP bridge, delegation loop
tags:
  - type/note
  - area/runtime
  - area/synapse
  - status/active
related: ["[[note-synapse-harness-playbook]]", "[[hub-synapse]]"]
references_docs: ["[[doc-runtime-wiring]]", "[[doc-agent-architecture]]"]
---

# DeepSeek Harness as a Synapse runtime — endpoint, MCP bridge, delegation loop

How the **DeepSeek Harness** (`dsh`) was wired to this vault as a daily-driver agent runtime: the model
endpoint, the MCP bridge, the delegation loop, one engine bug found and fixed, and the context-economics
rule that decides how agent briefings should enter a long-lived session. Distilled from one end-to-end
integration session (2026-08-20/21) in which every claim below was verified against a fact — an exit code,
a DB row, an HTTP status — never an impression ([[note-synapse-harness-playbook]] P5).

## The shape: DSH is a second runtime alongside OpenCode

DSH joins `--cli opencode|claude|cursor` as another sink for the same vault ([[doc-runtime-wiring]]).
[[note-synapse-harness-playbook]] **P1 holds unchanged**: the harness is personal infra, the vault is
content, and **MCP is the only bridge**. Nothing about DSH was committed into the vault; all of it lives in
`$DSH_HOME` (`~/.dsh`).

## The model endpoint — use Ollama's `/v1`, not the native `/api`

The Mac Pro serves Ollama over Tailscale. **DSH must use the OpenAI-compatible `/v1` path**, which is the
opposite of the OpenCode guidance in [[doc-runtime-wiring]] — and the reason is structural, not
preferential:

- DSH's only pluggable model adapter is **pi-ai**, whose wire protocols are `openai-completions`,
  `openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, and the Google ones. **There is no
  native-Ollama protocol.** pi-ai's own README lists Ollama under "any OpenAI-compatible API".
- OpenCode reaches `/api` only because it loads a *native* Ollama npm provider. DSH has no equivalent, so
  pointing it at `/api` sends OpenAI-shaped requests to `/api/chat/completions` — **verified 404**, while
  `/v1/chat/completions` returns 200.
- The `/v1`-drops-tool-calls warning carried in the OpenCode config is a **library** quirk, not a server
  one. Verified directly: a streaming `/v1` request returns a complete `tool_calls` delta plus
  `finish_reason: tool_calls`. Tools round-trip fine.

Two non-obvious settings make it work:

- **Compat switches.** pi-ai treats an unrecognized gateway as though it were OpenAI itself, which Ollama
  is not: `supportsStore: false`, `supportsDeveloperRole: false`, `supportsReasoningEffort: false`,
  `maxTokensField: max_tokens`.
- **A throwaway credential.** Ollama needs no auth, but pi-ai's `openai-completions` **refuses to send a
  request carrying neither an API key nor an `authorization` header** (a deliberate guard against
  authenticating with whatever unrelated key the environment holds). Supplying
  `headers: { Authorization: "Bearer <anything>" }` satisfies the guard; Ollama ignores it. Without this
  every turn dies as `PI_AI_ERROR: No API key for provider`.

## The MCP bridge

- The patch belongs in **`~/.dsh/profiles/<profile>/cordis.patch.yml`** — per profile. `web` and `headless`
  each need their own; there is no `~/.dsh/cordis.patch.yml`.
- Use an **absolute node path**: DSH scrubs the child's environment, so a bare `node` (nvm-managed here)
  may not resolve.
- Surface **`orchestrator`** exposes the full 27-tool set — the read tools plus handover, authoring, and the
  durable spawn/delegation family.
- Point it at the **vault**, whose installed `@eborja/synapse` package carries the MCP server, and whose
  `db/` holds `episodes.db` and `durable-spawn.db`.
- Profile patches load **only at boot**. YAML changes need a DSH restart; `settings.yaml` model changes do
  not.
- A vault whose dependencies are not installed fails as `ERR_MODULE_NOT_FOUND: @modelcontextprotocol/sdk`,
  repeated — the repetition is DSH's supervisor retrying the crashed child, not N distinct faults.

## The delegation loop, and where the briefing belongs

The loop was proven end to end from DSH: `synapse_history` → `synapse_recall` → `synapse_claim_and_brief`
→ doer → `synapse_spawn_release`, with the episode landing in `episodes.db` as `outcome=done` and
`synapse_history` recalling it afterwards. **Multi-agent works**: two subagents (`oracle` + `curator`)
claimed and released in one turn, each recorded under its own agent id.

**DSH supplies the missing doer.** `claim_and_brief` deliberately stops at "launch the doer yourself"
([[note-synapse-harness-playbook]] P6). DSH's own `subagent` tool is that launcher, so the canonical chain
is: claim → hand the briefing to a `subagent` → release with the doer's answer. No `--cli` selector is
needed; **DSH is the runtime**.

### The context-economics rule — inject the pointer, not the payload

A rendered `agent-oracle + hub-synapse` briefing is **~15k tokens** (`lean` and `standard` were identical
here; only `fat` differed, at ~30k). A one-shot CLI can afford to paste that because the process exits. A
long-lived DSH session cannot.

The failure is sharper than "slow", and it has a **named proximate cause** worth remembering:

```
dsh: TIMEOUT: pi-ai stream idle timeout after 300000ms
```

pi-ai bounds the **idle** time while one stream read is outstanding, and its default is five minutes. A
local model prefilling a 15k-token briefing can sit longer than that before emitting its first token, so
DSH kills the stream mid-delegation. The model was never confused — it was still prefilling. Two
delegations in one turn reproduced it reliably (once at ~32 minutes wall clock).

**Two complementary fixes, and both are needed.** Raise `streamIdleTimeoutMs` (and `timeoutMs`) on the
provider route so a large prefill cannot hit the cliff — these bound idle time, so a healthy fast turn is
unaffected. And stop walking toward the cliff at all, by not paying the briefing cost until it is needed:

The rule this yields, which agrees with the vault's own `AGENTS.md` and the "Fetch before you act"
checklist: **a session start should inject a pointer to the briefing, never the briefing itself.** The
agent already holds the MCP tools; let it fetch. This is why the chosen integration is a **skill** whose
body is a ~40-token protocol (call `synapse_brief` with this agent/hub/profile; resume from a handover if
one was named; check `synapse_history` first), rather than a session hook that renders the closure up
front. A per-agent **preset** then tags each agent and points it at its skill on startup.

The CLI's flags map cleanly: `--profile` becomes a skill argument, `--handover <path>` becomes a
`synapse_resume_from_handover` step, and `--cli` disappears.

Per [[rule-framework-docs-current]] the skills are authored in the framework and consumed by the vault
through npm — never written into the vault directly.

## Engine bug found and fixed — short agent ids in the spawn path

An orchestrator naturally calls `synapse_claim_and_brief({ agent: "oracle" })`, because `oracle` is the
short id its own `synapse_list_agents` output shows, and the tool's schema advertises
*"'spec-builder' or 'agent-spec-builder'"*. It failed:
`render-failed: unknown artifact(s): oracle`.

**Cause.** Both spawn tools forwarded the raw id to the render engine, which resolves only the full
artifact id. `normalizeAgentId()` already existed and was used by `synapse_brief`, handover, authoring and
new-note; **the spawn path alone never called it.** Latent since the spawn tools shipped (0.9.0/0.10.0) —
it only became *fatal* once the renderer began rejecting unresolved roots instead of skipping them.

**Fix.** Normalize once at each handler entry so the claim, the render and the episode record all carry
the full id. Three regression tests use a render spy to assert the id at the render seam. Proposed as a
human-gated PR (#47), never self-merged ([[rule-synapse-human-gated-push]]).

**The lesson worth keeping:** a tool whose *description* promises a lenient input must normalize it at the
boundary. The gap survived for eight minor versions because every caller happened to be a human passing
the full id — an LLM orchestrator reading `list_agents` was the first caller to take the schema at its word.

## The operating model — what a day looks like

> **Status: proposed, partly unvalidated.** The layering and the flag mapping follow from what was
> verified; two mechanics marked **(pending)** below were still being checked against the DSH source when
> this was written. Treat those two as open questions, not as settled fact.

### The layers, and what each costs

| Layer | Lives in | Enters context | Cost |
|---|---|---|---|
| 0. Vault protocol | `AGENTS.md` (vault) | every session, automatically | already paid — works today |
| 1. Agent catalog | skills, discovered from the framework | once per session, as a `<system-reminder>` | ~1 line per agent |
| 2. Agent protocol | that agent's `SKILL.md` body | only when the agent is invoked | ~40 tokens |
| 3. The briefing | `synapse_brief` tool result | only when the agent calls it | ~15k tokens, **on demand, once** |
| 4. Doer context | the subagent's own session | per delegation | isolated from the caller |

The point of the whole arrangement: the failure mode is paying layer 3 at session *start* whether or not
it is needed. Afterwards it is paid only when an agent actually engages.

### One turn, start to finish

Typing *"oracle — what did we decide about hybrid retrieval?"*:

1. The **catalog** already named `oracle` at session start — one line, no vault content yet.
2. The **skill body** loads (~40 tokens): fetch the briefing, check history first, cite, never mutate.
3. **`synapse_history`** — was this already answered? If yes it says so and stops. This is the step that
   prevents re-doing work, and it is nearly free.
4. **`synapse_brief`** with the agent, the hub, the profile, and the question as `task` — *now* the ~15k
   closure arrives, plus semantic recall aimed at that question.
5. It answers with citations; when the topic shifts it calls **`synapse_recall`** to top up rather than
   re-briefing.

### The CLI flags, afterwards

| CLI | Becomes |
|---|---|
| `<agent>` | the skill name — `oracle`, `curator`, … |
| `<task>` | the message |
| `--profile lean\|standard\|fat` | an argument the skill passes to `synapse_brief` |
| `--handover <path>` | a `synapse_resume_from_handover` step in the skill |
| `--cli opencode\|claude\|cursor` | **gone** — DSH *is* the runtime |

### When the task needs subagents

1. **`synapse_claim_and_brief`** with a canonical job id → a **lease** (a concurrent duplicate job is
   refused), an **open episode**, and the doer's **briefing**.
2. The briefing goes to a **`subagent`** — DSH's own doer launcher — which works in *its own* context, so
   the orchestrator's session stays lean. This is the concrete answer to "launch the doer yourself"
   ([[note-synapse-harness-playbook]] P6): DSH supplies the launcher Synapse deliberately does not.
3. **`synapse_spawn_release`** closes the lease and writes the doer's answer as the episode summary —
   which a later `synapse_history` finds instead of repeating the work.

### Open questions (pending)

- Whether a preset can genuinely **force-load** a skill at startup, or whether the closest achievable
  behavior is a preset whose system-prompt section *instructs* the agent to load it.
- Whether presets **inherit** the profile-level `mcp-synapse` entry, or each preset must re-declare it.
  DSH's preset documentation warns that a child joining nothing "reaches the model with no tools at all",
  so this decides whether the MCP config is written once or per preset.

## Facts established

- All **14 Synapse MCP tools** exercised green over stdio. (`synapse_factory_doctor` is **not** a Synapse
  tool — it is a vault-local plugin in `_meta/mcp-plugins/factory.mjs` pointing at an external Buzz stack
  that is absent on this machine.)
- `dsh --profile headless "<task>"` answers one task and exits — the scriptable probe path, far better than
  browser automation for verifying the loop.
- Stale `open` episodes are the honest trace of a run that died mid-flight; closing them as `abandoned`
  keeps `synapse_history` from telling a later agent that unfinished work was in progress.

## Verified end-to-end (2026-08-22)

A two-domain orchestration ran green in the web UI, driven as a real user would type it: **2 claims → 2
subagents → 2 releases**, 12/12 assertions passing. Both specialists returned grounded answers (live
revolving debt across 5 cards; `hub-health` closure "thin on prose, heavy on SQL — only ONE typed member
note"). Distinct fence tokens, both episodes closed by the model, leases back to baseline, **no leak**,
and no `job_output` misuse. The Stop-hook guard never had to fire.

Three things had to be true at once, and each was found by a run that failed without it:

- **A model that can hold the procedure.** A local 30B claimed after ~17 min with invented job ids and,
  when delegation stalled, silently did the work itself while reporting the spawn "still in progress".
  A stronger hosted model claimed in ~50s with canonical `agent:hub:facet:scope` ids and, when its
  children died, **said so** instead of fabricating.
- **The subagent's provider must actually resolve.** Every child session died instantly with
  `no adapter registered for provider "opencode"` (`NO_ADAPTER`) after that provider was renamed: the
  parent used the new name, the spawned child still resolved the old one. This is the single highest-value
  thing to check when delegation "runs" but produces nothing — the models were reporting a broken spawn
  **accurately**, and the governance layer was never at fault.
- **`run_in_background: false`.** Without it the `subagent` call returns a job id rather than the answer,
  and the orchestrator then reaches for `job_output` on a subagent id — a lookup that can never succeed,
  because subagents are not jobs.

### Open questions — resolved

- Presets **do** inherit the profile-level `mcp-synapse` entry: subagents spawned from the `standard`
  preset called `mcp__synapse__*` tools without the preset re-declaring anything.
- Skills do not need force-loading. The harness injects a **skill catalog** into the child's context, and
  the model read and cited it unprompted ("the skill says to pass `prompt = briefing + …`"). Writing the
  procedure into the skill is enough; a preset that *instructs* loading is unnecessary.

### Still open

- `toolCallTimeoutMs` defaults to **60 s** in `dsh-mcp-client` and is not set for `mcp-synapse`. A claim
  whose ~60 KB briefing exceeds it fails with MCP `-32001` **after the lease is already taken**, so the
  retry collides with the caller's own lease (`refused: "held"`) and it can never delegate.
- The Stop-hook guard fires on a clean turn-end but **not on an interrupt**, so an interrupted run leaks
  its lease until TTL expiry.

## Related
[[note-synapse-harness-playbook]] · [[doc-runtime-wiring]] · [[doc-agent-architecture]] · [[doc-semantic-recall]] · [[decision-0004-opencode-local-ollama-runtime]] · [[rule-synapse-human-gated-push]] · [[hub-synapse]]
