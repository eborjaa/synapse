---
id: hub-courses
type: hub
title: Courses — sub-hub of Career
tags:
  - type/hub
  - area/career
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-career]]"]
---

# Courses — sub-hub of Career

A **sub-hub**: a full hub unit that composes *under* [[hub-career]]. It is a `hub` like any other — it
gathers its own members and can itself hold further sub-hubs — but it declares a **parent** ([[hub-career]])
in `related`, so the two navigate to each other while their members stay separate
([[decision-0007-composable-sub-hubs]]).

## What lives here
- **Course notes** — `note-course-*` notes, one idea per file (e.g. [[note-course-ml-foundations]]), each
  wired here via `related`. These are the *detail* the parent [[hub-career]] deliberately does **not**
  pull at `standard`.
- **(Optional) deeper sub-hubs** — a heavy course can become its own `hub-course-<slug>` that lists this
  hub as its parent, nesting one level further. The pattern is recursive.

## How the layers render
- `oracle hub-courses` (or `--profile standard`) → this hub's own body **plus its course notes** (its
  members) **plus a shallow pointer up to** [[hub-career]].
- `oracle hub-career` → the career map **plus this hub's body** (the courses map), but **not** the course
  notes — those are one layer too deep until `--profile fat`.

## Members
*Populate as course notes land.* They roll up here once they link back via `related`
([[rule-synapse-edges-by-role]]).

## Related
[[decision-0007-composable-sub-hubs]] · [[hub-career]] · [[conventions]]
