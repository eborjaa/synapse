#!/usr/bin/env bash
# vault-privacy-gate.sh — reference privacy-gate hook (Claude Code PreToolUse).
#
# Seals a private directory from an EXTERNAL coding agent while leaving the rest of the
# parent tree (e.g. the public framework) fully readable. The deployment-side companion to
# docs/doc-deployment-gate.md. Host-level + CLI-specific (Claude Code) reference impl; adapt
# the same idea for other CLIs.
#
# ── Install ─────────────────────────────────────────────────────────────────────
#   1. Copy this script to ~/.claude/hooks/vault-privacy-gate.sh  (chmod +x)
#   2. Wire it as a PreToolUse hook in ~/.claude/settings.json, passing the dir to seal:
#        "hooks": { "PreToolUse": [ {
#          "matcher": "Read|Edit|Write|Glob|Grep|NotebookEdit|Bash",
#          "hooks": [ { "type": "command",
#            "command": "SYNAPSE_VAULT_GATE_PATH=/abs/path/to/your/private-vault bash ~/.claude/hooks/vault-privacy-gate.sh" } ] } ] }
#      (tip: give the vault a DISTINCTIVE basename — matching is by basename substring.)
#
# ── Toggle (default ON) ────────────────────────────────────────────────────────
#   vault-gate off | on | status      # friendly command (ships in agents.sh)
#   …or the raw host sentinel:  `: > ~/.claude/vault-gate-off` (OFF) · `rm` it (ON)
#
# The gate is the OWNER's switch: an external agent can't disable its own gate (the sentinel
# lives in host config + the CLI's safety classifier refuses agent self-disable). Fails CLOSED.
set -euo pipefail

# Toggle: off-sentinel present -> gate disabled (allow everything).
[ -f "${HOME}/.claude/vault-gate-off" ] && exit 0

# The directory to seal. Unset -> gate is inert (configure it to activate).
GATE_DIR="${SYNAPSE_VAULT_GATE_PATH:-}"
[ -n "$GATE_DIR" ] || exit 0
MARKER="$(basename "$GATE_DIR")"

input=$(cat)
deny() { jq -nc --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'; exit 0; }
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""')

if [[ "$tool" == "Bash" ]]; then
  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
  [[ "$cmd" == *"$MARKER"* ]] || exit 0
  # Block command-chaining / redirection / substitution near the vault (except one leading `cd … &&`).
  if [[ "$cmd" =~ [\;\|\<\>\`] ]] || [[ "$cmd" =~ \$\( ]] || [[ "$cmd" =~ \&\&.*\&\& ]]; then
    deny "$MARKER is private (gate on). Only a clean 'git fetch/merge/pull … upstream' is allowed."
  fi
  # Allow ONLY a clean upstream pull (optionally prefixed by `cd <…vault…> &&` or `git -C <…vault…>`).
  allow_re='^[[:space:]]*(cd[[:space:]]+[^&|;<>$`]*'"$MARKER"'[^&|;<>$`]*&&[[:space:]]*)?git[[:space:]]+(-C[[:space:]]+[^&|;<>$`]*'"$MARKER"'[^&|;<>$`]*[[:space:]]+)?(fetch|merge|pull)[[:space:]]+[^&|;<>$`]*upstream[^&|;<>$`]*$'
  [[ "$cmd" =~ $allow_re ]] && exit 0
  deny "$MARKER is private (gate on). The only permitted action on this repo is 'git fetch/merge/pull … upstream'."
fi

# Non-Bash tools: gate on PATH fields only (mentioning the name in file content is fine).
fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')
sp=$(printf '%s' "$input" | jq -r '.tool_input.path // ""')
[[ "$fp" == *"$MARKER"* ]] && deny "$MARKER is private (gate on). Reads/edits/writes are blocked."
if [[ -n "$sp" ]]; then
  { [[ "$sp" == *"$MARKER"* ]] || [[ "$GATE_DIR" == "$sp"* ]]; } && deny "$MARKER is private (gate on). Searches that would reach it are blocked."
fi
exit 0
