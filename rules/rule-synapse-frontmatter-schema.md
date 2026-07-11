---
id: rule-synapse-frontmatter-schema
type: rule
title: Every note obeys the frontmatter + naming schema
tags:
  - type/rule
  - area/governance
  - status/active
provenance: ["the context-vault schema layer (conventions)", "Emmanuel 2026-06-15"]
---

**Rule:** Every vault artifact (any `.md` with a `type:`) must satisfy the schema layer ([[conventions]]),
and `lint.mjs` ([[tool-lint]]) enforces it:

- **Required frontmatter:** `id`, `type`, `title`, `tags`. `id` equals the basename.
- **Prefix ↔ type match:** the filename prefix implies the type (`note-*`→`note`, `hub-*`→`hub`,
  `rule-*`→`rule`, `contact-*`→`contact`, …). They must agree.
- **`#type/<type>` tag:** the `tags:` list must contain `type/<type>` matching `type:`. Use **block-style**
  tags (one per line) so the tag check matches — flow-style (`[type/x, …]`) puts a comma after the tag and
  silently fails.
- **Agents additionally** carry `purpose` and `invokes_skills` (may be `[]`); **loops** carry
  `owner_agent`, `goal`, `exit_condition`; **generated views** (`contact`/`account`/`summary`) carry
  `generated: true` and `source:`.
- **Links are bare-basename wikilinks** — never path-qualified; a slash inside the brackets won't resolve.
- **No secrets** inline (keys, tokens, passwords).
- **`migration:` targets must exist** on disk relative to the vault root.

**Why:** The engine is schema-driven. A missing field, a prefix/type mismatch, or a dead `migration:`
path makes a note unrenderable or silently mis-grouped, and a leaked secret in a committed note is a
security incident. Mechanical conformance is what keeps renders cheap and correct.

**How to apply:** Treat a clean `lint.mjs` (`errors=0`) as the gate. Repair the unambiguous breakages
directly (fill a derivable `id`, add the missing `#type/<type>` tag, quote a malformed `related:` array,
fix a single-candidate typo'd link). A broken `migration:` path or a 0-or-many-candidate link is **not**
mechanical — escalate it ([[rule-synapse-fail-loudly]]).

Related: [[conventions]] · [[rule-synapse-edges-by-role]] · [[rule-synapse-single-source-of-truth]] · [[rule-derived-views-are-generated]] · [[tool-lint]]
