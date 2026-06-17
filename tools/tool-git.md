---
id: tool-git
type: tool
title: git — version history and the diff that is the mutation gate
tags:
  - type/tool
  - area/meta
  - status/active
---

# tool-git

The **version-history layer** and the spine of the mutation model. Every change to the vault — Markdown
notes *and* the `migrations/NNNN-*.sql` files that drive the records DB — lives in one private git repo,
so every mutation is a reviewable, revertible diff ([[doc-governance-model]]).

## What it is
The repo holds all Markdown (knowledge + generated views), the manifest, the tooling, and the migration
files. The local SQLite DB is gitignored — it is derived and replayable from the migrations, which double
as the records' audit log and revert path ([[doc-storage-model]]).

## How it is used in Synapse
How the loop ([[loop-maintain-synapse]]) commits and pushes depends on the repo and the content type
([[rule-synapse-human-gated-push]], [[decision-0006-self-healing-vault]]). On the **framework**, the agent
proposes and a human merges: it commits on a dated branch and never touches `main` directly:

```sh
git switch -c synapse/curator-2026-06-15        # branch off latest main, never edit main
git add <only the files you touched>          # never `git add -A`
git commit -m "curator: synapse maintenance 2026-06-15"
```

On the **private vault**, verified Markdown/knowledge is committed and pushed **directly** (self-healing,
no PR). In every case: stage only what was touched (**never `git add -A`**), and **never force-push or
rewrite shared history**; on the framework, never push to `main` or self-merge — the pull request is the
handoff ([[tool-gh]]'s job). Record/DB changes are the exception that stays gated **everywhere**: they ride
`migrations/NNNN-*.sql` files through the human gate, never a direct write to `db/synapse.db`
([[decision-0003-human-gated-mutation]]).

## Related
[[tool-gh]] · [[doc-governance-model]] · [[rule-synapse-human-gated-push]] · [[decision-0006-self-healing-vault]] · [[decision-0003-human-gated-mutation]] · [[loop-maintain-synapse]]
