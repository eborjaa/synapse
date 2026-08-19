// retrieval.mjs — augment + embeddings status/rebuild.

import { mkdirSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { VAULT, SYNAPSE_BIN, runSynapse, asToolResult } from "../vault.mjs";

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

  // Reports FRESHNESS, not just presence. Presence alone was the misleading answer: an index built two
  // months ago passes every existence check while recall silently ranks against a vault that no longer
  // exists. staleCount is the number of notes gen-embeddings would (re-)embed right now.
  server.registerTool(
    "synapse_embeddings_status",
    {
      title: "Embeddings / recall health",
      description:
        "Is semantic recall working AND current? Reports whether the index exists, how many notes are "
        + "indexed, and how many have been added or edited since (staleCount). A stale index never "
        + "errors — it quietly ranks against an older vault — so check this when recall looks wrong, "
        + "after a large edit, or after pulling a teammate's notes. Read-only: builds nothing. "
        + "Rebuild with synapse_embeddings_rebuild.",
      inputSchema: {
        fast: z.boolean().optional()
          .describe("Skip the exact per-note comparison (~25ms instead of ~400ms); staleCount is then null"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ fast }) => {
      // Lazy import: this pulls in node:sqlite, and a server on an older Node must still start and
      // serve every other tool rather than failing at module load.
      let mod;
      try {
        mod = await import("../../lib/index-freshness.mjs");
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Freshness check unavailable: ${e.message}` }] };
      }
      const st = mod.embeddingsStatus({ precise: !fast, deep: !fast });
      const lines = [`vault=${VAULT}`, mod.formatStatus(st)];
      if (st.stale) {
        lines.push("");
        lines.push(st.present
          ? "Recall is ranking against an OUT-OF-DATE index — rebuild before trusting semantic hits."
          : "Semantic recall is OFF — every augment falls back to the deterministic briefing.");
        lines.push("Fix: synapse_embeddings_rebuild, or `synapse embeddings` in the vault.");
      }
      lines.push("");
      lines.push(JSON.stringify({
        present: st.present, stale: st.stale, staleCount: st.staleCount, precise: st.precise,
        indexed: st.rows, corpusNotes: st.corpusNotes, model: st.model,
        storedMaxMtime: st.storedMaxMtime, corpusMaxMtime: st.corpusMaxMtime, newestPath: st.newestPath,
        collisions: st.collisions,
      }, null, 2));
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // DETACHED on purpose. This used to run in-band with a 10-minute timeout, which freezes the calling
  // agent's turn for the whole rebuild with no progress channel. Now it starts the job and returns; the
  // caller polls synapse_embeddings_status. Concurrency is handled one layer down — the refresh takes a
  // cooperative lock, so N agents sharing a vault produce ONE rebuild, not N writers on one SQLite file.
  server.registerTool(
    "synapse_embeddings_rebuild",
    {
      title: "Rebuild embeddings cache",
      description:
        "Start a rebuild of the semantic-recall index (the embeddings cache — NOT `synapse index`, which "
        + "is the SQL projections). Returns IMMEDIATELY: the job runs detached for minutes, so poll "
        + "synapse_embeddings_status until stale=false. Incremental by default; all=true re-embeds "
        + "everything and is only needed after an embed-model change. Safe to call concurrently — a lock "
        + "collapses simultaneous requests into one rebuild. Needs a running local Ollama; without one "
        + "the job exits and the existing index is left intact.",
      inputSchema: {
        all: z.boolean().optional().describe("Force a FULL re-embed (slow) — only after an embed-model change"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ all }) => {
      const logPath = join(VAULT, "db", "embed-rebuild.log");
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        const fd = openSync(logPath, "a");
        const args = [SYNAPSE_BIN, "embeddings-status", "--refresh", "--force"];
        if (all) args.push("--all");
        const child = spawn(process.execPath, args, {
          cwd: VAULT,
          env: { ...process.env, SYNAPSE_VAULT: VAULT },
          detached: true,
          stdio: ["ignore", fd, fd],
        });
        child.unref();
        return {
          content: [{
            type: "text",
            text: `Started a ${all ? "FULL" : "incremental"} re-embed in the background (pid ${child.pid}).\n\n`
              + "It runs for minutes and does NOT block this conversation — poll "
              + `synapse_embeddings_status until stale=false.\nProgress log: ${logPath}`,
          }],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Could not start the rebuild: ${e.message}` }] };
      }
    },
  );
}
