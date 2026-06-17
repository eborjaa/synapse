---
id: doc-deployment-gate
type: doc
title: Deployment model & privacy gate — framework readable, vault sealed, local-only
tags:
  - type/doc
  - area/security
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[moc-synapse]]"]
---

# Deployment model & privacy gate

Privacy is a *core intention*, not a feature: **your data never leaves hardware you control.** This note
describes the intended on-disk layout, the host-level gate that lets an external AI coding agent maintain
the public framework while your private vault stays sealed, and why that boundary is agent-scoped. It is
the deployment-time companion to the two-repo model ([[doc-fork-and-extend]]) and the runtime privacy
posture ([[doc-security-privacy]]).

## The intended layout — one parent, two repos side by side

A single parent directory holds **both** repos as siblings:

```text
synapse/
├── synapse-framework/   # the PUBLIC framework — engine, conventions, agents, docs, rules, tools
└── synapse-vault/       # YOUR PRIVATE vault — personal records, knowledge, db/synapse.db
```

This is the on-disk realization of the two-layer architecture ([[doc-fork-and-extend]]): the framework is
the upstream-tracked template (read and maintained freely); the vault is your private `origin` where
knowledge and records actually live. Keeping them as siblings under one parent is what makes the gate
below expressible as a single path boundary.

## The privacy gate — framework open, vault sealed

The whole point of the layout is that you can point an **external AI coding agent** (e.g. Claude Code) at
the parent directory to read and maintain the framework, while it is *structurally incapable* of touching
the vault. You configure this gate at the **host level**, outside either repo. The reference gate is a
Claude Code configuration in `~/.claude/settings.json`:

- **`permissions.deny` rules** that refuse tool access to vault paths, plus
- **a `PreToolUse` hook** that inspects every tool call and **denies** any `Read`/`Edit`/`Write`/`Glob`/`Grep`
  whose path resolves inside the vault, and any `Bash` command that references the vault path.

The gate allows **exactly one** exception: a clean `git fetch` / `git merge` / `git pull … upstream` — so
the framework can still pull upstream updates *into* the vault, without ever exposing the vault's contents.
Compound or redirected commands are rejected; only the bare upstream-pull form passes.

**Reference implementation.** This boundary lives in the host's AI-agent config, not in either repo:
`permissions.deny` rules plus a fail-closed `PreToolUse` hook script (e.g. `~/.claude/hooks/synapse-vault-gate.sh`)
in `~/.claude/settings.json`. The hook matches on **path fields**, so naming the vault inside a framework
note is fine — only paths *into* the vault are blocked. Being host-level, the gate is the user's to own;
neither the framework nor the vault encodes it.

The result: the agent sees the framework as a normal working tree, and the vault as a wall. Reads, edits,
writes, and searches that would reach the vault's contents are blocked; only the one-way upstream pull is
permitted.

## It is agent-scoped — by design

The gate constrains **only the external coding agent.** Everything that is *supposed* to touch your data
still does, at full fidelity:

- **Your local model** (OpenCode + Ollama over Tailscale, no API key — [[decision-0004-opencode-local-ollama-runtime]])
  reads and maintains the vault as designed.
- **Obsidian** authors and links your notes directly.
- **The engine scripts** (`render.mjs`, `lint.mjs`, `gen-views.mjs`, the migration runner) operate over the
  vault unchanged.

So the boundary is not "the vault is read-only" — it is "*this one external agent* cannot reach the vault."
Your own local-first tooling is unaffected, which is exactly the local-only posture Synapse exists to
protect ([[doc-vision]], [[doc-security-privacy]]).

## Why this is a central intention

Synapse's reason to exist is a second brain an LLM can read and maintain **without your data ever leaving
hardware you control** ([[doc-vision]]). The runtime side of that promise is the Tailnet-only, local-model
posture ([[doc-security-privacy]]); the *deployment* side is this gate. Together they mean you can adopt a
capable cloud coding agent for the framework — engine fixes, doc upkeep, convention changes — and still
guarantee that not one byte of private knowledge or records is readable by it. The framework is public and
shareable; the vault is sealed; the only seam between them is the reviewable, one-directional upstream
pull.

## Related
[[doc-security-privacy]] · [[doc-fork-and-extend]] · [[doc-governance-model]] · [[doc-vision]] · [[decision-0004-opencode-local-ollama-runtime]] · [[moc-synapse]]
</content>
</invoke>
