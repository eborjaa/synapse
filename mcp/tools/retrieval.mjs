// retrieval.mjs — augment + embeddings status/rebuild.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { VAULT, runSynapse, asToolResult } from "../vault.mjs";

const PROFILE = z.enum(["lean", "standard", "fat"]);

export function registerRetrievalTools(server) {
  server.registerTool(
    "synapse_augment",
    {
      title: "Augment a Synapse closure with semantic recall",
      description:
        "Typed closure for the start ids PLUS embedding-nearest notes for the task. "
        + "Prefer ids = [agent, one hub]. Semantic hits are labeled suggestions — not a second "
        + "hub's members, not authoritative. Degrades in-band if Ollama/index unavailable. "
        + "Prefer synapse_brief(agent, hub, task) when you want the same path with shorter args.",
      inputSchema: {
        ids: z.array(z.string()).min(1)
          .describe("Start ids — prefer [agent, one hub], e.g. ['agent-oracle','hub-finances']"),
        task: z.string().describe("Task / query for semantic ranking"),
        profile: PROFILE.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ids, task, profile }) => {
      const args = ["augment", ...ids, "--task", task];
      if (profile) args.push("--profile", profile);
      return asToolResult(await runSynapse(args));
    },
  );

  server.registerTool(
    "synapse_embeddings_status",
    {
      title: "Embeddings / recall health",
      description:
        "Report whether semantic recall can work: vault path, vector DB presence, and a short "
        + "self-check via synapse embeddings --selftest when available.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const candidates = [
        join(VAULT, "db", "synapse.db"),
        join(VAULT, "db", "vault-vectors.db"),
        join(VAULT, "db", "note_vectors.db"),
      ];
      const found = candidates.filter((p) => existsSync(p));
      const lines = [
        `vault=${VAULT}`,
        `db files present: ${found.length ? found.join(", ") : "(none of the common paths)"}`,
      ];
      const res = await runSynapse(["embeddings", "--selftest"], { timeoutMs: 60_000 });
      lines.push(`embeddings --selftest exit=${res.code}`);
      if (res.stdout.trim()) lines.push(res.stdout.trim());
      if (res.stderr.trim()) lines.push(`--- stderr ---\n${res.stderr.trim()}`);
      const verdict = res.code === 0 ? "healthy-or-ok" : "DEGRADED";
      lines.unshift(`verdict: ${verdict}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "synapse_embeddings_rebuild",
    {
      title: "Rebuild embeddings cache",
      description:
        "Re-embed vault notes via local Ollama (slow, write). Only call when the user asks.",
      inputSchema: {
        all: z.boolean().optional().describe("Pass --all to rebuild everything"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ all }) => {
      const args = ["embeddings"];
      if (all) args.push("--all");
      return asToolResult(await runSynapse(args, { timeoutMs: 600_000 }));
    },
  );
}
