---
id: 2026-08-28-handoff-identity-and-dsh-e2e
type: handover
title: "Handover — PR #75 merged: handle API + live dsh/e2e on DSH 0.1.2"
tags:
  - type/handover
  - status/active
  - area/runtime
related: ["[[hub-synapse]]", "[[decision-0019-handoff-identity]]", "[[decision-0018-dsh-session-vault-router]]", "[[doc-four-containers]]", "[[doc-npm-release]]", "[[rule-context-handover]]"]
---

# 2026-08-28 — PR #75 merged: handle API + dsh/e2e

Self-contained. A new session with no prior chat can continue from this. **PR #75 is merged into `main`.** The live four-container stack was up for the e2e run on 2026-08-27; it is **down** as of 2026-08-28.

## State of the world

| | |
|---|---|
| `origin/main` | `2caca98` — merge of PR #75 |
| PR #75 | **MERGED** 2026-08-27T22:42:46Z — https://github.com/eborjaa/synapse/pull/75 |
| Commits in that PR | `4afe2cd` handle API · `97b04cc` dsh/e2e |
| Local checkout | still on **deleted** branch `fix/handoff-identity` at `97b04cc` (one parent of the merge). `git checkout main && git pull` before any new work |
| npm `@eborja/synapse` | **2.0.0 is already on the registry** and does **not** include #75. Git `package.json` is still `2.0.0`. Next ship needs a bump (likely **2.1.0**: 27 orchestrator tools + new close contract). Do **not** `npm publish` unless Emmanuel asks |
| Live stack | **down** (no `synapse-dsh` / `synapse-core` containers on 2026-08-28) |

## What was done

### 1. Handoff identity (the product bug)

Live DSH run: the model mistyped one character of `episodeId` on `synapse_spawn_release`. Lease released, episode stayed `open`, summary discarded, tool still returned `released: true`.

Shipped as [[decision-0019-handoff-identity]]:

- Job name stays for **dedup**. **Handoff handle** (Crockford base32, ~10 payload + hyphen + 2-char CRC-10, lowercase, e.g. `h7k2m9qp4v-c3`) is identity + authority.
- Claim returns `handle`. Release is `{ handle, summary }` → `{ closed: true, outcome }` or `{ closed: false, reason }` (`invalid-handle` / `unknown-handle` / `superseded` / `already-closed`). Never a false success.
- New `synapse_handoffs_open`. Orchestrator **27** tools (was 26); admin 32 (was 31).
- One-char-off handle is `invalid-handle` and leaves the row open. Sweep closes lapsed open episodes as `ended-unknown`.
- Old field names accepted **one release** (deprecated). Do not fall back to job name on a miss; do not fix it in a client hook.

Key files: `lib/ports/handoff.mjs`, `lib/durable-spawn/handoff.mjs`, `mcp/tools/spawn.mjs`.

### 2. DSH fork rebase (local only — do not force-push)

Checkout: `/Users/eborja/synapse/deepseek-harness`

- `origin` = `deepseek-ai/deepseek-harness`, `eborjaa` = fork.
- Rebased onto `origin/master` (`cd5ef81481`, DSH **0.1.2-alpha.1**).
- Replayed: `c3a43c8556` `feat(llm-pi-ai): bump pi-ai to 0.84.3 for OpenCode Go Luna`.
- Follow-up needed for docker `pnpm run build`: `44b4cd95a2` `fix(llm-pi-ai): classify 0.84.3 catalog drift gates` (`thinking.budget`, `thinkingTokenBudgetField`, `allowedFallbackModels`).
- Branch is **ahead 1081, behind 1** of `eborjaa/master`. Rebase rewrote history. **Do not force-push `eborjaa/master`.**
- Docker files remain **untracked** in the DSH repo: `Dockerfile`, `docker-entrypoint.sh`, `.dockerignore`, `docker-loopback-proxy.mjs`.

Build gotchas already fixed in the host tree / `.dockerignore`:

- Stale `packages/host/apiproxy/lib` (removed upstream) caused tsdown `MISSING_EXPORT`. Deleted leftover dir; `.dockerignore` has `packages/host/apiproxy`.
- Do **not** dockerignore all `**/lib/` — tsdown needs per-package `lib/types`.

### 3. Images and compose

- `synapse-dsh:local` — rebased DSH + synapse plugin from worktree `/Users/eborja/synapse/.worktrees/dsh-image` (HTTP vault-pool). **Do not** build DSH with `SYNAPSE_SRC` = the framework `main` tree: `dsh/vault-pool.mjs` on `main` still has **no HTTP**; the plugin would spawn stdio children and fail stack-guards.
- `synapse-synapse-core:latest` — built from the handle-API branch (now `main`). Core serves 27 tools.
- Recreate from the **worktree** compose: `cd /Users/eborja/synapse/.worktrees/dsh-image && BIND_ADDR=127.0.0.1 ./deploy/up.sh up -d --no-build --force-recreate dsh synapse-core vpn-sidecar`.
- Never `--build` while `DSH_IMAGE=synapse-dsh:local` or compose rebuilds the stub.
- HTTP plugin + compose (`SYNAPSE_MCP_HTTP_URL`, `dsh-home`, `boot-sync`) live as **uncommitted** work on worktree `feat/dsh-real-image`. They were **not** copied onto #75 (mixing epics). Core was rebuilt from the handle branch; DSH image plugin from the worktree.

### 4. `dsh/e2e` landed on `main`

Path: `dsh/e2e/`. Root `npm test` does **not** pick it up (needs a live stack). Run: `npm --prefix dsh/e2e test`.

Last live run (2026-08-27, stack still up): **9/9 in 3.8 min**.

| Spec | Claim |
|---|---|
| `folder-binding.spec.mjs` | Four folders, four vaults, in parallel |
| `episodic-memory.spec.mjs` | What one folder logs, another cannot find |
| `orchestration.spec.mjs` | claim → held → renew → `closed: true` through **handle**, not owner/token |
| `multi-agent.spec.mjs` | One ask → 2× `synapse_claim_and_brief` → ≥2 DSH `subagent` → 2× `synapse_spawn_release`; answer cites vault note ids |
| `stack-guards.spec.mjs` | No stdio `synapse-mcp` in the container; path-addressed endpoints; 27 tools, zero admin |

**Where to see the two-subagent transcript in the DSH UI** (if the same `dsh-home` volume is remounted): workspace **`synapse-vault`**, session title **Parallel Vault Analysis: Finances and Career**. That is not the episodic-memory chat (`E2E-SYNAPSE-FRAMEWORK-MARK-…` under `synapse-framework`).

DSH 0.1.2 **401s** `http://127.0.0.1:8080/` until you open `http://127.0.0.1:8080/?token=…`. Scrape the token from `docker logs synapse-dsh` (`dsh web: http://127.0.0.1:3080/?token=…`) but use proxy port **8080**, not 3080. The e2e suite does this in `dsh/e2e/fixtures.mjs` (`dshAuthPath()`).

### 5. E2e traps (all hit at least once)

Full write-up: `dsh/e2e/README.md`. Load-bearing ones:

1. Enter is not Send. Click **Send message**, then treat disabled as the send receipt.
2. A DSH session is **server-side**. `workers: 1`. Sequential `openVaults`. Four parallel Sends remount the composer — episodic **seed** is sequential; history queries stay parallel. Folder-binding still asks in parallel.
3. Message flow is virtualized. `ask()` poll-captures `[data-tool]` by `data-chat-call-id` (promote `running` → `ok`/`error`), waits for `[data-turn-tail]` **and** zero in-flight rows. Old locator `[data-chat-anchor-key^="9:turn-tail"]` is stale on 0.1.2.
4. Never assert absence of a string that is in the prompt. Isolation rests on `"episodes": []` plus the other vault's summary line.
5. Composer names: `/Describe what you want|Message the agent|Message or run a task/`.

## What was explicitly not done

- Merge of #75 — **Emmanuel did this**. Do not re-merge.
- npm publish / version bump after #75.
- Force-push of DSH `eborjaa/master`.
- Copying HTTP `vault-pool` onto the handle PR / onto `main`.
- `synapse_spawn`, admin tools, `write: true` authoring, `embeddings_rebuild` in e2e.

## Local dirt — do not commit unless asked

In `/Users/eborja/synapse/synapse-framework`:

- Older untracked `inbox/handovers/*` (SPEC, PR-BODY, epic WIP notes), `.playwright-mcp/`, `PLAN-four-containers.md`, `dsh-ui-live.png`. Leave them.
- `agents/agent-curator.md` now has the inbound `[[2026-08-28-handoff-identity-and-dsh-e2e]]` edge (required so this note is not an orphan). A stray `[[2026-08-25-epic3-done-epic4-wip]]` was reverted.

## What's next (in order)

1. `git checkout main && git pull` in `synapse-framework`. Confirm `HEAD` is `2caca98` or newer.
2. Decide with Emmanuel whether to **bump and publish** (handle API is not on npm 2.0.0). Follow [[doc-npm-release]]. After registry, bump the private vaults.
3. Keep HTTP vault-pool / real DSH image on worktree `feat/dsh-real-image` until that epic has its own PR. Do not mix it into a publish of #75.
4. If the live stack is needed again: rebuild/recreate from the worktree as above; never `--build` with `DSH_IMAGE=synapse-dsh:local`.
5. Do not force-push the DSH fork. If the fork must move, open a branch and a PR, or ask Emmanuel before any `+master` push.

## Open escalations

None in `inbox/attention/`. Human decisions still open:

- Publish vs wait (npm 2.0.0 already exists without #75).
- Whether/how to update `eborjaa/master` on the DSH fork after the rebase.

## Relaunch command

In this repo, after `git checkout main && git pull`:

```
curator hub-synapse --handover 2026-08-28-handoff-identity-and-dsh-e2e --cli cursor
```

Equivalent:

```
synapse augment agent-curator hub-synapse --handover 2026-08-28-handoff-identity-and-dsh-e2e
```

MCP: `synapse_resume_from_handover` with ref `2026-08-28-handoff-identity-and-dsh-e2e`.
