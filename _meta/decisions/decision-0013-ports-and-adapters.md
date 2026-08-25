---
id: decision-0013-ports-and-adapters
type: decision
title: "Five ports, and no harness named in the core — adding a harness is one adapter, zero core edits"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[decision-0011-generated-harness-skills]]", "[[decision-0008-addressable-vs-autonomous]]", "[[note-dsh-extension-seams]]", "[[hub-synapse]]"]
---

**Status:** Accepted — 2026-08-24 · **Implemented** the same day (`lib/ports/`).

## Context

Synapse serves four consumer surfaces, and the code had grown one hand-written path per surface with no
interface between them. [[decision-0011-generated-harness-skills]] tabulated four independent
implementations of a single idea — *publish this vault's agent roster* — and the MCP config generator
separately branched per client across three different functions (target building, environment
carry-over, and surface read-back), each with its own copy of "which file, which shape, which key".

The cost is not aesthetic. It is that **adding a fifth harness means finding and editing every one of
those places**, and missing one produces a partial integration that works until it doesn't.

[[decision-0008-addressable-vs-autonomous]] had already stated the governing principle — *"the package
declares the roster; the harness consumes it"* — and [[decision-0011-generated-harness-skills]] closed
the fourth surface against it. This decision generalizes the same inversion to the code.

## Decision

**Five ports. The core imports ports; no core module names or imports a harness.**

| Port | Owns | Adapters |
|---|---|---|
| `RosterPort` | publishing a vault's roster to a harness | dsh |
| `ToolTransportPort` | exposing the tool surface | stdio |
| `VaultBindingPort` | resolving a request to one vault | env-pinned, bearer-token |
| `ClientConfigPort` | writing a harness's wiring file | claude, cursor, opencode |
| `VaultStorePort` | vault handles and epochs, keyed by vault | filesystem + SQLite |

**The acceptance test is stated in the code, not just here:** adding a fifth harness must be one new
adapter file and zero core edits. If adding a harness makes someone edit a core module, the boundary
has leaked and the fix belongs in the port.

**Every port carries a one-line behavioral contract and a contract test that runs against every
registered adapter.** This is the half that matters. Shape-checking an adapter only guarantees a call
will not throw; the interesting promises are behavioral, and they were previously inline behavior that
a refactor could silently drop:

- a foreign server already in a client's config **survives** regeneration — only the `synapse` key is
  ours, and a vault is a normal repo whose config routinely holds rows a human added
- a surface **round-trips**, which is what stops a regeneration silently downgrading a vault raised to
  `orchestrator`
- a hand-authored file is **never overwritten** without an explicit force, and the run **reports** that
  it kept it ([[decision-0011-generated-harness-skills]])
- no binding adapter honors a vault passed as a **tool argument**

A new adapter is therefore tested by registration rather than by someone remembering to write its
guards.

**Ports were extracted from working code, never designed ahead of it.** Every adapter wraps behavior
that already shipped. The evidence that each seam is real is that something had already implemented it
more than once.

## Rejected

- **A config table instead of `ClientConfigPort`.** The three clients differ in top-level key, command
  shape (string vs argv array), environment key name, and merge strategy — and one of them carries a
  model-provider block that belongs to the user, not to synapse. A table cannot express three merge
  rules; a `merge()` per adapter can.
- **Implementing `VaultStorePort` in the same change that declared it.** Un-memoizing the epoch and the
  database handles touches the lease-and-fence path that is the single-writer guarantee for a database
  holding financial records. It shipped as its own reviewable change, with the declaring test flipped
  rather than deleted so the transition is visible in the diff.
- **A DI container or class hierarchy.** Neither catches the failure that actually happens — an adapter
  silently lacking a member the core calls months later. A registration-time shape check plus a contract
  test does, and costs nothing else.

## Consequences

- (+) A fifth harness is an additive change with a known blast radius.
- (+) Four behavioral guarantees that lived only in reviewers' heads are now executable.
- (+) `VaultStorePort` gave [[decision-0014-multi-vault-amendment]] something to implement against
  rather than a refactor to negotiate first.
- (−) One more layer to read. Mitigated by keeping the port core tiny and stating the acceptance test
  at the top of `lib/ports/index.mjs`, where someone adding a harness will actually look.
- (↔) A declared port with no adapter is decoration, so each port's real status is recorded in that
  same file — including, honestly, what is *not* implemented and why.

## Related
[[decision-0012-no-global-vault-pin]] · [[decision-0014-multi-vault-amendment]] · [[decision-0011-generated-harness-skills]] · [[hub-synapse]]
