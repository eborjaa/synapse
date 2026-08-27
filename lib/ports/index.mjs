#!/usr/bin/env node
// index.mjs — the ports Synapse's core depends on, and where each one's adapters live.
//
// READ THIS FIRST IF YOU ARE ADDING A HARNESS. You should need to touch exactly one adapter file and
// nothing else. If adding a harness makes you edit a core module — lib/mcp-config.mjs, lib/skills.mjs,
// mcp/server.mjs, lib/vault-root.mjs — the boundary has leaked and the fix belongs here, not there.
// That is the acceptance test for this whole layer, stated once, in the file people will find.
//
// WHY THESE. The first five are axes along which harnesses genuinely disagree, established by reading
// the existing code rather than by guessing at extension points. HandoffPort is a sixth, not a harness
// seam: it is the claim→renew→close lifecycle expressed once so the tool layer cannot drop the logbook
// while releasing the ticket ([[decision-0019-handoff-identity]]).
//
//   ClientConfigPort   — three clients, three file shapes, three merge rules   (fully extracted)
//   RosterPort         — decision-0011 tabulates FOUR independent implementations of "publish the
//                        roster", which is the strongest evidence in the repo that this is a real seam
//   ToolTransportPort  — stdio + authenticated loopback/VPN HTTP
//   VaultBindingPort   — env-pinned (stdio) + bearer-token (HTTP)
//   VaultStorePort     — the seam that must exist before HTTP is safe (stage 4)
//   HandoffPort        — one handle per attempt; ticket + logbook close together or neither does
//
// HONEST STATUS. Ports are declared here in full, but they are not all extracted yet, and a declared
// port with no adapter would be decoration. So each one below states what it is TODAY:
//
//   ClientConfigPort   ✅ extracted, 3 adapters, contract-tested against every adapter
//   RosterPort         ✅ declared + dsh adapter over the existing generator, contract-tested
//   ToolTransportPort  ✅ stdio + HTTP adapters. HTTP authenticates before building a server, binds the
//                        credential per request, and refuses wildcard listen addresses. Both adapters
//                        receive the same buildServer factory; the contract test compares their live
//                        wire tool lists.
//   VaultBindingPort   ✅ two adapters: env-pinned (stdio) and bearer-token (multi-vault)
//   VaultStorePort     ✅ extracted (stage 4); EPOCH + db handles keyed by vault, contract-tested
//   HandoffPort        ✅ declared; sqlite adapter is per-vault (lib/durable-spawn/handoff.mjs)
//
// Nothing here starts a process; importing this file is free.

import { definePort, registry } from "./port.mjs";
import { ClientConfigPort, clientConfigAdapters } from "./client-config.mjs";
import { buildSkillTargets, applySkillTargets } from "../skills.mjs";
import { resolveVault } from "../vault-root.mjs";
import { VaultStorePort as _VaultStorePort } from "./vault-store.mjs";
import { HandoffPort as _HandoffPort } from "./handoff.mjs";
import {
  bearerVaultBinding, bearerBindingAdapters, extractBearer, VAULT_CREDENTIAL_REFUSAL,
} from "./vault-tokens.mjs";

export { definePort, registry, assertImplements } from "./port.mjs";
export { ClientConfigPort, clientConfigAdapters } from "./client-config.mjs";

// ── RosterPort ────────────────────────────────────────────────────────────────
// Publish a vault's agent roster to one harness.
//
// The contract's teeth are the "kept, never clobbered" rule from decision-0011: a hand-authored file is
// the human's, and a generator that overwrites it destroys tuned work. The four shipped skills were
// written against observed local-30B failure modes; a regeneration that flattened them would be a
// regression no test currently catches at this layer, so the contract test catches it here.

export const RosterPort = definePort({
  name: "RosterPort",
  fields: ["label"],
  methods: ["targets", "apply", "discoveryHint"],
  contract:
    "targets() is pure and writes nothing; apply() is idempotent and NEVER overwrites a hand-authored "
    + "file without an explicit force.",
});

const dshRoster = {
  id: "dsh",
  label: "DeepSeek Harness",
  // Default output is the vault REPO ROOT's .dsh/skills — DSH's highest-ranked root (project-dsh),
  // discovered with no symlink and no YAML. `outDir` targets the user-scoped root instead.
  targets: ({ root, vaultDir, agent = null, outDir = null }) =>
    buildSkillTargets({ root, vaultDir, agent, outDir }),
  apply: (targets, { root, write = false, force = false } = {}) =>
    applySkillTargets(targets, { root, write, force }),
  discoveryHint: ({ root, outDir = null }) => ({
    path: outDir || `${root}/.dsh/skills`,
    rank: outDir ? 400 : 100,
    note: outDir
      ? "user-scoped root — found from wherever DSH starts"
      : "project root — highest-ranked, needs no configuration",
  }),
};

export const rosterAdapters = registry(RosterPort, [dshRoster]);

// ── ToolTransportPort ─────────────────────────────────────────────────────────
// Expose the tool surface over one transport. The server FACTORY is the boundary: decision-0010 already
// refactored mcp/server.mjs into a factory precisely so a second transport could reuse it unchanged.
//
// The contract that matters is that the transport cannot change the tool list. When the HTTP adapter
// lands in stage 5, the same contract test runs against both and a divergence fails there rather than
// in someone's client six weeks later.

export const ToolTransportPort = definePort({
  name: "ToolTransportPort",
  fields: ["label"],
  methods: ["serve", "describe"],
  contract:
    "the same server factory yields an identical tool list on every transport; serve() never mutates "
    + "the factory or the vault.",
});

const stdioTransport = {
  id: "stdio",
  label: "stdio (dual-era)",
  // Imported lazily: pulling in the MCP SDK at module load would make importing this index start the
  // dependency chain for every consumer, including the CLI, which never serves anything.
  async serve(buildServer, { legacy = "serve" } = {}) {
    const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
    return serveStdio(buildServer, { legacy });
  },
  describe: () => ({
    transport: "stdio",
    multiVault: false,          // one connection is one process is one vault
    eras: ["2025-11-25", "2026-07-28"],
  }),
};

const WILDCARD_HTTP_ADDRESSES = new Set([
  "0", "0.0", "0.0.0", "0.0.0.0",
  "::", "::0", "[::]", "[::0]", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0",
]);

/**
 * Refuse all-interface listeners before they become an accidental public endpoint.
 *
 * A non-loopback address is allowed because the supported remote shape is an explicitly selected VPN
 * interface. The post-listen check below verifies that a hostname did not resolve back to a wildcard.
 */
/**
 * Split a request path into "is this our endpoint" and "which vault did it name".
 *
 * `/mcp` is the bare endpoint (no vault named); `/mcp/<id>` names one. The id is ONE segment, decoded
 * once, and handed to the binding for an exact-equality check against the credential's grant — it is a
 * registry id, never a filesystem path ([[decision-0017-path-addressed-vaults]]).
 *
 * `new URL()` has already resolved any `..` before this sees it, so traversal cannot arrive here as a
 * path. A literal `%2e%2e` survives decoding, and is simply an id that matches no grant.
 *
 * @returns `{ ok: false }` when the path is not this endpoint at all (→ 404), otherwise
 *          `{ ok: true, vaultId }` with `vaultId` null for the bare endpoint.
 */
export function routeVaultPath(pathname, basePath) {
  if (pathname === basePath) return { ok: true, vaultId: null };
  const prefix = basePath.endsWith("/") ? basePath : `${basePath}/`;
  if (!pathname.startsWith(prefix)) return { ok: false, vaultId: null };
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes("/")) return { ok: false, vaultId: null };
  let decoded;
  try { decoded = decodeURIComponent(rest); } catch { return { ok: false, vaultId: null }; }
  if (!decoded || decoded.includes("/")) return { ok: false, vaultId: null };
  return { ok: true, vaultId: decoded };
}

export function assertSafeHttpBindHost(host = "127.0.0.1") {
  const raw = String(host || "").trim();
  const value = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (!value || WILDCARD_HTTP_ADDRESSES.has(raw.toLowerCase()) || WILDCARD_HTTP_ADDRESSES.has(value.toLowerCase())) {
    throw new Error(
      `HTTP transport refuses wildcard bind address "${raw || "(empty)"}". `
      + "Use 127.0.0.1, ::1, or the address of a VPN interface; never 0.0.0.0 or ::.",
    );
  }
  return value;
}

const authRefusalResponse = () => new Response(
  JSON.stringify({ error: "invalid_token", error_description: VAULT_CREDENTIAL_REFUSAL }),
  {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate":
        `Bearer error="invalid_token", error_description="${VAULT_CREDENTIAL_REFUSAL}"`,
    },
  },
);

function requestHeaders(raw = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) for (const part of value) headers.append(name, part);
    else if (value !== undefined) headers.set(name, String(value));
  }
  return headers;
}

async function requestBody(req, maxBodyBytes) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBodyBytes) {
      const error = new Error(`HTTP request body exceeds ${maxBodyBytes} bytes`);
      error.code = "SYNAPSE_HTTP_BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function writeNodeResponse(res, response, Readable, pipeline) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) res.setHeader(name, value);
  if (response.body === null) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), res);
}

const httpTransport = {
  id: "http",
  label: "HTTP (dual-era, bearer-bound)",

  /**
   * Start one authenticated MCP endpoint.
   *
   * The SDK does NOT parse Authorization: createMcpHandler only passes through an authInfo supplied by
   * its caller. This adapter therefore refuses a bad credential before MCP dispatch, then passes that
   * identity into the per-request factory. The factory binds it again at the security boundary and
   * calls the SAME buildServer() used by stdio, adding adminAuthorized from the credential's scopes.
   */
  async serve(buildServer, {
    host = "127.0.0.1",
    port = 0,
    path = "/mcp",
    surface,
    plugins = [],
    binding = bearerVaultBinding,
    legacy = "stateless",
    responseMode,
    maxBodyBytes = 1024 * 1024,
    onerror = null,
  } = {}) {
    host = assertSafeHttpBindHost(host);
    port = Number(port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`HTTP transport port must be an integer from 0 to 65535 (got ${port})`);
    }
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("?") || path.includes("#")) {
      throw new Error(`HTTP transport path must be an absolute URL path (got ${JSON.stringify(path)})`);
    }
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
      throw new Error(`HTTP transport maxBodyBytes must be a positive integer (got ${maxBodyBytes})`);
    }

    // Lazy imports preserve this module's contract: importing the ports registry starts no SDK chain,
    // opens no socket, and remains safe for CLI consumers that never serve MCP.
    const [
      { createMcpHandler },
      { createServer },
      { Readable },
      { pipeline },
      { createVaultContext },
    ] = await Promise.all([
      import("@modelcontextprotocol/server"),
      import("node:http"),
      import("node:stream"),
      import("node:stream/promises"),
      import("../../mcp/vault-context.mjs"),
    ]);

    const reportError = (error) => {
      if (onerror) onerror(error);
      else process.stderr.write(`[synapse-mcp/http] ${error?.stack || error}\n`);
    };

    const { isAdminAuthorized, surfaceForRequest } = await import("../../mcp/build-server.mjs");
    const handler = createMcpHandler((ctx) => {
      // `ctx.authInfo` is the GRANT and the only credential input. The vault id comes from the request's
      // own URL — transport configuration the model cannot rewrite — and can only narrow that grant.
      // MCP params are still never read here: passing the whole Request to the binding would make it
      // possible for a future adapter to "helpfully" inspect tool arguments
      // ([[decision-0010-mcp-2026-07-28-dual-era]], [[decision-0017-path-addressed-vaults]]).
      let requestedVaultId = null;
      if (ctx.requestInfo?.url) {
        requestedVaultId = routeVaultPath(new URL(ctx.requestInfo.url).pathname, path).vaultId;
      }
      const bound = binding.bind({ authInfo: ctx.authInfo }, { requestedVaultId });
      if (!bound.ok) throw new Error(VAULT_CREDENTIAL_REFUSAL);
      // WHY the catalogue is chosen here, from the credential. `--surface` is the everyday ceiling.
      // An admin-scoped bearer upgrades; any other credential never sees mint/revoke/register. If this
      // process was started with `--surface admin`, a normal token is served orchestrator instead of
      // inheriting privileged tools.
      const adminAuthorized = isAdminAuthorized(bound);
      const vault = createVaultContext({
        root: bound.root,
        vaultDir: bound.vaultDir,
        manifest: bound.manifest || {},
      });
      vault.assertVault();
      return buildServer({
        surface: surfaceForRequest(surface, adminAuthorized),
        plugins,
        vault,
        adminAuthorized,
      });
    }, {
      // stdio calls this posture "serve"; HTTP calls the same dual-era intent "stateless".
      legacy: legacy === "serve" ? "stateless" : legacy,
      ...(responseMode ? { responseMode } : {}),
      onerror: reportError,
    });

    let baseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
    const server = createServer((req, res) => {
      void (async () => {
        const pathname = new URL(req.url || "/", baseUrl).pathname;
        const route = routeVaultPath(pathname, path);
        if (!route.ok) {
          req.resume();
          await writeNodeResponse(res, new Response("Not found", { status: 404 }), Readable, pipeline);
          return;
        }

        // Authenticate before reading the body. An unauthenticated peer cannot make the server buffer
        // arbitrary input, and every failure gets the same response with no vault attached.
        //
        // The preflight resolves the SAME vault the factory will, path included. Checking only the
        // credential here would let `/mcp/<not-granted>` past the gate and fail deeper, where the error
        // shape differs — and a different answer for "not granted" than for "unknown token" is exactly
        // the enumeration oracle this endpoint is built to avoid.
        const token = extractBearer({ headers: req.headers });
        const authInfo = token
          ? { token, clientId: "synapse-local-client", scopes: ["mcp"] }
          : undefined;
        const preflight = binding.bind({ authInfo }, { requestedVaultId: route.vaultId });
        if (!preflight.ok) {
          req.resume();
          await writeNodeResponse(res, authRefusalResponse(), Readable, pipeline);
          return;
        }

        const body = await requestBody(req, maxBodyBytes);
        const request = new Request(new URL(req.url || "/", baseUrl), {
          method: req.method || "GET",
          headers: requestHeaders(req.headers),
          ...(body === undefined ? {} : { body }),
        });
        const response = await handler.fetch(request, { authInfo });
        await writeNodeResponse(res, response, Readable, pipeline);
      })().catch(async (error) => {
        reportError(error);
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        const status = error?.code === "SYNAPSE_HTTP_BODY_TOO_LARGE" ? 413 : 500;
        const response = Response.json(
          { error: status === 413 ? "request_too_large" : "internal_server_error" },
          { status },
        );
        try { await writeNodeResponse(res, response, Readable, pipeline); }
        catch { res.destroy(); }
      });
    });

    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => reject(error);
        server.once("error", failed);
        server.listen(port, host, () => {
          server.off("error", failed);
          resolve();
        });
      });
    } catch (error) {
      await handler.close();
      throw error;
    }

    const address = server.address();
    if (!address || typeof address === "string" || WILDCARD_HTTP_ADDRESSES.has(address.address.toLowerCase())) {
      await handler.close();
      await new Promise((resolve) => server.close(() => resolve()));
      throw new Error("HTTP transport resolved to a wildcard listener; refusing to serve.");
    }
    const authority = address.family === "IPv6" ? `[${address.address}]:${address.port}` : `${address.address}:${address.port}`;
    baseUrl = `http://${authority}`;

    let closed = false;
    return {
      server,
      handler,
      address,
      url: `${baseUrl}${path}`,
      async close() {
        if (closed) return;
        closed = true;
        await handler.close();
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      },
    };
  },

  describe: () => ({
    transport: "http",
    multiVault: true,
    auth: "Authorization: Bearer",
    bindDefault: "127.0.0.1",
    eras: ["2025-11-25", "2026-07-28"],
  }),
};

export const toolTransportAdapters = registry(ToolTransportPort, [stdioTransport, httpTransport]);

// ── VaultBindingPort ──────────────────────────────────────────────────────────
// Resolve an inbound request to exactly ONE vault.
//
// THE CONTRACT IS A SECURITY BOUNDARY, not a convenience. decision-0010 deferred multi-vault with a
// specific reason: "the moment vault selection is a tool argument, the only thing isolating vaults
// holding finance, health and contacts data is the model's choice of argument." So `bind()` takes a
// request and reads its CREDENTIAL; an adapter that reads a tool argument is not a valid adapter, and a
// token that does not resolve is a refusal — never a fallback to some default vault.

export const VaultBindingPort = definePort({
  name: "VaultBindingPort",
  fields: ["label"],
  methods: ["bind", "describe"],
  contract:
    "binding derives the vault from the caller's identity, NEVER from a tool argument; an unresolvable "
    + "credential is a refusal, never a fallback to a default vault.",
});

const envPinnedBinding = {
  id: "env-pinned",
  label: "environment-pinned (one vault per process)",
  // Today's behavior, unchanged: the harness launches the server with $SYNAPSE_VAULT set in generated
  // config, and a long-lived server cannot `cd`, so the env is the authoritative vault and must beat
  // whatever cwd the harness happened to start in. Hence preferCwd:false.
  bind() {
    try {
      const r = resolveVault({ readManifest: true, preferCwd: false });
      return { ok: true, root: r.root, vaultDir: r.vaultDir, manifest: r.manifest || {} };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  },
  describe: () => ({ mode: "env-pinned", multiVault: false, source: "$SYNAPSE_VAULT" }),
};

export const vaultBindingAdapters = registry(VaultBindingPort, [envPinnedBinding, bearerVaultBinding]);

// ── VaultStorePort ────────────────────────────────────────────────────────────
// All vault handles and epochs behind one seam, keyed BY VAULT. Implemented in ./vault-store.mjs —
// see that file for why the three module-level singletons it replaces were correct on stdio and
// silently wrong off it, and for why single-writer is NOT weakened by this change.

export { VaultStorePort, vaultStoreAdapters, vaultStore } from "./vault-store.mjs";
export { HandoffPort, mintHandle, parseHandle, checksumOf } from "./handoff.mjs";
export { bearerVaultBinding, bearerBindingAdapters, VAULT_CREDENTIAL_REFUSAL };

/** Every port declared in this package, for diagnostics and for the contract-test sweep. */
export const ALL_PORTS = Object.freeze([
  ClientConfigPort, RosterPort, ToolTransportPort, VaultBindingPort, _VaultStorePort, _HandoffPort,
]);
