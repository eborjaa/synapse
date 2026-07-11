---
id: doc-deployment-gate
type: doc
title: Deployment model & privacy gate — framework readable, vault sealed, local-only
tags:
  - type/doc
  - area/security
  - status/active
references_docs: ["[[conventions]]", "[[doc-runtime-wiring]]"]
related: ["[[hub-synapse]]"]
---

# Deployment model & privacy gate

Privacy is a *core intention*, not a feature: **your data never leaves hardware you control.** This note
describes the intended on-disk layout, the host-level gate that lets an external AI coding agent maintain
the public framework while your private vault stays sealed, and why that boundary is agent-scoped. It is
the deployment-time companion to the engine-package vs vault model ([[doc-fork-and-extend]]) and the runtime privacy
posture ([[doc-security-privacy]]).

## The intended layout — one parent, two repos side by side

A single parent directory holds **both** repos as siblings:

```text
synapse/
├── synapse-framework/   # the PUBLIC framework — engine, conventions, agents, docs, rules, tools
└── synapse-vault/       # YOUR PRIVATE vault — personal records, knowledge, db/synapse.db
```

This is the on-disk realization of the two-layer architecture ([[doc-fork-and-extend]]): the engine is
the npm package (reference notes optional via upstream) (read and maintained freely); the vault is your private `origin` where
knowledge and records actually live. Keeping them as siblings under one parent is what makes the gate
below expressible as a single path boundary.

## The privacy gate — framework open, vault sealed

The whole point of the layout is that you can point an **external AI coding agent** (e.g. Claude Code) at
the parent directory to read and maintain the framework, while it is *structurally incapable* of touching
the vault. You configure this gate at the **host level**, outside either repo. The reference gate is a
Claude Code configuration in `~/.claude/settings.json`, and the enforcement is **a single, fail-closed,
path-based `PreToolUse` hook** — the sole enforcement point:

- The hook inspects every tool call and **denies** any `Read`/`Edit`/`Write`/`Glob`/`Grep` whose path
  resolves inside the vault, and any `Bash` command that references the vault path.
- It is **fail-closed**: if the hook cannot prove a call is safe, it denies. A single matcher covers every
  path into the vault, so no separate `permissions.deny` list is needed — earlier drafts paired deny rules
  with a hook, but the hook subsumes them, leaving one enforcement point to reason about and maintain.

The gate allows **exactly one** exception: a clean `git fetch` / `git merge` / `git pull … upstream` — so
the framework can still pull upstream updates *into* the vault, without ever exposing the vault's contents.
Compound or redirected commands are rejected; only the bare upstream-pull form passes.

**Reference implementation (shipped).** The framework ships a ready hook — `_meta/tools/vault-privacy-gate.sh`
— so anyone can wire the gate in ~30 seconds. You install it at the **host** level (not in either repo):
copy it to `~/.claude/hooks/`, point it at the directory to seal via the `SYNAPSE_VAULT_GATE_PATH` env var,
and register it as a `PreToolUse` hook in `~/.claude/settings.json`:

```bash
cp _meta/tools/vault-privacy-gate.sh ~/.claude/hooks/ && chmod +x ~/.claude/hooks/vault-privacy-gate.sh
# settings.json → hooks.PreToolUse[].hooks[].command:
#   "SYNAPSE_VAULT_GATE_PATH=/abs/path/to/your-vault bash ~/.claude/hooks/vault-privacy-gate.sh"
```

The hook matches on **path fields** (so naming the vault inside a framework note is fine — only paths
*into* the vault are blocked), derives its marker from the sealed dir's **basename** (give your vault a
distinctive name), and **fails closed**. Toggle it with the shipped `vault-gate` command (from `agents.sh`;
default ON):

```bash
vault-gate off      # agent may enter the vault for a scoped task
vault-gate on       # re-seal (default; a forgotten toggle fails closed)
vault-gate status   # show current state
# under the hood it's just a host sentinel: `: > ~/.claude/vault-gate-off` (off) / `rm` it (on)
```

The framework now ships the **mechanism**; the *wiring and the protected path* still live in host config you
own (the vault never encodes its own gate). Other CLIs: adapt the same idea to their pre-tool hook surface.

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

## It is owner-toggleable — but only by the owner

The gate is the **owner's switch**, not the agent's. The hook checks a **host sentinel** — a file outside
either repo, e.g. `~/.claude/vault-gate-off` — before it enforces. The default is **ON**: with no sentinel
present, the gate is live and the vault is sealed.

This lets the owner deliberately open the gate for a scoped task and then close it again. The motivating
case: temporarily letting a **more capable external CLI** maintain the vault directly — Claude Code,
selected via the `--cli claude` selector ([[doc-runtime-wiring]]) — for a one-off cleanup the local model
can't handle. The owner creates the sentinel, runs the scoped task, then deletes it to re-seal the vault.
Default ON means a forgotten step fails *closed*, not open.

Crucially, disabling the gate is meant to be a **deliberate human act**, not something the agent does to
free itself — but it's worth being precise about *how* that's enforced, because it's a **policy guardrail,
not a structural one**. The vault hook guards paths *into the vault*; it does **not** itself block writes
to the host sentinel (the sentinel path is outside the vault). What actually keeps an agent from flipping
its own gate is the host CLI's **safety classifier**, which independently refuses agent-initiated attempts
to weaken a user's privacy control — in practice it declines to create the off-sentinel on the agent's own
initiative. Combined with **default-ON** (a forgotten or failed toggle fails *closed*), the effect is that
the owner turns the gate off and on as a conscious act at the host, and the agent only ever experiences
whichever state the owner has set. The protection is real, but it lives in the agent's safety policy layer
plus the human-in-the-loop, not in the vault hook alone.

## Why this is a central intention

Synapse's reason to exist is a second brain an LLM can read and maintain **without your data ever leaving
hardware you control** ([[doc-vision]]). The runtime side of that promise is the Tailnet-only, local-model
posture ([[doc-security-privacy]]); the *deployment* side is this gate. Together they mean you can adopt a
capable cloud coding agent for the framework — engine fixes, doc upkeep, convention changes — and still
guarantee that not one byte of private knowledge or records is readable by it. The framework is public and
shareable; the vault is sealed; the only seam between them is the reviewable, one-directional upstream
pull.

## Related
[[doc-security-privacy]] · [[doc-fork-and-extend]] · [[doc-governance-model]] · [[doc-vision]] · [[doc-runtime-wiring]] · [[decision-0004-opencode-local-ollama-runtime]] · [[hub-synapse]]
</content>
</invoke>
