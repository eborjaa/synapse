#!/usr/bin/env bash
# Synapse pre-commit hook — fast local mirror of the vault lint gate.
#
# Install (opt-in, from the repo root):
#     ln -sf ../../_meta/tools/pre-commit.sh .git/hooks/pre-commit
#     chmod +x _meta/tools/pre-commit.sh
# Skip once with:  git commit --no-verify
#
# The vault root IS the repo root, so any staged .md (or the migrations dir, or AGENTS.md) is a vault
# touch. Runs the strict lint only when staged files touch the vault, so non-vault commits aren't slowed.
# Pure Node, no install. Blocks the commit on lint failure.

set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
staged="$(git diff --cached --name-only)"

# Vault touch = any staged Markdown note, the migrations dir, the manifest, or AGENTS.md.
if echo "$staged" | grep -qE '(\.md$|^migrations/|^_meta/tools/context\.manifest\.json$|^AGENTS\.md$)'; then
  echo "[pre-commit] vault touched -> linting (strict)..."
  # Always lint THIS repo. An ambient $SYNAPSE_VAULT (e.g. a private consumer vault)
  # must not redirect the gate — that falsely fails framework commits when the other
  # vault has unrelated drift or missing notes.
  # Resolve the engine for THIS repo, most-specific first. A consumer vault has no `bin/` — it installs
  # the engine from npm — so the framework-only path must be the last resort, not the only fallback.
  # `command -v synapse` is checked but cannot be trusted alone: in a non-interactive hook shell it
  # misses a `synapse` defined as a shell function in an interactive profile, and the hook then fell
  # through to a `bin/` that does not exist in a vault, crashing on module resolution.
  if [ -x "$REPO/node_modules/.bin/synapse" ]; then
    _lint_cmd=("$REPO/node_modules/.bin/synapse" lint --strict)   # consumer vault (npm-installed)
  elif [ -f "$REPO/bin/synapse.mjs" ]; then
    _lint_cmd=(node "$REPO/bin/synapse.mjs" lint --strict)        # the framework repo itself
  elif command -v synapse >/dev/null 2>&1; then
    _lint_cmd=(synapse lint --strict)                             # a global install
  else
    echo "[pre-commit] FAIL: no synapse engine found — expected $REPO/node_modules/.bin/synapse (vault) or $REPO/bin/synapse.mjs (framework)." >&2
    exit 1
  fi
  if ! env SYNAPSE_VAULT="$REPO" "${_lint_cmd[@]}"; then
    echo "[pre-commit] FAIL: vault lint failed. Fix the errors above, or bypass with 'git commit --no-verify'." >&2
    exit 1
  fi
  unset _lint_cmd
  echo "[pre-commit] ok: vault clean"
fi
