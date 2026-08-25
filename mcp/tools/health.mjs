// health.mjs — vault mechanical health (lint).

import { z } from "zod";
import { asToolResult } from "../vault.mjs";
import { envPinnedContext } from "../vault-context.mjs";

/** Available on standard + full — curator needs this. */
export function registerHealthTools(server, vault = envPinnedContext()) {
  server.registerTool(
    "synapse_lint",
    {
      title: "Lint the Synapse vault",
      description:
        "Run the vault mechanical health check (synapse lint). Read-only: reports errors/warnings "
        + "(broken links, schema issues, orphans, etc.). Does NOT fix anything and does NOT start "
        + "an agent session. Use before proposing hygiene work. Pass strict=true for --strict.",
      inputSchema: {
        strict: z.boolean().optional().describe("If true, run synapse lint --strict"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ strict }) => {
      const args = ["lint"];
      if (strict) args.push("--strict");
      // lint exits non-zero when errors>0; still return stdout/stderr as content
      const res = await vault.runSynapse(args, { timeoutMs: 120_000 });
      if (res.timedOut) {
        return {
          isError: true,
          content: [{ type: "text", text: `Timed out.\n\n${res.stderr}` }],
        };
      }
      const body = [
        res.stdout.trim(),
        res.stderr.trim() ? `--- stderr ---\n${res.stderr.trim()}` : "",
        `exit=${res.code}`,
      ].filter(Boolean).join("\n\n");
      // Warnings-only runs may still exit 0; surface the report either way.
      return { content: [{ type: "text", text: body || "(no lint output)" }] };
    },
  );
}
