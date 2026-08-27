#!/usr/bin/env node
// man.mjs — the full synapse manual. One place that explains the launcher grammar, every subcommand,
// the memory/live-context tools, and the env vars. Needs no vault (prints anywhere). `synapse man`.
const B = (s) => `\x1b[1m${s}\x1b[0m`;   // bold
const D = (s) => `\x1b[2m${s}\x1b[0m`;   // dim
const tty = process.stdout.isTTY;
const b = tty ? B : (s) => s;
const d = tty ? D : (s) => s;

process.stdout.write(`
${b("SYNAPSE — manual")}   ${d("(synapse man · a fuller `synapse help`)")}

${b("0. START HERE")} ${d("(new machine or new vault — in this order)")}

  ${b("1")}  npm install @eborja/synapse        the engine
  ${b("2")}  npx synapse init --write           scaffold the vault (manifest, agents, rules, hubs)
  ${b("3")}  npx synapse mcp-config --write     wire the MCP clients   ${d("— minimum viable")}
      ${d("add --surface orchestrator here if this vault delegates to other agents (see 5.)")}
      ${d("or")}  npx synapse install --write    ${d("the above PLUS the shell CLI, editor dirs + /synapse-<agent> skills")}
  ${b("4")}  exec \$SHELL                        only if you ran install (picks up the shell CLI)
  ${b("5")}  npx synapse lint                   should end: clean (errors=0)

  ${b("Which of setup / install / mcp-config do I need?")}
    ${b("mcp-config")}  writes ONLY the MCP client configs (.mcp.json, .cursor/mcp.json, opencode.json)
                so the vault shows up as tools in your editor. Enough on its own.
    ${b("install")}     a superset: the same MCP configs PLUS the sourced shell CLI — one verb per agent
                (curator, oracle, …), the vault-* helpers, the --cli sinks, AND one harness skill
                per agent so /synapse-<agent> works. Needs exec \$SHELL.
    ${b("setup")}       UNRELATED to the two above. Provisions the SEMANTIC runtime (Ollama + the embed
                model) and builds the index. Entirely optional — skip it and briefings simply
                carry no "Semantically related" section.

  ${b("Upgrading a vault you already have")} ${d("(full two-path guide: docs/doc-install-end-to-end.md)")}
    cd /path/to/your-vault && npm install @eborja/synapse@^2.0.0
    npx synapse install --write     re-wires MCP configs + shell CLI + harness skills (idempotent)
    Coming from < 1.1.0 you also need the harness skills: npx synapse skills --write
    Using DSH? re-run: npx @eborja/dsh-synapse install --write  (needs 0.1.1+; 0.1.0 could wire
    the WRONG vault when $SYNAPSE_VAULT was set). Do NOT use \`init\` to upgrade — it scaffolds.

  ${b("Safe to run on a vault you already built")}
    init FILLS GAPS ONLY (a customised agent is never edited) · mcp-config MERGES (other MCP servers
    and your opencode model/provider are kept) · skills never writes agents/ and leaves a hand-authored
    SKILL.md alone. The one surprise: init re-adds a shipped note you DELETED, because "fills gaps"
    cannot tell deleted-on-purpose from not-yet-installed — so do not re-run init on a pruned vault.

  ${b("About the database")}
    \`init\` ships ZERO migrations and no db/synapse.db. Markdown is canonical for KNOWLEDGE; the DB
    holds RECORDS (contacts, accounts, finances, health). \`synapse migrate\` on a fresh vault prints
    "up to date — nothing to apply" and creates an empty db/synapse.db. Skip it and nothing breaks —
    the vault lints clean and every read tool works. The DB starts mattering when you author your
    first migrations/NNNN-*.sql, the only path that writes records, and it is human-gated.

${b("1. THE LAUNCHER GRAMMAR")} ${d("(sourced agents.sh — one verb per agent)")}

  ${b("<agent> [<target>] [\"task\"] [flags…]")}

  <agent>     a verb per agents/agent-*.md   (e.g. qa-lead, curator, oracle)
  <target>    OPTIONAL. A hub-*/moc-* or any note id that RESOLVES in the vault.
              The first word is a target ONLY if it is hub-*/moc-* (a typo still
              errors clearly) or resolves to a real note — otherwise it is the task.
              So a one-word task like "hi" is a task, not a bad note id.
  "task"      OPTIONAL. A bare quoted string. Enables semantic augment when an
              embeddings index exists. Flags are consumed from ANY position and
              never leak into the task.

  ${b("Flags")}
    --profile lean|standard|fat   context depth (a hub-* target auto-upgrades lean→standard)
    --cli opencode|claude|cursor|clip|print   runtime (default opencode); clip=clipboard, print=stdout
    --model <id>                  runtime model (Tab-completes per --cli)
    --auto|-y --bypass|--yolo --no-auto|--safe|--manual   permission posture (default auto)
    --no-semantic                 skip augment even if an index exists
    --clipboard|-c                copy the briefing (+task) to the clipboard
    --handover <ref>              boot FROM a handover note (see §3)
    --prompt-file <path>          use a note's body as the task, no successor protocol

  ${b("Examples")}
    qa-lead                                     launch, then type your task
    qa-lead "triage the sensors flake"          bare task
    qa-lead moc-sensors "fix the grid"          fuse a hub/moc + task
    qa-lead moc-sensors --profile fat           deeper context, no task
    qa-lead --handover journal/2026-…-ci.md      resume a handover note
    qa-lead moc-sensors "skip the VPN check" --handover <ref> --cli cursor
                                                handover + an inline steering comment (composed)

${b("2. THE `synapse` CLI")} ${d("(npm package — also reachable as `synapse <sub>`)")}

  render <id> …               role-based briefing (the engine)
  augment <id> … --task "…"   render + semantic recall  (also: --handover <ref> / --prompt-file <path>)
  handover-task <ref> [--plain]   print a note (a handover) as a task string
  embeddings [--all]          (re)build the local embeddings cache
  embeddings-status [--json] [--refresh] [--fast]   is that cache current? (staleCount)
  lint [--strict]             mechanical vault health-check
  index / views / migrate     Markdown⇄SQL projections + migrations
  new <kind> <name> [--write] scaffold a wired note: hub | agent | note | handover
  init [dir] [--write]        scaffold a vault from the notes this package ships (fills gaps only)
  setup [--write]             provision the SEMANTIC runtime (Ollama + embed model) + build the index
  install [--write]           MCP configs + shell CLI + editor dirs + harness skills (superset)
                              [--surface skeleton|standard|full|orchestrator]  (see 5.)
                              [--force-rc] rewrite a shell-rc line you edited by hand (see 7.)
  mcp-config [--write]        the MCP client configs alone  [--client claude|cursor|opencode]
                              [--surface skeleton|standard|full|orchestrator]  (see 5.)
  skills [--write]            one harness SKILL.md per agent THIS vault defines  [--agent] [--out] [--force]
  agents | hubs | profiles | models   discovery (shell)
  man | help                  this manual | the quick cheat-sheet

${b("3. BOOT FROM A HANDOVER")}

  A handover note IS a task. --handover <ref> resolves a note (a path anywhere incl. journal/, or a
  fuzzy slug in inbox/handovers/), strips frontmatter, prepends the successor protocol (read it first,
  confirm locked decisions, resume from Next actions, reconcile against the vault), and uses the text
  as the task + recall query. A bare "task" alongside it is APPENDED as an extra instruction — neither
  is dropped. Same behavior via: synapse handover-task (CLI), synapse_resume_from_handover (MCP).

${b("4. MEMORY & LIVE CONTEXT (MCP tools)")} ${d("— see docs/doc-agent-memory.md")}

  synapse_recall(task)        top up context when the task SHIFTS (delta only; a built-in gate says
                              "nothing new" when nothing is relevant). Call it on every topic shift.
  synapse_history(query)      what was already done (keyword; empty = not RECORDED, not "never happened")
  synapse_log(task,summary)   record work you did yourself
  synapse_brief(note:"<id>")  FETCH one note in full — the on-demand "Fetch before you act" path
  synapse_embeddings_status   is the index current (staleCount)?  ·  _rebuild starts a detached rebuild
  synapse_claim_and_brief     dedup-safe delegation: claim a job + get the doer's briefing (records an episode)

  ${d("On-demand notes: a note with `on_demand: true` + `trigger:` renders a ~35-token pointer under a")}
  ${d("\"Fetch before you act\" checklist instead of its body; fetch the body when the trigger matches.")}

${b("5. MCP SURFACES")} ${d("— how many tools the server exposes")}

  A surface is a PERMISSION DIAL, not a feature flag: each is a superset of the last, and a tool that
  is not on the surface is not merely hidden — it is never registered, so it cannot be called.

    ${b("skeleton")}      3 tools   list_agents, list_hubs, render
    ${b("standard")}     11 tools   + brief, augment, embeddings_*, lint, history, log, recall  (read-only)
    ${b("full")}         20 tools   + handover + authoring (create_*, which PROPOSE unless write:true)
    ${b("orchestrator")} 27 tools   + dedup-safe delegation: claim_and_brief, spawn_*, spawn_release, handoffs_open
    ${b("admin")}        32 tools   + vault/credential administration — HTTP + admin-scoped bearer only

  ${b("HOW TO CHANGE IT")} ${d("— both commands take --surface")}
    npx synapse mcp-config --write --surface orchestrator    ${d("the configs alone")}
    npx synapse install    --write --surface orchestrator    ${d("or as part of a full re-wire")}
    npx synapse mcp-config --write --client claude --surface standard    ${d("one client only")}

    ${d("Omit --surface and BOTH commands KEEP the surface this vault is already on (a fresh vault")}
    ${d("gets `full`). They print which they used and why:  surface: orchestrator (kept from this")}
    ${d("vault's existing config). So re-running install never silently downgrades you.")}

  ${b("Or per-process")}
    \$SYNAPSE_MCP_SURFACE=orchestrator   ${d("read by the MCP server at startup; default is full")}

  ${b("Which to choose")}
    Give a read-only assistant ${b("standard")} — it answers from the vault but cannot author or delegate.
    Use ${b("full")} for an agent that files notes. Use ${b("orchestrator")} only for an agent that hands work
    to OTHER agents: it adds the lease + episode machinery. Note that claim_and_brief LAUNCHES NOTHING
    — your harness starts the doer; the claim only makes the dedup unskippable. ${b("admin")} is not a
    generated-config surface: mint \`synapse vaults token <id> --admin\` and connect over HTTP.

${b("6. YOUR AGENTS AS /synapse-<agent>")} ${d("— the harness roster is generated, not shipped")}

  Every \`agents/agent-*.md\` in YOUR vault becomes a harness skill, so a vault with its own roster
  gets its own slash commands — not the four this package happens to ship.

    npx synapse skills                 ${d("dry run — what would be written")}
    npx synapse skills --write         ${d("→ <vault-repo-root>/.dsh/skills/synapse-<agent>/SKILL.md")}
    npx synapse skills --write --agent oracle          ${d("just one")}
    npx synapse skills --write --out ~/.dsh/skills     ${d("the user-scoped root instead of the vault's")}

  ${b("Where they land, and why the default needs no symlink")}
    <repo-root>/.dsh/skills   ${d("project-dsh, DSH's HIGHEST-ranked root. The default.")}
    ~/.dsh/skills             ${d("user-scoped; follows symlinks — what @eborja/dsh-synapse links.")}

    ${d("DSH finds the project root by walking UP for .git, falling back to its launch directory — so")}
    ${d("the target is the repo root, not context-vault/. No .git anywhere? The command warns; use")}
    ${d("--out ~/.dsh/skills for a location that works from wherever you start DSH.")}

  ${b("The body is a POINTER, not a payload")}
    A generated SKILL.md carries the PROCEDURE — become this agent, how to delegate, what you must
    never do. Step 2 is always \`synapse_brief\` with that agent's own id and profile, and THAT
    briefing is the real context. Skill bodies have no size cap, so a skill that grows toward briefing
    size re-creates the very context problem the render engine exists to solve.

  ${b("Your customised agent wins over a shipped skill")}
    The four hand-authored skills are installed verbatim ONLY while your agent still matches the one
    this package ships. Change agent-oracle.md's purpose / profile / delegates_to / uses_tools /
    addressable / outputs and the command warns and generates /synapse-oracle from YOUR definition —
    a tuned skill describing a role you no longer have is worse than a generic one that is accurate.
    Editing only the agent's PROSE BODY changes nothing: the skill is built from frontmatter, and the
    body reaches the model through synapse_brief.

  ${b("Hand-authored skills win, twice over")}
    A SKILL.md without the generated marker is never overwritten. --force overrides that and DISCARDS
    those edits, so think before you use it.

    And where the PACKAGE ships a hand-authored skill for an agent (oracle, curator, ingester,
    reconciler), that copy is installed verbatim instead of a generated one. Not a nicety: the
    project root OUTRANKS the ~/.dsh/skills symlinks, so a generated copy would shadow the tuned
    one. The template is the floor for agents nothing is shipped for, never a replacement.

  ${d("Two things shape what the model sees: `description` is the ONLY routing signal DSH puts in the")}
  ${d("catalog (bodies, paths and whenToUse are excluded), and the `/<name>` gesture injects the whole")}
  ${d("body as user context with no model discretion — which is why it also works headless.")}

${b("7. VAULT RESOLUTION & ENV")}

  Interactive tools resolve the vault CWD-FIRST: the vault you cd into wins; an exported
  \$SYNAPSE_VAULT is a FALLBACK (used only when cwd is not inside a vault). The MCP server is the
  exception — it is config-pinned via .mcp.json and cannot cd, so its env wins.

  \`install --write\` never exports SYNAPSE_VAULT. Its rc line sets \$SYNAPSE_VAULT_FALLBACK — NOT
  exported, consulted last — so installing from another vault can never redirect this one.

  \$SYNAPSE_VAULT          override the vault (YOU set it; fallback for interactive tools, authoritative for MCP)
  \$SYNAPSE_VAULT_FALLBACK written to your shell rc by install --write; not exported, lowest priority
  \$SYNAPSE_NO_REFRESH=1   skip the auto re-embed on augment (the staleness warning still prints)
  \$SYNAPSE_CLI            default runtime for the launcher (default opencode)
  \$SYNAPSE_MODEL          default model  ·  \$SYNAPSE_MCP_SURFACE  skeleton|standard|full|orchestrator

${d("Full reference: docs/doc-cli-reference.md · memory: docs/doc-agent-memory.md · hub-synapse.md")}
`);
