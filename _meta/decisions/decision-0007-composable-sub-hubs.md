---
id: decision-0007-composable-sub-hubs
type: decision
title: Composable sub-hubs — a hub is a reusable unit that nests under a parent hub
tags:
  - type/decision
  - area/meta
  - status/active
related: ["[[conventions]]", "[[hub-career]]", "[[hub-courses]]"]
references_docs: ["[[context-engine-guide]]"]
---

**Status:** Accepted — 2026-07-14

## Context
Domains are not flat. A `career` domain contains courses; a course contains lecture notes; a project
contains plans. The user wants **composable sub-hubs**: a hub that is itself a unit — it can nest under a
parent and contain further sub-hubs — where **each layer carries just enough about its sub-layers to
orient, but not the full depth the child carries.** The open question was whether this needs a new
ontology type, field, role, or engine change.

## Decision
**A sub-hub is an ordinary `hub` note. No new type, field, role, or engine change.** Composition reuses
mechanisms that already exist:

1. **Parent/child link — child-declares-parent, exactly like a member declares its hub.** A sub-hub lists
   its **parent** in `related`; the parent does *not* list the child in frontmatter (it keeps a prose
   *Sub-hubs* section for humans). The engine resolves `related` → a `hub` target as the **NAVIGATES**
   role, made **bidirectional** (`direction: both`) so the single child→parent edge renders both ways: a
   parent pulls its sub-hubs (reverse) and a sub-hub pulls its parent (forward)
   ([[context-engine-guide]], [[rule-synapse-edges-by-role]]). One declared edge, one direction of truth —
   which is also what lets `hub-parent/<TAB>` list exactly the children.
2. **The layered "shallow-parent / deep-child" view — the existing profile depth.** `NAVIGATES` is
   depth-capped per profile: **0 at `lean`, 1 at `standard`, 99 (transitive) at `fat`.** So rendering a
   parent hub at `standard` pulls each sub-hub's **own body** (its map) but **not** the sub-hub's members
   — those are one hop too deep. `BINDS` (members) likewise starts only at the rendered hub, so a
   grandchild's notes never leak up until `fat`. Depth *is* the "not as extended as the child" rule.
3. **Notes attach to the layer that owns them.** A note binds (`related`) to whichever hub-layer owns it —
   career-wide prose to the parent, course detail to the sub-hub — so the rollup lands at the right level
   ([[rule-synapse-single-source-of-truth]]).
4. **Workspace directory — filesystem mirrors the hub tree.** A hub you *work in* lives under a path
   that matches its parent chain: `hub/<parent-slug>/hub-<parent-slug>.md` for a domain parent, and
   `hub/<parent-slug>/<child-slug>/hub-<child-slug>.md` for each nested sub-hub. That directory is the
   workspace: typed member notes and non-note helpers (assignments, clones, scratch) sit beside the hub
   file. Flat `hub/hub-*.md` remains valid for map-only domain hubs. Hub discovery (`synapse hubs`, Tab
   completion) finds both layouts via a recursive scan under `hub/`.

The worked reference example is [[hub-career]] (`hub/career/`) → [[hub-courses]]
(`hub/career/courses/`) → `note-course-*`. The pattern is recursive: a heavy course may become its own
`hub-course-<slug>` under [[hub-courses]].

## Consequences
- (+) **Zero engine surface added** — sub-hubs are just hubs; `synapse hubs`, Tab completion, render,
  augment, and the agents all work on them unchanged.
- (+) **The depth dial already expresses intent**: `standard` = one layer of context, `fat` = the whole
  subtree. No per-layer configuration to maintain.
- (+) **Recursive** — nesting is unbounded; each hub is a self-contained unit you can point an agent at
  (`oracle hub-courses "…"`).
- (+) **Direction is structural, not just prose.** Because only the child declares the parent, the tree is
  unambiguous: `synapse`'s Tab completion navigates it (`curator hub-career/<TAB>` → `hub-courses`), the
  leaf being the real target. The master `hub-synapse` stays a curated root index that lists its domains
  and is never treated as anyone's child.
- (Δ) **The master is the one exception** — it enumerates its domain hubs forward (a convenient curated
  index) while every other layer is child-declares-parent. Completion excludes the master from child
  lists so this asymmetry is invisible in practice.
- (−) The `members>=1` invariant counts only direct `BINDS` members, so a parent hub whose content is
  *entirely* sub-hubs (no direct notes) reports `members=0` — the same report-level signal today's
  near-empty domain hubs already emit. Give a parent at least one direct note, or treat the report as
  benign. A dedicated containment field + a `subhubs` lint metric is a possible **future** enhancement if
  directional, lint-clean parents are wanted; deliberately deferred to avoid new engine surface.

## Related
[[conventions]] · [[context-engine-guide]] · [[hub-career]] · [[hub-courses]] · [[rule-synapse-edges-by-role]] · [[hub-synapse]]
