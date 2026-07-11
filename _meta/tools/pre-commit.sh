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
  if command -v synapse >/dev/null 2>&1; then
    if ! synapse lint --strict; then
      echo "[pre-commit] FAIL: vault lint failed. Fix the errors above, or bypass with 'git commit --no-verify'." >&2
      exit 1
    fi
  elif ! node "$REPO/_meta/tools/lint.mjs" --strict; then
    echo "[pre-commit] FAIL: vault lint failed. Fix the errors above, or bypass with 'git commit --no-verify'." >&2
    exit 1
  fi
  echo "[pre-commit] ok: vault clean"
fi
