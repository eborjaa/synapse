#!/usr/bin/env bash
# maintain-synapse-cron.sh — LOCAL nightly runner for loop-maintain-synapse.
#
# Runs entirely on this machine: no cloud, no GitHub Actions, NO API key. Detection is git/gh; the
# agent runs via OpenCode (`opencode run`) against local Ollama over Tailscale — the model + endpoint
# come from your ~/.config/opencode/opencode.json (see decision-0004 / doc-runtime-wiring). It detects
# new commits on `main` since the last maintenance commit and, if any, runs agent-curator headlessly
# loading its briefing (skill: maintain-synapse). A dry night just appends a heartbeat line and exits.
#
# PERMISSION POSTURE: this runner does NOT pass --dangerously-skip-permissions. The vault carries a
# finances DB; the curator must run under a constrained OpenCode permission config (read freely;
# edits/bash gated to ask/deny) PLUS the human-gated PR. See doc-runtime-wiring for the opencode.json
# posture. The PR is the human handoff — the curator never merges, never pushes to main.
#
# INSTALL (run as YOUR user so the OpenCode config + ssh/gh login are in scope — never root):
#   crontab -e   ->   30 3 * * *  /path/to/synapse/_meta/tools/maintain-synapse-cron.sh >> /tmp/synapse-cron.log 2>&1
#
#   or a launchd LaunchAgent (~/Library/LaunchAgents/com.synapse.maintain.plist) running daily at 03:30:
#     ProgramArguments = /path/to/synapse/_meta/tools/maintain-synapse-cron.sh
#     StartCalendarInterval = { Hour = 3; Minute = 30; }
#     StandardOutPath / StandardErrorPath = /tmp/synapse-cron.log
#   load with:  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.synapse.maintain.plist
#
# REQUIRES on PATH: git, gh (authenticated: `gh auth status`), opencode (configured: a working
#   ~/.config/opencode/opencode.json pointing at your local Ollama; the Pro must be awake), node.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"               # tools -> _meta -> vault root (= repo root)
BRANCH="main"
MODEL="${SYNAPSE_MODEL:-ollama/qwen3.6-256k}"
LOG="$REPO/inbox/curator/logs/LOG.md"
TS="$(date '+%Y-%m-%d %H:%M')"

mkdir -p "$(dirname "$LOG")"
cd "$REPO"
git fetch -q origin "$BRANCH" || true

# Last-run marker = the latest maintenance commit on the branch (the durable state; see the loop note).
LAST="$(git log "origin/$BRANCH" --grep '^curator: synapse maintenance' -n 1 --format='%H' 2>/dev/null || true)"
[ -z "$LAST" ] && LAST="$(git log -n 1 --format='%H' 2>/dev/null || true)"

# New commits on the branch since the marker, EXCLUDING the curator's own maintenance commits (no-spin).
NEW="$(git log "$LAST..origin/$BRANCH" --format='%s' 2>/dev/null \
        | grep -vc '^curator: synapse maintenance' || true)"

# Prefer the packaged `synapse` CLI (after `synapse install`); fall back to legacy shim.
__syn() {
  if command -v synapse >/dev/null 2>&1; then synapse "$@"
  else node "$REPO/_meta/tools/$1.mjs" "${@:2}"
  fi
}

# Also run if the working tree is currently dirty per a non-dry strict lint (real local drift).
LINT_DIRTY=0
if ! __syn lint --strict >/dev/null 2>&1; then
  LINT_DIRTY=1
fi

if [ "${NEW:-0}" -eq 0 ] && [ "$LINT_DIRTY" -eq 0 ]; then
  echo "$TS - trigger nightly-cron - no new commits since ${LAST:0:9}, lint clean - dry" >> "$LOG"
  exit 0
fi

echo "$TS - trigger nightly-cron - ${NEW:-0} new commit(s) since ${LAST:0:9} (lint_dirty=$LINT_DIRTY) - running curator" >> "$LOG"

# Render the curator's briefing (carries rules, tools, conventions, the loop contract), then run it
# headlessly via OpenCode on the local model. The executable procedure is the OpenCode command
# .opencode/command/maintain-synapse.md (mirrors loop-maintain-synapse). NO --dangerously-skip-permissions:
# the curator runs under your opencode.json permission posture + the human-gated PR.
BRIEFING="$(__syn render agent-curator loop-maintain-synapse --profile standard)"

opencode run -m "$MODEL" --dir "$REPO" "$BRIEFING

---
TASK: You are agent-curator on a LOCAL nightly maintenance run. Execute the maintain-synapse playbook
end-to-end exactly as in .opencode/command/maintain-synapse.md (mirror of loop-maintain-synapse):
(1) Orient on inbox/attention/ + inbox/curator/logs/ first; action any human-resolved escalation.
(2) Detect: synapse lint --strict; DB <-> derived-view divergence; orphans/broken links;
    inbox items. There is NO code-drift detection — this vault is its own source of truth.
(2.5) DRY GATE: if lint errors=0 AND no view diverges AND nothing in the inbox, there is NOTHING to do —
    dispatch nothing, edit nothing, open no PR; append a 'no-op - dry' line to inbox/curator/logs/LOG.md
    and STOP. Treat as success. Only continue if there is real work.
(3) Heal — reconcile, don't regenerate: apply mechanical lint autofixes yourself in .md only. For EACH
    drifted unit, dispatch agent-reconciler seeded with its scoped briefing
    (synapse render agent-reconciler hub-<domain> --profile standard) to regenerate a stale
    derived view or make the MINIMAL note edit. Never regenerate a domain from scratch.
(3c) VERIFY each reconciler diff (maker != checker): in-scope? single-sourced? schema-clean? no stray
    edits? Repair the unambiguous yourself; escalate over-reach. Stage only what you touched (never git add -A).
(3d) A genuinely NEW domain/note with no existing note is from-scratch authoring — do NOT generate it;
    escalate for a human-run ingest (agent-ingester).
(4) Escalate every ambiguous/destructive judgment call, and ANY DB write, to inbox/attention/ as a dated
    note with Options, then stop on it. A record change is proposed as a MIGRATION in the PR, never applied.
(5) Re-lint to errors=0; surface any unresolved error loudly in the PR body — never swallow it.
(6) If (and only if) something changed: branch synapse/curator-\$(date +%F) FRESH off main, commit subject
    'curator: synapse maintenance '\$(date +%F) (the next marker), git push -u origin HEAD (new branch only),
    gh pr create --base main. NEVER force-push, NEVER push to main directly, NEVER gh pr merge — the PR is
    the human handoff. A dry pass opens NO PR.
(7) Log: append a heartbeat line to inbox/curator/logs/LOG.md and, if the pass did something, a per-pass
    run-log in inbox/curator/logs/.
Hard rules: vault .md + migration files ONLY — never write db/synapse.db directly, never edit a generated
view by hand, never merge your own PR, never force-push. Fail loudly; when in doubt, escalate."

echo "$TS - trigger nightly-cron - curator run complete (rc=$?)" >> "$LOG"
