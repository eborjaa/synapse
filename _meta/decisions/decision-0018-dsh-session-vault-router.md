---
id: decision-0018-dsh-session-vault-router
type: decision
title: "DSH sessions bind their vault by working directory, through a Synapse-owned plugin"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[decision-0010-mcp-2026-07-28-dual-era]]", "[[decision-0017-path-addressed-vaults]]", "[[decision-0013-ports-and-adapters]]", "[[note-dsh-extension-seams]]", "[[hub-synapse]]"]
---

**Status:** Accepted — 2026-08-26 · Implemented the same day (`dsh/`, `lib/vault-for-cwd.mjs`).

## Context

Claude Code, Cursor and opencode all answer "which vault?" the same way: Synapse writes their config
**inside the vault** (`<vault>/.mcp.json`, `<vault>/.cursor/mcp.json`, `<vault>/opencode.json`), so
opening a folder selects a vault and nothing else is needed.

DSH cannot do this. Its config layers — bundles, the profile's `cordis.patch.yml`,
`$DSH_HOME/cordis.patch.yml`, `--patch` overlays — are **all machine-wide**. Nothing reads a file from
the directory you are working in.

The result was a split that failed silently. DSH resolves **skills** per session
(`skill-filesystem` → `roots(options.cwd)` → `<projectRoot>/.dsh/skills` at rank 100) but registers
**MCP tools** once per process (`mcp-client` → `ctx.tools.register` at activation, no cwd anywhere).
Change the workspace and the agent list followed while the tools kept answering from the vault named in
the machine-wide config. No error, no warning — worse than not switching, because it looked like it
worked.

Three alternatives were investigated and rejected on evidence:

- **A generated preset per vault.** Presets are the only thing a human selects per session, so this
  works — but it makes vault choice a separate gesture from opening a folder, and the two can then
  disagree. Rejected on preference: the goal is that changing folder is the whole act.
- **MCP `roots`.** The SDK states the 2026-07-28 revision *"has no server→client request channel"*;
  the legacy path we serve is stateless where *"gates refuse"*; `listRoots` is deprecated there.
  Independently, DSH's MCP client declares `{ capabilities: {} }` and implements no roots at all.
- **`dsh-mcp-manager`, a community plugin** reported to add per-workspace MCP config. Its own source
  persists servers in `$DSH_HOME/mcp-servers.json` *"(global, shared by …)"*; its `cwd` is the spawned
  child's working directory and its `scopes` are OAuth scopes. It does not do this.

## Decision

**Synapse ships its own DSH plugin that routes each session to the vault its folder belongs to.**

- **The selector is `agent.session.header.cwd`.** The host stamps it at session creation, validates it
  absolute, and rejects a mismatch rather than moving it; subagents inherit it. The model cannot write
  it. That is what makes it a legitimate vault selector where a tool argument is not
  ([[decision-0010-mcp-2026-07-28-dual-era]]) — and it is the same field DSH's own `tool-lsp` reads via
  `sessionCwd(exec)` to route to a per-workspace `lsp-stdio` pool. This is that pattern with Synapse
  substituted for `gopls`.
- **Registration is per session, into `agent.ctx`**, whose contributions are agent-local and unwind on
  disposal. Not once at startup: a vault may carry its own `_meta/mcp-plugins/`, so two vaults do not
  publish the same tools. One global list would show a vault's extra tools everywhere or hide them
  everywhere.
- **The registry is the authority, not the filesystem.** A directory that merely contains a manifest is
  refused. Answering from an unregistered vault would let any backup, archived copy or foreign clone go
  live by being stood in, with the caller's full tool surface pointed at it — the failure that motivated
  [[decision-0012-no-global-vault-pin]], and worse here. An unregistered vault is a *distinct* answer so
  the refusal can name the fix.
- **One Synapse child per vault, pooled**, refcounted and idle-evicted, dropped on exit so the next use
  respawns. Concurrent acquires share one spawn: two children on one vault are two writers against a
  single-writer DB.
- **Failure is always closed.** No vault, an unregistered vault, or a child that cannot be read all
  register **nothing** and log why. There is no fallback to a default vault on any path.

## Consequences

- (+) Changing folder moves both planes. The agent list and the tools cannot disagree, because both now
  derive from the same value.
- (+) DSH stops being a special case; the mismatch is impossible rather than guarded.
- (Δ) Replaces the `@deepseek-ai/dsh-mcp-client` row for synapse with `@eborja/synapse/dsh-plugin`. Its
  reconnect supervisor, pagination drain and image-attachment admission are **not** reimplemented.
- (Δ) ~85 MB resident per live child, for vaults actually opened rather than registered. Idle eviction
  returns it.
- (Δ) Couples Synapse to DSH's plugin API, whose own docs say *"prefer the correct foundation over
  compatibility shims: rename or repackage freely"*. Re-verify after a DSH upgrade.
- (−) Applies only to DSH. The other three harnesses already bind by folder and are untouched.

## Related
[[decision-0017-path-addressed-vaults]] · [[note-dsh-extension-seams]] · [[decision-0013-ports-and-adapters]] · [[doc-runtime-wiring]] · [[hub-synapse]]
