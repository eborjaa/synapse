---
id: doc-stack-on-a-new-machine
type: doc
title: "Runbook — the four-container stack on a machine that has never seen Synapse"
tags:
  - type/doc
  - area/runtime
  - status/active
references_docs: ["[[doc-four-containers]]", "[[doc-deployment-gate]]", "[[doc-runtime-wiring]]", "[[doc-install-end-to-end]]", "[[doc-cli-reference]]"]
related: ["[[hub-synapse]]", "[[decision-0016-four-container-deployment]]", "[[decision-0017-path-addressed-vaults]]", "[[decision-0018-dsh-session-vault-router]]"]
---

# Runbook — the stack on a new machine

Bare machine to a browser tab where a DeepSeek Harness session answers from the vault whose folder you
opened. Every command is copy-pasteable and every step ends in a **check** — a step that can fail
quietly is worse than one that fails loudly, and most of the failures here are quiet.

[[doc-four-containers]] explains *why* the stack is shaped this way. This document is the sequence.

Every check below was run against a live stack, and two of them are here **because** that run showed
them looking like failures when they were not: `boot-sync` reporting `0 roster file(s)`, and the
readiness probe reporting `answered HTTP 401`. Both are noted where they appear. The build steps
themselves have not been walked on a genuinely bare machine — if one of them is wrong, it is a
prerequisite this document assumed you already had.

> **Two different installs, do not confuse them.** [[doc-install-end-to-end]] puts Synapse **on** a
> machine — a vault, `npm install @eborja/synapse`, MCP configs for your editors. This document runs
> Synapse **as a stack** — containers, an HTTP core, a browser UI. You can do either, or both. Nothing
> here requires the other.

---

## 0. What the machine needs

| | | Check |
|---|---|---|
| **Docker** with Compose v2 | any recent Engine or Desktop | `docker compose version` |
| **git** | to clone | `git --version` |
| **Node 22+** | only on the *host*, and only for `deploy/up.sh`'s bind guard | `node -v` |
| **~6 GB disk** | the DSH image is large; the core image is ~200 MB | `docker system df` |
| **A model** | a provider key, or an Ollama host. Everything through step 6 works with **no model** | — |

Linux or macOS. Nothing in any image knows which ([[decision-0016-four-container-deployment]]).

**You do not need:** a public IP, a domain, a reverse proxy, or an npm login. Nothing is published to
the internet at any point ([[doc-deployment-gate]]).

---

## 1. Get the two source trees

```bash
mkdir -p ~/synapse && cd ~/synapse
git clone https://github.com/eborjaa/synapse.git synapse-framework
git clone https://github.com/deepseek-ai/deepseek-harness.git
```

The harness clone is only needed for the real UI (step 6). Skip it and the stack still comes up on the
stub, which proves every wire except the browser.

**Check:**

```bash
ls ~/synapse/synapse-framework/deploy/compose.yml    # must exist
```

---

## 2. Build `synapse-core`

```bash
cd ~/synapse/synapse-framework
cp deploy/.env.example deploy/.env      # BIND_ADDR=127.0.0.1 — do not edit yet
BIND_ADDR=127.0.0.1 ./deploy/up.sh build synapse-core
```

Always `./deploy/up.sh`, never raw `docker compose`. It refuses a wildcard `BIND_ADDR` **before**
Docker publishes anything; the MCP listener's own guard runs after the port is already open, which is
too late.

**Check:**

```bash
docker image ls synapse-synapse-core        # one row
```

> **What is deliberately not in that image.** The starter vault content (`_meta/`, `agents/`, `rules/`,
> `skills/`, `hub-synapse.md`) is absent — its only reader is `synapse init`, which scaffolds a new
> vault, and that is a host-side authoring act. **`synapse init` inside this container will fail for
> lack of sources.** Vaults are data this container mounts, never content it carries. Create vaults on
> the host (step 4).

---

## 3. First boot on the stub UI

```bash
BIND_ADDR=127.0.0.1 ./deploy/up.sh up -d --build
```

Four containers start: `synapse-vpn` (idle busybox), `synapse-dsh` (stub), `synapse-core`, and — only
with `--profile embeddings` — `synapse-ollama`.

**Check, in order. Each one catches a different failure:**

```bash
docker compose -f deploy/compose.yml ps            # dsh + core + vpn are Up
docker logs synapse-core 2>&1 | tail -20           # 'boot-sync: no vaults registered — skip', then ready
curl -si http://127.0.0.1:8080/ | head -1          # the UI stub answers
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/mcp   # 000 — core is NOT on the host
```

That last one is the point of the design, not a failure. `synapse-core` binds `127.0.0.1:3000` **inside
`dsh`'s network namespace**. `dsh` reaches it as loopback; the host cannot. Only `dsh` publishes, as
`${BIND_ADDR}:8080:8080`.

**Prove nothing is on a public interface** — this is the assertion [[doc-deployment-gate]] asks for, and
it is worth running on a machine you have not run it on before:

```bash
# On the machine itself. Expect 8080 bound to 127.0.0.1 ONLY, and no 3000 at all.
ss -ltnp 2>/dev/null | grep -E ':8080|:3000' || netstat -an | grep -E '\.8080|\.3000'
```

A row reading `0.0.0.0:8080` means `BIND_ADDR` was overridden somewhere. Stop and fix it before going on.

---

## 4. Put vaults on the volume and register them

A vault is a directory with `_meta/tools/context.manifest.json` in it. Make one **on the host** (that is
what [[doc-install-end-to-end]] is for), then copy it onto the `vaults` volume:

```bash
# On the host — a brand-new vault, if you do not have one yet:
mkdir -p ~/my-vault && cd ~/my-vault && npm init -y
npm install @eborja/synapse && npx synapse init --write && npx synapse lint

# Onto the volume both containers share:
docker cp ~/my-vault synapse-core:/synapse/vaults/my-vault
```

Copy in as many as you want — the whole point is that one core answers for all of them. Then register
each, from inside the container:

```bash
docker exec synapse-core node --experimental-sqlite /app/lib/vaults.mjs add /synapse/vaults/my-vault
docker exec synapse-core node --experimental-sqlite /app/lib/vaults.mjs list
```

`add` refuses a path that is not inside a vault rather than guessing, so a typo is a refusal, not a
wrongly-registered directory.

**Restart core so it wires what you just registered:**

```bash
docker compose -f deploy/compose.yml restart synapse-core
docker logs synapse-core 2>&1 | grep boot-sync
# → boot-sync: 1 vault(s) · N roster file(s) · M skill file(s)
```

The vault count is what matters. On a **re-run** the file counts are `0 roster file(s) · 0 skill
file(s)` — nothing changed, so nothing was rewritten. That is success, not a failure, and it looks
identical to one.

`boot-sync` runs `vaults roster` and `skills` for every registered vault *before* the listener opens,
and writes `/synapse/skills/index.json` — id and root only, never credentials — which is how the UI
container resolves an open folder to a vault without ever mounting `config/`.

**Mint one credential covering every vault you will open:**

```bash
docker exec synapse-core node --experimental-sqlite /app/lib/vaults.mjs token my-vault --label laptop
```

It is printed **once** and is not recoverable; only its hash is stored. A credential may grant several
vaults — name them all as bare arguments — and the **address** then picks which one answers
([[decision-0017-path-addressed-vaults]]). A multi-vault credential *must* name its vault in the path:
the bare `/mcp` endpoint refuses it rather than quietly serving whichever vault sorts first.

**Check the credential actually reaches the vault**, from inside the namespace:

```bash
TOKEN=<paste>
docker exec synapse-dsh sh -c "curl -s -X POST http://127.0.0.1:3000/mcp/my-vault \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'" | head -c 400
```

A tool list means the whole chain works: transport, credential, path-addressing, vault binding. **If you
only ever run one check from this document, run this one** — everything after it is UI.

---

## 5. Stop here if you do not want the browser UI

You now have a working shared Synapse over HTTP. Any MCP client that can send a bearer can use it, and
`docs/doc-runtime-wiring.md` covers pointing Claude Code, Cursor or opencode at it. Steps 6–8 are the
DeepSeek Harness on top.

---

## 6. Build and run the real UI

The stub proves the port. A real UI is a build of the DeepSeek Harness with the Synapse plugin inside it.

```bash
cd ~/synapse/synapse-framework
DSH_SRC=~/synapse/deepseek-harness ./deploy/build-dsh.sh     # ~10–20 min the first time
```

The script passes this repo as a **named build context** so the image carries `@eborja/synapse` at
`/opt/synapse`. A plain `docker build` of the harness checkout produces an image that starts, serves,
and has no Synapse tools in it — which looks like a wiring bug and is not one.

Then add to `deploy/.env` (**gitignored — it holds the bearer**):

```
BIND_ADDR=127.0.0.1
DSH_IMAGE=synapse-dsh:local
SYNAPSE_MCP_HTTP_URL=http://127.0.0.1:3000/mcp
SYNAPSE_MCP_TOKEN=<the credential from step 4>
```

`SYNAPSE_MCP_HTTP_URL` is a **base, not an endpoint**. The plugin appends `/<vault-id>` for the folder
the session opened. Pinning it to `…/mcp/my-vault` makes every session answer from that one vault — and
it will look like it is working.

Bring it up. Two rules, both learned the hard way:

```bash
BIND_ADDR=127.0.0.1 ./deploy/up.sh up -d --force-recreate --no-build
```

- **`--no-build`**, because `--build` rebuilds the *stub* and retags it as `DSH_IMAGE`, silently
  replacing the image you just spent twenty minutes on.
- **Recreate `dsh` and `synapse-core` together.** Core lives in dsh's network namespace; recreating
  only `dsh` leaves core in the old one, and `127.0.0.1:3000` inside the new `dsh` answers nothing.

**Check:**

```bash
docker logs synapse-dsh 2>&1 | grep -E 'synapse-core answered|dsh-proxy|dsh web:'
```

Three lines you want:

```
[dsh] synapse-core answered HTTP 401
[dsh-proxy] 0.0.0.0:8080 → 127.0.0.1:3080
dsh web: http://127.0.0.1:3080/?token=…
```

**`answered HTTP 401` is the good outcome.** The readiness probe is unauthenticated on purpose — it
asks only "is something listening", and a core that refuses an anonymous request is a core that is
working. A `0` there, or `did not answer in 60s`, is the failure.

> **Why the in-container proxy exists.** DSH refuses `--host 0.0.0.0` — that would put remote code
> execution on the network. But Docker can only publish a port the process listens on on the
> container's external interface. So DSH runs on `127.0.0.1:3080` and a ~20-line TCP proxy binds
> `0.0.0.0:8080` **inside** the container. The **host** publish is still `${BIND_ADDR}:8080:8080`. The
> wildcard never leaves the container.

---

## 7. Open it

DSH 0.1.2 returns **401 on `/`** until a browser exchanges its process token for a cookie. Take the token
from the logs, but connect on the **published** port, not the one in the log line:

```bash
docker logs synapse-dsh 2>&1 | grep -o 'token=[A-Za-z0-9_-]*' | tail -1
# open http://127.0.0.1:8080/?token=<that>     ← 8080, not the 3080 the log prints
```

Then, in the UI:

1. Open the folder `/synapse/vaults/my-vault` as a workspace.
2. Ask the session to list its agents. They are **that vault's** agents.
3. Open a second vault folder in a second workspace. Its agent list is different, and its tools answer
   from its own vault — no dropdown, no restart. Opening a folder is the whole act of switching
   ([[decision-0018-dsh-session-vault-router]]).

**Pick a model** in DSH's own settings — that part is yours and the stack deliberately does not choose
for you. A local Ollama on the Docker host is reachable from the UI container as
`http://host.docker.internal:11434/v1` (the `extra_hosts` entry in `compose.yml` is what makes that
resolve on Linux too).

---

## 8. Prove it, without trusting the chat

Prose in a chat window can claim a success the machinery never achieved. Two assertions that cannot.

**The container runs no second writer:**

```bash
docker exec synapse-dsh sh -c 'ps ax | grep -c "[s]ynapse-mcp"'   # 0
```

A stdio `synapse-mcp` in the UI container would be a second writer against databases `synapse-core`
already owns — the one thing the single-writer design forbids.

**Destroy everything and lose nothing** (US-4.2, and the reason for the volume layout):

```bash
BIND_ADDR=127.0.0.1 ./deploy/up.sh down            # NOT -v: that deletes the volumes
BIND_ADDR=127.0.0.1 ./deploy/up.sh up -d --no-build
docker exec synapse-core node --experimental-sqlite /app/lib/vaults.mjs list   # your vaults, still there
```

Everything above the volumes is disposable. `down -v` is the one command that destroys real data.

**The full browser suite**, if you want it — it needs a live stack *and* a live model:

```bash
npm --prefix dsh/e2e install
npm --prefix dsh/e2e test        # 9 specs; ~4 min. See dsh/e2e/README.md
```

---

## 9. Optional pieces

**Semantic recall.** `augment` and `embeddings` want an embedding model; the deterministic core does not.

```bash
BIND_ADDR=127.0.0.1 ./deploy/up.sh --profile embeddings up -d ollama
docker exec synapse-ollama ollama pull mxbai-embed-large
```

**A VPN, to reach it from a phone.** `vpn-sidecar` idles until you name a real tunnel. Swapping the VPN
is swapping one image, not editing the compose file:

```
VPN_IMAGE=tailscale/tailscale:v1.84.0
TS_AUTHKEY=<key>
BIND_ADDR=<the VPN interface address>      # never 0.0.0.0, and up.sh will refuse it
```

`BIND_ADDR` is the **only** laptop-vs-server difference in the whole stack.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `up.sh` exits before Docker runs | `BIND_ADDR` is `0.0.0.0`, `::`, or empty | Set a loopback or VPN-interface address. This guard is the point. |
| Core exits **3** at boot | Another core holds `synapse-core.lock` | One core per volume set. If the holder is genuinely gone, the entrypoint clears a *foreign-container* record on its own; a same-container record is the recycled-pid case and resolves itself. |
| UI is up, no synapse tools | The image has no plugin | Rebuilt with plain `docker build`. Use `deploy/build-dsh.sh` — the named `synapse` context is not optional. |
| Tools present, every session answers from one vault | `SYNAPSE_MCP_HTTP_URL` was pinned to a `/<vault-id>` | Set it to the **base** `http://127.0.0.1:3000/mcp`. |
| `SYNAPSE_MCP_TOKEN is empty` | The bearer never reached the container | It comes from `deploy/.env` through compose. Recreate `dsh` after editing that file. |
| Session in a vault folder sees no tools | That vault is not registered, or `index.json` is stale | `vaults.mjs add`, then restart `synapse-core` so `boot-sync` rewrites the index. |
| `dsh` reachable, core unreachable from it | `dsh` was recreated alone | Recreate both — core lives in dsh's namespace. |
| Your beautiful DSH image became the stub again | `up.sh up --build` with `DSH_IMAGE` set | `--no-build`, then `build-dsh.sh` again. |
| Browser gets 401 | DSH 0.1.2 wants its process token once | `http://127.0.0.1:8080/?token=…` — port **8080**, not the 3080 in the log. |
| `/synapse-<agent>` slash commands missing | Those are the roster plane, not the plugin | Restart core (`boot-sync` writes them) — or on a host vault, `synapse skills --write`. |

---

## What is specific to *your* machine

Nothing in any image. Exactly four things live outside it, and all four are yours:

1. `deploy/.env` — `BIND_ADDR`, `DSH_IMAGE`, and the bearer. Gitignored; never commit it.
2. The `vaults` volume — your knowledge.
3. The `config` volume — `vaults.json` and `tokens.json` (0600). Never mounted into the UI container.
4. The `dsh-home` volume — DSH's own settings, including which model you chose.

Moving to another machine is copying those volumes. Rebuilding is destroying every container.

## Related
[[doc-four-containers]] · [[doc-deployment-gate]] · [[doc-runtime-wiring]] · [[doc-install-end-to-end]] · [[decision-0016-four-container-deployment]] · [[hub-synapse]]
