---
id: tool-gh
type: tool
title: gh — open the human-gated pull request
tags:
  - type/tool
  - area/meta
  - status/active
---

# tool-gh

The GitHub CLI — the agents' interface to the **human-gated pull request**, the point where a proposed
change waits for a human to review and merge ([[doc-governance-model]]). The PR is the handoff for the
**framework** repo and for **record/DB changes everywhere**; vault Markdown self-heals without it
([[rule-synapse-human-gated-push]], [[decision-0006-self-healing-vault]]).

## What it is
`gh` opens (and inspects) PRs from the command line, so an agent can hand off its work without a browser.
On the framework the PR is the gate: Markdown diffs and proposed record migrations ride the *same* pull
request, reviewed together before anything is applied. On the private vault, `gh` is reached for the gate
that still applies there — a **record/DB migration** proposed for human review — since vault Markdown is
pushed directly ([[tool-git]]).

## How it is used in Synapse
At the end of a non-dry **framework** maintenance pass, the curator opens **one** PR to `main` from its
dated branch (on the vault, a PR is opened only when a record/DB migration is proposed):

```sh
gh pr create --base main --head synapse/curator-2026-06-15 \
  --title "curator: synapse maintenance 2026-06-15" \
  --body "lint errors=0; reconciled N views; M escalations in inbox/attention/"
```

The PR body surfaces any unresolved lint error loudly rather than swallowing it
([[rule-synapse-fail-loudly]]), and lists what was reconciled and what was escalated. A **dry pass opens no
PR**. The agent never self-merges and never force-pushes — a human reviews the diff and merges, after
which the migration runner applies any DB changes ([[rule-synapse-human-gated-push]]).

## Related
[[tool-git]] · [[doc-governance-model]] · [[rule-synapse-human-gated-push]] · [[decision-0006-self-healing-vault]] · [[rule-synapse-fail-loudly]]
