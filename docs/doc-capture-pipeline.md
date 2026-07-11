---
id: doc-capture-pipeline
type: doc
title: Capture → ingestion — freeform in, typed notes and rows out
tags:
  - type/doc
  - area/architecture
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# Capture → ingestion

The agent is the write path. You capture freely; the ingester classifies and routes. No forms.

## Capture: everything lands in `inbox/`
Freeform capture — a phone note, a voice-to-text dump, a pasted email, a quick thought — is dropped into
`inbox/` as-is. Capture optimizes for *zero friction at the moment of thought*; structure is the
ingester's job, not yours.

## Ingest: classify, decompose, route, provenance
[[agent-ingester]] takes one inbox item and:
1. **Classifies** each idea — is it *knowledge* (prose) or a *record* (structured data)?
2. **Decomposes** — one idea per file ([[decomposition-recipe]]); a single dump becomes several atomic notes.
3. **Routes:**
   - prose → a typed note (`note` / `journal` / `plan` / `project` / `person` / `decision`) in its dir,
     wired into the right `hub-<domain>` via `related`.
   - record → a **migration** proposing the row(s) — never a direct DB write ([[doc-governance-model]]).
4. **Carries `provenance:`** — every derived note and row cites its inbox source, so anything traces back.
5. **Clears** the inbox entry once everything is routed.

## It proposes; a human merges
The ingester writes notes and migration files onto a branch and stops — the same human-gated PR gate as
every other change ([[rule-synapse-human-gated-push]]). Ambiguous classification → escalate to
`inbox/attention/` with Options ([[rule-synapse-fail-loudly]]); never guess a routing it isn't sure of.

## Related
[[doc-governance-model]] · [[decomposition-recipe]] · [[agent-ingester]] · [[rule-synapse-fail-loudly]] · [[hub-synapse]]
