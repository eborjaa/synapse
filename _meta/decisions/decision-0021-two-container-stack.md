---
id: decision-0021-two-container-stack
type: decision
title: "Two containers, not four: a VPN belongs on the host and an embedding server is a URL"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[decision-0016-four-container-deployment]]", "[[doc-four-containers]]", "[[doc-deployment-gate]]", "[[doc-stack-on-a-new-machine]]", "[[hub-synapse]]"]
---

**Status:** Accepted — 2026-08-28 · Amends [[decision-0016-four-container-deployment]].

## Context

The stack shipped four containers. Two of them never did anything.

`vpn-sidecar` was an idle `busybox` running `sleep infinity`, waiting for someone to set `VPN_IMAGE`.
Nobody ever did, on any machine, in the entire life of the stack. `ollama` sat behind
`profiles: [embeddings]`, which means it did not start unless explicitly asked for — and it was not.

Both were *options presented as containers*. The cost of that framing is not the disk they consume
while stopped; it is that every reader of `compose.yml`, every diagram, and every runbook step had to
account for two services that were placeholders. The four-container design was described as the
deliverable, so a person standing the stack up reasonably assumed all four mattered.

## Decision

**Two services: `dsh` and `synapse-core`.**

`vpn-sidecar` is removed. **Run the tunnel on the host** — Tailscale, WireGuard, anything — and point
`BIND_ADDR` at its interface address. This is not a reduction in the privacy posture, because the
posture was never "a VPN container exists". It is, and remains, that `BIND_ADDR` is not a wildcard and
nothing is published on a public interface ([[doc-deployment-gate]]). That is asserted by
`deploy/up.sh` before Docker publishes anything, and by the compose default, exactly as before.

`ollama` is removed **as a container, not as a capability.** `SYNAPSE_OLLAMA_URL` still points core at
an embedding host and now defaults to one on the Docker host. Semantic recall works; compose does not
have to own that process's lifecycle. The deterministic core never needed it at all.

Both compose files keep a comment recording what left and how to get it back. A reader who remembers
the four-container diagram deserves better than silence.

**`doc-four-containers` keeps its id.** Two dozen notes link to it, and a decision note is a dated
record of what was decided then, not a document to rewrite when the design moves. The note's title and
body describe the current stack; this note explains the change.

## Rejected

**Keeping them "in case someone wants them."** That is what `profiles:` was for, and the ollama profile
proved the point: a service nobody starts is a service nobody maintains. When it was finally needed it
would have been stale.

**A separate `compose.vpn.yml` overlay.** A second file to explain, for a capability the host already
provides better. Tailscale on the host also covers ssh and every other service on the machine, which a
sidecar bound to one namespace cannot.

## Consequences

- (+) Two services, four volumes. The file is readable in one screen.
- (+) One less privileged container: `vpn-sidecar` carried `cap_add: NET_ADMIN`.
- (−) Reaching the stack over a VPN is now a host setup step, not a compose variable. Documented in
  [[doc-stack-on-a-new-machine]].
- (−) `docker compose --profile embeddings up` no longer brings an embedding server with it.
- (Δ) **`extra_hosts` lives on `dsh` alone.** Found by running the stack, not by reading it: Docker
  refuses `extra_hosts` on a container sharing another's network namespace — *"conflicting options:
  custom host-to-IP mapping and the network mode"*. `/etc/hosts` belongs to the namespace, so core
  resolves `host.docker.internal` through the entry `dsh` declares. Verified live:
  `host.docker.internal -> 192.168.65.254` from inside core.

## Related
[[decision-0016-four-container-deployment]] · [[doc-four-containers]] · [[doc-deployment-gate]] · [[doc-stack-on-a-new-machine]] · [[hub-synapse]]
