#!/usr/bin/env sh
# agents.sh — Synapse context-vault CLI: one shell command per agent, each launching
# OpenCode (local Ollama over Tailscale) seeded with a rendered, role-based briefing.
#
# Source from your shell rc (one-time setup — the installer bakes the absolute path):
#     export SYNAPSE_VAULT="/abs/path/to/wiki"; source "/abs/path/to/wiki/_meta/tools/agents.sh"
# (run `node _meta/tools/install.mjs --write` to add that line for you)
#
# ── What you get ──────────────────────────────────────────────────────────────
#
#   curator                              # launch OpenCode as agent-curator (its default profile)
#   curator moc-finances                 # agent + a target MOC (standard — auto-upgrades)
#   reconciler moc-contacts              # agent + a single domain hub
#   curator moc-finances --profile fat   # override the profile (context dial)
#   curator moc-finances "regenerate the Q2 summary view"   # seed a task
#
#   vault-agents    # list all agent commands + their purpose
#   vault-mocs      # list all MOC targets (valid second arg)
#   vault-profiles  # explain the three profiles (context dials)
#
# ── Syntax ────────────────────────────────────────────────────────────────────
#   <agent-name> [<target-id>] [--profile lean|standard|fat] [--cli opencode|claude|clip|print] ["task text"]
#
#   <agent-name>   = agent id minus the `agent-` prefix  (e.g. curator, reconciler, ingester)
#   <target-id>    = any vault id: moc-*, project-*, plan-*, note-*, contact-*, account-*, …
#   --profile      = lean | standard | fat; auto-upgrades to standard when a MOC target is given
#
# Runtime is PLUGGABLE via --cli (or `export SYNAPSE_CLI=…`), default `opencode`:
#   • opencode — OpenCode + local Ollama over Tailscale (NO API key, NO cloud); model from SYNAPSE_MODEL,
#                endpoint/key in YOUR ~/.config/opencode/opencode.json (this file hardcodes neither).
#   • claude   — Claude Code, scoped to the repo dir + seeded with the briefing (its own model/keys/config).
#   • clip     — copy the briefing to the clipboard; print (or -) — write it to stdout, pipe into anything.
# The render + semantic pipeline is IDENTICAL for every sink; only the final hand-off differs. So you can
# maintain the public framework with Claude Code and a private vault with local OpenCode, same commands.
#
# ROADMAP (out of full scope here): first-class multi-CLI + external-API-key support — per-CLI model and
# permission config, and an installer that wires more than OpenCode. This selector is the minimal wiring
# toward that goal; see docs/doc-runtime-wiring.md. Contributions welcome.
#
# Must be SOURCED, not executed. zsh + bash (+ POSIX sh) supported.

# ── default model (override in your env: export SYNAPSE_MODEL=ollama/<your-model>) ──
: "${SYNAPSE_MODEL:=ollama/qwen3.6-256k}"
# ── default CLI sink (override per-call with --cli, or globally: export SYNAPSE_CLI=claude) ──
: "${SYNAPSE_CLI:=opencode}"

# ── locate the vault ──────────────────────────────────────────────────────────
# Prefer a pre-set SYNAPSE_VAULT — the installer bakes the absolute path into the source
# line, which is robust against shells / direnv where sourced-script self-detection
# (%x / BASH_SOURCE) comes back empty. Fall back to self-detection (2 levels up from
# _meta/tools/) only when SYNAPSE_VAULT isn't already a valid vault.
if [ -z "${SYNAPSE_VAULT:-}" ] || [ ! -d "${SYNAPSE_VAULT:-}/agents" ]; then
  if [ -n "${ZSH_VERSION:-}" ]; then
    _mx_self="${(%):-%x}"
  elif [ -n "${BASH_VERSION:-}" ]; then
    _mx_self="${BASH_SOURCE[0]}"
  else
    _mx_self="$0"
  fi
  SYNAPSE_VAULT="$(cd "$(dirname "$_mx_self")/../.." 2>/dev/null && pwd)"
  unset _mx_self
fi
export SYNAPSE_VAULT SYNAPSE_MODEL SYNAPSE_CLI

if [ -z "$SYNAPSE_VAULT" ] || [ ! -d "$SYNAPSE_VAULT/agents" ]; then
  echo "agents.sh: could not locate the vault (SYNAPSE_VAULT=$SYNAPSE_VAULT)" >&2
  return 0 2>/dev/null || exit 0
fi

# ── core launcher ──────────────────────────────────────────────────────────────
# $1 = agent-id (full, e.g. agent-curator)
# $2 = default profile (from the agent's `profile:` frontmatter)
# rest = optional [<target-id>] [--profile P] ["task"]
__mx_launch() {
  agent="$1"; profile="$2"; shift 2

  # helper: is $1 a bare profile word?
  __mx_is_profile() { case "$1" in lean|standard|fat) return 0;; *) return 1;; esac; }

  # optional target id — a vault note slug (lowercase, starts with a letter, not a flag/profile word)
  target=""
  if [ -n "${1:-}" ] && ! __mx_is_profile "${1:-}" && [ "${1#--}" = "$1" ] && [ "${1#[a-z]}" != "$1" ]; then
    target="$1"; shift
    # auto-upgrade to standard for MOC targets (user can still override below)
    case "$target" in moc-*) [ "$profile" = "lean" ] && profile="standard" ;; esac
  fi

  # optional profile — bare word (lean|standard|fat) OR --profile / -P flag
  if __mx_is_profile "${1:-}"; then
    profile="$1"; shift
  elif [ "${1:-}" = "--profile" ] || [ "${1:-}" = "-P" ]; then
    case "${2:-}" in
      lean|standard|fat) profile="$2"; shift 2 ;;
      *) echo "profile must be lean|standard|fat (got '${2:-}')" >&2; return 2 ;;
    esac
  fi

  # --no-semantic escape: a flag anywhere in the remaining args forces the deterministic-only path.
  # Strip it out of the positional args (POSIX-safe: rebuild $@ without it) so it never leaks into the task.
  no_semantic=0
  cli="${SYNAPSE_CLI:-opencode}"   # where to send the briefing; --cli overrides (opencode|claude|clip|print)
  __mx_kept=""
  __mx_want_cli=0
  for __mx_a in "$@"; do
    if [ "$__mx_want_cli" = "1" ]; then cli="$__mx_a"; __mx_want_cli=0; continue; fi
    case "$__mx_a" in
      --no-semantic) no_semantic=1; continue ;;
      --cli)         __mx_want_cli=1; continue ;;
    esac
    __mx_kept="${__mx_kept:+$__mx_kept }$__mx_a"
  done

  # remaining args = task text passed through to the chosen CLI as the positional prompt suffix
  task="$__mx_kept"

  # validate the CLI selector (a typo falls back to opencode rather than failing)
  case "$cli" in
    opencode|claude|clip|clipboard|print|-) ;;
    *) echo "[synapse] unknown --cli '$cli' (use opencode|claude|clip|print) — using opencode" >&2; cli=opencode ;;
  esac

  if ! command -v node >/dev/null 2>&1; then
    echo "node not found — install Node.js to render briefings." >&2; return 127
  fi

  # ── decide deterministic-only vs. semantic-augmented ────────────────────────────
  # Semantic augment runs only when a TASK is supplied (it embeds task + briefing). With no task we keep
  # the pure render. SYNAPSE_SEMANTIC overrides: 1/on → force on, 0/off → force off. Default: ON when
  # db/synapse.db has a non-empty note_vectors table, else OFF (the augment would only skip anyway).
  # --no-semantic always wins. This realizes the opt-in posture of decision-0005 / rule-semantic-suggests.
  __mx_semantic=0
  if [ -n "$task" ] && [ "$no_semantic" = "0" ]; then
    case "${SYNAPSE_SEMANTIC:-auto}" in
      1|on|true|yes) __mx_semantic=1 ;;
      0|off|false|no) __mx_semantic=0 ;;
      *) # auto: probe note_vectors for at least one row
        if node -e '
          import("node:sqlite").then(({DatabaseSync})=>{
            try{
              const db=new DatabaseSync(process.argv[1],{readOnly:true});
              const t=db.prepare("SELECT name FROM sqlite_master WHERE type='"'"'table'"'"' AND name='"'"'note_vectors'"'"'").get();
              const n=t?db.prepare("SELECT COUNT(*) c FROM note_vectors").get().c:0;
              process.exit(n>0?0:1);
            }catch{process.exit(1);}
          }).catch(()=>process.exit(1));
        ' "$SYNAPSE_VAULT/db/synapse.db" 2>/dev/null; then __mx_semantic=1; fi ;;
    esac
  fi

  # Render the briefing. Args are passed EXPLICITLY (agent + optional target) — never via an
  # unquoted string: zsh does not word-split unquoted vars, so `node … $ids` would pass
  # "agent moc" as ONE arg and render would fail. When semantic is on, route through augment.mjs (which
  # shells render.mjs itself, then appends the labeled "## Semantically related" section); the task text
  # is passed via --task so augment can embed it. augment degrades gracefully if Ollama is unreachable.
  _mx_render() {  # $1=outfile ("" → --copy fallback passthrough), rest appended
    _out="$1"; shift
    if [ "$__mx_semantic" = "1" ]; then
      _mx_eng="$SYNAPSE_VAULT/_meta/tools/augment.mjs"
      if [ -n "$_out" ]; then
        if [ -n "$target" ]; then node "$_mx_eng" "$agent" "$target" --profile "$profile" --task "$task" "$@" > "$_out" 2>/dev/null
        else                      node "$_mx_eng" "$agent"           --profile "$profile" --task "$task" "$@" > "$_out" 2>/dev/null; fi
      else
        if [ -n "$target" ]; then node "$_mx_eng" "$agent" "$target" --profile "$profile" --task "$task" "$@" 2>&1
        else                      node "$_mx_eng" "$agent"           --profile "$profile" --task "$task" "$@" 2>&1; fi
      fi
    else
      _mx_eng="$SYNAPSE_VAULT/_meta/tools/render.mjs"
      if [ -n "$_out" ]; then
        if [ -n "$target" ]; then node "$_mx_eng" "$agent" "$target" --profile "$profile" "$@" > "$_out" 2>/dev/null
        else                      node "$_mx_eng" "$agent"           --profile "$profile" "$@" > "$_out" 2>/dev/null; fi
      else
        if [ -n "$target" ]; then node "$_mx_eng" "$agent" "$target" --profile "$profile" "$@" 2>&1
        else                      node "$_mx_eng" "$agent"           --profile "$profile" "$@" 2>&1; fi
      fi
    fi
  }

  # ── sinks that need no external CLI ─────────────────────────────────────────────
  case "$cli" in
    clip|clipboard) _mx_render "" --copy; return $? ;;   # render → clipboard, paste into any tool
    print|-)        _mx_render "";          return $? ;;  # render → stdout, pipe into anything
  esac

  # ── CLI sinks (opencode | claude) — require the binary, else fall back to clipboard ──
  if ! command -v "$cli" >/dev/null 2>&1; then
    echo "[synapse] '$cli' not found in PATH — copying briefing to clipboard instead. (install $cli, or use --cli print)" >&2
    _mx_render "" --copy
    return $?
  fi

  tmp="$(mktemp "${TMPDIR:-/tmp}/synapse.XXXXXX")" || return 1
  if ! _mx_render "$tmp"; then
    rm -f "$tmp"; return 1
  fi
  tok="$(( $(wc -c < "$tmp" | tr -d ' ') / 4 ))"
  echo "[synapse] ${agent#agent-}${target:+ + $target} (${profile}, ~${tok} tok$([ "$__mx_semantic" = "1" ] && echo ', +semantic')) → launching ${cli}" >&2
  if [ "$tok" -gt 60000 ]; then
    echo "[synapse] ⚠ briefing is large (~${tok} tok) — 'fat' pulls the transitive graph. Try 'standard' for a tighter, faster prompt." >&2
  fi

  # Assemble the prompt: render output + (optional) task text. The repo dir scopes the session; the
  # edit/bash permission posture is your CLI's OWN config (opencode.json / Claude Code settings + any
  # host gate, e.g. a private-vault PreToolUse gate — see decision-0004 / doc-runtime-wiring).
  briefing="$(cat "$tmp")"
  rm -f "$tmp"
  [ -n "$task" ] && briefing="$briefing

---
TASK: $task"

  # TUI (interactive, seeded — default in a terminal; you stay in a live session) vs one-shot (no UI,
  # auto-selected with no TTY: cron/pipes). Override with SYNAPSE_TUI=1 (force TUI) / SYNAPSE_TUI=0.
  _mx_tui="${SYNAPSE_TUI:-auto}"
  case "$_mx_tui" in
    auto)           { [ -t 0 ] && [ -t 1 ]; } && _mx_tui=1 || _mx_tui=0 ;;
    1|on|true|yes)  _mx_tui=1 ;;
    *)              _mx_tui=0 ;;
  esac

  case "$cli" in
    opencode)
      # OpenCode + local Ollama over Tailscale (model from SYNAPSE_MODEL; endpoint/key live in opencode.json).
      if [ "$_mx_tui" = "1" ]; then
        echo "[synapse] opening the OpenCode TUI — native progress; live session (SYNAPSE_TUI=0 for one-shot)." >&2
        opencode "$SYNAPSE_VAULT" -m "$SYNAPSE_MODEL" --prompt "$briefing"
      else
        # Local reasoning models look frozen for the first 30–90s on a big briefing; stream reasoning.
        _mx_oc=(run -m "$SYNAPSE_MODEL" --dir "$SYNAPSE_VAULT")
        case "${SYNAPSE_THINKING:-1}" in
          0|off|false|no) ;;
          *) _mx_oc+=(--thinking) ;;
        esac
        opencode "${_mx_oc[@]}" "$briefing"
      fi ;;
    claude)
      # Claude Code: scoped to the repo via cwd, seeded with the briefing. Model + permissions are
      # Claude Code's own config; SYNAPSE_MODEL (an Ollama id) does NOT apply. Any host privacy gate
      # (e.g. the private-vault PreToolUse gate) still applies — disable it to use Claude on the vault.
      if [ "$_mx_tui" = "1" ]; then
        echo "[synapse] launching Claude Code (interactive, seeded) in $SYNAPSE_VAULT (SYNAPSE_TUI=0 for one-shot)." >&2
        ( cd "$SYNAPSE_VAULT" && claude "$briefing" )
      else
        ( cd "$SYNAPSE_VAULT" && claude -p "$briefing" )
      fi ;;
  esac
}

# ── auto-generate one function per agent-*.md ─────────────────────────────────
_mx_field() { sed -n "s/^$2:[[:space:]]*//p" "$1" | tr -d '"' | head -1; }

# Word-wrap $2 to the terminal width with a hanging indent of $1 columns.
# The caller has already printed a $1-wide prefix on the current line, so the
# FIRST wrapped line is emitted with no leading pad (it continues that line);
# continuation lines are padded to align under the description column.
_mx_wrap() {
  local indent="$1" text="$2" width
  width="${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}"
  case "$width" in ''|*[!0-9]*) width=80 ;; esac
  awk -v ind="$indent" -v width="$width" -v text="$text" '
    BEGIN {
      avail = width - ind; if (avail < 24) avail = 24
      pad = sprintf("%*s", ind, "")
      n = split(text, w, /[ \t]+/); line = ""; first = 1
      for (i = 1; i <= n; i++) {
        cand = (line == "" ? w[i] : line " " w[i])
        if (length(cand) > avail && line != "") {
          print (first ? "" : pad) line; first = 0; line = w[i]
        } else line = cand
      }
      if (line != "") print (first ? "" : pad) line
    }'
}

for _mx_f in "$SYNAPSE_VAULT"/agents/agent-*.md; do
  [ -e "$_mx_f" ] || continue
  _mx_id="$(basename "$_mx_f" .md)"
  _mx_name="${_mx_id#agent-}"                            # e.g. curator
  _mx_prof="$(_mx_field "$_mx_f" profile)"
  _mx_prof="${_mx_prof:-lean}"
  # shellcheck disable=SC2086,SC2090
  eval "${_mx_name}() { __mx_launch '${_mx_id}' '${_mx_prof}' \"\$@\"; }"
done
unset _mx_f _mx_id _mx_name _mx_prof

# ── discovery commands ────────────────────────────────────────────────────────

vault-agents() {
  echo "Synapse vault agent commands:"
  echo "  Usage: <name> [<target-id>] [--profile lean|standard|fat] [--cli opencode|claude|clip|print] [\"task\"]"
  echo ""
  for f in "$SYNAPSE_VAULT"/agents/agent-*.md; do
    [ -e "$f" ] || continue
    id="$(basename "$f" .md)"
    name="${id#agent-}"
    prof="$(_mx_field "$f" profile)"; prof="${prof:-lean}"
    purpose="$(_mx_field "$f" purpose)"
    printf '  %-14s [%-8s] ' "$name" "$prof"   # 28-col prefix; no newline
    _mx_wrap 28 "$purpose"                      # wraps purpose under the prefix
  done
  echo ""
  echo "  Also: vault-mocs  vault-profiles"
  echo "  Runtime (--cli, default ${SYNAPSE_CLI:-opencode}):  opencode | claude | clip | print"
  echo "    opencode → local Ollama over Tailscale (no API key, model $SYNAPSE_MODEL); claude → Claude Code in \$SYNAPSE_VAULT."
  echo "    e.g.  curator moc-finances --cli claude \"rebuild summaries\"   (maintain via Claude Code instead of OpenCode)"
}

vault-mocs() {
  echo "Synapse vault MOC targets (pass as the second arg to any agent):"
  echo "  Usage: <agent> <moc-id> [--profile standard]"
  echo ""
  for f in "$SYNAPSE_VAULT"/moc/moc-*.md "$SYNAPSE_VAULT"/moc-synapse.md; do
    [ -e "$f" ] || continue
    id="$(basename "$f" .md)"
    title="$(grep -m1 '^title:' "$f" | sed 's/^title:[[:space:]]*//' | tr -d '"')"
    printf '  %-24s %s\n' "$id" "$title"
  done
  echo ""
  echo "  Also valid as targets: project-* / plan-* / note-* / contact-* / account-* / summary-*"
  echo "  Discover: ls \$SYNAPSE_VAULT/moc"
}

vault-profiles() {
  echo "Synapse vault profiles (context dial — presets of relationship ROLES, not hop counts):"
  echo ""
  printf '  %-10s %-30s %-12s %s\n' "Profile" "Roles pulled" "~Budget" "Best for"
  printf '  %-10s %-30s %-12s %s\n' "lean" "self + rules/skills/tools/deleg" "~4K tok" "an agent + its rules/skills/tools, or a single unit note"
  printf '  %-10s %-30s %-12s %s\n' "standard" "+ members/attach/navigate/refs" "~15K tok" "a domain MOC (pulls its members, attachments, refs)"
  printf '  %-10s %-30s %-12s %s\n' "fat" "+ transitive closure" "~30K tok" "deep dives / maximum context"
  echo ""
  echo "  Rule of thumb: agents → their declared profile; MOCs → standard (auto-applied when target is moc-*)."
  echo "  --dry-run previews the closure without rendering bodies."
}
