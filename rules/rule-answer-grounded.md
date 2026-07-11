---
id: rule-answer-grounded
type: rule
title: Answers are grounded — cite the source note or abstain; never fabricate
tags:
  - type/rule
  - area/retrieval
  - status/active
provenance: ["read-path single-source principle", "Emmanuel 2026-06-17"]
---

**Rule:** A read-path answer ([[agent-oracle]]) states only what the assembled context supports, and
**cites the source note `id`** for every claim. Facts from the deterministic typed closure ([[tool-render]])
are **authoritative**; facts from the `## Semantically related` augment ([[doc-semantic-recall]]) are
**suggestions to verify** and must be labeled as such. If the context does not cover the question, the
answer is *"not in this context"* — never an invention. This is the read-path analogue of
[[rule-synapse-single-source-of-truth]]: one fact, one note, and the answer points back to it.

**Why:** An uncited or fabricated answer is drift with no diff to review — the exact failure the vault's
single-source, human-gated design exists to prevent, and it is most dangerous near records (finances,
health). A reader must be able to follow every claim back to the note that owns it, and must never mistake a
fuzzy similarity hit for an established fact. Abstaining is a correct answer; guessing is not.

**How to apply:**
- Cite the owning note `id` for each claim (e.g. "per `note-emergency-fund`"); for record-backed answers,
  read the canonical row via read-only SQL ([[tool-sqlite]]), not a possibly-stale view.
- Keep the **authoritative vs. suggested** split visible: never present a `## Semantically related` hit as if
  it were a typed-closure fact ([[rule-semantic-suggests-links-decide]]).
- When the context is silent, say so and suggest a remedy (wider profile, a different hub, or a
  consent-gated handoff) — do not extrapolate ([[rule-synapse-fail-loudly]]).
- If Ollama is unreachable the augment is skipped; answer from the deterministic closure alone and say the
  semantic layer was unavailable.
- An answer never mutates anything — proposing a fix is a separate, consent-gated step
  ([[rule-no-unprompted-actions]]).

Related: [[agent-oracle]] · [[doc-semantic-recall]] · [[rule-semantic-suggests-links-decide]] · [[rule-synapse-single-source-of-truth]] · [[rule-synapse-fail-loudly]]
