// http-server.mjs — one long-lived, bearer-bound Synapse MCP server over local HTTP.
//
// This is the startup half only. Tool registration remains in buildServer(), shared byte-for-byte with
// stdio; the HTTP adapter owns the socket and turns each validated credential into one bound context.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { toolTransportAdapters } from "../lib/ports/index.mjs";
import { buildServer, loadPlugins, resolveSurface, version } from "./build-server.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_PATH = "/mcp";

/** HTTP has no single startup vault, so only explicitly shared plugins can be loaded once for all. */
export function sharedPluginPaths(raw = process.env.SYNAPSE_MCP_PLUGINS || "") {
  return [...new Set(String(raw).split(",").map((value) => value.trim()).filter(Boolean))];
}

export async function startHttpServer({
  host = process.env.SYNAPSE_MCP_HOST || process.env.BIND_ADDR || DEFAULT_HOST,
  port = process.env.SYNAPSE_MCP_PORT || DEFAULT_PORT,
  path = process.env.SYNAPSE_MCP_PATH || DEFAULT_PATH,
  surface = resolveSurface(),
  plugins = null,
  onerror = null,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  surface = resolveSurface(surface);
  // Per-vault plugin auto-discovery is intentionally absent here. Discovering from cwd would make one
  // arbitrary vault's tools appear for every credential; loading a different set per vault would break
  // ToolTransportPort's stable-catalogue contract. SYNAPSE_MCP_PLUGINS is explicit and shared.
  const loaded = plugins || await loadPlugins(sharedPluginPaths());
  const live = await toolTransportAdapters.get("http").serve(buildServer, {
    host,
    port,
    path,
    surface,
    plugins: loaded,
    legacy: "stateless",
    onerror,
  });

  log(
    `[synapse-mcp] ready · v${version} · transport=http · surface=${surface} · ${live.url}`
    + " · vault=bearer-bound"
    + `${loaded.length ? ` · plugins=${loaded.map((plugin) => plugin.name).join(",")}` : ""}`,
  );
  return live;
}

export function closeOnSignals(live) {
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await live.close();
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(`[synapse-mcp] shutdown failed: ${error?.stack || error}\n`);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const live = await startHttpServer();
  closeOnSignals(live);
}
