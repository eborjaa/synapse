---
id: decision-0011-generated-harness-skills
type: decision
title: "Generate one harness skill per vault agent — /synapse-<agent> is the surface, the roster is not shipped"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[decision-0008-addressable-vs-autonomous]]", "[[note-dsh-extension-seams]]", "[[doc-agent-architecture]]", "[[doc-cli-reference]]"]
---

**Status:** Accepted — 2026-08-24 · **Implemented** the same day (`lib/skills.mjs`, `synapse skills`).

## Context

A vault installed on a second machine defines its own agents — `spec-author`, `qa-lead`, whatever that
vault is for. None of them surfaced in the DeepSeek Harness. The only `/synapse-<agent>` gestures
available were the four this package ships as static files in `.dsh/skills/`, and `dsh-synapse`'s
installer merely symlinks whatever the package happens to contain.

That is a gap in **one surface**, not a missing capability. Three consumer surfaces already read the
vault's own roster:

| Surface | Mechanism | Per-vault? |
|---|---|---|
| Shell launcher | `agents.sh` resolves the vault, scans `agents/agent-*.md`, `eval`s one verb per agent | yes |
| opencode / Cursor | the launcher renders the briefing into each client's **native identity format** — `.opencode/agents/synapse-<agent>.md` (whose body IS the system prompt), `.synapse-vault-briefing.mdc` | yes |
| MCP registry | `synapse_list_agents` reads the same frontmatter, including the `addressable` / `autonomous` flags | yes |
| **DSH skills** | four `SKILL.md` files shipped in `files[]` | **no** |

[[decision-0008-addressable-vs-autonomous]] already settled the principle and used almost these words:
*"The package declares the roster; the harness consumes it. A conforming harness reads these flags
(surfaced through the agent registry) **instead of a hand-maintained list of names** — so adding a
watchable agent is a package edit, not a per-install re-wiring."* The four static skills are exactly
that hand-maintained list. This decision does not invent a pattern; it closes the fourth surface
against a contract we took eleven months of work ago.

## Decision

**`synapse skills [--write]` generates one `SKILL.md` per `agents/agent-*.md` in the resolved vault**,
and `synapse install --write` runs it as its fifth step — mirroring how `synapse mcp-config --write`
already generates per-vault client config rather than shipping one.

**The `/<name>` gesture stays the surface.** [[note-dsh-extension-seams]] rejected every alternative
with a reason, and none of them has moved:

- **MCP cannot contribute a slash command.** `dsh-mcp-client` implements tools only, with no
  `prompts/list`. The registry that already knows the roster has no way to expose it as a gesture.
- **Presets cannot carry it.** A preset cannot live in a project repo (the launcher force-overwrites
  `agent-presets.roots` as a final overlay), a symlinked preset directory is invisible
  (`isDirectory()` is false for a symlink), and presets **do not exist in `--profile headless`** at all.
- **`dsh-commands` results "never enter model history"** — not a prompt path.
- The `/<name>` gesture injects the complete skill body as user-role context **deterministically, with
  no model discretion**, and works headless because the runner submits the task as an ordinary user
  message. It is the only entry point with those properties.

**The generated body is a pointer, not a payload.** Step 2 of every generated procedure is
`synapse_brief` with that agent's own id and declared profile; the render engine — which already
compiles rules, tools and typed closure from the same frontmatter — remains the single source of the
actual context. Skill bodies have no size cap, so a `SKILL.md` that grows toward briefing size
re-creates the context problem the whole engine exists to solve.

**Hand-authored skills win, twice over.** A `SKILL.md` lacking the generated marker is never overwritten
without `--force`. And where **this package** ships a hand-authored skill for an agent, that copy is
installed verbatim rather than generated. The second rule is load-bearing: `skill-filesystem` ranks the
project root (`<repo>/.dsh/skills`, rank 100) **above** the user root (`~/.dsh/skills`, rank 400) that
`@eborja/dsh-synapse` symlinks the shipped skills into, and a duplicate name resolves to the better rank.
Generating over `synapse-oracle` would therefore have shadowed the tuned skill with a generic one on
every machine using the recommended DSH install — a regression caught by running the cold install rather
than by reading the code. The four shipped skills were tuned against failure modes observed driving a local 30B
through the harness — claim conflated with spawn, polling `synapse_spawn_status` for a doer nobody
launched, `refused: "held"` treated as fatal — and a regeneration must not silently flatten that.

### What the template reads, and what it refuses to guess

Every conditional branch keys on a **declared** field, never on prose:

| Emitted | Condition |
|---|---|
| catalog `description` | `purpose` (capped) + a trigger sentence from `tags: area/*` — appended **after** the cap, because `description` is the only routing signal DSH puts in the catalog |
| `## Delegating` (the three-call spine) | `delegates_to` is non-empty; the block names the real targets |
| verify + record steps, "propose, do not push" | `uses_tools` contains `tool-lint` or `tool-git` |
| "**Never mutate**" instead of the above | it contains neither — a read-only role is never handed a step that invites a write |
| "**You are addressable**" (publish to the thread) | `addressable: true` ([[decision-0008-addressable-vs-autonomous]]) |
| `## What you produce` | `outputs` is non-empty |
| skipped, with a warning | the id cannot produce a name matching DSH's `^[a-z0-9]+(?:-[a-z0-9]+)*$`, or there is no `purpose`/`title` to route on |

The marker lives in the **body**, as an HTML comment, not in frontmatter: DSH drops a whole skill on a
malformed frontmatter value (the camelCase invocation keys are already a known trap), so we add no keys
to a block whose parser we do not control.

**Default output is the vault REPO ROOT's `.dsh/skills`**, which DSH discovers as `project-dsh`, its
highest-ranked root — so a vault that generates there is wired with no symlink and no YAML at all. The
repo root rather than `vaultDir` is deliberate: `skill-filesystem` resolves that root by walking **up
from its launch directory for a `.git`**, which under the nested layout lands on the repo root and never
on `context-vault/`. When there is no `.git` anywhere it falls back to the launch directory, so the
command warns and names `--out ~/.dsh/skills` — the user-scoped root `@eborja/dsh-synapse` symlinks,
which is found from wherever DSH starts. The two roots coexist.

## Consequences

- (+) A vault's own agents are addressable as `/synapse-<agent>` on any machine, from `synapse install
  --write` alone. This is the feature; everything else is how.
- (+) The delegation spine and working-economy rules live in **one template** instead of copy-pasted per
  agent, so the next lesson learned from a failed run is fixed once.
- (+) `agents/agent-*.md` becomes the single source for all four consumer surfaces — shell, opencode,
  Cursor, and now the harness — which is what [[decision-0008-addressable-vs-autonomous]] asked for.
- (↔) A generated skill is necessarily more generic than a hand-tuned one. The four shipped skills stay
  hand-authored and are skipped by default; the template is the floor, not the ceiling.
- (−) Two ways to author a skill now exist (generated, hand-authored) and the marker is what tells them
  apart. Delete the marker line and the file is yours; that is the whole protocol, and it is stated in
  the file itself.
- (−) Regeneration does not reach a live web session: `skill-filesystem` watches `~/.dsh/skills` live,
  but a preset-bundled skill needs the composition file to move. Start a new session after `--write`.

## Related
[[decision-0008-addressable-vs-autonomous]] · [[note-dsh-extension-seams]] · [[doc-agent-architecture]] · [[doc-cli-reference]] · [[decision-0003-human-gated-mutation]]
