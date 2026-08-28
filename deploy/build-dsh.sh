#!/usr/bin/env bash
# build-dsh.sh — build the real DeepSeek Harness image used as DSH_IMAGE.
# Rebase the harness checkout onto upstream first. Does not publish a port;
# compose still publishes BIND_ADDR:8080:8080.
#
# The image copies @eborja/synapse from the named context `synapse` so the
# DSH plugin can talk HTTP to synapse-core. Always pass that context; a
# plain `docker build` of the harness repo alone has no plugin.
set -euo pipefail
SRC="${DSH_SRC:-$HOME/synapse/deepseek-harness}"
TAG="${DSH_IMAGE:-synapse-dsh:local}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SYNAPSE_SRC="${SYNAPSE_SRC:-$(cd "$HERE/.." && pwd)}"
if [[ ! -f "$SRC/Dockerfile" ]]; then
  echo "no Dockerfile at $SRC — set DSH_SRC to your deepseek-harness checkout" >&2
  exit 1
fi
if [[ ! -f "$SYNAPSE_SRC/package.json" ]]; then
  echo "no package.json at $SYNAPSE_SRC — set SYNAPSE_SRC to the synapse engine repo" >&2
  exit 1
fi
exec docker build -t "$TAG" --build-context synapse="$SYNAPSE_SRC" "$SRC"
