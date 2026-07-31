#!/usr/bin/env node
// synapse-mcp — stdio MCP server exposing the consumer's Synapse vault as tools.
//
//   synapse-mcp                       # full surface (default)
//   SYNAPSE_MCP_SURFACE=standard synapse-mcp
//   SYNAPSE_MCP_PLUGINS=/abs/plugin.mjs synapse-mcp
//
// The vault is located exactly as every other synapse command locates it ($SYNAPSE_VAULT, else an
// ancestor walk for _meta/tools/context.manifest.json). Thin launcher: the server lives in mcp/.

import "../mcp/server.mjs";
