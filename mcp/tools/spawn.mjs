// spawn.mjs — durable, CLI-agnostic agent delegation as MCP tools (the `orchestrator` surface).
//
// synapse_spawn launches a DETACHED doer whose dedup is guaranteed by a SQLite lease keyed on a
// CANONICAL job id the caller supplies from stable facts (ticket/branch) — never from prose. A
// semantic "same task?" pre-check catches a differently-worded duplicate before the lease is taken;
// the lease is the hard guarantee, the semantic check is a soft net that fails OPEN when Ollama is down.
//
// Identity at close time is one checksummed HANDLE the server minted at claim
// ([[decision-0019-handoff-identity]]). This module calls HandoffPort; it contains no table access
// and no cross-record coordination.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { normalizeAgentId } from "../vault.mjs";
import { envPinnedContext } from "../vault-context.mjs";
import { vaultStore } from "../../lib/ports/vault-store.mjs";
import { parseHandle } from "../../lib/ports/handoff.mjs";
import { createSqliteHandoff, openSpawnDb, openEpisodeDb } from "../../lib/durable-spawn/handoff.mjs";
import { renderBriefing, launchDetached } from "../../lib/spawn-runtime.mjs";
import { resolveOllamaBase, resolveEmbedModel, embedText, cosine } from "../../lib/gen-embeddings.mjs";

const EPOCH = (vault) => vaultStore.epoch(vault.vaultDir);
const dbPath = (vault) => join(vault.vaultDir, "db", "durable-spawn.db");
const SIM_THRESHOLD = Number(process.env.SYNAPSE_SPAWN_SIM_THRESHOLD || 0.86);
const DEFAULT_TTL_MS = Number(process.env.SYNAPSE_SPAWN_TTL_MS || 60 * 60 * 1000); // 1h > a long turn

const dbFor = (vault) => vaultStore.db(vault.vaultDir, {
  name: "durable-spawn",
  open: (path) => openSpawnDb(path),
});
const edbFor = (vault) =>
  vaultStore.db(vault.vaultDir, { name: "episodes", open: (path) => openEpisodeDb(path) });

const text = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});
const fail = (obj) => ({ isError: true, ...text(obj) });

const DEPRECATION =
  "[synapse] job/owner/token/spawnId/episodeId are deprecated on spawn_release/renew; pass handle\n";

function handoffFor(vault) {
  return createSqliteHandoff({
    db: dbFor(vault),
    edb: edbFor(vault),
    epoch: EPOCH(vault),
  });
}

/** Soft net: is `task` semantically close to a live spawn's task? Fails OPEN (returns null) when
 *  Ollama is unreachable — the exact-key lease remains the hard dedup guarantee. */
async function semanticDuplicate(handoff, task) {
  const live = handoff.liveSpawns().filter((s) => s.task);
  if (!live.length || !task) return null;
  try {
    const base = resolveOllamaBase();
    const model = resolveEmbedModel();
    const target = await embedText(base, model, task);
    let best = null;
    for (const s of live) {
      const sim = cosine(target, await embedText(base, model, s.task));
      if (!best || sim > best.similarity) best = { similarJob: s.job, similarity: Number(sim.toFixed(3)) };
    }
    return best && best.similarity >= SIM_THRESHOLD ? best : null;
  } catch {
    return null;
  }
}

/**
 * Shared gate: semantic pre-check → HandoffPort.claim → render. Render failure closes the handoff
 * as failed (never strands a ticket). Returns {ok:true, handle, briefing, ...} or a refusal/failure.
 */
async function claimAndRender(handoff, { agent, task, job, target, profile, ttlMs, force, statusFile }, render) {
  if (!force) {
    const dup = await semanticDuplicate(handoff, task);
    if (dup) {
      return {
        ok: false,
        body: {
          refused: "looks-like-duplicate",
          ...dup,
          hint: `A live job '${dup.similarJob}' looks like the same task (sim ${dup.similarity}). Reuse it, or call again with force:true if it is genuinely different.`,
        },
      };
    }
  }

  const claimed = handoff.claim({ job, agent, task, hub: target ?? null, ttlMs, statusFile });
  if (claimed.refused) {
    return { ok: false, body: { refused: claimed.refused, reason: claimed.reason, holder: claimed.holder ?? null, job: claimed.job ?? job } };
  }

  const r = await render({ agent, target, task, profile });
  if (!r.ok) {
    handoff.close({ handle: claimed.handle, outcome: "failed", summary: `render-failed: ${r.error}` });
    return { ok: false, isError: true, body: { error: "render-failed", job, detail: r.error } };
  }

  return {
    ok: true,
    handle: claimed.handle,
    spawnId: claimed.spawnId,
    owner: claimed.owner,
    token: claimed.token,
    briefing: r.briefing,
    priorRun: claimed.priorRun,
  };
}

function resolveHandle(handoff, { handle, job, owner, token, spawnId, episodeId }) {
  if (handle) {
    const parsed = parseHandle(handle);
    if (!parsed.ok) return { handle: null, reason: "invalid-handle", deprecated: false };
    return { handle: parsed.handle, reason: null, deprecated: Boolean(job || owner || token || spawnId || episodeId) };
  }
  const mapped = handoff.handleFromLegacy({ job, owner, token, spawnId, episodeId });
  if (mapped) return { handle: mapped, reason: null, deprecated: true };
  return { handle: null, reason: "unknown-handle", deprecated: true };
}

const NEXT =
  "Launch the doer yourself with prompt = briefing + '\\n\\n---\\n\\n' + task, then call synapse_spawn_release({ handle, summary }) when it finishes. The summary is what a future agent will read instead of redoing this.";

export function registerSpawnTools(
  server,
  vault = envPinnedContext(),
  { launch = launchDetached, render = null } = {},
) {
  const handoff = () => handoffFor(vault);
  render = render || ((opts) => renderBriefing(vault.runSynapse.bind(vault), opts));

  server.registerTool(
    "synapse_claim_and_brief",
    {
      title: "Claim a job + get the doer's briefing (PRIMARY delegation path)",
      description:
        "THE DEFAULT WAY TO DELEGATE. Atomically claims `job` (SQLite lease — a live or near-identical "
        + "job is REFUSED) and returns the doer's fully-rendered briefing plus a `handle`. YOU then launch "
        + "the doer with your own harness (Cursor/Claude Task tool, an @mention, a terminal) using "
        + "prompt = <briefing>\\n\\n---\\n\\n<task> — so you keep every native feature (task panel, "
        + "streaming, completion notification) while dedup is still enforced. CRITICAL: `job` MUST be a "
        + "CANONICAL id from stable facts (e.g. 'spec-builder:REL-38837:report-suite:<branch>'), never "
        + "named from your prose. When the doer finishes, call synapse_spawn_release({ handle, summary }). "
        + "Use synapse_spawn instead ONLY when the work must outlive your session or there is no harness "
        + "to launch it.",
      inputSchema: {
        agent: z.string().describe("Agent id, e.g. 'spec-builder' or 'agent-spec-builder'"),
        task: z.string().describe("What the doer should do (append it after the briefing when you launch)"),
        job: z.string().describe("Canonical dedup key from stable ids — NOT free-text prose"),
        target: z.string().optional().describe("A hub or note id to scope the briefing"),
        profile: z.enum(["lean", "standard", "fat"]).optional().describe("Default standard — never starve a fresh window with lean"),
        ttlMs: z.number().optional().describe("Lease TTL in ms (default 1h). Must exceed the doer's expected runtime."),
        force: z.boolean().optional().describe("Skip the semantic same-task pre-check (the lease still applies)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ agent, task, job, target, profile, ttlMs, force }) => {
      const agentId = normalizeAgentId(agent);
      const claim = await claimAndRender(
        handoff(),
        { agent: agentId, task, job, target, profile: profile || "standard", ttlMs: ttlMs || DEFAULT_TTL_MS, force, statusFile: null },
        render,
      );
      if (!claim.ok) return claim.isError ? fail(claim.body) : text(claim.body);
      return text({
        ok: true,
        handle: claim.handle,
        job,
        launcher: "yours (harness-native)",
        ...(claim.priorRun ? { priorRun: claim.priorRun } : {}),
        next: NEXT,
        briefing: claim.briefing,
      });
    },
  );

  server.registerTool(
    "synapse_spawn",
    {
      title: "Launch a DETACHED durable doer (specialist — prefer synapse_claim_and_brief)",
      description:
        "SPECIALIST PATH. Same claim + briefing as synapse_claim_and_brief, but SYNAPSE performs the "
        + "launch: a detached OS process via --cli (cursor/claude/opencode). It therefore survives your "
        + "session ending — and is INVISIBLE to your harness's task panel, with no completion "
        + "notification (poll synapse_spawn_status instead). Use it ONLY when (a) the work must outlive "
        + "your session/turn, or (b) there is no harness to launch with (cron, a script, a headless run). "
        + "Otherwise use synapse_claim_and_brief and launch natively so you keep your harness's features. "
        + "CRITICAL: `job` MUST be a CANONICAL id from stable facts, never named from your prose.",
      inputSchema: {
        agent: z.string().describe("Agent id, e.g. 'spec-builder' or 'agent-spec-builder'"),
        task: z.string().describe("What the doer should do (the user message)"),
        job: z.string().describe("Canonical dedup key from stable ids — NOT free-text prose"),
        target: z.string().optional().describe("A hub or note id to scope the briefing"),
        cli: z.enum(["cursor", "claude", "opencode"]).optional().describe("Runtime sink (default SYNAPSE_CLI or cursor)"),
        cwd: z.string().optional().describe("Working dir for the doer — a CODE checkout for a code task; defaults to the vault"),
        model: z.string().optional().describe("Model id for the doer, in the runtime's own naming (e.g. claude 'sonnet', opencode 'anthropic/claude-sonnet-4-5'); default = runtime's configured model"),
        profile: z.enum(["lean", "standard", "fat"]).optional(),
        ttlMs: z.number().optional().describe("Lease TTL in ms (default 1h). Must exceed the doer's max runtime."),
        force: z.boolean().optional().describe("Skip the semantic same-task pre-check (the lease still applies)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ agent, task, job, target, cli, cwd, model, profile, ttlMs, force }) => {
      const h = handoff();
      const agentId = normalizeAgentId(agent);
      cli = cli || process.env.SYNAPSE_CLI || "cursor";
      cwd = cwd || vault.vaultDir;
      model = model || "";
      profile = profile || "standard";
      ttlMs = ttlMs || DEFAULT_TTL_MS;

      const claim = await claimAndRender(
        h,
        { agent: agentId, task, job, target, profile, ttlMs, force, statusFile: null },
        render,
      );
      if (!claim.ok) return claim.isError ? fail(claim.body) : text(claim.body);

      const runDir = join(vault.vaultDir, "db", "spawn", claim.spawnId);
      const statusFile = join(runDir, "status.log");
      const logFile = join(runDir, "runtime.log");
      mkdirSync(runDir, { recursive: true });
      h.attachStatusFile({ handle: claim.handle, statusFile });
      let pid;
      try {
        ({ pid } = launch({
          cli, briefing: claim.briefing, task, statusFile, logFile,
          vault: vault.vaultDir, model, permMode: "auto",
          job, owner: claim.owner, token: claim.token, dbPath: dbPath(vault), cwd,
        }));
      } catch (e) {
        h.close({ handle: claim.handle, outcome: "failed", summary: `launch-failed: ${e.message}` });
        return fail({ error: "launch-failed", job, cli, detail: e.message });
      }

      return text({
        ok: true,
        handle: claim.handle,
        spawnId: claim.spawnId,
        job,
        pid,
        cli,
        statusFile,
        note: "Poll synapse_spawn_status. The doer heartbeats to its status file; a stale heartbeat escalates to you, never auto-kills. Release with synapse_spawn_release({ handle, summary }).",
      });
    },
  );

  server.registerTool(
    "synapse_spawn_status",
    {
      title: "Liveness + progress of a spawned doer",
      description:
        "Classify one spawn by lease + status-file heartbeats. state: alive|waiting|done|failed|orphaned"
        + "|hang-suspected; action: none|reap-result|re-lease|escalate-human. Give handle, spawnId, or job.",
      inputSchema: {
        handle: z.string().optional().describe("Handoff handle from claim/spawn"),
        spawnId: z.string().optional(),
        job: z.string().optional().describe("Latest spawn for this job (if handle/spawnId omitted)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ handle, spawnId, job }) => {
      const r = handoff().observe({ handle, spawnId, job });
      if (r.error) return fail(r);
      return text(r);
    },
  );

  server.registerTool(
    "synapse_spawn_list",
    {
      title: "List in-flight spawns (+ restart reconciliation)",
      description:
        "Every running spawn with its live classification, plus `stale` spawns left by a PREVIOUS "
        + "orchestrator boot (different epoch) that need reconciling.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(handoff().listSpawns()),
  );

  server.registerTool(
    "synapse_handoffs_open",
    {
      title: "List unfinished handoffs",
      description:
        "This vault's open handoffs (claimed, not yet closed) with age and expiry. The orchestrator's "
        + "peek: recover a dropped handle and re-close with synapse_spawn_release({ handle, summary }).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text({ open: handoff().openHandoffs() }),
  );

  server.registerTool(
    "synapse_spawn_renew",
    {
      title: "Renew a spawn's lease (keep the claim alive)",
      description: "Extend the lease for a job you hold by presenting its handle. Usually the doer's heartbeat does this; call it to hold a claim across an orchestrator gap.",
      inputSchema: {
        handle: z.string().optional().describe("Handoff handle from claim/spawn"),
        job: z.string().optional(),
        owner: z.string().optional(),
        token: z.number().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ handle, job, owner, token }) => {
      const h = handoff();
      const resolved = resolveHandle(h, { handle, job, owner, token });
      if (resolved.deprecated) process.stderr.write(DEPRECATION);
      if (!resolved.handle) return fail({ ok: false, refused: resolved.reason });
      const r = h.renew({ handle: resolved.handle });
      if (r.refused) return fail({ ok: false, refused: r.refused, ...(resolved.deprecated ? { deprecated: true } : {}) });
      return text({ ok: true, ...(resolved.deprecated ? { deprecated: true } : {}) });
    },
  );

  server.registerTool(
    "synapse_spawn_release",
    {
      title: "Close a handoff (ticket + logbook together)",
      description:
        "Close the handoff identified by `handle`: release the lease and close the episode with the "
        + "summary a future agent will read. Never reports success when the logbook did not close. "
        + "job/owner/token/spawnId/episodeId are accepted for one release (deprecated).",
      inputSchema: {
        handle: z.string().optional().describe("Handoff handle from claim/spawn — the only field you need"),
        job: z.string().optional(),
        owner: z.string().optional(),
        token: z.number().optional(),
        spawnId: z.string().optional(),
        episodeId: z.string().optional(),
        outcome: z.enum(["done", "failed", "abandoned"]).optional().describe("Default done"),
        summary: z.string().optional()
          .describe("WHAT HAPPENED, in a sentence or two. This is what a future agent reads instead of "
            + "redoing the work — findings, decisions, what was left undone. Omitting it records that "
            + "something happened without recording what."),
        refs: z.array(z.string()).optional().describe("Ids/URLs/paths produced or touched (PRs, tickets, note ids, specs)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ handle, job, owner, token, spawnId, episodeId, outcome, summary, refs }) => {
      const h = handoff();
      const resolved = resolveHandle(h, { handle, job, owner, token, spawnId, episodeId });
      if (resolved.deprecated) process.stderr.write(DEPRECATION);
      if (!resolved.handle) {
        return fail({ closed: false, reason: resolved.reason, ...(resolved.deprecated ? { deprecated: true } : {}) });
      }
      const r = h.close({
        handle: resolved.handle,
        outcome: outcome || "done",
        summary: summary ?? null,
        refs: refs ?? null,
      });
      if (r.refused) {
        const body = { closed: false, reason: r.refused, ...(resolved.deprecated ? { deprecated: true } : {}) };
        if (r.refused === "already-closed") return text(body);
        return fail(body);
      }
      return text({
        closed: true,
        outcome: r.outcome,
        ...(resolved.deprecated ? { deprecated: true } : {}),
        ...(summary ? {} : { note: "No summary recorded — this run is now a fact with no content. Prefer passing one." }),
      });
    },
  );
}
