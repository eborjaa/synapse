---
id: rule-buzz-reply-contract
type: rule
title: Buzz reply contract — a chat agent must publish its result every turn
tags:
  - type/rule
  - status/active
related: ["[[hub-synapse]]"]
---

# Buzz reply contract — a chat agent must publish its result every turn

**Rule:** When you run as a standing agent on Buzz, you MUST end every turn by publishing your
result to the channel with the `buzz` CLI. A correct answer you compute but never send is a **FAILED
turn** — not a completed one.

## Why this rule exists

buzz-acp does **not** auto-publish your final text. You appear in the channel ONLY when you
explicitly **send a message with the `buzz` CLI**. An agent that streams an answer and then ends its
turn without sending has answered **into the void**: the human sees nothing.

This is **role-independent**. It bit the orchestrator role, whose rendered prompt framed output as
filesystem / PR / escalation actions — so it considered the task done and never sent — while a
read-front-door role (which naturally ends by answering) sent fine on the same base prompt. The
obligation therefore lives here, in a shared rule, not in any one role.

## How to publish — the `buzz` CLI (a shell command, not a tool)

Replying is a **shell command**. `SendMessage` is the agent-to-agent tool; it is **not** the Buzz
channel reply — do not reach for it. Run, in your shell:

```
buzz messages send --channel <CHANNEL_UUID> --content "<your reply>" --reply-to <INCOMING_EVENT_ID>
```

- `--channel` — the channel you are answering in.
- `--reply-to <event id of the message you are answering>` — **threads** your reply (this is what
  produces the in-thread `e`-tag). Omit it only for a deliberate new top-level post.
- `--mention <pubkey>` — when the task belongs to another agent, start a **fresh thread** and
  `--mention` the next agent, handing it only the context it needs. That mention is the handover.
- **Credentials — you need BOTH a key and a relay URL.** The CLI reads `BUZZ_PRIVATE_KEY` and
  `BUZZ_RELAY_URL` from your environment, and **neither is guaranteed to be set** in the shell your
  tools run in. Source your per-agent env file (the one the harness provisions) and retry: it holds
  your key as `SEC` → `BUZZ_PRIVATE_KEY`, and `BUZZ_RELAY_URL`. If an older env file predates that and
  carries no relay URL, the machine-local relay config beside it does — read it, don't invent one.
  **Never guess a relay URL.** A wrong one fails as a *mention-preflight / exit-4* error rather than an
  obvious auth error, so it reads as a permissions problem and sends you down the wrong path.

## The contract

1. **Publish every turn** — send before you end the turn.
2. **Thread it** with `--reply-to`; **hand off** with a new thread + `--mention`.
3. **Unposted = failed.** Before ending, verify you actually ran a successful `buzz messages send`.

## Boundaries

- **Addressable agents only.** This applies to any agent that holds a Buzz identity — i.e.
  `addressable: true` ([[decision-0008-addressable-vs-autonomous]]) — the ones a human `@mention`s,
  **including an addressable doer** summoned in a thread. An agent reached via `Task` with no chat
  identity returns its result to the orchestrator that spawned it, and the orchestrator publishes
  ([[rule-agent-orchestration]]).
- **Do not relocate the base manual.** Never set `BUZZ_ACP_BASE_PROMPT_FILE` — it overrides the
  compiled-in base prompt that teaches the `buzz` reply CLI. Role prompts (this rule included) render
  into the system prompt only.
- **Publishing is not authorizing.** Sending a result to the channel is reversible chat; it does not
  bypass the human gate on irreversible actions ([[rule-synapse-human-gated-push]]).

## Related
[[hub-synapse]] · [[rule-agent-orchestration]] · [[rule-synapse-human-gated-push]] ·
[[agent-curator]] · [[agent-oracle]]
