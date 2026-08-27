# DSH × Synapse — open-folder end-to-end suite

Proves the property the HTTP plugin exists for: **Synapse tools in the DeepSeek Harness follow
the folder you have open.** Four DSH workspaces, four vaults, one shared `synapse-core`.

Nothing is mocked. A mock cannot be wrong about which vault answered, which is the only thing
this suite is trying to find out.

## Run it

```sh
# 1. the stack must already be up — never --build while DSH_IMAGE=synapse-dsh:local
BIND_ADDR=127.0.0.1 ./deploy/up.sh up -d --no-build

# 2. once, to fetch the browser
npm --prefix dsh/e2e install && npm --prefix dsh/e2e run install-browser

# 3. the suite
npm --prefix dsh/e2e test
npm --prefix dsh/e2e run test:headed   # watch it drive
npm --prefix dsh/e2e run report        # after a failure
```

`npm test` at the repo root does **not** pick this up — its glob names directories explicitly
and `dsh/e2e/*.spec.mjs` is not among them. That is deliberate: this suite needs a live stack
and a live model, so it must never gate an offline unit run.

| Env | Default | |
|---|---|---|
| `DSH_URL` | `http://127.0.0.1:8080` | where the harness UI is published |
| `DSH_TOKEN` | scraped from `docker logs` | process token DSH 0.1.2 prints on boot |
| `DSH_CONTAINER` | `synapse-dsh` | container name for the stack guards |
| `PW_RUN_ID` | random 8 chars | pin it to reproduce one run's markers |

## What each file asserts

| File | Claim |
|---|---|
| `folder-binding.spec.mjs` | Each folder sees its own agents and hubs, and none of the other three's. |
| `episodic-memory.spec.mjs` | What one folder logs, another folder cannot find. |
| `orchestration.spec.mjs` | claim → duplicate is `held` → renew → release → episode closes `done`; authoring tools propose without writing. |
| `multi-agent.spec.mjs` | One human-shaped ask spawns two briefed subagents, and the answer cites vault notes — i.e. the briefing had content in it. |
| `stack-guards.spec.mjs` | No stdio `synapse-mcp` child in the container; one path-addressed endpoint per folder; 27 tools and zero admin tools. |

## Traps, all of them hit at least once while writing this

Worth reading before editing anything here. The first three make the suite **lie**; the rest made
it fail while the product was working.

**1. Expected tokens in the prompt.** If a prompt names `hub-finances`, then a model that never
called a tool and merely echoed the question passes. Prompts here name **tools only** — never an
agent, a hub, or a vault. Keep it that way.

**2. Absence asserted on a string that is in the prompt.** To ask vault A for vault B's marker you
must put B's marker in A's prompt, where it stays on screen. Asserting its absence would fail on a
*correct* system. The negative rests instead on two tokens that exist only inside a stored episode:
the empty-result shape `"episodes": []`, and the other vault's summary line.

**3. Asserting on a half-streamed reply.** An absence assertion passes trivially against text that
has not arrived yet. `ask()` waits for the turn-tail count to increase — DSH only appends that
footer when a turn settles — so every assertion runs against a finished reply.

**4. THE MESSAGE FLOW IS VIRTUALIZED — this is the big one.** Once a reply is long enough to fill
the viewport, the tool rows above it are **unmounted**, not merely scrolled out of view. `ask()`
poll-captures `[data-tool]` rows while the turn runs (same `data-chat-call-id` promotes
`running` → `ok`/`error`), then waits for `[data-turn-tail]` *and* zero in-flight rows. Do not
reintroduce live locators for transcript content after settle — they will miss what unmounted.

**5. `Enter` is not Send.** In this composer Enter is a newline as often as a submit. When it lands
as a newline the prompt just sits in the box and the test burns its whole budget waiting for a turn
nobody started — which reads as "the tool hung", and is not. `ask()` clicks the **Send message**
button and then asserts that button went *disabled*, because it is disabled exactly when the
composer is empty. That makes it a send receipt.

**6. A DSH session is SERVER-side.** Every browser context sees the same sidebar. Two workers each
clicking "New session" race for the same draft, and the loser spends the rest of the test watching
a session it never sent to. Hence `workers: 1` and sequential session creation in `openVaults`. Four
parallel **Send** clicks also remount the composer (the button detaches mid-click). Folder-binding
still asks in parallel; episodic-memory **seeds** sequentially and keeps the history queries
parallel — that is where the isolation claim lives.

**7. Not every tool row is a Synapse tool.** `subagent`, `send_message`, `list_agents`, `job_list`
and `skill` are DSH's own, and their `data-tool` carries no `mcp__synapse__` prefix. Use
`nativeCallsFor()` for those and `callsFor()` for Synapse's.

**8. `callTool` asserts the tool ran *at least* once more, not exactly once.** A model may
legitimately call a tool several times in one turn, and that is not the property under test.

## Cost of a run

Nine tests, about **4 minutes**, roughly forty live model turns. It writes one episode per
vault per run and claims two leases, both released before the test ends — verified by reading
`db/durable-spawn.db` directly, where the suite leaves zero lease rows behind. It writes no vault
files.

## Deliberately not covered

- **`synapse_spawn`** — launches a detached `cursor` / `claude` / `opencode` process inside the
  DSH container. Not installed there, and not something a test should leave running.
  `synapse_claim_and_brief` exercises the same lease machinery.
- **`synapse_admin_*`, `write: true`, `handover_write`, `embeddings_rebuild`** — these mutate a
  real vault. `stack-guards.spec.mjs` asserts the admin surface is *unreachable* instead.
- **Retries** are off. A turn is a live model call against a vault this suite has already
  written to; a retry would be testing a different world than the first attempt.
