# Handover — Epic 1 done, Epic 2 next (PLAN-four-containers)

> Self-contained. A Cursor session with no prior context can work from this.
> Written 2026-08-25. Companion to `PLAN-four-containers.md` in the repo root.

---

## 0. One thing needs a human, right now

**The Epic 1 PR is not open.** The branch is pushed; `gh pr create` was blocked by a permission
classifier. Run this yourself:

```bash
cd /Users/eborja/synapse/synapse-framework
gh pr create --base main --head feat/thread-vault-context \
  --title "feat(mcp): thread a per-request vault context through the tool layer (Epic 1)" \
  --body-file inbox/handovers/PR-BODY-epic1.md
```

The body is written for you at `inbox/handovers/PR-BODY-epic1.md`.
Per `rule-synapse-human-gated-push`: **do not merge it yourself.**

---

## 1. State of play

| | |
|---|---|
| `main` | `c4a29f0` — unchanged, nothing merged this session |
| Branch | `feat/thread-vault-context` → commit `3ebd37a`, **pushed to origin** |
| Worktree | `/Users/eborja/synapse/.worktrees/thread` (`node_modules` symlinked to the main tree — untracked, never commit it) |
| Tests | **387 pass, 0 fail** (baseline was 374; +13, none removed) |
| Lint | `node lib/lint.mjs --strict` → **errors=0**, 49 advisories (all pre-existing) |
| Epic 1 | **DONE** — code, tests, decision note, changelog |
| Epic 2 | not started |

Epic 1 = *"A request carries its own vault."* It is the gate: `synapse-core` cannot be its own
container until this lands, because two containers have no shared process tree and therefore no stdio.

---

## 2. What was built, and the one idea behind it

`mcp/vault.mjs` resolved the vault **once, at module load**, into a `VAULT` constant that ~60
references across eight tool modules read. On stdio that is correct and `decision-0010` says so — one
connection is one process is one vault. Off stdio it is wrong and quiet: under an HTTP handler the
module loads once and serves many vaults, so every tool answers from whichever vault won the import
race. Multi-vault in the URL, single-vault in the data.

**A bound vault is now a value.** `mcp/vault-context.mjs` → `buildServer({ vault })` → closed over by
each tool handler.

**Why a value and not `AsyncLocalStorage`.** The SDK's own type settles it — verified in
`node_modules/@modelcontextprotocol/server/dist/createMcpHandler-*.d.mts:3781-3808`:

```ts
type McpServerFactory = (ctx: McpRequestContext) => McpServer | Server | Promise<…>
// createMcpHandler invokes it ONCE PER HTTP REQUEST (ctx carries authInfo + requestInfo);
// serveStdio invokes it once per connection.
```

So *"one server per bound vault"* and *"one server per serving unit"* are the same object. A
per-request vault needs no ambient state to travel in. Isolation then rests on there being **no shared
name to read**, not on anyone remembering a rule.

### Files

| Path | What |
|---|---|
| `mcp/vault-context.mjs` | **NEW.** `createVaultContext()` + `envPinnedContext()`. Read this first. |
| `mcp/vault.mjs` | now a shim: pure helpers + the **deprecated** single-vault surface |
| `mcp/build-server.mjs` | `buildServer({ surface, plugins, vault })` — the seam |
| `mcp/server.mjs` | resolves the vault once at startup, hands the same context to every connection |
| `mcp/tools/*.mjs` | every `register*(server, vault = envPinnedContext(), …)` |
| `mcp/vault-context.test.mjs` | **NEW.** 13 tests, offline, two vaults in one process |

### Three things to know before you touch it

1. **`envPinnedContext()` goes through `VaultBindingPort`**, not `resolveVault()` directly. That is
   deliberate: Epic 2 swaps the bearer adapter in *there* and touches zero tool modules.
2. **It is resolved fresh per call, never memoized.** A module-load memo is the exact bug removed.
3. **`mcp/vault.mjs`'s deprecated exports stay** — `<vault>/_meta/mcp-plugins/*.mjs` is a documented
   extension point with consumers this package does not ship. **Nothing inside the package imports
   them, and a test enforces that** (it walks `mcp/` and greps named imports). The old bug is
   re-introducible by one careless import and would be invisible again until something served two
   vaults.

### Two real bugs found on the way

Both invisible on stdio (cwd == pinned vault), both cross-vault reads the moment they differ:

- `synapse_embeddings_status` printed `vault=<pinned>` in its header while calling
  `embeddingsStatus()` with its **cwd-first default** — the header and the measurement disagreed.
  Now passes `freshnessPaths(vault)`.
- `synapse_resume_from_handover` called `resolveVault()` fresh (cwd-first) instead of the server's
  vault.

### The clearest evidence the constant is gone

`mcp/e2e.test.mjs` lost its per-harness module cache-bust
(`import("./tools/spawn.mjs?v=" + Math.random())`). That workaround existed **only** because
`mcp/vault.mjs` resolved `VAULT` at its own module load and was never busted, so every harness in the
process shared the first temp vault's path. A second harness is now just a second argument.

---

## 3. How the gates were verified — reproduce these before trusting anything

```bash
cd /Users/eborja/synapse/.worktrees/thread
npm test                     # 387 pass, 0 fail
node lib/lint.mjs --strict   # errors=0
```

**Generated config byte-identical** — run BOTH trees against the SAME vault, or you diff on paths and
on the existing `.mcp.json` surface, which is noise:

```bash
cd /Users/eborja/synapse/synapse-framework
for c in claude cursor opencode; do
  diff <(node lib/mcp-config.mjs --client $c --dry-run) \
       <(node /Users/eborja/synapse/.worktrees/thread/lib/mcp-config.mjs --client $c --dry-run)
done                          # all silent
```

**Live wire surface byte-identical, all four surfaces**, real server processes speaking raw JSON-RPC,
both protocol eras — skeleton 3 · standard 11 · full 20 · orchestrator 26 tools:

```bash
for s in skeleton standard full orchestrator; do
  diff <(node /Users/eborja/synapse/synapse-framework/mcp/conformance.mjs --surface $s --json | sed "s#/Users/eborja/synapse/synapse-framework#V#g") \
       <(node /Users/eborja/synapse/.worktrees/thread/mcp/conformance.mjs --surface $s --json | sed "s#/Users/eborja/synapse/.worktrees/thread#V#g")
done                          # all silent
```

### One false alarm, so you do not chase it

`node lib/skills.mjs --dry-run` **does** differ between the two trees — `generated` vs `shipped`. It is
**not** a regression. `lib/skills.mjs:97` — `shippedSkill()` returns `null` when the shipped path
equals the target path, so running the package from a directory other than the vault flips the label.
`lib/` is untouched by this PR apart from a comment block in `lib/ports/index.mjs`; confirm with
`git diff --name-only origin/main -- lib/`.

---

## 4. Epic 2 — where to start

**Goal:** one long-lived Synapse many clients connect to, with the caller's credential deciding the
vault. This is what lets `dsh` and `synapse-core` be different containers.

Everything Epic 2 needs already exists:

- `createMcpHandler` ships in `@modelcontextprotocol/server@2` — **verified present**, not a gap.
- `bearerVaultBinding` in `lib/ports/vault-tokens.mjs` — **built and tested, not yet in the request
  path**. Epic 2 moves it in.
- `buildServer({ vault })` — the per-request seam, landed in this PR.

**The shape:**

1. Add an `httpTransport` adapter to `toolTransportAdapters` in `lib/ports/index.mjs`, next to
   `stdioTransport`. Lazy-import the SDK the way `stdioTransport` does.
2. Per request: read the credential from `ctx.authInfo` → `bearerVaultBinding.bind()` → a vault →
   `buildServer({ surface, plugins, vault })`.
3. Bind to **loopback or the VPN interface, never `0.0.0.0`** (`doc-deployment-gate`: "a core
   intention, not a feature").

**The stories, and the trap in each:**

| | | Watch for |
|---|---|---|
| US-2.1 | two clients on one server, tool list identical to stdio's | — |
| US-2.2 | the credential decides the vault | a request carrying vault B's id **in its arguments** must be answered by vault A, and the argument read by nothing. `VaultBindingPort`'s contract is a **security boundary** — `decision-0010`: *"the moment vault selection is a tool argument, the only thing isolating vaults holding finance, health and contacts data is the model's choice of argument."* |
| US-2.3 | a bad credential is refused outright | the message for **"unknown"** and **"vault gone"** must be **identical** — a difference is an enumeration oracle |
| US-2.4 | stdio keeps working alongside HTTP | both transports serve the same tool list **from the same factory** |

**Gate:** one contract test passing on **both** transports · two vaults answered correctly from one
process.

Two halves of that contract test already exist and should be reused rather than rewritten: the tool
list must not change with the **vault** (`mcp/vault-context.test.mjs`), nor with the **transport**
(`ToolTransportPort` in `lib/ports/index.mjs`).

**Do not relitigate:** exactly one `synapse-core` instance (the lease/fence design in
`mcp/tools/spawn.mjs` assumes one writer per vault DB); local only; vault identity never a tool
argument; agents propose, humans merge.

---

## 5. Answers the human already gave

From `PLAN-four-containers.md` §11 — settled, do not re-ask:

1. Epic 6 runs **once at the end**, not per epic.
2. Release **`2.0.0` after Epic 1**, not before. *(Nothing blocks it now — Epic 1 is complete. Until it
   ships, `synapse` on `PATH` is the old published package, so run new commands as
   `node lib/vaults.mjs …`, not `synapse vaults …`.)*
3. **Pick the vault before the session starts** — US-5.1 as written. Mid-session switching is a
   different design and is out of scope.

---

## 6. Repo rules that bite

- **Never commit, merge or push to `main`.** One worktree + branch per epic; open a PR and leave it.
- `git status --porcelain` before touching a tree. **Stage by explicit path, never `git add -A`.**
  Never stash or revert work you did not author.
- A pre-commit hook runs `synapse lint --strict` whenever vault files are touched — it is loud and it
  is fine; look for `clean; N advisory`.
- Comments state **why**, including the failure mode being prevented. Match `lib/mcp-config.mjs`.
- Zero dependencies, Node ESM, idempotent, fail loudly.
- Per-machine generated config is gitignored (`.gitignore:36-38`). Generate it, never commit it.

```bash
npm test    # node --experimental-sqlite --test lib/*.test.mjs lib/ports/*.test.mjs \
            #   lib/durable-spawn/*.test.mjs mcp/*.test.mjs mcp/tools/*.test.mjs
```

---

## 7. Episodic memory

This work is recorded in the vault's episodic memory — episode
`ca39d572-8048-4dac-b4b8-57510c465cae`. From any Synapse-connected session:

```
synapse_history({ query: "per-request vault context" })
```

That record carries more implementation detail than this note. An empty result from
`synapse_history` means something was **not recorded**, never that it did not happen.
