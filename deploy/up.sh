#!/usr/bin/env bash
# up.sh — bring the four-container stack up after refusing a wildcard bind.
#
# WHY a wrapper, not raw `docker compose up`. Compose will happily publish
# `0.0.0.0:8080` if BIND_ADDR is that string. The MCP server would also refuse
# that address, but the UI publish happens in Docker before Node starts.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/deploy/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  ENV_FILE="$ROOT/deploy/.env.example"
fi

if [[ -z "${BIND_ADDR:-}" ]]; then
  BIND_ADDR="$(awk -F= '/^BIND_ADDR=/{print $2; exit}' "$ENV_FILE")"
fi
export BIND_ADDR="${BIND_ADDR:-127.0.0.1}"

node "$ROOT/deploy/assert-bind.mjs" "$BIND_ADDR"

exec docker compose -f "$ROOT/deploy/compose.yml" --env-file "$ENV_FILE" "$@"
