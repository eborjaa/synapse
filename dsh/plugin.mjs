// plugin.mjs — the DeepSeek Harness plugin: each session gets the vault its folder belongs to.
//
// Replaces the `@deepseek-ai/dsh-mcp-client` row for synapse. That bridge registers its tools ONCE, at
// plugin activation, with no notion of a session — which is why dsh could show one vault's agent list
// (skills resolve per session from `session.header.cwd`) while its tools answered from a different
// vault entirely. Nothing in dsh reads config from the directory you are working in, so the gap cannot
// be closed with configuration; it needs a plugin that routes.
//
// THE SEAM, AND WHY IT IS TRUSTWORTHY. `agent.session.header.cwd` is stamped by the host when a session
// is created, validated absolute, and immutable for that session's life — the host rejects a mismatch
// rather than moving it. Subagents inherit the parent's cwd, so delegation stays consistent. A note
// that says "actually you are in the other vault" therefore changes nothing: the model cannot write
// this value, which is what makes it a legitimate vault selector where a tool argument is not
// ([[decision-0010-mcp-2026-07-28-dual-era]]).
//
// This is dsh's own pattern, not an invention: `packages/lsp/tool-lsp` reads the same field through its
// `sessionCwd(exec)` helper and routes to a per-workspace pool in `lsp-stdio`. Substitute Synapse for
// gopls and this is that.
//
// Everything testable lives in ./session-tools.mjs and ./vault-pool.mjs; this file is the wiring.

import { z } from "zod";

import { createVaultPool } from "./vault-pool.mjs";
import { bindSessionTools } from "./session-tools.mjs";

export const name = "synapse-vault-router";
export const inject = ["tools"];

// Cordis validates plugin Config through the Standard Schema interface
// (`Config["~standard"].validate`). A JSON-Schema-shaped object has no such
// method, so a DSH profile that named this plugin would throw at load — before
// any session started, and with no vault tools at all. Zod 4 implements that
// interface; this package already depends on it.
export const Config = z.object({
  surface: z.string().default("orchestrator"),
  idleMs: z.number().default(300_000),
  // "http" = talk to an already-running synapse-core. Default stdio keeps the Mac host path.
  transport: z.enum(["stdio", "http"]).default("stdio"),
  httpUrl: z.string().optional(),
  token: z.string().optional(),
});

export function apply(ctx, config = {}) {
  const log = (line) => ctx.logger?.info?.(line) ?? process.stderr.write(`${line}\n`);
  const httpUrl = config.httpUrl || process.env.SYNAPSE_MCP_HTTP_URL || "";
  const token = config.token || process.env.SYNAPSE_MCP_TOKEN || "";
  const transport = config.transport || (httpUrl ? "http" : "stdio");
  const pool = createVaultPool({
    surface: config.surface || "orchestrator",
    idleMs: typeof config.idleMs === "number" ? config.idleMs : 300000,
    log,
    ...(transport === "http" ? { httpUrl, token } : {}),
  });

  // One binding per live agent, so a session's tools unwind exactly when that session does.
  const bindings = new Map();

  ctx.on("agent/created", ({ agent }) => {
    void (async () => {
      try {
        const bound = await bindSessionTools({
          cwd: agent?.session?.header?.cwd,
          pool,
          // Agent-scoped: "its contributions are agent-local, unwind on disposal". Registering
          // globally here would put one vault's tools in front of every other session.
          register: (definition) => agent.ctx.tools.register(definition),
          log,
        });
        if (bound.bound) bindings.set(agent, bound);
        else await bound.dispose();
      } catch (error) {
        // A session that cannot resolve a vault is a session without synapse tools — never a session
        // that fails to start, and never one quietly pointed at some default vault.
        log(`[synapse] could not bind vault tools for this session: ${error?.message || error}`);
      }
    })();
  });

  ctx.on("agent/disposed", ({ agent }) => {
    const bound = bindings.get(agent);
    if (!bound) return;
    bindings.delete(agent);
    void bound.dispose().catch(() => { /* the scope unwound the tools already */ });
  });

  ctx.on("dispose", () => {
    for (const bound of bindings.values()) void bound.dispose().catch(() => {});
    bindings.clear();
    void pool.disposeAll().catch(() => {});
  });
}
