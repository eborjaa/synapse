// episodes.mjs — EPISODIC MEMORY over MCP: what agents already did, and a way to record it.
//
// Synapse ships procedural memory (agents/rules/skills — how to act) and semantic memory (notes +
// embeddings — what is true). This is the third store: what HAPPENED. Without it every session starts
// amnesiac — a lead re-plans work a doer finished yesterday, and the only cure is a human writing a
// handover note by hand.
//
// SURFACE NOTE — why a write tool is registered on the read-only surface. `synapse_log` records a FACT
// about a run; it does not author vault content, cannot change what any briefing says, and needs no
// human review. The "read front door never mutates" guarantee is about the knowledge graph, which this
// does not touch. A doer restricted to `standard` still has to be able to say what it did, or the
// memory has a hole exactly where the work happens.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as lease from "../../lib/durable-spawn/lease.mjs";
import * as episodes from "../../lib/durable-spawn/episodes.mjs";
import { recall as recallDelta } from "../../lib/recall.mjs";
import { envPinnedContext } from "../vault-context.mjs";
import { vaultStore } from "../../lib/ports/vault-store.mjs";

// Keyed BY VAULT rather than memoized per module load — see lib/ports/vault-store.mjs for why the
// module-level singleton was correct on stdio and silently wrong off it. The KEY now comes from the
// bound context rather than a module constant, which is what closes the last half of that gap: the
// store was already keyed per vault, but every caller handed it the same key.
const dbFor = (vault) =>
  vaultStore.db(vault.vaultDir, { name: "episodes", open: (path) => episodes.openEpisodeDb(path) });

const text = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

export function registerEpisodeTools(server, vault = envPinnedContext()) {
  const db = () => dbFor(vault);
  registerRecallTool(server, vault);

  server.registerTool(
    "synapse_history",
    {
      title: "Recall what was already done (episodic memory)",
      description:
        "Search the record of work agents have ALREADY done: the task, how it ended, a summary of what "
        + "happened, and what it touched. Call this BEFORE planning or delegating anything that might "
        + "have been done before — a briefing tells you how to act and the vault tells you what is true, "
        + "but only this tells you what already happened. Keyword search (exact ids like 'REL-38837' "
        + "match reliably), newest first, filterable by agent/hub/outcome/age. Read-only.",
      inputSchema: {
        query: z.string().optional().describe("Keywords — ticket ids, branch names, spec paths, topic words"),
        agent: z.string().optional().describe("Only this agent's episodes, e.g. 'agent-spec-builder'"),
        hub: z.string().optional().describe("Only this domain, e.g. 'moc-sensors'"),
        outcome: z.enum(["open", "done", "failed", "abandoned"]).optional()
          .describe("'open' = still running or died mid-flight; 'failed' = what to avoid repeating blindly"),
        sinceDays: z.number().optional().describe("Only the last N days"),
        limit: z.number().optional().describe("Max results (default 10, cap 100)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, agent, hub, outcome, sinceDays, limit }) => {
      const d = db();
      const since = sinceDays ? lease.dbNow(d) - sinceDays * 86_400_000 : null;
      const hits = episodes.searchEpisodes(d, { query, agent, hub, outcome, since, limit: limit || 10 });
      if (!hits.length) {
        return text({
          episodes: [],
          note: "Nothing recorded matches. That means no agent logged this work — NOT that it was never "
            + "done. Treat it as unknown, not as absent.",
        });
      }
      return text({
        count: hits.length,
        episodes: hits.map((e) => ({
          when: new Date(e.startedAt).toISOString(),
          agent: e.agent, hub: e.hub, outcome: e.outcome,
          task: e.task, summary: e.summary, refs: e.refs, job: e.job,
        })),
      });
    },
  );

  server.registerTool(
    "synapse_log",
    {
      title: "Record what you did (episodic memory)",
      description:
        "Append a finished piece of work to episodic memory so a future agent — or you, next session — "
        + "finds it instead of redoing it. Delegated work is recorded automatically by "
        + "synapse_claim_and_brief + synapse_spawn_release; use this for work you did YOURSELF, or for "
        + "anything that happened outside a spawn. The summary is the whole value: write what a "
        + "colleague would need to not repeat this — findings, decisions, what was left undone. "
        + "Append-only: it records a fact, and does not modify the vault.",
      inputSchema: {
        task: z.string().describe("What the work was"),
        summary: z.string().describe("What actually happened — findings, decisions, what remains"),
        outcome: z.enum(["done", "failed", "abandoned"]).optional().describe("Default done"),
        agent: z.string().optional().describe("Your agent id, if you have one"),
        hub: z.string().optional().describe("Domain, e.g. 'moc-sensors'"),
        job: z.string().optional().describe("Canonical job id, if this work had one"),
        refs: z.array(z.string()).optional().describe("Ids/URLs/paths produced or touched (PRs, tickets, notes, specs)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ task, summary, outcome, agent, hub, job, refs }) => {
      const d = db();
      const { episodeId } = episodes.log(d, {
        agent: agent ?? null, hub: hub ?? null, job: job ?? null,
        task, summary, outcome: outcome || "done", refs: refs ?? null,
      });
      return text({ recorded: true, episodeId, task, outcome: outcome || "done" });
    },
  );
}

/**
 * synapse_recall — the top-up when the task shifts mid-session. The briefing was rendered once at
 * dispatch; this returns only the DELTA for the current subtask across all three memories: relevant
 * notes (semantic), rules that now apply (on-demand triggers), and prior work (episodes). It never
 * re-renders the spine the agent already holds.
 */
function registerRecallTool(server, vault) {
  const db = () => dbFor(vault);
  server.registerTool(
    "synapse_recall",
    {
      title: "Top up context for the current subtask",
      description:
        "Your briefing was built ONCE, at the start. When the work moves to a new subtask, call this "
        + "with what you are doing NOW to get only what changed — relevant notes, any rule that now "
        + "applies (fetch it before acting), and whether this was already done. Does NOT re-send your "
        + "briefing. If nothing is relevant it says so plainly. Read-only. Call it whenever the topic "
        + "shifts — it is cheap, and a stale briefing is how agents drift.",
      inputSchema: {
        task: z.string().describe("What you are working on RIGHT NOW — the current subtask, in your words"),
        k: z.number().optional().describe("Max semantic hits (default 6)"),
        includePriorWork: z.boolean().optional().describe("Also search episodic memory for this task (default true)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ task, k, includePriorWork }) => {
      const episodesFn = (includePriorWork === false)
        ? null
        : (t) => episodes.searchEpisodes(db(), { query: t, limit: 3 })
            .map((e) => ({ when: new Date(e.startedAt).toISOString(), outcome: e.outcome, summary: e.summary, job: e.job }));
      const r = await recallDelta({ vault, task, k: k || 6, episodesFn });
      return text(r);
    },
  );
}
