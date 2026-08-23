#!/bin/sh
set -eu

: "${MCPO_API_KEY:?MCPO_API_KEY must be set}"

test -f /vault/bin/synapse-mcp.mjs || {
  printf '%s\n' 'Synapse MCP entrypoint not found: /vault/bin/synapse-mcp.mjs' >&2
  exit 1
}

test -d /vault/node_modules/@modelcontextprotocol/sdk || {
  printf '%s\n' 'Synapse MCP dependency not found: /vault/node_modules/@modelcontextprotocol/sdk' >&2
  exit 1
}

exec mcpo \
  --host "$MCPO_HOST" \
  --port "$MCPO_PORT" \
  --api-key "$MCPO_API_KEY" \
  -- \
  node /vault/bin/synapse-mcp.mjs
