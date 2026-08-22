---
id: note-dsh-extension-seams
type: note
title: DeepSeek Harness extension seams — skills, presets, persona, and what bites
tags:
  - type/note
  - area/runtime
  - area/synapse
  - status/active
related: ["[[note-deepseek-harness-integration]]", "[[note-synapse-harness-playbook]]", "[[hub-synapse]]"]
references_docs: ["[[doc-runtime-wiring]]"]
---

# DeepSeek Harness extension seams — skills, presets, persona, and what bites

The extension seams of the **DeepSeek Harness** (`dsh`), established by reading the DSH source directly and
recorded so that briefing a DSH-capable agent is a render rather than a re-investigation. Every claim
carries a source path. Companion to [[note-deepseek-harness-integration]], which covers the wiring; this
note covers **where to extend it and what will bite you**.

> **Currency.** DSH is pre-release and says so in its own `AGENTS.md` ("prefer the correct foundation over
> compatibility shims: rename or repackage freely"). Config keys and the base/web-app row split can move
> without deprecation. Re-verify this note after a DSH upgrade.

## The three planes

Registrations land in a **scope layer**, and resolution runs `agent → preset → global`, nearest shadowing
farthest (`packages/preset/agent-presets/README.md`). This one rule explains most of the surprises below.

- **Host/global plane** — a plain plugin context registers globally.
- **Preset plane** — a preset's rows register for every agent joined to that preset.
- **Agent plane** — an agent's own `agent.ctx` registers for it alone.

**Consequence that matters most: an MCP client mounted at the profile root registers GLOBALLY**, so every
preset and every subagent child sees its tools. A preset must therefore **not** re-declare `mcp-client` —
`serverName` must be unique across live instances, and a duplicate fails the later plugin at load
(`packages/mcp/mcp-client/README.md`). One MCP row, at the root, serves everything.

## Skills

**Discovery roots**, in precedence order (`packages/skill/skill-filesystem/src/index.ts`):

| Rank | Source | Path |
|---|---|---|
| 100 | `project-dsh` | `<gitRoot>/.dsh/skills` |
| 200 | `project-agents` | `<gitRoot>/.agents/skills` |
| 300 | `custom` | `customSkillDirs` (absolute paths only) |
| 400 | `user-dsh` | `$DSH_HOME/skills` — i.e. `~/.dsh/skills` |
| 500 | `user-agents` | `$DSH_AGENTS_HOME/skills` |

**Layout** is one level deep only: `<root>/<name>/SKILL.md`, or a flat `<root>/<name>.md`. Nested
`**/SKILL.md` is deliberately excluded.

**Frontmatter** must open on line 1 with exactly `---`. Required: **`name`** (matching
`^[a-z0-9]+(?:-[a-z0-9]+)*$`) and **`description`**; missing either drops the skill with a warning. The
catalog name is the frontmatter `name`, **not** the directory name.

**The invocation keys are kebab-case, and the camelCase spellings are actively rejected** — writing
`modelInvocable` or `userInvocable` does not merely fail to apply, it **drops the whole skill**. The real
keys:

- `disable-model-invocation: true` — hidden from the model-facing catalog and the `skill` tool; its only
  entry point becomes the `/<name>` gesture.
- `user-invocable: false` — hidden from human surfaces; does **not** restrict the model-facing tool.

Both default to permitting, and a non-boolean value drops the skill — invocation policy **fails closed**.

**Two traps:**

- **`~/.dsh/skills` follows symlinks**, so skills authored in the framework can be linked in and are seen
  by every profile **with no YAML at all**. Reach for `customSkillDirs` only when a link will not do.
- **The web app DISABLES the host `skill-filesystem` and `tool-skill` rows** (`packages/bundle/web-app/
  cordis.patch.yml`) and moves discovery onto the preset plane, where the shipped `standard` preset
  re-mounts both. **A web profile patch targeting `skill-filesystem` therefore lands on a disabled row and
  silently does nothing.** In headless the row is live and patchable.

**Claude Code compatibility is real**: unknown frontmatter keys are ignored rather than rejected, and the
`<name>/SKILL.md` layout is identical — so one directory can serve both harnesses. What is *not* shared is
the root: **DSH never scans `.claude/skills`**. Point each harness at the same directory separately.

Skill bodies have **no size cap**, so a SKILL.md that grows toward briefing size re-creates the very
context problem that motivated [[note-deepseek-harness-integration]]'s pointer-not-payload rule.

## Presets — web only, and not where you would put them

- **Presets do not exist in `--profile headless`.** That bundle composes no roster, and its own source says
  the model-facing rows sit in the host plane instead. Any design that relies on presets has **no effect**
  headless; use `system-prompt.persona` config there instead.
- **A preset cannot live in a project repo.** The launcher force-overwrites `agent-presets.roots` with the
  shipped root as a *final* overlay (`apps/cli/src/profile-boot.ts`), discarding whatever a profile patch
  set. The only writable root is **`~/.dsh/.agent-presets/<id>/agent.cordis.yml`**.
- **A symlinked preset directory is invisible.** Discovery uses `readdir(withFileTypes)` + `isDirectory()`,
  which is `false` for a symlink to a directory. The symlink escape hatch that works for *skills* does
  **not** work for *presets* — the YAML must be a real file.
- Directory names must match `[a-z0-9][a-z0-9-]*` or they are skipped with no diagnostic; a matching
  directory missing `agent.cordis.yml` is listed as **broken** and still occupies the id.
- **A patch replaces the targeted row's whole `config` block** — restate every key you own.

Selection is a **web** affair: a new-session chip (staged, spent on first use), a General-settings default,
a read-only session-header label, and a management page. `select` works only while a session is blank;
afterwards the host answers `agent-preset-locked`.

## No preset can force-load a skill at startup

There is **no preload/autoload seam** in `tool-skill` — its only config key is
`catalogDescriptionMaxLength`. What a session actually receives is the **catalog**: names and capped
descriptions only, with bodies, paths, providers and `whenToUse` explicitly excluded. (`whenToUse` is *not*
rendered into the catalog, which makes **`description` the only routing signal** the model gets.)

The three achievable alternatives, best first:

1. **`@deepseek-ai/dsh-persona`** — a preset-scoped row that shadows the deployment persona for that agent
   alone, rendering as the order-0 persona section, **prefix-stable for the life of the agent** and costing
   zero tool calls. This is the right home for a short protocol pointer, and it is what "a preset points at
   its skill" can actually mean: *stating the protocol in the identity*, not force-loading a body. The row
   is scope-only and fails loud outside a preset — headless must use `system-prompt.persona` instead.
2. **The `/<name>` gesture** — a whitespace-bounded `/name` token anywhere in a user message injects that
   skill's complete body as user-role context, deterministically and with no model discretion. It works
   headless because the runner submits the task as an ordinary user message, which makes it the scriptable
   entry point. The catalog tells the model not to re-load a skill delivered this way.
3. **`dsh-agent-instructions` `dshHome`** — unconditionally injects `<dshHome>/AGENTS.md` into durable
   history at the first pre-step, and `dshHome` is a per-row config field, so a preset can force-load an
   arbitrary file. It **replaces** the `~/.dsh/AGENTS.md` link in the chain rather than adding to it.

**The design lesson.** A skill is a fine container for a *procedure* but a poor one for a *pointer*: it
costs a discretionary two-hop (catalog appears → the model must choose to call `skill` → body arrives →
only then the real work), and nothing forces that choice. Unconditional context belongs in the persona;
on-demand procedure belongs in the skill.

## Other seams, and why they were rejected

- **`dsh-skill-badge`** — a fixed single skill, no customization.
- **`dsh-commands`** — results "never enter model history", so it is not a prompt path at all.
- **Agent Teams** (`spawn_teammate`, a durable peer mailbox and shared task DAG) is **experimental** and
  shipped disabled. The production delegation surface is `packages/subagent/*` with the `subagent` /
  `subagent_fork` tools, host-plane by design — that is the launcher to pair with
  `synapse_claim_and_brief`.
- **MCP prompts are not supported**: `dsh-mcp-client` implements tools only, with no `prompts/list`. An MCP
  server cannot contribute a slash-command-style template to DSH.

## Operational footguns

- **A superseded preset generation is never reclaimed**, and `skill-filesystem` watches its roots by
  default, so each edit-then-create cycle adds a live watcher set in a long-lived web process.
- **The preset generation stamp is the composition file alone** — editing a preset-bundled `SKILL.md` does
  not reach new sessions until `agent.cordis.yml` moves or the process restarts. Skills under
  `~/.dsh/skills` avoid this: they are watched live.
- **Reads are never sandbox-fenced** ("every mode permits reading"), so skill roots outside the session cwd
  load fine.

## Related
[[note-deepseek-harness-integration]] · [[note-synapse-harness-playbook]] · [[doc-runtime-wiring]] · [[hub-synapse]]
