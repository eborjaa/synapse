# synapse-core — the engine + MCP HTTP server. Exactly one of these against a set of volumes.
#
# WHY root. Named volumes start root-owned; a dropped USER would make tokens.json unwritable on
# first boot. This stack is owner-hardware only ([[doc-deployment-gate]]), not a multi-tenant image.

FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The SERVING image, not the whole package. bin/ + lib/ + mcp/ is everything `synapse-mcp --http` and the
# vault-registry CLI touch; a vault is data this container MOUNTS, never content it carries.
#
# Deliberately absent: the shipped starter content (_meta/, agents/, rules/, tools/, skills/,
# hub-synapse.md). Its only reader is `synapse init`, which scaffolds a NEW vault from the package's own
# notes — a host-side authoring step, not a serving one. `synapse init` inside this container will fail
# for lack of sources; add those COPY lines (and loosen .dockerignore's root `*.md`) if Epic 5's vault
# picker ever needs to create a vault from inside the stack.
COPY bin ./bin
COPY lib ./lib
COPY mcp ./mcp
COPY agents.sh ./

ENV SYNAPSE_HOME=/synapse/config
ENV SYNAPSE_SKILLS_ROOT=/synapse/skills
ENV SYNAPSE_MCP_HOST=127.0.0.1
ENV SYNAPSE_MCP_PORT=3000
ENV SYNAPSE_MCP_PATH=/mcp

COPY deploy/core-entrypoint.sh /core-entrypoint.sh
RUN chmod +x /core-entrypoint.sh && mkdir -p /synapse/vaults /synapse/config /synapse/skills

EXPOSE 3000
ENTRYPOINT ["/core-entrypoint.sh"]
