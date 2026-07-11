---
id: rule-synapse-edges-by-role
type: rule
title: Put each link in the role-field the engine actually traverses
tags:
  - type/rule
  - area/governance
  - status/active
provenance: ["the manifest role/field/endpoint model", "Emmanuel 2026-06-15"]
---

**Rule:** A link only reaches a render briefing if it sits in the frontmatter field whose **role** the
manifest traverses to that target's `type:` ([[context-engine-guide]]). Use the right field for the edge:

| Field | Role | Reaches `type:` |
|---|---|---|
| `applies_rules` | CONSTRAINS (forward) | `rule` |
| `uses_tools`, `invokes_skills` | USES (forward) | `tool`, `skill` |
| `delegates_to` | DELEGATES (forward) | `agent` |
| `references_docs` | REFERENCES (forward) | `doc` |
| `related` → hub | NAVIGATES (forward) | `hub` |
| `related` → member | BINDS / `members` (reverse) | `note`, `journal`, `project`, `plan`, `contact`, `account`, `summary` |
| `related` → attachment | ATTACHES (both) | `person`, `decision`, `tool`, `glossary` |

**Why:** `related: [[conventions]]` looks linked but renders **nothing** — `doc` is not a `related`
endpoint, so the closure never follows it. Putting an edge in the wrong field is the most common way a
"linked" note silently fails to appear in a briefing. BINDS and ATTACHES share the `related` field but are
**disjoint by endpoint type** — a type is either a member (rolls up under a hub) or an attachment
(bidirectional), never both.

**How to apply:** When wiring or repairing links, pick the field by the target's `type:` using the table —
not by what reads nicely. A `doc` in an agent's briefing → `references_docs`; a rule → `applies_rules`; a
person or decision → `related`. If the target type is not a valid endpoint of any field, the link belongs
in prose, not frontmatter.

Related: [[context-engine-guide]] · [[conventions]] · [[rule-synapse-frontmatter-schema]]
