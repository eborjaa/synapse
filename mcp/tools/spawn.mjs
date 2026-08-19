// spawn.mjs — durable, CLI-agnostic agent delegation as MCP tools (the `orchestrator` surface).
//
// synapse_spawn launches a DETACHED doer whose dedup is guaranteed by a SQLite lease keyed on a
// CANONICAL job id the caller supplies from stable facts (ticket/branch) — never from prose. A
// semantic "same task?" pre-check catches a differently-worded duplicate before the lease is taken;
// the lease is the hard guarantee, the semantic check is a soft net that fails OPEN when Ollama is down.
//
// This is the ONE surface where a Synapse tool starts background work — every other tool returns text.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { VAULT, runSynapse } from "../vault.mjs";
import * as lease from "../../lib/durable-spawn/lease.mjs";
import * as registry from "../../lib/durable-spawn/registry.mjs";
import * as episodes from "../../lib/durable-spawn/episodes.mjs";
import { parseStatus } from "../../lib/durable-spawn/heartbeat.mjs";
import { classify } from "../../lib/durable-spawn/liveness.mjs";
import { renderBriefing, launchDetached } from "../../lib/spawn-runtime.mjs";
import { resolveOllamaBase, resolveEmbedModel, embedText, cosine } from "../../lib/gen-embeddings.mjs";

const EPOCH = randomUUID(); // per MCP-server boot — the reconciliation key for staleSpawns()
const DB_PATH = join(VAULT, "db", "durable-spawn.db");
const EPISODE_DB_PATH = join(VAULT, "db", "episodes.db");
const SIM_THRESHOLD = Number(process.env.SYNAPSE_SPAWN_SIM_THRESHOLD || 0.86);
const DEFAULT_TTL_MS = Number(process.env.SYNAPSE_SPAWN_TTL_MS || 60 * 60 * 1000); // 1h > a long turn

let _db = null;
function db() {
  if (_db) return _db;
  mkdirSync(join(VAULT, "db"), { recursive: true });
  _db = lease.openDb(DB_PATH);
  registry.migrate(_db);
  return _db;
}

// Episodes live in their OWN file: db/durable-spawn.db is disposable runtime state (a stuck lease is
// cleared by deleting it), and permanent memory must not ride along with something people delete.
let _edb = null;
function edb() {
  if (_edb) return _edb;
  mkdirSync(join(VAULT, "db"), { recursive: true });
  _edb = episodes.openEpisodeDb(EPISODE_DB_PATH);
  return _edb;
}

const text = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});
const fail = (obj) => ({ isError: true, ...text(obj) });

function leaseRowFor(d, job) {
  return d.prepare("SELECT owner, token, ttl_ms, renewed_at FROM lease WHERE job = ?").get(job) ?? null;
}

/** Running spawns whose lease is still live (the set a new task could collide with). */
function liveSpawns(d) {
  const now = lease.dbNow(d);
  return registry
    .listByState(d, "running")
    .filter((s) => lease.isLive(leaseRowFor(d, s.job), now));
}

/** Soft net: is `task` semantically close to a live spawn's task? Fails OPEN (returns null) when
 *  Ollama is unreachable — the exact-key lease remains the hard dedup guarantee. */
async function semanticDuplicate(d, task) {
  const live = liveSpawns(d).filter((s) => s.task);
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

function statusFacts(d, spawn) {
  const leaseLive = lease.isLive(leaseRowFor(d, spawn.job), lease.dbNow(d));
  const raw = spawn.status_file && existsSync(spawn.status_file)
    ? readFileSync(spawn.status_file, "utf8")
    : "";
  const parsed = parseStatus(raw, Date.now());
  const verdict = classify({ registryState: spawn.state, leaseLive, ...parsed });
  // No status file = the caller's own harness launched it (synapse_claim_and_brief), so completion
  // arrives through that harness, not heartbeats. `alive` here means "claimed and not yet released".
  const via = spawn.status_file ? "detached (synapse)" : "harness-native (yours)";
  return { via, leaseLive, ...verdict };
}

/**
 * The shared gate both delegation tools run: semantic pre-check → lease acquire → render the briefing.
 * This is where dedup is ENFORCED — and because it is what hands back the briefing (which a doer may
 * never start without), routing delegation through it makes the lease unskippable regardless of who
 * performs the launch. Returns {ok:true, owner, token, briefing} or {refusal} / {failure}.
 */
async function claimAndRender(d, { agent, task, job, target, profile, ttlMs, force }, render) {
  if (!force) {
    const dup = await semanticDuplicate(d, task);
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

  const owner = randomUUID();
  const acq = lease.acquire(d, job, owner, ttlMs);
  if (!acq.ok) {
    return { ok: false, body: { refused: "held", reason: acq.reason, holder: acq.holder ?? null, job } };
  }

  const r = await render({ agent, target, task, profile });
  if (!r.ok) {
    lease.release(d, job, owner, acq.token); // never strand a lease on a job that never started
    return { ok: false, isError: true, body: { error: "render-failed", job, detail: r.error } };
  }
  // Historical dedup — the counterpart to the lease. The lease refuses a job running NOW; this reports a
  // job that ALREADY RAN, and what came of it. It WARNS rather than refuses on purpose: re-running a
  // triage next week is legitimate work; re-running it UNKNOWINGLY is the waste worth naming.
  let priorRun = null;
  try {
    const prev = episodes.lastForJob(edb(), job);
    if (prev && prev.outcome !== "open") {
      priorRun = {
        outcome: prev.outcome,
        summary: prev.summary,
        endedAt: prev.endedAt,
        refs: prev.refs,
        hint: "This job ran before. Read the summary before repeating it — if the work still needs doing, carry on.",
      };
    }
  } catch { /* memory is additive — never block a claim on it */ }

  return { ok: true, owner, token: acq.token, briefing: r.briefing, priorRun };
}

// `launch`/`render` are injectable so tests can drive the tools without a real runtime or vault render.
export function registerSpawnTools(
  server,
  { launch = launchDetached, render = (opts) => renderBriefing(runSynapse, opts) } = {},
) {
  server.registerTool(
    "synapse_claim_and_brief",
    {
      title: "Claim a job + get the doer's briefing (PRIMARY delegation path)",
      description:
        "THE DEFAULT WAY TO DELEGATE. Atomically claims `job` (SQLite lease — a live or near-identical "
        + "job is REFUSED) and returns the doer's fully-rendered briefing. YOU then launch the doer with "
        + "your own harness (Cursor/Claude Task tool, an @mention, a terminal) using "
        + "prompt = <briefing>\\n\\n---\\n\\n<task> — so you keep every native feature (task panel, "
        + "streaming, completion notification) while dedup is still enforced. CRITICAL: `job` MUST be a "
        + "CANONICAL id from stable facts (e.g. 'spec-builder:REL-38837:report-suite:<branch>'), never "
        + "named from your prose. When the doer finishes, call synapse_spawn_release with "
        + "{job, owner, token, spawnId}. Use synapse_spawn instead ONLY when the work must outlive your "
        + "session or there is no harness to launch it.",
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
      const d = db();
      const claim = await claimAndRender(
        d,
        { agent, task, job, target, profile: profile || "standard", ttlMs: ttlMs || DEFAULT_TTL_MS, force },
        render,
      );
      if (!claim.ok) return claim.isError ? fail(claim.body) : text(claim.body);

      // Registered with NO status file: a harness-launched doer reports completion through the harness
      // (liveness.classify's registryState channel), so it never needs the heartbeat protocol.
      const spawnId = randomUUID();
      registry.record(
        d,
        { spawnId, job, owner: claim.owner, epoch: EPOCH, token: claim.token, statusFile: null, task },
        lease.dbNow(d),
      );

      // Episodic memory: the episode opens HERE, at claim time, not at completion — so work that dies
      // mid-flight still leaves a record, which is exactly the case a later agent most needs.
      const { episodeId } = episodes.open(
        edb(), { agent, job, spawnId, task, hub: target ?? null }, lease.dbNow(d),
      );

      return text({
        ok: true,
        spawnId,
        episodeId,
        job,
        owner: claim.owner,
        token: claim.token,
        launcher: "yours (harness-native)",
        ...(claim.priorRun ? { priorRun: claim.priorRun } : {}),
        next: "Launch the doer yourself with prompt = briefing + '\\n\\n---\\n\\n' + task, then call synapse_spawn_release({job, owner, token, spawnId, episodeId, summary}) when it finishes. The summary is what a future agent will read instead of redoing this.",
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
      const d = db();
      cli = cli || process.env.SYNAPSE_CLI || "cursor";
      cwd = cwd || VAULT;
      model = model || "";
      profile = profile || "standard";
      ttlMs = ttlMs || DEFAULT_TTL_MS;

      // 1-3. The same enforced gate the primary path uses: semantic net → lease → briefing.
      const claim = await claimAndRender(d, { agent, task, job, target, profile, ttlMs, force }, render);
      if (!claim.ok) return claim.isError ? fail(claim.body) : text(claim.body);
      const owner = claim.owner;
      const acq = { token: claim.token };
      const r = { briefing: claim.briefing };

      // 4. Launch detached — the one thing this path does that claim_and_brief leaves to the caller.
      const spawnId = randomUUID();
      const runDir = join(VAULT, "db", "spawn", spawnId);
      const statusFile = join(runDir, "status.log");
      const logFile = join(runDir, "runtime.log");
      let pid;
      try {
        ({ pid } = launch({
          cli, briefing: r.briefing, task, statusFile, logFile,
          vault: VAULT, model, permMode: "auto",
          job, owner, token: acq.token, dbPath: DB_PATH, cwd,
        }));
      } catch (e) {
        lease.release(d, job, owner, acq.token);
        return fail({ error: "launch-failed", job, cli, detail: e.message });
      }

      // 5. Durable record (survives an orchestrator restart → staleSpawns reconciliation) + the episode.
      registry.record(d, { spawnId, job, owner, epoch: EPOCH, token: acq.token, statusFile, task }, lease.dbNow(d));
      const { episodeId } = episodes.open(edb(), { agent, job, spawnId, task, hub: target ?? null }, lease.dbNow(d));

      return text({ ok: true, spawnId, episodeId, job, token: acq.token, owner, pid, cli, statusFile,
        note: "Poll synapse_spawn_status. The doer heartbeats to its status file; a stale heartbeat escalates to you, never auto-kills." });
    },
  );

  server.registerTool(
    "synapse_spawn_status",
    {
      title: "Liveness + progress of a spawned doer",
      description:
        "Classify one spawn by lease + status-file heartbeats. state: alive|waiting|done|failed|orphaned"
        + "|hang-suspected; action: none|reap-result|re-lease|escalate-human. Give spawnId, or job for its"
        + " latest spawn.",
      inputSchema: {
        spawnId: z.string().optional(),
        job: z.string().optional().describe("Latest spawn for this job (if spawnId omitted)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ spawnId, job }) => {
      const d = db();
      const spawn = spawnId
        ? registry.get(d, spawnId)
        : job
          ? d.prepare("SELECT * FROM spawn WHERE job = ? ORDER BY created_at DESC LIMIT 1").get(job) ?? null
          : null;
      if (!spawn) return fail({ error: "unknown-spawn", spawnId: spawnId ?? null, job: job ?? null });
      const v = statusFacts(d, spawn);
      // A live, progressing doer holds its claim as long as the orchestrator is watching: renewal lives
      // here (flagged server) rather than in the doer's sqlite-free CLI. If the orchestrator dies and
      // stops polling, the lease lapses → orphaned → safely re-leasable (fencing stops the zombie).
      if ((v.state === "alive" || v.state === "waiting") && spawn.token != null) {
        lease.renew(d, spawn.job, spawn.owner, spawn.token);
      }
      // Reflect a terminal/orphan verdict back into the registry so _list stays accurate.
      if (v.state === "done" || v.state === "failed") registry.markState(d, spawn.spawn_id, v.state, lease.dbNow(d));
      else if (v.state === "orphaned") registry.markState(d, spawn.spawn_id, "orphaned", lease.dbNow(d));
      return text({ spawnId: spawn.spawn_id, job: spawn.job, ...v });
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
    async () => {
      const d = db();
      const running = registry.listByState(d, "running").map((s) => ({
        spawnId: s.spawn_id, job: s.job, cli: undefined, ...statusFacts(d, s),
      }));
      const stale = registry.staleSpawns(d, EPOCH).map((s) => ({ spawnId: s.spawn_id, job: s.job, ...statusFacts(d, s) }));
      return text({ epoch: EPOCH, running, staleFromPriorBoot: stale });
    },
  );

  server.registerTool(
    "synapse_spawn_renew",
    {
      title: "Renew a spawn's lease (keep the claim alive)",
      description: "Extend the lease for a job you own. Usually the doer's heartbeat does this; call it to hold a claim across an orchestrator gap.",
      inputSchema: { job: z.string(), owner: z.string(), token: z.number() },
      annotations: { readOnlyHint: false },
    },
    async ({ job, owner, token }) => text(lease.renew(db(), job, owner, token)),
  );

  server.registerTool(
    "synapse_spawn_release",
    {
      title: "Release a spawn's lease + mark it done",
      description: "Release the lease (only the holder can) and mark the spawn done. Call after reaping a finished doer's result.",
      inputSchema: {
        job: z.string(), owner: z.string(), token: z.number(), spawnId: z.string().optional(),
        episodeId: z.string().optional().describe("From synapse_claim_and_brief — closes that episode"),
        outcome: z.enum(["done", "failed", "abandoned"]).optional().describe("Default done"),
        summary: z.string().optional()
          .describe("WHAT HAPPENED, in a sentence or two. This is what a future agent reads instead of "
            + "redoing the work — findings, decisions, what was left undone. Omitting it records that "
            + "something happened without recording what."),
        refs: z.array(z.string()).optional().describe("Ids/URLs/paths produced or touched (PRs, tickets, note ids, specs)"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ job, owner, token, spawnId, episodeId, outcome, summary, refs }) => {
      const d = db();
      const rel = lease.release(d, job, owner, token);
      const state = outcome === "failed" ? "failed" : "done";
      if (spawnId) registry.markState(d, spawnId, state, lease.dbNow(d));
      const ep = episodes.close(
        edb(), { episodeId: episodeId ?? null, job, outcome: outcome || "done", summary: summary ?? null, refs: refs ?? null },
        lease.dbNow(d),
      );
      return text({
        released: rel.ok, job, spawnId: spawnId ?? null,
        episodeClosed: ep.ok ? ep.episodeId : null,
        ...(summary ? {} : { note: "No summary recorded — this run is now a fact with no content. Prefer passing one." }),
      });
    },
  );
}
