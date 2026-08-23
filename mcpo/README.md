# Synapse MCP bridge for Open WebUI

This image runs Synapse's stdio MCP server behind MCPO's HTTP/OpenAPI bridge.

Expected Dokploy configuration:

- Build this directory with the `Dockerfile`.
- Bind-mount `/home/chamito/cerebro` to `/vault`.
- Attach the service to `dokploy-network`.
- Do not publish port `8000` to the host.
- Set `MCPO_API_KEY` as a Dokploy secret.
- Keep the defaults for `SYNAPSE_VAULT`, `SYNAPSE_MCP_SURFACE`, `NODE_OPTIONS`, and `MCPO_PORT`.

Open WebUI connects to this service as an OpenAPI tool server at:

```text
http://synapse-mcpo:8000
```

The service expects the mounted vault to contain:

- `/vault/bin/synapse-mcp.mjs`
- `/vault/node_modules/@modelcontextprotocol/sdk`
- `/vault/node_modules/zod`
- `/vault/db/synapse.db`
