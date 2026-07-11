---
id: capture-philosophy
type: doc
title: Capture philosophy — why structure is derived, not demanded
tags:
  - type/doc
  - area/meta
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# Capture philosophy

The thoughtful *why* behind capture, where [[conventions]] is the mechanical *how*. The aim is a second
brain that survives contact with a busy life: easy to feed, hard to corrupt. This note lives under
`_meta/`, so its illustrative links are not link-checked.

## Capture at zero friction
The most valuable thought is the one you almost didn't write down. So capture must cost nothing at the
moment of thought: a phone note, a voice-to-text dump, a pasted email, a one-line idea — dropped into
`inbox/` raw, in whatever shape it arrived. No type, no title, no folder, no tags required. If capture
demands structure, you stop capturing, and the system starves.

## Structure is derived, not demanded
Structure is real work, and it belongs to a tool, not to you-in-the-moment. The ingester reads a raw
inbox item later and *derives* its shape — classify, split, name, route, cite — following a deterministic
recipe ([[decomposition-recipe]]). You decide *what* is worth remembering; the agent decides *where* it
goes. Demanding structure at capture time conflates those two jobs and taxes the wrong one.

## One idea per file
A note holds exactly one idea. Atomic notes are findable, linkable, and composable; a dump that fuses
five ideas is none of those. So the ingester splits a multi-idea capture into several notes, each named
by its type prefix, each wired to the right hub. Smallness is what lets the graph — and a briefing built
from it — stay legible.

## Markdown for narrative, SQL for records
The substrate follows the *shape* of the thing, not your mood. If you read, link, or narrate it →
Markdown. If you aggregate, filter, sort, or relate it → SQL ([[doc-storage-model]]). A reflection is
prose; a transaction is a row. Forcing records into prose makes them un-queryable; forcing narrative into
columns makes it un-writable. Pick the substrate by how the thing will be *used*.

## Single source of truth
Every fact lives in exactly one place, edited in place, never copied. Where the two substrates meet, one
side is canonical and the other is *generated*, never authored ([[rule-synapse-single-source-of-truth]],
[[rule-derived-views-are-generated]]). Two copies is two truths waiting to diverge; a duplicated fact is a
future contradiction.

## The agent proposes, a human merges
Capture is frictionless precisely *because* nothing it produces is trusted blindly. The ingester routes
onto a branch and stops; every derived note and proposed row arrives as a reviewable diff through the
human-gated PR ([[doc-governance-model]], [[rule-synapse-human-gated-push]]). Frictionless in, gated out —
that asymmetry is the whole point: you can think freely without the system ever mutating itself behind
your back.

## Related
[[conventions]] · [[doc-capture-pipeline]] · [[decomposition-recipe]] · [[doc-storage-model]] · [[doc-governance-model]] · [[hub-synapse]]
