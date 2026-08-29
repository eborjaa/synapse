---
id: decision-0020-declarative-stack-bootstrap
type: decision
title: "A stack can register its own vaults and take one credential from the environment; both are off by default"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[decision-0017-path-addressed-vaults]]", "[[decision-0016-four-container-deployment]]", "[[decision-0015-admin-surface]]", "[[doc-four-containers]]", "[[doc-stack-on-a-new-machine]]", "[[doc-deployment-gate]]", "[[hub-synapse]]"]
---

**Status:** Accepted — 2026-08-28 · Implemented the same day (`lib/bootstrap.mjs`, `deploy/standalone/`).

## Context

The four-container stack could only be run by someone holding two source checkouts. Standing it up
meant: clone both repos, build two images, bring the stack up, `docker exec` to register each vault,
`docker exec` again to mint a credential, read that credential out of the terminal, paste it into
`.env`, recreate. Nine steps, two of them inside a container, one of them carrying a secret by hand.

That is a reasonable price on the machine that develops Synapse. On any other machine it is the
product. Handing a colleague a compose file did not work, because the compose file built from source
that they did not have, and because the two `docker exec` steps have no declarative form.

Every one of those steps also fails *quietly*. A vault that was never registered, or a credential that
was pasted with a truncated character, both surface four steps later as "the session has no tools" —
a symptom that names neither cause.

## Decision

**Two switches on `synapse-core`, both defaulting to off, and a compose file that pulls instead of
builds.**

| `SYNAPSE_AUTO_REGISTER` | `SYNAPSE_BOOTSTRAP_TOKEN` | Behaviour |
|---|---|---|
| unset | unset | unchanged — register and mint by hand |
| `1` | unset | vault directories under `SYNAPSE_VAULTS_DIR` register themselves |
| `1` | a secret | ...and that secret becomes a credential granting all of them |

Three modes rather than a flag day, because an existing stack has a populated registry and minted
credentials, and turning either switch on implicitly could register vaults its owner never chose to
register.

**The bootstrap secret is an ordinary credential row**, not a new kind of authority. It is hashed on
arrival, granting an explicit set of vaults ([[decision-0017-path-addressed-vaults]]), never admin
([[decision-0015-admin-surface]]). The one thing that is new is where the plaintext comes from: the
operator's `.env` rather than `mintToken`'s CSPRNG. Both containers read that single variable, which
is the point — no secret is carried out of one process and into a file by a human.

**`deploy/standalone/compose.yml`** names published images, bind-mounts the host's vault directory,
and defaults `BIND_ADDR` to `127.0.0.1`. It is a sibling of `deploy/compose.yml`, not a replacement:
that one builds and is for changing Synapse; this one pulls and is for running it.

Four refusals keep this from being a weaker security model than minting:

1. A secret shorter than 24 characters is **refused**. A short bearer on a listener that answers every
   request identically is guessable in a way nothing else here tolerates, and silently accepting one
   would leave a credential that looks minted and is not.
2. A secret with **no registered vault** is refused rather than stored granting nothing. An empty
   grant is indistinguishable from a revoked credential at the listener.
3. Re-running is **idempotent by hash**, so a restart loop adds one row, not one per boot. A vault
   registered later *widens* the existing row rather than adding a second.
4. Auto-register **never removes**. A directory that is not there right now and a vault that is gone
   are different claims, and a mount that has not come up yet looks exactly like the first.

## Rejected

**Core mints a credential and writes it somewhere DSH reads.** The only volume both containers share
is `skills`, which exists precisely so the *public* vault index can be shared without the credential
store beside it. Putting a secret there would undo the reason that volume is separate. A new
credential-only volume would work, but it adds a mount to protect in exchange for removing an
environment variable the operator is already editing.

**Auto-register on by default.** It would silently change what an existing stack serves on its next
`docker compose pull`. A convenience that alters an existing deployment's vault set without being
asked is not a convenience.

**Publishing the vault content in the image.** Vaults are data the stack mounts, never content it
carries — unchanged, and the reason `synapse init` still cannot run inside the core image.

**A hosted deployment.** Still refused. Publishing an *image* is not publishing a *service*: nothing
in the image contains vault data or credentials, and the stack it starts still binds loopback
([[doc-deployment-gate]]).

## Consequences

- (+) A colleague with Docker and a vault directory runs two `curl`s and `docker compose up`.
- (+) The two failure-prone manual steps have a declarative form, and both refuse loudly.
- (+) The images are pullable, so "cannot build the harness" stops being a prerequisite for using it.
- (−) A credential now exists in a file on disk (`.env`) that previously existed only in a terminal
  scrollback. That file is gitignored, and it is the same file already holding `OPENCODE_GO_API_KEY`.
- (−) Publishing images means a release now has two artefacts beyond npm, and they can drift from the
  package version. The workflow refuses a tag whose version disagrees with `package.json`.
- (Δ) `mintToken` accepts a caller-supplied secret. It was previously the only source of token
  plaintext, and that is no longer true.

## Related
[[decision-0017-path-addressed-vaults]] · [[decision-0016-four-container-deployment]] · [[decision-0015-admin-surface]] · [[doc-stack-on-a-new-machine]] · [[doc-four-containers]] · [[doc-deployment-gate]] · [[hub-synapse]]
