---
id: rule-framework-docs-current
type: rule
title: Keep the framework's top-level overview docs current in the same change
tags:
  - type/rule
  - area/governance
  - status/active
provenance: ["the framework's top-level docs are its public face; stale overviews are drift", "Emmanuel 2026-06-17"]
---

**Rule:** The framework's top-level overview docs — `README.md` and `TUTORIAL.md` (and `AGENTS.md`) — must
be brought current in the **same change** as any framework-wide modification: a new or changed agent, rule,
domain hub, runtime/CLI behavior, governance posture, the privacy gate, or anything else that alters how the
system is described to a reader. A framework-wide change that leaves these docs describing the *old* reality
is **drift** — and the curator's detection pass ([[loop-maintain-synapse]]) should flag it, treating
stale top-level docs as a valid reconcile target, not an out-of-scope file.

**Why:** Unlike the typed vault notes, `README.md` and `TUTORIAL.md` carry no frontmatter, so the linter and
the render engine never traverse them — they cannot catch a doc that has fallen behind. They are also the
**public face** of the framework: the first thing a new user reads and the canonical "what this is / how it
runs" reference. A reader who is told there are *three agents* when there are four, or that the runtime is
OpenCode-only when `--cli` makes it pluggable, is being silently misled — exactly the divergence the whole
single-source-of-truth design exists to prevent ([[doc-governance-model]]). Because nothing mechanical
guards these files, the discipline has to be a rule the agents carry.

**How to apply:**
- When a change is **framework-wide** (touches an agent, a rule, a domain hub, runtime/CLI behavior,
  governance, the gate, or the architecture), update `README.md`, `TUTORIAL.md`, and `AGENTS.md` in the
  **same** commit/PR so the overview never lags the reality it describes.
- On a maintenance pass, the [[agent-curator]] **detects** top-level-doc drift — phrasings that contradict
  the current agent roster, runtime, governance, or domains — and treats it as a reconcile target (a
  minimal, in-place edit to bring the doc current), not a file to skip. Sweep these the same way other
  drift is swept ([[loop-maintain-synapse]]).
- Keep edits concise and in the existing voice — reconcile to the truth, do not rewrite or pad. A
  from-scratch rewrite of an overview is an authoring decision, so escalate it rather than guess.
- These files are lint-ignored (no frontmatter), so confirm any **vault-note wikilinks** you touch still
  resolve; a `synapse lint --strict` of `errors=0` still gates the rest of the change.

Related: [[doc-governance-model]] · [[agent-curator]] · [[loop-maintain-synapse]]
