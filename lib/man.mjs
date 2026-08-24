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
      ${d("or")}  npx synapse install --write    ${d("the above PLUS the agents.sh shell CLI + editor dirs")}
  ${b("4")}  exec \$SHELL                        only if you ran install (picks up the shell CLI)
  ${b("5")}  npx synapse lint                   should end: clean (errors=0)

  ${b("Which of setup / install / mcp-config do I need?")}
    ${b("mcp-config")}  writes ONLY the MCP client configs (.mcp.json, .cursor/mcp.json, opencode.json)
                so the vault shows up as tools in your editor. Enough on its own.
    ${b("install")}     a superset: the same MCP configs PLUS the sourced shell CLI — one verb per agent
                (curator, oracle, …), the vault-* helpers, and the --cli sinks. Needs exec \$SHELL.
    ${b("setup")}       UNRELATED to the two above. Provisions the SEMANTIC runtime (Ollama + the embed
                model) and builds the index. Entirely optional — skip it and briefings simply
                carry no "Semantically related" section.

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
  install [--write]           MCP configs + the agents.sh shell CLI + editor dirs (superset of mcp-config)
  mcp-config [--write]        the MCP client configs alone  [--client claude|cursor|opencode] [--surface …]
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
    ${b("orchestrator")} 26 tools   + dedup-safe delegation: claim_and_brief, spawn_*, spawn_release

  ${b("Raise it when you generate the config")}
    npx synapse mcp-config --write --surface orchestrator
    npx synapse mcp-config --write --client claude --surface standard    ${d("one client only")}

  ${b("Or per-process")}
    \$SYNAPSE_MCP_SURFACE=orchestrator   ${d("read by the MCP server at startup; default is full")}

  ${b("Which to choose")}
    Give a read-only assistant ${b("standard")} — it answers from the vault but cannot author or delegate.
    Use ${b("full")} for an agent that files notes. Use ${b("orchestrator")} only for an agent that hands work
    to OTHER agents: it adds the lease + episode machinery. Note that claim_and_brief LAUNCHES NOTHING
    — your harness starts the doer; the claim only makes the dedup unskippable.

${b("6. VAULT RESOLUTION & ENV")}

  Interactive tools resolve the vault CWD-FIRST: the vault you cd into wins; an exported
  \$SYNAPSE_VAULT is a FALLBACK (used only when cwd is not inside a vault). The MCP server is the
  exception — it is config-pinned via .mcp.json and cannot cd, so its env wins.

  \$SYNAPSE_VAULT          override the vault (fallback for interactive tools; authoritative for MCP)
  \$SYNAPSE_NO_REFRESH=1   skip the auto re-embed on augment (the staleness warning still prints)
  \$SYNAPSE_CLI            default runtime for the launcher (default opencode)
  \$SYNAPSE_MODEL          default model  ·  \$SYNAPSE_MCP_SURFACE  skeleton|standard|full|orchestrator

${d("Full reference: docs/doc-cli-reference.md · memory: docs/doc-agent-memory.md · hub-synapse.md")}
`);
