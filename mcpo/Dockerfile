FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/opt/venv/bin:$PATH" \
    SYNAPSE_VAULT=/vault \
    SYNAPSE_MCP_SURFACE=standard \
    NODE_OPTIONS=--experimental-sqlite \
    MCPO_HOST=0.0.0.0 \
    MCPO_PORT=8000

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir "mcpo" "mcp>=1.17.0,<2" \
    && apt-get purge -y python3-venv \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --chmod=755 entrypoint.sh /usr/local/bin/synapse-mcpo

USER node
WORKDIR /vault

ENTRYPOINT ["synapse-mcpo"]
