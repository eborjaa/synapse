// admin.mjs — machine-scoped vault and credential administration.
//
// These tools are registered ONLY on the credential-authorized admin surface. They never appear on a
// normal catalogue: absence is the security boundary, not a handler that says "permission denied".

import { existsSync } from "node:fs";
import { z } from "zod";

import {
  addVault, applySync, planSync, readRegistry, registryPath, writeRegistry,
} from "../../lib/vaults.mjs";
import {
  mintToken, readTokens, revokeToken, tokensPath, writeTokens,
} from "../../lib/ports/vault-tokens.mjs";

const asText = (value, isError = false) => ({
  isError,
  content: [{
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  }],
});

export const ADMIN_TOOL_NAMES = Object.freeze([
  "synapse_admin_list",
  "synapse_admin_register",
  "synapse_admin_mint",
  "synapse_admin_revoke",
  "synapse_admin_sync",
]);

export function registerAdminTools(server) {
  server.registerTool(
    "synapse_admin_list",
    {
      title: "List registered vaults and credential metadata",
      description:
        "ADMIN ONLY. List machine-scoped vault registrations and hashed credential metadata. "
        + "Never returns a plaintext credential.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const reg = readRegistry();
      const store = readTokens();
      return asText({
        vaults: reg.vaults.map((vault) => ({
          id: vault.id,
          root: vault.root,
          vaultDir: vault.vaultDir,
          live: existsSync(vault.root) && existsSync(vault.vaultDir),
        })),
        credentials: store.tokens.map((token) => ({
          label: token.label || "",
          vaultId: token.vaultId,
          scopes: Array.isArray(token.scopes) ? token.scopes : [],
          hashPrefix: `${String(token.hash).slice(0, 12)}…`,
          createdAt: token.createdAt,
        })),
        registryPath: registryPath(),
        tokensPath: tokensPath(),
      });
    },
  );

  server.registerTool(
    "synapse_admin_register",
    {
      title: "Register a vault",
      description:
        "ADMIN ONLY. Register or refresh one vault path in the machine registry. "
        + "The transcript reports exactly which registry row changed.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path inside the vault to register"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ path }) => {
      try {
        const out = addVault(path);
        const written = writeRegistry(out.reg);
        return asText({
          mutation: "vault.register",
          status: out.added ? "registered" : "refreshed",
          vault: out.entry,
          registryPath: written,
        });
      } catch (error) {
        return asText(`vault.register refused: ${error.message}`, true);
      }
    },
  );

  server.registerTool(
    "synapse_admin_mint",
    {
      title: "Mint a vault credential",
      description:
        "ADMIN ONLY. Mint one bearer credential bound to exactly one registered vault. "
        + "The plaintext is returned once in this transcript and is never stored.",
      inputSchema: {
        vaultId: z.string().min(1),
        label: z.string().max(80).optional(),
        admin: z.boolean().optional().describe("Grant the admin scope; false/default creates a normal credential"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ vaultId, label, admin }) => {
      try {
        const out = mintToken(vaultId, {
          label: label || "",
          scopes: admin ? ["admin"] : [],
        });
        const written = writeTokens(out.store);
        return asText({
          mutation: "credential.mint",
          status: "minted",
          vaultId: out.vaultId,
          scopes: out.scopes,
          label: label || "",
          plaintext: out.plaintext,
          tokensPath: written,
          warning: "This plaintext is shown once and is not recoverable.",
        });
      } catch (error) {
        return asText(`credential.mint refused: ${error.message}`, true);
      }
    },
  );

  server.registerTool(
    "synapse_admin_revoke",
    {
      title: "Revoke a vault credential",
      description:
        "ADMIN ONLY. Revoke by exact label, full hash, or hash prefix. "
        + "The transcript reports the credential metadata removed.",
      inputSchema: {
        selector: z.string().min(1).describe("Exact label, full hash, or unique-enough hash prefix"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ selector }) => {
      const out = revokeToken(selector);
      if (!out.revoked) return asText(`credential.revoke refused: nothing matches "${selector}"`, true);
      const written = writeTokens(out.store);
      return asText({
        mutation: "credential.revoke",
        status: "revoked",
        credential: {
          label: out.revoked.label || "",
          vaultId: out.revoked.vaultId,
          scopes: Array.isArray(out.revoked.scopes) ? out.revoked.scopes : [],
          hashPrefix: `${String(out.revoked.hash).slice(0, 12)}…`,
        },
        tokensPath: written,
      });
    },
  );

  server.registerTool(
    "synapse_admin_sync",
    {
      title: "Synchronize registered vault client configuration",
      description:
        "ADMIN ONLY. Plan by default; write:true applies the same plan. "
        + "Every affected vault and generated path is returned in the transcript.",
      inputSchema: {
        write: z.boolean().optional().describe("false/default previews; true writes generated client config"),
        surface: z.enum(["skeleton", "standard", "full", "orchestrator"]).optional(),
        client: z.enum(["all", "claude", "cursor", "opencode"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ write, surface, client }) => {
      const plans = planSync({
        surface: surface || null,
        client: client || "all",
      });
      const results = applySync(plans, { write: Boolean(write), log: () => {} });
      return asText({
        mutation: "vault.sync",
        status: write ? "applied" : "planned",
        write: Boolean(write),
        surface: surface || "keep-each-vault",
        client: client || "all",
        vaults: plans.map((plan, index) => ({
          id: plan.vault.id,
          missing: Boolean(plan.missing),
          failed: Boolean(plan.failed),
          changed: results[index]?.changed || 0,
          paths: plan.targets.map((target) => target.path),
          warnings: plan.warnings || [],
        })),
      });
    },
  );
}
