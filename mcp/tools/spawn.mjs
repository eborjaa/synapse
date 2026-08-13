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
import { parseStatus } from "../../lib/durable-spawn/heartbeat.mjs";
import { classify } from "../../lib/durable-spawn/liveness.mjs";
import { renderBriefing, launchDetached } from "../../lib/spawn-runtime.mjs";
import { resolveOllamaBase, resolveEmbedModel, embedText, cosine } from "../../lib/gen-embeddings.mjs";

const EPOCH = randomUUID(); // per MCP-server boot — the reconciliation key for staleSpawns()
const DB_PATH = join(VAULT, "db", "durable-spawn.db");
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
  return { leaseLive, ...verdict };
}

// `launch`/`render` are injectable so tests can drive the tools without a real runtime or vault render.
export function registerSpawnTools(
  server,
  { launch = launchDetached, render = (opts) => renderBriefing(runSynapse, opts) } = {},
) {
  server.registerTool(
    "synapse_spawn",
    {
      title: "Launch a durable, dedup-safe background doer",
      description:
        "Render <agent>'s briefing and launch it as a DETACHED background doer via --cli, deduped by a "
        + "SQLite lease on `job`. CRITICAL: `job` MUST be a CANONICAL id built from stable facts "
        + "(e.g. 'spec-builder:REL-38837:report-suite:<branch>') — extract the ticket/branch, do NOT "
        + "name it from your prose, or two phrasings of the same task will both run. Returns "
        + "{ok, spawnId, token, ...} on launch, or {refused:'held'|'looks-like-duplicate', ...} when a "
        + "live or near-identical job already runs. Poll with synapse_spawn_status.",
      inputSchema: {
        agent: z.string().describe("Agent id, e.g. 'spec-builder' or 'agent-spec-builder'"),
        task: z.string().describe("What the doer should do (the user message)"),
        job: z.string().describe("Canonical dedup key from stable ids — NOT free-text prose"),
        target: z.string().optional().describe("A hub or note id to scope the briefing"),
        cli: z.enum(["cursor", "claude", "opencode"]).optional().describe("Runtime sink (default SYNAPSE_CLI or cursor)"),
        profile: z.enum(["lean", "standard", "fat"]).optional(),
        ttlMs: z.number().optional().describe("Lease TTL in ms (default 1h). Must exceed the doer's max runtime."),
        force: z.boolean().optional().describe("Skip the semantic same-task pre-check (the lease still applies)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ agent, task, job, target, cli, profile, ttlMs, force }) => {
      const d = db();
      cli = cli || process.env.SYNAPSE_CLI || "cursor";
      profile = profile || "standard";
      ttlMs = ttlMs || DEFAULT_TTL_MS;

      // 1. Soft semantic net (skippable with force).
      if (!force) {
        const dup = await semanticDuplicate(d, task);
        if (dup) {
          return text({
            refused: "looks-like-duplicate",
            ...dup,
            hint: `A live job '${dup.similarJob}' looks like the same task (sim ${dup.similarity}). Reuse it, or call again with force:true if it is genuinely different.`,
          });
        }
      }

      // 2. Hard dedup: the lease. A live lease is refused for any owner.
      const owner = randomUUID();
      const acq = lease.acquire(d, job, owner, ttlMs);
      if (!acq.ok) return text({ refused: "held", reason: acq.reason, holder: acq.holder ?? null, job });

      // 3. Render the briefing; release the lease if we cannot even brief.
      const r = await render({ agent, target, task, profile });
      if (!r.ok) {
        lease.release(d, job, owner, acq.token);
        return fail({ error: "render-failed", job, detail: r.error });
      }

      // 4. Launch detached.
      const spawnId = randomUUID();
      const runDir = join(VAULT, "db", "spawn", spawnId);
      const statusFile = join(runDir, "status.log");
      const logFile = join(runDir, "runtime.log");
      let pid;
      try {
        ({ pid } = launch({
          cli, briefing: r.briefing, task, statusFile, logFile,
          vault: VAULT, model: "", permMode: "auto",
          job, owner, token: acq.token, dbPath: DB_PATH, cwd: VAULT,
        }));
      } catch (e) {
        lease.release(d, job, owner, acq.token);
        return fail({ error: "launch-failed", job, cli, detail: e.message });
      }

      // 5. Durable record (survives an orchestrator restart → staleSpawns reconciliation).
      registry.record(d, { spawnId, job, owner, epoch: EPOCH, token: acq.token, statusFile, task }, lease.dbNow(d));

      return text({ ok: true, spawnId, job, token: acq.token, owner, pid, cli, statusFile,
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
      inputSchema: { job: z.string(), owner: z.string(), token: z.number(), spawnId: z.string().optional() },
      annotations: { readOnlyHint: false },
    },
    async ({ job, owner, token, spawnId }) => {
      const d = db();
      const rel = lease.release(d, job, owner, token);
      if (spawnId) registry.markState(d, spawnId, "done", lease.dbNow(d));
      return text({ released: rel.ok, job, spawnId: spawnId ?? null });
    },
  );
}
