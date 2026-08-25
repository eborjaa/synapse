#!/usr/bin/env node
// synapse-mcp — expose Synapse as MCP over stdio (default) or authenticated local HTTP.
//
//   synapse-mcp                       # full surface (default)
//   SYNAPSE_MCP_SURFACE=standard synapse-mcp
//   SYNAPSE_MCP_PLUGINS=/abs/plugin.mjs synapse-mcp
//   synapse-mcp --http --host 127.0.0.1 --port 3000
//
// stdio resolves one vault from $SYNAPSE_VAULT / cwd. HTTP resolves one vault per request from the
// caller's bearer credential. Thin launcher: both serving paths live in mcp/.

const args = process.argv.slice(2);
if (!args.includes("--http")) {
  await import("../mcp/server.mjs");
} else {
  const usage = `synapse-mcp --http [--host <loopback|vpn-address>] [--port <n>] [--path </mcp>] [--surface <name>]

Starts ONE bearer-authenticated, dual-era MCP server. Defaults: 127.0.0.1:3000/mcp.
The host may be loopback or an explicit VPN interface; 0.0.0.0 and :: are refused.`;
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }

  const values = new Map();
  const valueFlags = new Set(["--host", "--port", "--path", "--surface"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--http") continue;
    if (!valueFlags.has(arg)) {
      console.error(`synapse-mcp: unknown HTTP option "${arg}".\n\n${usage}`);
      process.exit(2);
    }
    if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
      console.error(`synapse-mcp: ${arg} requires a value.`);
      process.exit(2);
    }
    values.set(arg, args[++i]);
  }

  const { startHttpServer, closeOnSignals } = await import("../mcp/http-server.mjs");
  const live = await startHttpServer({
    ...(values.has("--host") ? { host: values.get("--host") } : {}),
    ...(values.has("--port") ? { port: values.get("--port") } : {}),
    ...(values.has("--path") ? { path: values.get("--path") } : {}),
    ...(values.has("--surface") ? { surface: values.get("--surface") } : {}),
  });
  closeOnSignals(live);
}
