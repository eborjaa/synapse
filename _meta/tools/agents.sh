#!/usr/bin/env sh
# Backward-compat — source the package agents.sh (repo root / node_modules).
if [ -n "${ZSH_VERSION:-}" ]; then _s="${(%):-%x}"; elif [ -n "${BASH_VERSION:-}" ]; then _s="${BASH_SOURCE[0]}"; else _s="$0"; fi
_pkg="$(cd "$(dirname "$_s")/../.." 2>/dev/null && pwd)/agents.sh"
if [ -f "$_pkg" ]; then
  # shellcheck source=/dev/null
  . "$_pkg"
else
  echo "agents.sh: could not find package agents.sh at $_pkg" >&2
  return 1 2>/dev/null || exit 1
fi
