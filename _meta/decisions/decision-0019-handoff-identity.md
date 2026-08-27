---
id: decision-0019-handoff-identity
type: decision
title: "One checksummed handle per handoff; job name stays for dedup; sweep heals stranded logbook rows"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[decision-0013-ports-and-adapters]]", "[[decision-0009-agent-memory-from-waku]]", "[[doc-agent-memory]]", "[[doc-mcp-tools]]", "[[hub-synapse]]"]
---

**Status:** Accepted — 2026-08-27 · Implemented the same day (`lib/ports/handoff.mjs`, `lib/durable-spawn/handoff.mjs`).

## Context

Closing a delegated job asked a model to retype five identifiers from an earlier turn: `job`, `owner`,
`token`, `spawnId`, `episodeId`. In a live DeepSeek Harness run the model mistyped one character of
`episodeId`. `episodes.close()` looked that id up, found nothing, and **gave up without trying the `job`
that was correct in the same message**. The ticket released. The logbook entry stayed `open` with its
summary discarded. `synapse_spawn_release` still returned `released: true`.

An entry stuck `open` tells every future agent "someone is on this — stand down", forever, about work
that finished and recorded nothing. That is worse than no record.

A single id cannot do both jobs the five identifiers were mixing:

| | **Job name** | **Handoff handle** |
|---|---|---|
| Who makes it | the agent, from stable facts | the server, at claim time |
| Lifetime | forever; stable across every attempt | one attempt |
| Purpose | **deduplication** | **identity + authority** for one handoff |
| Unique? | deliberately not — collision is the feature | yes |

## Decision

**The model carries one checksummed handle at close time.** `HandoffPort` expresses the lifecycle
once (`claimed → (renewed)* → closed`); the sqlite adapter keeps today's three tables behind that
port; the tool layer calls the port and never touches a table.

1. **Handle format.** Crockford base32 (~10 payload characters + 2-character checksum, e.g.
   `h7k2m9qp4v-c3`). Validate the checksum **before** any lookup. A bad checksum is `invalid-handle`,
   which is a different answer from `unknown-handle`.
2. **The handle is the capability.** Presenting a valid, current handle authorises close and renew.
   `owner` + `token` stay internal (the fence counter for superseded claims).
3. **Closing is atomic and idempotent.** Ticket and logbook close together or neither closes. Closing
   an already-closed handle is `already-closed`, not an error, and does not rewrite the summary.
4. **A superseded handle is refused.** If the ticket expired and someone else re-claimed the job, the
   old handle must not close the new claim (`superseded`).
5. **Nothing stays open past its expiry.** Any handoff whose ticket has lapsed and which is not closed
   is swept to `ended-unknown`. Typos are therefore non-fatal even if nobody retries.
6. **Honest tool results.** `synapse_spawn_release` returns `{ closed: true, outcome }` or
   `{ closed: false, reason }`. It never reports success when the logbook did not close.

`synapse_handoffs_open` is the orchestrator's peek: unfinished handoffs with age and expiry, so a
dropped handle can be recovered while the summary is still in context.

## Rejected

- **Fix it in a client hook.** Wrong layer. Four harnesses, any of which can be off, and the client
  cannot know the correct id. The rules belong in core.
- **Fall back to the job name when the episode id misses.** The job name is hand-typed too — a
  discount, not a fix. Supplying *more* correct information was exactly what made the live bug fail.
  A checksummed handle refuses a typo *before* lookup; it does not guess.

A raw UUID was also rejected as the handle shape: 36 characters, hex, zero redundancy — replacing one
long opaque id with another reproduces the bug.

## Consequences

- (+) A mistyped handle is a clear error the orchestrator can retry, not silent data loss.
- (+) Stranded open episodes (including pre-handle rows whose ticket is gone) heal on sweep.
- (+) The job name's dedup semantics are unchanged.
- (Δ) Orchestrator catalogue is 27 tools (was 26); `handle` replaces `owner`/`token`/`spawnId`/`episodeId`
  on the model-facing close path. Old field names are accepted for one release, mapped onto the handle,
  and logged as deprecated.
- (−) True atomicity across `durable-spawn.db` and `episodes.db` is still two SQLite files. Close writes
  the logbook first; sweep heals the other order.

## Related
[[decision-0013-ports-and-adapters]] · [[decision-0009-agent-memory-from-waku]] · [[doc-agent-memory]] · [[hub-synapse]]
