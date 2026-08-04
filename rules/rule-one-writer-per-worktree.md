---
id: rule-one-writer-per-worktree
type: rule
title: One writer per working tree — never switch branches or stage work you did not author
tags:
  - type/rule
  - area/governance
  - status/active
related: ["[[hub-synapse]]"]
---

# One writer per working tree

**Rule:** A git working tree has **one writer at a time**. Before you `checkout`, create a branch,
`stash`, or stage anything, run `git status --porcelain`. If it shows changes **you did not author**,
another agent or a human session is working in that tree: do not switch branches, do not `git add -A`,
and do not "clean up" the foreign diff. Stage **only the paths you touched**, by explicit path — or
leave the tree alone and report the contention ([[rule-synapse-fail-loudly]]).

## Why this rule exists

Agents that share a machine share its checkouts. A branch switch is not local to you: it **relocates
every uncommitted change in the tree onto the branch you switch to**, including changes belonging to
someone else. `git add -A` then sweeps them into your commit, and the other writer's work lands in your
PR under your message — attributed to you, reviewed as yours.

Observed live 2026-08-04: an orchestrator handling a reconcile task ran `git checkout -b` in a shared
repo where another session held an uncommitted edit. The edit silently moved to the new branch. The
orchestrator then spent turn budget investigating a diff it had not made and could not explain — the
contention cost it more than the task.

The failure is quiet in both directions: the other writer sees no error, and you inherit work you
cannot vouch for. Nothing in git warns you, so the check has to be a habit.

## How to apply

1. **Look before you touch.** `git status --porcelain` and `git branch --show-current` first. Know whose
   changes are in the tree before changing its shape.
2. **Foreign changes present → do not switch branches.** Do your work in place on the current branch, or
   report the contention and stop. A branch switch with a dirty tree is the failure mode above.
3. **Stage by path, never `-A`.** `git add <the files you edited>`. `git add -A` cannot distinguish your
   work from anyone else's.
4. **Never revert, stash, or checkout-restore a change you did not make.** It may be another agent's
   in-flight work, and a stash is invisible to the writer who owns it.
5. **Preserve, don't discard.** If foreign work blocks you and the human must choose, commit it on the
   branch it belongs to with attribution, or leave it untouched and escalate — never delete it to
   unblock yourself ([[rule-no-unprompted-actions]]).

**Isolation beats etiquette.** Where a harness can give each agent its **own checkout** (a `git
worktree`, a per-agent clone), that removes the hazard outright rather than relying on every writer
remembering the steps above. Prefer it for any agent expected to run concurrently with others.

## Related
[[hub-synapse]] · [[rule-synapse-fail-loudly]] · [[rule-no-unprompted-actions]] · [[rule-synapse-human-gated-push]] · [[rule-agent-orchestration]]
