---
id: doc-security-privacy
type: doc
title: Security & privacy — Tailscale-only, local models, two credentials
tags:
  - type/doc
  - area/security
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# Security & privacy

Privacy is the whole point. Synapse runs on hardware you control and is reachable only over your Tailnet.

## The access path is the Tailnet — there is no other
No public endpoint, no port-forwarding, no cloud function. The model server (Ollama) and the records DB
are reachable only inside Tailscale; the agent runtime (OpenCode) talks to Ollama over the Tailnet; the
git remote is a **private** repo ([[decision-0004-opencode-local-ollama-runtime]]).

## Local models — no data leaves the machines
Inference is local Ollama; the core loop uses **no API key and no third-party model**. Knowledge and
records never transit a vendor.

## Two credentials for the records DB
- **Query / chat path = read-only.** Opened immutable / `query_only`; a generated query can never mutate
  or drop a table ([[decision-0001-sqlite-over-postgres]]).
- **Ingestion / migration path = read-write**, and only via the human-gated migration runner
  ([[decision-0003-human-gated-mutation]]).

## What the linter does and does not protect
`lint.mjs` scans for inline **secrets** (keys, tokens, passwords) and fails the commit on a hit — a real
guard now that finances are in scope. It does **not** catch account numbers or balances. Those are
protected by: the repo being private, the read-only query credential, and the derived-view design (record
detail lives in the DB and in generated views, not pasted into prose). Privacy here is an architecture,
not a regex.

## What lives where
Markdown + generated views + migration files live in the private git repo; the SQLite binary
(`db/synapse.db`) is **gitignored** (derived, sensitive, binary) and backed up by file copy
([[doc-storage-model]]).

## Related
[[doc-storage-model]] · [[decision-0001-sqlite-over-postgres]] · [[decision-0003-human-gated-mutation]] · [[decision-0004-opencode-local-ollama-runtime]] · [[rule-synapse-frontmatter-schema]] · [[hub-synapse]]
