---
id: decision-0017-path-addressed-vaults
type: decision
title: "A credential grants a set of vaults; the URL path selects one of them"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[decision-0010-mcp-2026-07-28-dual-era]]", "[[decision-0014-multi-vault-amendment]]", "[[decision-0015-admin-surface]]", "[[doc-runtime-wiring]]", "[[hub-synapse]]"]
---

**Status:** Accepted — 2026-08-26 · Amends [[decision-0010-mcp-2026-07-28-dual-era]] and
[[decision-0014-multi-vault-amendment]].

## Context

[[decision-0014-multi-vault-amendment]] bound one vault per credential, and `lib/ports/vault-tokens.mjs`
wrote that down as a rule that named its own escape hatch:

> **2. One token maps to exactly ONE vault. Not a set, not a wildcard. Broadening is a future decision
> with its own review, not an emergent property of a data structure.**

This is that review.

One token per vault is what makes per-vault client configuration unavoidable. Every client that reaches
two vaults needs two rows, each carrying a different secret, and each row lands in a different place —
`<vault>/.mcp.json`, `<vault>/.cursor/mcp.json`, `<vault>/opencode.json`. The secret is duplicated per
repo, and the number of rows grows with vaults × clients.

Three alternatives were investigated and rejected on evidence before this one:

- **MCP `roots`** — the client advertises its workspace at handshake. Elegant, and it removes the
  duplication outright. It is unavailable: the SDK states the 2026-07-28 revision *"has no server→client
  request channel, so the call fails before any wire traffic"*, the legacy path we serve is stateless
  where *"gates refuse"*, and `listRoots` is deprecated in that revision. Separately, DSH's MCP client
  declares `{ capabilities: {} }` and implements no roots at all.
- **Inferring the vault from a filesystem path the client sends.** Unverifiable, and meaningless once
  the server is in a container. Public multi-tenant MCP servers do not do this.
- **A vault handle as a tool argument.** Refused by [[decision-0010-mcp-2026-07-28-dual-era]] and still
  refused. Nothing here reopens it.

## Decision

**The credential grants a set. The path selects within it. Neither can widen the other.**

```
http://127.0.0.1:3000/mcp/<vault-id>      Authorization: Bearer <token>
```

- A token record carries `vaultIds` — one or many. The legacy single `vaultId` field is read as a
  one-element set, so existing tokens keep working unchanged.
- The HTTP adapter reads the vault id from `requestInfo.url` — the request's own address — and passes it
  to `bind()` alongside `authInfo`.
- `bind()` resolves in exactly one way: **a path names a vault the credential does not grant → refuse.**
  The path can only ever narrow.

**Compatibility rule — unambiguous binds, ambiguous refuses.** A request with no vault in its path binds
successfully **only if the credential grants exactly one vault**. A credential granting several, asked at
the bare endpoint, is refused rather than resolved to a default. A default here would be the same silent
wrong-vault failure this project has spent four decisions removing.

**Why a URL path is not the thing [[decision-0010-mcp-2026-07-28-dual-era]] banned.** That decision
refused vault identity as *a tool argument* — something the model authors, turn by turn, where a prompt
injection in a note is enough to redirect it. A URL path is transport configuration: it is fixed when the
client is configured, the model cannot rewrite the address its client is connected to, and it is
therefore in the same trust class as the bearer token that travels beside it. The rule the original
decision was protecting — *the vault is something the caller HAS, never something the model SAYS* — is
unchanged.

**Refusal parity is unchanged and extended.** "No such vault", "that vault exists but this credential
does not grant it", and "unknown token" must remain byte-identical in status, body, and challenge. The
endpoint must not become an oracle for which vaults exist on the machine.

**Path handling is exact, never prefix-matched.** The id segment is compared for exact equality against
the registry's recorded ids after decoding. No `..` traversal, no canonicalized filesystem path, no
prefix match — the path names a registry id, and nothing else.

## Consequences

- (+) One config row shape for every client and every vault, differing in one path segment. The token
  can come from the environment rather than being written into each vault's repo.
- (+) The number of secrets to manage stops growing with vaults × clients.
- (Δ) **A leaked credential now exposes every vault it grants**, not one. Accepted deliberately; mint
  narrow tokens for narrow uses, and the admin scope stays separate ([[decision-0015-admin-surface]]).
- (Δ) Rule 2 in `lib/ports/vault-tokens.mjs` is superseded by this note and must be rewritten to point
  here, not silently deleted.
- (−) Does **not** make DSH follow the working directory. DSH has no per-folder config layer, so it still
  needs one row per vault. That is a separate problem with its own solution.

## Related
[[decision-0010-mcp-2026-07-28-dual-era]] · [[decision-0014-multi-vault-amendment]] · [[decision-0015-admin-surface]] · [[doc-runtime-wiring]] · [[doc-four-containers]]
