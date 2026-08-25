---
id: decision-0012-no-global-vault-pin
type: decision
title: "The installer never sets a global vault pin — cwd wins, and a human's export outranks ours"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[doc-install-end-to-end]]", "[[doc-cli-reference]]", "[[rule-synapse-fail-loudly]]", "[[hub-synapse]]"]
---

**Status:** Accepted — 2026-08-24 · **Implemented** the same day (`lib/install.mjs`, `agents.sh`).

## Context

`synapse install --write` appended a line to the user's shell rc that began with a **global**
`export SYNAPSE_VAULT=`, and its self-heal replaced *any* line carrying the installer's marker with a
freshly generated one. Three consequences followed, and all three were observed rather than predicted:

1. **The pin was global.** It was evaluated in every interactive shell and inherited by every child
   process, so installing from vault B redirected vault A everywhere `$PWD` detection did not apply.
2. **It was authoritative exactly where it should not have been.** `resolveVault({preferCwd:false})` —
   the MCP server's resolution path — reads the environment first by design, because a config-pinned,
   long-lived server cannot `cd`. A global export therefore beat the server's own configuration.
3. **It was unfixable by hand.** Deleting the export was clobbered by the next `install --write`. One
   user's rc carried the comment `# NO global SYNAPSE_VAULT pin — on purpose` directly above a line
   that had re-acquired the pin.

The export was not accidental. It was a deliberate safety net for shells and direnv setups where
per-directory detection comes back empty, and simply deleting it would have regressed those.

## Decision

**The rc line sets a non-exported `SYNAPSE_VAULT_FALLBACK`, and vault resolution consults it last.**
The order, now depended on by three surfaces:

```text
$PWD walk  →  $SYNAPSE_VAULT  →  $SYNAPSE_VAULT_FALLBACK  →  monorepo sibling
```

Read as a sentence: **the directory you are standing in wins; then a human's own export; then the
installer's guess.** The installer's suggestion ranks *below* an explicit human choice, and below the
evidence of where the person actually is. Nothing synapse writes is exported, so nothing it writes
leaks into a child process.

To keep commands working from *outside* every vault — which previously relied on the global export —
the launcher passes the resolved vault to the child as a per-command `SYNAPSE_VAULT=… cmd` assignment,
which dies with the process instead of persisting in the shell.

**The rc contract:** install rewrites the marked line **only** when it matches a shape install itself
generated (the fallback form, or the legacy global-export form). Anything else carrying the marker is
the user's — kept, reported, with `--force-rc` as the opt-in override. This is the same
"kept, never clobbered" rule `synapse skills` applies to a hand-authored `SKILL.md`
([[decision-0011-generated-harness-skills]]), and it exists for the same reason: a generator that
overwrites deliberate human edits trains people to stop making them.

## Rejected

- **Deleting the export outright.** It was a real safety net; removing it would regress direnv and
  empty-detection shells.
- **Ranking the installer's fallback above `$SYNAPSE_VAULT`.** That breaks every user who exports it
  themselves, and inverts the principle above.
- **Treating a bare `source "…agents.sh"  <marker>` line as a shape we generated.** Install never
  emitted that shape — it is precisely what a user is left with after deleting the export by hand, so
  recognizing it would re-clobber the very edit this decision protects.

## Consequences

- (+) Installing from one vault can no longer redirect another. This is the property the rest of the
  multi-vault work depends on: a global pin makes any per-request vault binding untrustworthy, so this
  had to land before [[decision-0014-multi-vault-amendment]].
- (+) A hand-edited rc line survives upgrades, and the installer says what it would have written.
- (−) The resolution order is now a real invariant that three surfaces share. It is stated here
  precisely because it was previously only a code comment.
- (↔) Migration is automatic but not silent: the first `--write` after this drops the export and says
  so, including that already-open shells keep the exported value until `unset SYNAPSE_VAULT`.

## Related
[[decision-0013-ports-and-adapters]] · [[doc-install-end-to-end]] · [[rule-synapse-fail-loudly]] · [[hub-synapse]]
