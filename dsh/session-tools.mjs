// session-tools.mjs — give one session the tools of the vault its folder belongs to.
//
// This is the half of the router that has nothing to do with dsh's plugin API, so it can be tested
// without a harness. `bindSessionTools` takes a working directory and a way to register tools, and
// answers with a disposer.
//
// WHY PER SESSION AND NOT ONCE AT STARTUP. The simpler design — connect once, read the tool list, and
// register it for everyone — is wrong for a real machine: a vault may carry its own MCP plugins from
// `<vault>/_meta/mcp-plugins/`, so two vaults do not publish the same tools. Registering one vault's
// list globally would show its extra tools in every other vault, or hide them everywhere. The list is
// therefore read from the vault this session actually resolved to.
//
// FAILING CLOSED MEANS REGISTERING NOTHING. A session whose folder is not a vault gets no synapse tools
// and one line in the log saying why. The alternative — falling back to some default vault — is the
// exact silent wrong-vault failure this whole design exists to remove.

import { vaultForCwd, explainNoVault } from "../lib/vault-for-cwd.mjs";

/** Model-facing names keep the shape dsh's own MCP bridge produces, so nothing downstream changes. */
export const toolName = (raw) => `mcp__synapse__${raw}`;

/**
 * Resolve `cwd` to a vault, take that vault's Synapse process from the pool, and register its tools.
 *
 * @param {object} options
 * @param {string|undefined} options.cwd     the session's working directory.
 * @param {object} options.pool              a vault pool (see ./vault-pool.mjs).
 * @param {(definition: object) => (() => void)} options.register  registers ONE tool, returns its disposer.
 * @param {object} [options.reg]             registry override, for tests.
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{ bound: boolean, vaultId?: string, tools: string[], dispose: () => Promise<void> }>}
 */
export async function bindSessionTools({ cwd, pool, register, reg = null, log = () => {} }) {
  const nothing = { bound: false, tools: [], dispose: async () => {} };

  if (typeof cwd !== "string" || !cwd.trim()) {
    // dsh types `exec.agent` as optional, and `tool-lsp` treats a missing workspace as a hard error.
    // Same reading here: no folder means no basis for choosing a vault, so choose none.
    log("[synapse] this session has no working directory; no vault tools registered");
    return nothing;
  }

  const found = vaultForCwd(cwd, { reg });
  if (!found.found) {
    log(`[synapse] ${explainNoVault(found, cwd)}`);
    return nothing;
  }

  const vault = found.vault;
  const lease = await pool.acquire(vault.root);
  const disposers = [];
  let listed;
  try {
    listed = await lease.client.listTools();
  } catch (error) {
    lease.release();
    log(`[synapse] ${vault.id}: could not read its tool list (${error?.message || error})`);
    return nothing;
  }

  const tools = [];
  for (const tool of listed?.tools || []) {
    const name = toolName(tool.name);
    disposers.push(register({
      name,
      description: tool.description || "",
      parameters: tool.inputSchema,
      // The vault is closed over, not passed in. There is no argument a caller could set to reach
      // another vault, which is the same structural guarantee the bearer-bound HTTP path gives.
      async execute(args, exec) {
        return lease.client.callTool(
          { name: tool.name, arguments: args ?? {} },
          { signal: exec?.signal },
        );
      },
    }));
    tools.push(name);
  }

  log(`[synapse] ${vault.id} → ${tools.length} tool(s) for this session (${vault.root})`);

  let disposed = false;
  return {
    bound: true,
    vaultId: vault.id,
    vaultRoot: vault.root,
    tools,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of disposers) { try { off(); } catch { /* already unwound with the scope */ } }
      lease.release();
    },
  };
}
