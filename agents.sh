#!/usr/bin/env sh
# agents.sh — Synapse context-vault CLI (sourced shell library for @eborja/synapse)
#
# Source from your shell rc (one-time setup via `synapse install --write`). Since the engine
# ships as an npm package, this file lives at the package root (or node_modules/@eborja/synapse/):
#     export SYNAPSE_VAULT="/path/to/vault"; source ".../node_modules/@eborja/synapse/agents.sh"
#
# One-time setup:
#     npx synapse install --write
# That sources this file and bakes SYNAPSE_VAULT as a safety-net override. Per-call vault
# resolution still prefers $PWD (flat or nested layout).
#
# Vault resolution (per command, from $PWD):
#   • dir with agents/ + _meta/tools/context.manifest.json  → that vault (flat)
#   • dir/context-vault/ with the same                       → nested vault
#   • else $SYNAPSE_VAULT override / monorepo synapse-vault default
#
# ── What you get ──────────────────────────────────────────────────────────────
#
#   curator                              # launch default CLI as agent-curator
#   curator hub-finances                 # agent + a target hub (standard — auto-upgrades)
#   reconciler hub-contacts              # agent + a single domain hub
#   curator hub-finances --profile fat   # override the profile (context dial)
#   curator hub-finances "regenerate the Q2 summary view"   # seed a task (+semantic)
#
#   synapse                # unified front door — `synapse help` lists everything
#   synapse agents         # list all agent commands + their purpose  (vault-agents)
#   synapse hubs           # list all hub targets (valid second arg)   (vault-hubs)
#   synapse profiles       # explain the three profiles (context dials)(vault-profiles)
#   synapse models         # list models for a CLI (--cli opencode|claude|cursor) (vault-models)
#   synapse reload         # force re-source agents.sh (also auto-reloads each prompt)(vault-reload)
#
# ── Syntax ────────────────────────────────────────────────────────────────────
#   <agent-name> [<target-id>] [--profile lean|standard|fat]
#     [--cli opencode|claude|cursor|clip|print]
#     [--model <id>] [--auto|--bypass|--manual] [--no-semantic] [--clipboard] ["task text"]
#
# Engine tools resolve via: `synapse` bin on PATH → package lib/ → node_modules/@eborja/synapse.
#
# Must be SOURCED, not executed. zsh + bash (+ POSIX sh) supported.

# ── defaults (override in your env) ───────────────────────────────────────────
: "${SYNAPSE_MODEL:=ollama/qwen3.6-256k}"
: "${SYNAPSE_CLI:=opencode}"
: "${SYNAPSE_CURSOR_MODEL:=auto}"
# Bedrock is opt-in only (subscription-dependent). Set on or run: vault-bedrock on
: "${SYNAPSE_CURSOR_BEDROCK:=off}"
# Semantic-recall Ollama endpoint (augment.mjs/gen-embeddings.mjs only; NOT opencode's runtime).
: "${SYNAPSE_OLLAMA_URL:=http://localhost:11434}"

# ── locate THIS script (package-aware — may live in node_modules/@eborja/synapse/) ──
if [ -n "${ZSH_VERSION:-}" ]; then
  _mx_self="${(%):-%x}"
elif [ -n "${BASH_VERSION:-}" ]; then
  _mx_self="${BASH_SOURCE[0]}"
else
  _mx_self="$0"
fi
_SYN_SELF_FILE="$(cd "$(dirname "$_mx_self")" 2>/dev/null && pwd)/$(basename "$_mx_self")"
export _SYN_SELF_FILE
# Package root = dirname of agents.sh (when shipped at package root).
_MX_PKG_ROOT="$(cd "$(dirname "$_mx_self")" 2>/dev/null && pwd)"
unset _mx_self

# Monorepo convenience: if this package sits next to synapse-vault/, default there outside any vault.
_MX_DEFAULT_VAULT="$(cd "$_MX_PKG_ROOT/../synapse-vault" 2>/dev/null && pwd)"
if [ ! -d "${_MX_DEFAULT_VAULT:-}/agents" ] || [ ! -f "${_MX_DEFAULT_VAULT:-}/_meta/tools/context.manifest.json" ]; then
  # Standalone: default is whichever vault $PWD / $SYNAPSE_VAULT resolves to.
  _MX_DEFAULT_VAULT=""
fi

export SYNAPSE_MODEL SYNAPSE_CLI SYNAPSE_OLLAMA_URL SYNAPSE_CURSOR_MODEL SYNAPSE_CURSOR_BEDROCK

# ── resolve the EFFECTIVE vault for a single invocation ───────────────────────
# A dir D is a vault when it has agents/ + _meta/tools/context.manifest.json (flat),
# or D/context-vault/ with the same (nested). Engine scripts may live in the npm package,
# Engine code lives in the npm package (lib/), not under _meta/tools/.
__mx_is_vault() { [ -d "$1/agents" ] && [ -f "$1/_meta/tools/context.manifest.json" ]; }

__mx_vault() {
  _mx_d="$PWD"
  while [ -n "$_mx_d" ] && [ "$_mx_d" != "/" ]; do
    if   __mx_is_vault "$_mx_d";               then printf '%s\n' "$_mx_d"; return 0
    elif __mx_is_vault "$_mx_d/context-vault"; then printf '%s\n' "$_mx_d/context-vault"; return 0
    fi
    _mx_d="$(dirname "$_mx_d")"
  done
  if [ -n "${SYNAPSE_VAULT:-}" ]; then
    if   __mx_is_vault "$SYNAPSE_VAULT";               then printf '%s\n' "$SYNAPSE_VAULT"; return 0
    elif __mx_is_vault "$SYNAPSE_VAULT/context-vault"; then printf '%s\n' "$SYNAPSE_VAULT/context-vault"; return 0
    fi
  fi
  if [ -n "${_MX_DEFAULT_VAULT:-}" ] && __mx_is_vault "$_MX_DEFAULT_VAULT"; then
    printf '%s\n' "$_MX_DEFAULT_VAULT"; return 0
  fi
  return 1
}

# ── resolve engine tools from the npm package ──
# True only when a real PATH *binary* named synapse exists. Must ignore the synapse()
# shell function defined below — otherwise `command -v synapse` always succeeds after
# agents.sh is sourced, and `command synapse` then fails with "command not found".
__mx_have_bin() {
  if [ -n "${ZSH_VERSION:-}" ]; then
    whence -p synapse >/dev/null 2>&1
  elif [ -n "${BASH_VERSION:-}" ]; then
    type -P synapse >/dev/null 2>&1
  else
    _mx_bin="$(command -v synapse 2>/dev/null || true)"
    if [ -n "$_mx_bin" ] && [ -x "$_mx_bin" ] && [ ! -d "$_mx_bin" ]; then
      unset _mx_bin
      return 0
    fi
    unset _mx_bin
    return 1
  fi
}

# Map `synapse <sub>` names → lib/*.mjs basenames (and accept legacy tool names as-is).
__mx_cli_to_tool() {
  case "$1" in
    embeddings) printf '%s\n' gen-embeddings ;;
    index)      printf '%s\n' gen-index ;;
    views)      printf '%s\n' gen-views ;;
    migrate)    printf '%s\n' apply-migrations ;;
    journal)    printf '%s\n' journal-new ;;
    *)          printf '%s\n' "$1" ;;
  esac
}

__mx_tool() {
  # $1 = render | augment | gen-embeddings | … (lib basename without .mjs)
  _mx_name="$1"
  _mx_file="${_mx_name}.mjs"

  # Prefer the package's own lib/ when agents.sh is sourced from the package root (dev / linked).
  if [ -f "$_MX_PKG_ROOT/lib/$_mx_file" ]; then
    printf '%s\n' "$_MX_PKG_ROOT/lib/$_mx_file"
    unset _mx_name _mx_file
    return 0
  fi

  _mx_start="$(__mx_vault 2>/dev/null || true)"
  [ -n "$_mx_start" ] || _mx_start="$PWD"
  for _mx_base in "$_mx_start" "$PWD"; do
    _mx_d="$_mx_base"
    while [ -n "$_mx_d" ] && [ "$_mx_d" != "/" ]; do
      if [ -f "$_mx_d/node_modules/@eborja/synapse/lib/$_mx_file" ]; then
        printf '%s\n' "$_mx_d/node_modules/@eborja/synapse/lib/$_mx_file"
        unset _mx_name _mx_file _mx_start _mx_base _mx_d
        return 0
      fi
      _mx_d="$(dirname "$_mx_d")"
    done
  done

  case "$_mx_name" in
    render|augment) _mx_sub="@eborja/synapse/$_mx_name" ;;
    *)              _mx_sub="" ;;
  esac
  if [ -n "$_mx_sub" ]; then
    _mx_p="$(node --input-type=module -e \
      "import{fileURLToPath}from 'node:url';process.stdout.write(fileURLToPath(import.meta.resolve('$_mx_sub')))" \
      2>/dev/null)"
    if [ -n "$_mx_p" ] && [ -f "$_mx_p" ]; then
      printf '%s\n' "$_mx_p"
      unset _mx_name _mx_file _mx_start _mx_base _mx_d _mx_sub _mx_p
      return 0
    fi
  fi
  unset _mx_name _mx_file _mx_start _mx_base _mx_d _mx_sub _mx_p
  return 1
}

__mx_run() {
  # $1 = synapse CLI subcommand (render|augment|index|…) OR legacy tool basename without .mjs
  _mx_cmd="$1"; shift
  if __mx_have_bin; then
    # Prefer the PATH binary — never recurse into the synapse() shell function.
    command synapse "$_mx_cmd" "$@"
    _mx_rc=$?
  else
    _mx_toolpath="$(__mx_tool "$(__mx_cli_to_tool "$_mx_cmd")")"
    if [ -z "$_mx_toolpath" ] && [ "$(__mx_cli_to_tool "$_mx_cmd")" != "$_mx_cmd" ]; then
      _mx_toolpath="$(__mx_tool "$_mx_cmd")"
    fi
    if [ -z "$_mx_toolpath" ]; then
      echo "❌ [synapse] could not resolve '$_mx_cmd' (no 'synapse' bin on PATH and no @eborja/synapse install)." >&2
      unset _mx_cmd _mx_toolpath
      return 127
    fi
    node "$_mx_toolpath" "$@"
    _mx_rc=$?
    unset _mx_toolpath
  fi
  unset _mx_cmd
  return $_mx_rc
}

if ! __mx_vault >/dev/null 2>&1 && [ -z "${SYNAPSE_VAULT:-}" ]; then
  echo "ℹ️  [synapse] no vault found yet (cd into a vault, or set SYNAPSE_VAULT). Commands will resolve per-call." >&2
fi

# Launch an agent by short name; profile read from the effective vault at call time.
__mx_agent_cmd() {
  _name="$1"; shift
  _vault="$(__mx_vault)"
  _prof="$(_mx_field "$_vault/agents/agent-${_name}.md" profile)"
  _prof="${_prof:-lean}"
  __mx_launch "agent-${_name}" "$_prof" "$@"
}

# ── clipboard helper (same tool matrix as render --copy) ──────────────────────
__mx_clip() {
  if   command -v pbcopy >/dev/null 2>&1; then pbcopy
  elif command -v clip   >/dev/null 2>&1; then clip
  elif command -v xclip  >/dev/null 2>&1; then xclip -selection clipboard
  else cat; fi
}

# ── per-CLI model memory (last explicit --model wins until overridden) ────────
__mx_last_model_path() { printf '%s/.synapse-last-model-%s' "${HOME}" "$1"; }

__mx_last_model_save() {
  [ -n "${2:-}" ] || return 0
  printf '%s\n' "$2" > "$(__mx_last_model_path "$1")" 2>/dev/null || true
}

__mx_last_model_load() {
  cat "$(__mx_last_model_path "$1")" 2>/dev/null | head -1
}

# Resolve the model for a CLI: explicit --model > env/config default > last-used > fallback.
__mx_resolve_model() {
  _mx_cli="$1"
  _mx_explicit="$2"
  if [ -n "$_mx_explicit" ]; then
    __mx_last_model_save "$_mx_cli" "$_mx_explicit"
    printf '%s\n' "$_mx_explicit"
    return 0
  fi

  case "$_mx_cli" in
    cursor)
      if [ -n "${SYNAPSE_CURSOR_MODEL:-}" ]; then
        printf '%s\n' "$SYNAPSE_CURSOR_MODEL"; return 0
      fi
      _mx_cfg="${HOME}/.cursor/cli-config.json"
      if [ -f "$_mx_cfg" ] && command -v node >/dev/null 2>&1; then
        _mx_from_cfg="$(node -e '
          try {
            const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
            const sel = c.selectedModel?.modelId || c.model?.modelId || "";
            const aliases = c.model?.aliases;
            if (sel === "default" && aliases?.[0]) process.stdout.write(aliases[0]);
            else if (sel) process.stdout.write(sel);
          } catch {}
        ' "$_mx_cfg" 2>/dev/null)"
        if [ -n "$_mx_from_cfg" ]; then
          printf '%s\n' "$_mx_from_cfg"; return 0
        fi
      fi
      _mx_last="$(__mx_last_model_load cursor)"
      if [ -n "$_mx_last" ]; then printf '%s\n' "$_mx_last"; return 0; fi
      printf '%s\n' "auto"
      ;;
    opencode)
      if [ -n "${SYNAPSE_MODEL:-}" ]; then
        printf '%s\n' "$SYNAPSE_MODEL"; return 0
      fi
      _mx_last="$(__mx_last_model_load opencode)"
      if [ -n "$_mx_last" ]; then printf '%s\n' "$_mx_last"; return 0; fi
      _mx_oc_cfg="${HOME}/.config/opencode/opencode.json"
      if [ -f "$_mx_oc_cfg" ] && command -v node >/dev/null 2>&1; then
        _mx_from_cfg="$(node -e '
          try {
            const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
            if (c.model) process.stdout.write(c.model);
          } catch {}
        ' "$_mx_oc_cfg" 2>/dev/null)"
        if [ -n "$_mx_from_cfg" ]; then
          printf '%s\n' "$_mx_from_cfg"; return 0
        fi
      fi
      printf '%s\n' "ollama/qwen3.6-256k"
      ;;
    claude)
      if [ -n "${ANTHROPIC_MODEL:-}" ]; then
        printf '%s\n' "$ANTHROPIC_MODEL"; return 0
      fi
      _mx_last="$(__mx_last_model_load claude)"
      if [ -n "$_mx_last" ]; then printf '%s\n' "$_mx_last"; return 0; fi
      printf '%s\n' "sonnet"
      ;;
    *)
      printf '%s\n' ""
      ;;
  esac
}

# ── Cursor / AWS Bedrock (opt-in — subscription-dependent) ───────────────────
# Read-only: is Bedrock configured/enabled? Fast path reads cli-config; no network.
__mx_cursor_bedrock_is_enabled() {
  _mx_cfg="${HOME}/.cursor/cli-config.json"
  if [ -f "$_mx_cfg" ] && command -v node >/dev/null 2>&1; then
    node -e '
      try {
        const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        process.exit(c.bedrock?.enabled ? 0 : 1);
      } catch { process.exit(1); }
    ' "$_mx_cfg" 2>/dev/null && return 0
  fi
  return 1
}

# Enable org Bedrock models (us.anthropic.*, …). Only called by vault-bedrock on
# or when SYNAPSE_CURSOR_BEDROCK=on explicitly requests it.
__mx_cursor_bedrock_ensure() {
  command -v cursor-agent >/dev/null 2>&1 || return 1
  __mx_cursor_bedrock_is_enabled && return 0
  _mx_br_team="$(cursor-agent bedrock status 2>/dev/null | awk '/^Team role available:/{print $4}')"
  if [ "$_mx_br_team" = "yes" ]; then
    if cursor-agent bedrock use-team-role >/dev/null 2>&1; then
      echo "☁️  [synapse] Bedrock team-role enabled (org subscription models now available)" >&2
      return 0
    fi
  fi
  return 1
}

__mx_cursor_bedrock_wanted() {
  case "${SYNAPSE_CURSOR_BEDROCK:-off}" in
    1|on|true|yes) return 0 ;;
    *) return 1 ;;
  esac
}

# ── model list cache (per CLI) ────────────────────────────────────────────────
__mx_models_cache() { printf '%s/.synapse-models-%s.cache' "${TMPDIR:-/tmp}" "$1"; }

# Emit one model id per line for the given CLI. Cached (TTL SYNAPSE_MODELS_TTL, default 3600).
__mx_cli_model_ids() {
  cli="${1:-cursor}"
  cache="$(__mx_models_cache "$cli")"
  ttl="${SYNAPSE_MODELS_TTL:-3600}"
  if [ "${2:-}" = "--refresh" ]; then rm -f "$cache"; fi
  if [ -f "$cache" ]; then
    now="$(date +%s)"
    mtime="$(stat -c %Y "$cache" 2>/dev/null || stat -f %m "$cache" 2>/dev/null || echo 0)"
    if [ "$((now - mtime))" -lt "$ttl" ] && [ -s "$cache" ]; then
      cat "$cache"; return 0
    fi
  fi

  ids=""
  case "$cli" in
    cursor)
      command -v cursor-agent >/dev/null 2>&1 || { cat "$cache" 2>/dev/null; return 0; }
      # Fast catalog probe (subscription-agnostic — no Bedrock required).
      catalog="$(cursor-agent --list-models 2>/dev/null \
        | sed -n 's/^\([^ ][^ ]*\) - .*/\1/p')"
      ids="$catalog"
      # Optional Bedrock tenant IDs — only when explicitly opted in (slow probe).
      if __mx_cursor_bedrock_wanted; then
        __mx_cursor_bedrock_ensure 2>/dev/null || true
        _mx_probe_dir="${SYNAPSE_VAULT:-$_MX_DEFAULT_VAULT}"
        bedrock="$(cd "$_mx_probe_dir" 2>/dev/null && cursor-agent -p --model __invalid_probe__ "x" 2>&1 \
          | tr ',' '\n' | sed 's/^ *//;s/ *$//' \
          | grep -E '^(us|eu|ap|sa)\.(anthropic|amazon|meta|cohere|mistral)\.' \
          | sort -u)"
        if [ -n "$bedrock" ]; then
          ids="$(printf '%s\n%s\n' "$bedrock" "$catalog" | grep -v '^$' | sort -u)"
        fi
      fi
      ;;
    opencode)
      command -v opencode >/dev/null 2>&1 || { cat "$cache" 2>/dev/null; return 0; }
      ids="$(opencode models 2>/dev/null | sed '/^$/d')"
      ;;
    claude)
      # Claude Code accepts aliases (sonnet, opus, …) and full catalog names.
      # No reliable offline probe — ship common aliases; user can always type more.
      ids="$(printf '%s\n' \
        sonnet opus haiku fable \
        claude-sonnet-4-6 claude-opus-4-6 claude-opus-4-8 \
        claude-sonnet-5 claude-opus-4-8-thinking-high \
        claude-fable-5 claude-4.6-sonnet-medium)"
      ;;
    *)
      ids=""
      ;;
  esac

  if [ -n "$ids" ]; then
    printf '%s\n' "$ids" > "$cache" 2>/dev/null
    printf '%s\n' "$ids"
  else
    cat "$cache" 2>/dev/null
  fi
}

# ── status icons (shell UX — makes each step glanceable) ─────────────────────
__mx_agent_emoji() {
  case "${1#agent-}" in
    curator)    printf '🧭' ;;
    oracle)     printf '🔮' ;;
    reconciler) printf '🔧' ;;
    ingester)   printf '📥' ;;
    *)          printf '🤖' ;;
  esac
}
__mx_cli_emoji() {
  case "$1" in
    opencode)         printf '⚡' ;;
    claude)           printf '💬' ;;
    cursor)           printf '🖥️' ;;
    clip|clipboard)   printf '📋' ;;
    print|-)          printf '📤' ;;
    *)                printf '▶️' ;;
  esac
}
__mx_profile_emoji() {
  case "$1" in
    lean)     printf '🪶' ;;
    standard) printf '📦' ;;
    fat)      printf '📚' ;;
    *)        printf '🎚️' ;;
  esac
}

# ── core launcher ─────────────────────────────────────────────────────────────
__mx_launch() {
  agent="$1"; profile="$2"; shift 2

  SYNAPSE_VAULT="$(__mx_vault 2>/dev/null)" || true
  if [ -z "$SYNAPSE_VAULT" ]; then
    echo "❌ [synapse] could not locate a vault (cd into one, or set SYNAPSE_VAULT)." >&2
    return 2
  fi
  export SYNAPSE_VAULT

  __mx_is_profile() { case "$1" in lean|standard|fat) return 0;; *) return 1;; esac; }

  target=""
  if [ -n "${1:-}" ] && ! __mx_is_profile "${1:-}" && [ "${1#--}" = "$1" ] && [ "${1#[a-z]}" != "$1" ]; then
    target="$1"; shift
    # Hub-tree path (`hub-career/hub-courses`) is a completion aid; the leaf is the real target.
    case "$target" in */*) target="${target##*/}" ;; esac
    case "$target" in hub-*) [ "$profile" = "lean" ] && profile="standard" ;; esac
  fi

  if __mx_is_profile "${1:-}"; then
    profile="$1"; shift
  elif [ "${1:-}" = "--profile" ] || [ "${1:-}" = "-P" ]; then
    case "${2:-}" in
      lean|standard|fat) profile="$2"; shift 2 ;;
      *) echo "❌ [synapse] profile must be lean|standard|fat (got '${2:-}')" >&2; return 2 ;;
    esac
  fi

  # Extract flags anywhere in remaining args (before task/target parsing leaks them).
  no_semantic=0
  cli="${SYNAPSE_CLI:-opencode}"
  perm_mode="${SYNAPSE_PERM_MODE:-auto}"
  clipboard=0
  model=""
  case "${SYNAPSE_AUTO:-}" in
    0) perm_mode="manual" ;;
    1) perm_mode="auto"   ;;
  esac

  __mx_kept=""
  __mx_want_cli=0
  __mx_want_model=0
  for __mx_a in "$@"; do
    if [ "$__mx_want_cli" = "1" ]; then
      cli="$__mx_a"; __mx_want_cli=0; continue
    fi
    if [ "$__mx_want_model" = "1" ]; then
      model="$__mx_a"; __mx_want_model=0; continue
    fi
    case "$__mx_a" in
      --no-semantic)     no_semantic=1; continue ;;
      --cli)             __mx_want_cli=1; continue ;;
      --cli=*)           cli="${__mx_a#--cli=}"; continue ;;
      --model|-m)        __mx_want_model=1; continue ;;
      --model=*)         model="${__mx_a#--model=}"; continue ;;
      --auto|-y)         perm_mode="auto"; continue ;;
      --bypass|--yolo|--dangerously-skip-permissions) perm_mode="bypass"; continue ;;
      --no-auto|--safe|--confirm|--manual) perm_mode="manual"; continue ;;
      --clipboard|--copy|-c) clipboard=1; continue ;;
    esac
    __mx_kept="${__mx_kept:+$__mx_kept }$__mx_a"
  done

  task="$__mx_kept"

  case "$cli" in
    opencode|claude|cursor|clip|clipboard|print|-) ;;
    *) echo "⚠️  [synapse] unknown --cli '$cli' — using opencode" >&2; cli=opencode ;;
  esac
  case "$perm_mode" in
    manual|auto|bypass) ;;
    *) echo "❌ [synapse] SYNAPSE_PERM_MODE must be manual|auto|bypass (got '$perm_mode')" >&2; return 2 ;;
  esac

  if ! command -v node >/dev/null 2>&1; then
    echo "❌ [synapse] node not found — install Node.js to render briefings." >&2; return 127
  fi

  # Semantic augment: on when task present (unless --no-semantic / SYNAPSE_SEMANTIC=off).
  __mx_semantic=0
  if [ -n "$task" ] && [ "$no_semantic" = "0" ]; then
    case "${SYNAPSE_SEMANTIC:-auto}" in
      1|on|true|yes) __mx_semantic=1 ;;
      0|off|false|no) __mx_semantic=0 ;;
      *)
        if node -e '
          import("node:sqlite").then(({DatabaseSync})=>{
            try{
              const db=new DatabaseSync(process.argv[1],{readOnly:true});
              const t=db.prepare("SELECT name FROM sqlite_master WHERE type='"'"'table'"'"' AND name='"'"'note_vectors'"'"'").get();
              const n=t?db.prepare("SELECT COUNT(*) c FROM note_vectors").get().c:0;
              process.exit(n>0?0:1);
            }catch{process.exit(1);}
          }).catch(()=>process.exit(1));
        ' "$SYNAPSE_VAULT/db/synapse.db" 2>/dev/null; then __mx_semantic=1; fi
        ;;
    esac
  fi

  engine="render"
  if [ "$__mx_semantic" = "1" ]; then
    # Prefer package augment when resolvable (bin or lib); else fall back silently to render.
    if __mx_have_bin || __mx_tool augment >/dev/null 2>&1; then
      engine="augment"
    fi
  fi

  # Emit briefing to stdout or file. Briefing ONLY — task never mixed in here.
  _mx_emit() {
    _out="$1"; shift
    if [ "$engine" = "augment" ]; then
      if [ -n "$target" ]; then
        if [ -n "$_out" ]; then __mx_run augment "$agent" "$target" --profile "$profile" --task "$task" "$@" > "$_out"
        else                       __mx_run augment "$agent" "$target" --profile "$profile" --task "$task" "$@"; fi
      else
        if [ -n "$_out" ]; then __mx_run augment "$agent" --profile "$profile" --task "$task" "$@" > "$_out"
        else                       __mx_run augment "$agent" --profile "$profile" --task "$task" "$@"; fi
      fi
    else
      if [ -n "$target" ]; then
        if [ -n "$_out" ]; then __mx_run render "$agent" "$target" --profile "$profile" "$@" > "$_out"
        else                       __mx_run render "$agent" "$target" --profile "$profile" "$@"; fi
      else
        if [ -n "$_out" ]; then __mx_run render "$agent" --profile "$profile" "$@" > "$_out"
        else                       __mx_run render "$agent" --profile "$profile" "$@"; fi
      fi
    fi
  }

  _mx_agent_ico="$(__mx_agent_emoji "$agent")"
  _mx_who="${agent#agent-}${target:+ + $target}"

  case "$cli" in
    clip|clipboard)
      echo "📋 [synapse] ${_mx_agent_ico} copying ${_mx_who} ($(__mx_profile_emoji "$profile") ${profile}) → clipboard" >&2
      if [ -n "$task" ]; then
        { _mx_emit "" | cat; printf '\n\n---\n\n%s\n' "$task"; } | __mx_clip
      else
        _mx_emit "" --copy 2>/dev/null || _mx_emit "" | __mx_clip
      fi
      return $?
      ;;
    print|-)
      if [ -n "$task" ]; then
        _mx_emit ""
        printf '\n\n---\n\n%s\n' "$task"
      else
        _mx_emit ""
      fi
      return $?
      ;;
  esac

  _bin=""
  case "$cli" in
    opencode) _bin=opencode ;;
    claude)   _bin=claude ;;
    cursor)   _bin=cursor-agent ;;
  esac

  if ! command -v "$_bin" >/dev/null 2>&1; then
    echo "⚠️  [synapse] '${_bin}' not found — 📋 copying briefing to clipboard. (install ${_bin}, or use --cli print)" >&2
    _mx_emit "" --copy 2>/dev/null || _mx_emit "" | __mx_clip
    return $?
  fi

  echo "⏳ [synapse] ${_mx_agent_ico} building briefing for ${_mx_who}…" >&2
  tmp="$(mktemp "${TMPDIR:-/tmp}/synapse.XXXXXX")" || return 1
  if ! _mx_emit "$tmp"; then
    rm -f "$tmp"; return 1
  fi
  tok="$(( $(wc -c < "$tmp" | tr -d ' ') / 4 ))"
  _eng_tag=""; [ "$engine" = "augment" ] && _eng_tag=" 🔍 +semantic"
  if [ "$tok" -gt 60000 ]; then
    echo "⚠️  [synapse] briefing is large (~${tok} tok) — try 'standard' or a single note at 'lean'." >&2
  fi

  if [ "$clipboard" = "1" ]; then
    echo "📋 [synapse] ${_mx_agent_ico} ${_mx_who} ($(__mx_profile_emoji "$profile") ${profile}, ~${tok} tok${_eng_tag}) → clipboard" >&2
    if [ -n "$task" ]; then
      { cat "$tmp"; printf '\n\n---\n\n%s\n' "$task"; } | __mx_clip
    else
      cat "$tmp" | __mx_clip
    fi
    rm -f "$tmp"
    return 0
  fi

  echo "🚀 [synapse] ${_mx_agent_ico} ${_mx_who} ($(__mx_profile_emoji "$profile") ${profile}, ~${tok} tok${_eng_tag}, ${perm_mode}) → $(__mx_cli_emoji "$cli") ${cli}" >&2

  # Permission flags per CLI (loaded into $@ via set --)
  set --
  case "$cli" in
    claude)
      case "$perm_mode" in
        auto)   set -- --permission-mode auto ;;
        bypass) set -- --permission-mode bypassPermissions ;;
        manual) ;;
      esac
      ;;
    opencode)
      case "$perm_mode" in
        auto)
          set -- --dangerously-skip-permissions
          echo "ℹ️  [synapse] opencode has no separate 'auto' mode; using its bypass flag." >&2
          ;;
        bypass) set -- --dangerously-skip-permissions ;;
        manual) ;;
      esac
      ;;
    cursor)
      case "$perm_mode" in
        auto)   set -- --auto-review ;;
        bypass) set -- --force ;;
        manual) ;;
      esac
      ;;
  esac

  rc=0
  case "$cli" in
    claude)
      _mx_claude_model="$(__mx_resolve_model claude "$model")"
      if [ -n "$task" ]; then
        claude "$@" --append-system-prompt-file "$tmp" --add-dir "$SYNAPSE_VAULT" --model "$_mx_claude_model" -- "$task"
      else
        claude "$@" --append-system-prompt-file "$tmp" --add-dir "$SYNAPSE_VAULT" --model "$_mx_claude_model"
      fi
      rc=$?
      ;;
    cursor)
      _rules_dir="$PWD/.cursor/rules"
      _rule_file="$_rules_dir/.synapse-vault-briefing.mdc"
      mkdir -p "$_rules_dir"
      {
        printf '%s\n' '---'
        printf '%s\n' 'description: Synapse vault briefing (temporary — auto-deleted on exit)'
        printf '%s\n' 'alwaysApply: true'
        printf '%s\n' '---'
        printf '\n'
        cat "$tmp"
      } > "$_rule_file"
      trap "rm -f '$_rule_file' '$tmp'; trap - EXIT INT TERM" EXIT INT TERM

      if __mx_cursor_bedrock_wanted; then
        __mx_cursor_bedrock_ensure 2>/dev/null || \
          echo "ℹ️  [synapse] SYNAPSE_CURSOR_BEDROCK=on but Bedrock unavailable — using Cursor catalog" >&2
      fi
      _cursor_model="$(__mx_resolve_model cursor "$model")"
      if [ -n "$task" ]; then
        cursor-agent --model "$_cursor_model" "$@" --add-dir "$SYNAPSE_VAULT" "$task"
      else
        cursor-agent --model "$_cursor_model" "$@" --add-dir "$SYNAPSE_VAULT"
      fi
      rc=$?
      return $rc
      ;;
    opencode)
      _mx_model="$(__mx_resolve_model opencode "$model")"
      _mx_tui="${SYNAPSE_TUI:-auto}"
      case "$_mx_tui" in
        auto) { [ -t 0 ] && [ -t 1 ]; } && _mx_tui=1 || _mx_tui=0 ;;
        1|on|true|yes) _mx_tui=1 ;;
        *) _mx_tui=0 ;;
      esac
      if [ "$_mx_tui" = "1" ] && [ -z "$task" ]; then
        opencode "$SYNAPSE_VAULT" -m "$_mx_model" --prompt "$(cat "$tmp")"
        rc=$?
      elif [ -n "$task" ]; then
        # Briefing as context file; task as the user message (augment-aware).
        opencode run --interactive "$@" -m "$_mx_model" --dir "$SYNAPSE_VAULT" --file "$tmp" "$task"
        rc=$?
      else
        _mx_oc=(run -m "$_mx_model" --dir "$SYNAPSE_VAULT")
        case "${SYNAPSE_THINKING:-1}" in
          0|off|false|no) ;;
          *) _mx_oc+=(--thinking) ;;
        esac
        opencode "${_mx_oc[@]}" "$@" "$(cat "$tmp")"
        rc=$?
      fi
      ;;
  esac
  rm -f "$tmp"
  return $rc
}

# ── auto-generate one function per agent-*.md ─────────────────────────────────
_mx_field() { sed -n "s/^$2:[[:space:]]*//p" "$1" | tr -d '"' | head -1; }

_mx_wrap() {
  indent="$1"; text="$2"; width="${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}"
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

# Register short-name launchers. Core four always exist (cwd-agnostic); vault discovery
# adds any extra agent-*.md. Completions resolve the vault fresh via __mx_vault each Tab.
__mx_register_agent() {
  # shellcheck disable=SC2086,SC2090
  eval "${1}() { __mx_agent_cmd '${1}' \"\$@\"; }"
}

_MX_AGENT_NAMES=""
_mx_nullglob_restore=""
if [ -n "${ZSH_VERSION:-}" ]; then
  # Unmatched globs must not abort sourcing when the vault path is briefly empty.
  [[ -o nullglob ]] && _mx_nullglob_restore=keep || _mx_nullglob_restore=off
  setopt nullglob
fi
# Core agents always — Tab / command lookup work even before a vault is found at source time.
for _mx_name in curator oracle reconciler ingester; do
  __mx_register_agent "$_mx_name"
  _MX_AGENT_NAMES="$_MX_AGENT_NAMES $_mx_name"
done
_mx_agents_root="$(__mx_vault 2>/dev/null || true)"
[ -n "$_mx_agents_root" ] || _mx_agents_root="${SYNAPSE_VAULT:-}"
if [ -n "$_mx_agents_root" ] && [ -d "$_mx_agents_root/agents" ]; then
  for _mx_f in "$_mx_agents_root"/agents/agent-*.md; do
    [ -f "$_mx_f" ] || continue
    _mx_name="$(basename "$_mx_f" .md)"
    _mx_name="${_mx_name#agent-}"
    case " $_MX_AGENT_NAMES " in
      *" $_mx_name "*) continue ;;
    esac
    __mx_register_agent "$_mx_name"
    _MX_AGENT_NAMES="$_MX_AGENT_NAMES $_mx_name"
  done
fi
if [ "$_mx_nullglob_restore" = off ]; then
  unsetopt nullglob 2>/dev/null || true
fi
unset _mx_f _mx_name _mx_agents_root _mx_nullglob_restore
_MX_AGENT_NAMES="${_MX_AGENT_NAMES# }"

# ── TAB-completion (agents · hubs · flags · --model per --cli) ────────────────
# Vault is re-resolved on every Tab via __mx_vault, so completion works from any
# cwd as long as $SYNAPSE_VAULT points at a vault (synapse install --write sets it)
# or you are somewhere under a vault tree.
_MX_FLAGS="--cli --model --profile --auto --bypass --yolo --no-auto --safe --confirm --manual --no-semantic --clipboard --copy"
_MX_PROFILES="lean standard fat"
_MX_CLIS="opencode claude cursor clip print"
_MX_SYNAPSE_SUBS="render augment lint index views migrate embeddings setup install journal agents hubs profiles models bedrock reload gate help"

__mx_list_agent_names() {
  _mx_v="$(__mx_vault 2>/dev/null || true)"
  _mx_found=0
  if [ -n "$_mx_v" ] && [ -d "$_mx_v/agents" ]; then
    for _mx_f in "$_mx_v"/agents/agent-*.md; do
      [ -f "$_mx_f" ] || continue
      _mx_found=1
      _mx_n="$(basename "$_mx_f" .md)"
      printf '%s\n' "${_mx_n#agent-}"
    done
  fi
  if [ "$_mx_found" = 0 ]; then
    printf '%s\n' curator oracle reconciler ingester
  fi
  unset _mx_v _mx_f _mx_n _mx_found
}

__mx_list_agent_ids() {
  __mx_list_agent_names | while IFS= read -r _mx_n; do
    [ -n "$_mx_n" ] || continue
    printf 'agent-%s\n' "$_mx_n"
  done
  unset _mx_n
}

# Emit absolute paths of every hub note: root hub-synapse.md, flat hub/hub-*.md, and
# nested workspaces hub/<slug>/hub-*.md (see decision-0007). Sorted for stable Tab order.
__mx_iter_hub_files() {
  _mx_v="$1"
  [ -n "$_mx_v" ] || return 0
  [ -f "$_mx_v/hub-synapse.md" ] && printf '%s\n' "$_mx_v/hub-synapse.md"
  if [ -d "$_mx_v/hub" ]; then
    find "$_mx_v/hub" -type f -name 'hub-*.md' 2>/dev/null | LC_ALL=C sort
  fi
  unset _mx_v
}

__mx_list_hub_ids() {
  _mx_v="$(__mx_vault 2>/dev/null || true)"
  [ -n "$_mx_v" ] || return 0
  __mx_iter_hub_files "$_mx_v" | while IFS= read -r _mx_f; do
    [ -f "$_mx_f" ] || continue
    basename "$_mx_f" .md
  done
  unset _mx_v _mx_f
}

# Sub-hubs one level under $1: hubs whose `related` frontmatter declares $1 (child-declares-parent —
# see decision-0007). The master hub-synapse is a curated root index, never a child, so it is excluded.
# Scans the single-line `related:` field only (never the body) to avoid matching prose wikilinks.
__mx_child_hubs() {
  _mx_parent="$1"
  [ -n "$_mx_parent" ] || return 0
  _mx_v="$(__mx_vault 2>/dev/null || true)"
  [ -n "$_mx_v" ] || return 0
  __mx_iter_hub_files "$_mx_v" | while IFS= read -r _mx_f; do
    [ -f "$_mx_f" ] || continue
    _mx_id="$(basename "$_mx_f" .md)"
    [ "$_mx_id" = "$_mx_parent" ] && continue
    [ "$_mx_id" = "hub-synapse" ] && continue
    _mx_rel="$(sed -n 's/^related:[[:space:]]*//p' "$_mx_f" 2>/dev/null | head -1)"
    case "$_mx_rel" in
      *"[[$_mx_parent]]"*) printf '%s\n' "$_mx_id" ;;
    esac
  done
  unset _mx_parent _mx_v _mx_f _mx_id _mx_rel
}

# True when $1 looks like a render/launch target id (not a bare profile / flag / task word).
__mx_looks_like_target() {
  case "$1" in
    hub-*|agent-*|note-*|journal-*|project-*|plan-*|contact-*|account-*|summary-*|person-*|decision-*|rule-*|loop-*|doc-*|tool-*|skill-*|glossary-*) return 0 ;;
    *) return 1 ;;
  esac
}

__mx_cli_from_words() {
  # Args = the command words (each a separate arg). Must be passed word-by-word,
  # not as one joined scalar: zsh does not word-split an unquoted scalar, so
  # `for _w in $1` would see the whole line at once and never find `--cli <x>`.
  _w_cli="${SYNAPSE_CLI:-opencode}"
  _mx_next_cli=0
  for _w in "$@"; do
    if [ "$_mx_next_cli" = "1" ]; then _w_cli="$_w"; _mx_next_cli=0; continue; fi
    case "$_w" in
      --cli=*) _w_cli="${_w#--cli=}" ;;
      --cli)   _mx_next_cli=1 ;;
    esac
  done
  unset _mx_next_cli
  printf '%s\n' "$_w_cli"
}

if [ -n "${ZSH_VERSION:-}" ]; then
  __mx_complete_zsh() {
    local -a models hubs agents ids
    local cur="${words[CURRENT]}" prev="${words[CURRENT-1]}"
    local cli; cli="$(__mx_cli_from_words "${(@)words[2,-1]}")"
    case "$prev" in
      --model|-m)
        models=(${(f)"$(__mx_cli_model_ids "$cli" 2>/dev/null)"})
        compadd -- $models; return ;;
      --cli)
        compadd -- ${(z)_MX_CLIS}; return ;;
      --profile|-P)
        compadd -- ${(z)_MX_PROFILES}; return ;;
    esac
    case "$cur" in
      --model=*)
        models=(${(f)"$(__mx_cli_model_ids "$cli" 2>/dev/null)"})
        compadd -P '--model=' -- $models; return ;;
      --cli=*)
        compadd -P '--cli=' -- ${(z)_MX_CLIS}; return ;;
      --*)
        compadd -- ${(z)_MX_FLAGS}; return ;;
    esac

    # Hub-tree navigation: `hub-parent/<TAB>` drills one level down into its sub-hubs.
    if [[ "$cur" == hub-*/* ]]; then
      local base="${cur%/*}" leaf kids k
      leaf="${base##*/}"
      kids=(${(f)"$(__mx_child_hubs "$leaf" 2>/dev/null)"})
      for k in $kids; do compadd -S '' -- "$base/$k"; done
      return
    fi

    # Positional targets: hubs (cwd-agnostic via __mx_vault) + bare profile words.
    local has_target=0 w i
    for (( i=2; i < CURRENT; i++ )); do
      w="${words[i]}"
      [[ "$w" == -* ]] && continue
      __mx_looks_like_target "$w" && has_target=1
    done
    if [ "$has_target" = 0 ]; then
      hubs=(${(f)"$(__mx_list_hub_ids 2>/dev/null)"})
      (( ${#hubs} )) && compadd -- $hubs
    fi
    compadd -- ${(z)_MX_PROFILES}
    compadd -- ${(z)_MX_FLAGS}
  }
  __mx_complete_synapse_zsh() {
    local -a agents ids hubs
    local cur="${words[CURRENT]}"
    if [ "${CURRENT:-0}" -eq 2 ]; then
      agents=(${(f)"$(__mx_list_agent_names 2>/dev/null)"})
      compadd -- ${(z)_MX_SYNAPSE_SUBS} $agents
      return
    fi
    # synapse render|augment <agent-id|hub-id> …
    case "${words[2]}" in
      render|augment)
        case "$cur" in --*) ;; *)
          if [[ "${words[CURRENT-1]}" != --profile && "${words[CURRENT-1]}" != -P && \
                "${words[CURRENT-1]}" != --model && "${words[CURRENT-1]}" != -m && \
                "${words[CURRENT-1]}" != --cli ]]; then
            ids=(${(f)"$(__mx_list_agent_ids 2>/dev/null)"})
            hubs=(${(f)"$(__mx_list_hub_ids 2>/dev/null)"})
            compadd -- $ids $hubs
          fi
          ;;
        esac
        ;;
      bedrock|gate)
        if [ "${CURRENT:-0}" -eq 3 ]; then
          compadd -- on off status; return
        fi
        ;;
    esac
    __mx_complete_zsh
  }
  if whence compdef >/dev/null 2>&1 && (( ${+_comps} )); then
    # ${=...} forces word-splitting: zsh does NOT split unquoted params, so without
    # it the whole name list registers as one bogus command and per-agent Tab
    # completion (hubs, --model, --cli, --profile) silently dies.
    # shellcheck disable=SC2086
    compdef __mx_complete_zsh ${=_MX_AGENT_NAMES} vault-models vault-cursor-models
    compdef __mx_complete_synapse_zsh synapse
  fi
elif [ -n "${BASH_VERSION:-}" ]; then
  __mx_complete_bash() {
    local cur prev cli has_target w
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    cli="$(__mx_cli_from_words "${COMP_WORDS[@]}")"
    case "$prev" in
      --model|-m)
        # shellcheck disable=SC2207
        COMPREPLY=($(compgen -W "$(__mx_cli_model_ids "$cli" 2>/dev/null)" -- "$cur")); return ;;
      --cli)
        # shellcheck disable=SC2207
        COMPREPLY=($(compgen -W "$_MX_CLIS" -- "$cur")); return ;;
      --profile|-P)
        # shellcheck disable=SC2207
        COMPREPLY=($(compgen -W "$_MX_PROFILES" -- "$cur")); return ;;
    esac
    case "$cur" in
      --*)
        # shellcheck disable=SC2207
        COMPREPLY=($(compgen -W "$_MX_FLAGS" -- "$cur")); return ;;
    esac
    # Hub-tree navigation: `hub-parent/<TAB>` drills one level down into its sub-hubs.
    case "$cur" in
      hub-*/*)
        local base leaf kids
        base="${cur%/*}"; leaf="${base##*/}"
        kids="$(__mx_child_hubs "$leaf" 2>/dev/null | sed "s#^#$base/#")"
        # shellcheck disable=SC2207
        COMPREPLY=($(compgen -W "$kids" -- "$cur"))
        [ "${#COMPREPLY[@]}" -gt 0 ] && compopt -o nospace 2>/dev/null
        return ;;
    esac
    has_target=0
    local i
    if [ "${COMP_CWORD:-0}" -gt 1 ]; then
      for (( i=1; i < COMP_CWORD; i++ )); do
        w="${COMP_WORDS[i]}"
        [[ "$w" == -* ]] && continue
        __mx_looks_like_target "$w" && has_target=1
      done
    fi
    local opts="$_MX_PROFILES $_MX_FLAGS"
    if [ "$has_target" = 0 ]; then
      opts="$(__mx_list_hub_ids 2>/dev/null | tr '\n' ' ') $opts"
    fi
    # shellcheck disable=SC2207
    COMPREPLY=($(compgen -W "$opts" -- "$cur"))
  }
  __mx_complete_synapse_bash() {
    local cur prev sub
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    if [ "${COMP_CWORD:-0}" -eq 1 ]; then
      # shellcheck disable=SC2207
      COMPREPLY=($(compgen -W "$_MX_SYNAPSE_SUBS $(__mx_list_agent_names 2>/dev/null | tr '\n' ' ')" -- "$cur")); return
    fi
    sub="${COMP_WORDS[1]}"
    case "$sub" in
      render|augment)
        case "$cur" in --*) ;; *)
          case "$prev" in
            --profile|-P|--model|-m|--cli) ;;
            *)
              # shellcheck disable=SC2207
              COMPREPLY=($(compgen -W "$(__mx_list_agent_ids 2>/dev/null | tr '\n' ' ') $(__mx_list_hub_ids 2>/dev/null | tr '\n' ' ')" -- "$cur")); return
              ;;
          esac
          ;;
        esac
        ;;
      bedrock|gate)
        if [ "${COMP_CWORD:-0}" -eq 2 ]; then
          # shellcheck disable=SC2207
          COMPREPLY=($(compgen -W "on off status" -- "$cur")); return
        fi
        ;;
    esac
    __mx_complete_bash
  }
  # shellcheck disable=SC2086
  complete -F __mx_complete_bash ${_MX_AGENT_NAMES} vault-models vault-cursor-models 2>/dev/null
  complete -F __mx_complete_synapse_bash synapse 2>/dev/null
fi

# ── discovery commands ────────────────────────────────────────────────────────

vault-agents() {
  SYNAPSE_VAULT="$(__mx_vault)"
  echo "🤖 Synapse agents"
  echo "  Usage: <name> [<target-id>] [--profile lean|standard|fat] [--cli opencode|claude|cursor|clip|print]"
  echo "         [--model <id>] [--auto|--bypass|--manual] [--no-semantic] [--clipboard] [\"task\"]"
  echo "  Permission default: auto. Global: export SYNAPSE_PERM_MODE=manual|auto|bypass"
  echo "  --model TAB-completes per --cli; hubs & agents TAB-complete from any cwd (see: synapse models)"
  echo ""
  for f in "$SYNAPSE_VAULT"/agents/agent-*.md; do
    [ -e "$f" ] || continue
    id="$(basename "$f" .md)"
    name="${id#agent-}"
    prof="$(_mx_field "$f" profile)"; prof="${prof:-lean}"
    purpose="$(_mx_field "$f" purpose)"
    printf '  %s %-12s [%-8s] ' "$(__mx_agent_emoji "$name")" "$name" "$prof"
    _mx_wrap 28 "$purpose"
  done
  echo ""
  echo "  Also: synapse hubs | profiles | models | bedrock | reload | gate   (or the vault-* aliases)"
  echo "  Runtime (--cli, default ${SYNAPSE_CLI:-opencode}): opencode | claude | cursor | clip | print"
  echo "  Cursor default model: auto (override: --model <id> or SYNAPSE_CURSOR_MODEL=...)"
  echo "  Bedrock (opt-in): vault-bedrock on  or  SYNAPSE_CURSOR_BEDROCK=on"
}

vault-hubs() {
  SYNAPSE_VAULT="$(__mx_vault)"
  echo "🗺️  Synapse hubs (pass as the second arg to any agent)"
  echo "  Usage: <agent> <hub-id> [--profile standard]"
  echo "  Layout: flat hub/hub-<slug>.md  or  workspace hub/<slug>/hub-<slug>.md"
  echo ""
  __mx_iter_hub_files "$SYNAPSE_VAULT" | while IFS= read -r f; do
    [ -e "$f" ] || continue
    id="$(basename "$f" .md)"
    title="$(grep -m1 '^title:' "$f" | sed 's/^title:[[:space:]]*//' | tr -d '"')"
    # Show workspace-relative path when nested (e.g. hub/courses/hub-courses.md).
    rel="${f#"$SYNAPSE_VAULT"/}"
    case "$rel" in
      hub/*/*) printf '  %-24s %-40s %s\n' "$id" "($rel)" "$title" ;;
      *)       printf '  %-24s %s\n' "$id" "$title" ;;
    esac
  done
  echo ""
  echo "  Also valid: project-* / plan-* / note-* / contact-* / account-* / summary-*"
}

vault-profiles() {
  echo "🎚️  Synapse profiles (context dial — presets of relationship ROLES, not hop counts)"
  echo ""
  printf '  %-4s %-10s %-30s %-12s %s\n' "" "Profile" "Roles pulled" "~Budget" "Best for"
  printf '  %-4s %-10s %-30s %-12s %s\n' "$(__mx_profile_emoji lean)" "lean" "self + rules/skills/tools/deleg" "~4K tok" "an agent + its rules/skills/tools"
  printf '  %-4s %-10s %-30s %-12s %s\n' "$(__mx_profile_emoji standard)" "standard" "+ members/attach/navigate/refs" "~15K tok" "a domain hub"
  printf '  %-4s %-10s %-30s %-12s %s\n' "$(__mx_profile_emoji fat)" "fat" "+ transitive closure" "~30K tok" "deep dives / maximum context"
  echo ""
  echo "  Rule of thumb: agents → lean; hubs → standard (auto when target is hub-*)."
}

vault-models() {
  cli="${SYNAPSE_CLI:-opencode}"
  refresh=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --cli) cli="${2:-opencode}"; shift 2 ;;
      --refresh) refresh="--refresh"; shift ;;
      cursor|opencode|claude) cli="$1"; shift ;;
      *) shift ;;
    esac
  done
  if [ "$cli" = "cursor" ]; then
    if __mx_cursor_bedrock_wanted; then
      echo "☁️  Bedrock status (SYNAPSE_CURSOR_BEDROCK=on)"
      command -v cursor-agent >/dev/null 2>&1 && cursor-agent bedrock status 2>&1 | sed 's/^/  /' || echo "  cursor-agent not on PATH"
      echo ""
      echo "☁️  Raw Bedrock model IDs"
      __mx_cli_model_ids cursor $refresh 2>/dev/null | grep -E '^(us|eu|ap|sa)\.' | sed 's/^/  /' || echo "  (none)"
      echo ""
    elif __mx_cursor_bedrock_is_enabled; then
      echo "☁️  Bedrock"
      echo "  configured in ~/.cursor/cli-config.json (off by default for Synapse — set SYNAPSE_CURSOR_BEDROCK=on to include tenant IDs)"
      echo ""
    fi
    echo "🧠 Cursor catalog"
    __mx_cli_model_ids cursor $refresh 2>/dev/null | grep -v -E '^(us|eu|ap|sa)\.' | sed 's/^/  /'
  else
    echo "🧠 Models for --cli $cli"
    __mx_cli_model_ids "$cli" $refresh | sed 's/^/  /'
  fi
  echo ""
  echo "Use:  <agent> --cli $cli --model <id> ..."
  echo "Cache: $(__mx_models_cache "$cli")  (TTL ${SYNAPSE_MODELS_TTL:-3600}s; synapse models --cli $cli --refresh)"
}

# Alias for genesis-parity / cursor-focused docs
vault-cursor-models() {
  refresh=""; [ "${1:-}" = "--refresh" ] && refresh="--refresh"
  vault-models --cli cursor $refresh
}

# Toggle / inspect AWS Bedrock via Cursor team-role (org subscription models).
vault-bedrock() {
  if ! command -v cursor-agent >/dev/null 2>&1; then
    echo "❌ [synapse] cursor-agent not on PATH" >&2; return 127
  fi
  case "${1:-status}" in
    on|enable|use-team-role)
      if __mx_cursor_bedrock_ensure; then
        cursor-agent bedrock status 2>&1 | sed 's/^/  /'
      else
        echo "❌ [synapse] Could not enable Bedrock team-role. Check: cursor-agent bedrock status" >&2
        cursor-agent bedrock status 2>&1 | sed 's/^/  /' >&2
        return 1
      fi
      ;;
    off|disable)
      cursor-agent bedrock disable 2>&1 | sed 's/^/  /'
      rm -f "$(__mx_models_cache cursor)" 2>/dev/null
      ;;
    status)
      if command -v cursor-agent >/dev/null 2>&1; then
        cursor-agent bedrock status 2>&1 | sed 's/^/  /'
      else
        echo "  ❌ cursor-agent not on PATH" >&2
        return 127
      fi
      echo ""
      if __mx_cursor_bedrock_is_enabled; then
        echo "  ☁️  Raw Bedrock model IDs:"
        __mx_cli_model_ids cursor --refresh 2>/dev/null \
          | grep -E '^(us|eu|ap|sa)\.' | sed 's/^/    /' || echo "    (none)"
      else
        echo "  ☁️  Bedrock off (default). Enable: vault-bedrock on  or  SYNAPSE_CURSOR_BEDROCK=on"
      fi
      ;;
    *)
      echo "usage: vault-bedrock on|off|status" >&2; return 2 ;;
  esac
}

vault-reload() {
  _mx_env="${_MX_REPO:-}/bin/synapse-env.sh"
  if [ -f "$_mx_env" ]; then
    # shellcheck disable=SC1090
    . "$_mx_env"
    echo "🔄 [synapse] re-sourced via $_mx_env"
    return 0
  fi
  if [ -n "${ZSH_VERSION:-}" ]; then
    _mx_self="${(%):-%x}"
  elif [ -n "${BASH_VERSION:-}" ]; then
    _mx_self="${BASH_SOURCE[0]}"
  else
    echo "❌ vault-reload: re-source bin/synapse-env.sh manually" >&2; return 1
  fi
  # shellcheck disable=SC1090
  . "$_mx_self"
  echo "🔄 [synapse] agents.sh re-sourced from $_mx_self"
}

vault-gate() {
  case "${1:-status}" in
    off)    : > "$HOME/.claude/vault-gate-off" && echo "🔓 vault gate OFF — external agent may access the vault" ;;
    on)     rm -f "$HOME/.claude/vault-gate-off" && echo "🔒 vault gate ON — vault sealed (default)" ;;
    status) [ -f "$HOME/.claude/vault-gate-off" ] && echo "🔓 vault gate: OFF" || echo "🔒 vault gate: ON" ;;
    *)      echo "usage: synapse gate on|off|status" >&2; return 2 ;;
  esac
}

# ── unified front door: `synapse <sub>` ───────────────────────────────────────
# One namespace over two families: ENGINE subcommands go through __mx_run (PATH
# binary when present, else package lib/*.mjs via node); SHELL subcommands run
# in-process here because they must touch the live shell (re-source, env, host config).
# The vault-* functions above remain first-class synonyms.
__syn_help() {
  cat <<'EOF'
synapse — Synapse context-vault CLI (@eborja/synapse)

📦 Engine (PATH binary, or package lib/ when no synapse bin on PATH):
  synapse render <id> … [--profile lean|standard|fat] [--dry-run] [--copy]
  synapse augment <id> … --task "…"      render + semantic recall
  synapse lint [--strict]                mechanical vault health-check
  synapse index | views | migrate        SQL records tooling
  synapse embeddings [--all|--selftest]  (re)build the embeddings cache
  synapse setup [--write]                probe/provision Ollama + embedding model
  synapse install [--write]              wire this shell CLI + editor dirs
  synapse journal "slug"                 scaffold journal/<date>-<slug>.md

🐚 Shell (need this sourced CLI; vault-* aliases in parentheses):
  synapse agents        list agent commands            (vault-agents)
  synapse hubs          list hub targets               (vault-hubs)
  synapse profiles      explain the profiles           (vault-profiles)
  synapse models        list models per --cli          (vault-models)
  synapse bedrock …     toggle Cursor Bedrock (on|off|status)   (vault-bedrock)
  synapse reload        re-source this CLI now         (vault-reload)
  synapse gate …        host privacy gate (on|off|status)       (vault-gate)

🤖 Agents (Tab-completes; also as `synapse <agent>`):
  🧭 curator | 🔮 oracle | 🔧 reconciler | 📥 ingester  [<hub-id>] [--profile …] ["task"]
  e.g.  curator hub-<Tab>   or   synapse oracle hub-finances "…"
  Targets: hub ids Tab-complete from any cwd (via $SYNAPSE_VAULT / vault walk).
EOF
}

synapse() {
  case "${1:-}" in
    ""|-h|--help|help) __syn_help ;;
    agents)   shift; vault-agents   "$@" ;;
    hubs)     shift; vault-hubs     "$@" ;;
    profiles) shift; vault-profiles "$@" ;;
    models)   shift; vault-models   "$@" ;;
    bedrock)  shift; vault-bedrock  "$@" ;;
    reload)   shift; vault-reload   "$@" ;;
    gate)     shift; vault-gate     "$@" ;;
    *)
      # Agent short name → launcher (so `synapse curator …` matches Tab completion).
      _syn_as_agent=0
      case " $(__mx_list_agent_names 2>/dev/null | tr '\n' ' ') " in
        *" $1 "*) _syn_as_agent=1 ;;
      esac
      if [ "$_syn_as_agent" = 1 ]; then
        _syn_agent="$1"; shift
        unset _syn_as_agent
        __mx_agent_cmd "$_syn_agent" "$@"
        _syn_rc=$?
        unset _syn_agent
        return $_syn_rc
      fi
      unset _syn_as_agent
      # Engine subcommands: __mx_run uses the PATH binary when available, else node + lib/.
      _syn_eng="$1"; shift
      __mx_run "$_syn_eng" "$@"
      _syn_rc=$?
      unset _syn_eng
      return $_syn_rc
      ;;
  esac
}

# ── auto-reload agents.sh when the file changes (edit it, next prompt picks it up) ──
_MX_AGENTS_SH=""
if [ -n "${ZSH_VERSION:-}" ]; then
  _MX_AGENTS_SH="${(%):-%x}"
elif [ -n "${BASH_VERSION:-}" ]; then
  _MX_AGENTS_SH="${BASH_SOURCE[0]}"
fi
if [ -n "$_MX_AGENTS_SH" ] && [ -f "$_MX_AGENTS_SH" ]; then
  _MX_AGENTS_MTIME="$(stat -c %Y "$_MX_AGENTS_SH" 2>/dev/null || stat -f %m "$_MX_AGENTS_SH" 2>/dev/null || echo 0)"
  if [ -n "${ZSH_VERSION:-}" ]; then
  __mx_autoreload() {
    _mt="$(stat -c %Y "$_MX_AGENTS_SH" 2>/dev/null || stat -f %m "$_MX_AGENTS_SH" 2>/dev/null || echo 0)"
    if [ "$_mt" != "${_MX_AGENTS_MTIME:-0}" ]; then
      _MX_AGENTS_MTIME="$_mt"
      # shellcheck disable=SC1090
      . "$_MX_AGENTS_SH" 2>/dev/null
    fi
  }
  if typeset -f add-zsh-hook >/dev/null 2>&1; then
    add-zsh-hook precmd __mx_autoreload
  fi
  elif [ -n "${BASH_VERSION:-}" ]; then
    __mx_autoreload() {
      _mt="$(stat -c %Y "$_MX_AGENTS_SH" 2>/dev/null || stat -f %m "$_MX_AGENTS_SH" 2>/dev/null || echo 0)"
      if [ "$_mt" != "${_MX_AGENTS_MTIME:-0}" ]; then
        _MX_AGENTS_MTIME="$_mt"
        # shellcheck disable=SC1090
        . "$_MX_AGENTS_SH" 2>/dev/null
      fi
    }
    case "${PROMPT_COMMAND:-}" in
      *__mx_autoreload*) ;;
      *) PROMPT_COMMAND="__mx_autoreload${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
    esac
  fi
fi
