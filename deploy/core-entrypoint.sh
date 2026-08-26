#!/bin/sh
# Ensure volume mount points exist, then start the singleton HTTP server.
# MCP binds SYNAPSE_MCP_HOST (127.0.0.1 in compose). BIND_ADDR is a host-publish concern, not ours.
set -eu
mkdir -p "${SYNAPSE_HOME:-/synapse/config}" "${SYNAPSE_SKILLS_ROOT:-/synapse/skills}" /synapse/vaults

# Clear a lock left by a container that no longer exists.
#
# lib/core-lock.mjs REFUSES to do this on its own, and it is right to: from inside one namespace there
# is no way to tell a dead foreign holder from a live one, and guessing wrong runs two writers against
# a single-writer DB. What makes it safe HERE and nowhere else is that compose has already settled the
# question a layer up — `container_name: synapse-core` means at most one core container can exist, so a
# record naming a different container id is necessarily a container that is gone. The reachable path is
# a hard kill (release() never runs), then a recreate, which hands the new container a new id.
#
# A lock from THIS container is left alone: that is the recycled-pid case, and core-lock resolves it.
node -e '
import("/app/lib/core-lock.mjs").then(({ reapForeignHostLock }) => {
  const stale = reapForeignHostLock();
  if (stale) process.stderr.write(`[synapse-core] cleared a lock from a container that is gone (${stale.host}, started ${stale.startedAt})\n`);
});
'

exec node --experimental-sqlite /app/bin/synapse-mcp.mjs --http
