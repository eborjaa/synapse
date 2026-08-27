// durable-spawn / handoff.mjs — sqlite adapter for HandoffPort.
//
// Today's lease + spawn + episode tables stay three tables; they stop being three contracts the
// tool layer has to keep in step by hand. That split is where the original bug lived: spawn_release
// released the ticket, then looked up the logbook by a mistyped episodeId, found nothing, and still
// reported released:true. After this file, mcp/tools/spawn.mjs calls the port and never touches a
// table. See [[decision-0019-handoff-identity]].

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { HandoffPort } from "../ports/handoff.mjs";
import { mintHandle, parseHandle } from "../ports/handoff.mjs";
import * as lease from "./lease.mjs";
import * as registry from "./registry.mjs";
import * as episodes from "./episodes.mjs";
import { parseStatus } from "./heartbeat.mjs";
import { classify } from "./liveness.mjs";

export function openSpawnDb(path) {
  const d = lease.openDb(path);
  registry.migrate(d);
  return d;
}

export function openEpisodeDb(path) {
  return episodes.openEpisodeDb(path);
}

function mintUnique(db, edb) {
  for (let i = 0; i < 16; i++) {
    const h = mintHandle();
    const taken = db.prepare("SELECT 1 AS x FROM spawn WHERE handle = ?").get(h)
      || db.prepare("SELECT 1 AS x FROM lease WHERE handle = ?").get(h)
      || edb.prepare("SELECT 1 AS x FROM episode WHERE handle = ?").get(h);
    if (!taken) return h;
  }
  throw new Error("handoff: could not mint a unique handle");
}

function leaseByHandle(db, handle) {
  return db.prepare("SELECT * FROM lease WHERE handle = ?").get(handle) ?? null;
}

function spawnByHandle(db, handle) {
  return db.prepare("SELECT * FROM spawn WHERE handle = ?").get(handle) ?? null;
}

function episodeByHandle(edb, handle) {
  return edb.prepare("SELECT rowid, * FROM episode WHERE handle = ?").get(handle) ?? null;
}

function leaseByJob(db, job) {
  return db.prepare("SELECT * FROM lease WHERE job = ?").get(job) ?? null;
}

/** True when THIS attempt's ticket is still live. Pre-handle rows key off the job's current lease. */
function attemptLive(db, ep, at) {
  if (ep.handle) return lease.isLive(leaseByHandle(db, ep.handle), at);
  if (!ep.job) return false;
  return lease.isLive(leaseByJob(db, ep.job), at);
}

/**
 * Per-vault sqlite adapter. Instances are cheap; VaultStorePort owns the database handles.
 *
 * Extra methods (liveSpawns, observe, listSpawns, handleFromLegacy) are for the tool layer's
 * remaining spawn-status path. They are not HandoffPort members.
 */
export function createSqliteHandoff({ db, edb, epoch }) {
  if (!db || !edb) throw new Error("createSqliteHandoff: db and edb are required");
  if (!epoch) throw new Error("createSqliteHandoff: epoch is required");

  const adapter = {
    id: "sqlite",
    label: "SQLite lease + spawn + episode",

    claim({ job, agent = null, task, hub = null, ttlMs, statusFile = null, now } = {}) {
      if (!job) return { refused: "held", reason: "missing-job", job: null };
      if (!task || !String(task).trim()) throw new Error("HandoffPort.claim: task is required");
      const at = now ?? lease.dbNow(db);
      this.sweep({ now: at });

      const prior = episodes.lastForJob(edb, job);
      const priorRun = prior && prior.outcome !== "open"
        ? {
          outcome: prior.outcome,
          summary: prior.summary,
          endedAt: prior.endedAt,
          refs: prior.refs,
          hint: "This job ran before. Read the summary before repeating it — if the work still needs doing, carry on.",
        }
        : null;

      const owner = randomUUID();
      const handle = mintUnique(db, edb);
      const acq = lease.acquire(db, job, owner, ttlMs, at, { handle });
      if (!acq.ok) {
        return { refused: "held", reason: acq.reason, holder: acq.holder ?? null, job };
      }

      const spawnId = randomUUID();
      registry.record(
        db,
        { spawnId, job, owner, epoch, token: acq.token, statusFile, task, handle },
        at,
      );
      episodes.open(
        edb,
        { agent, job, spawnId, task, hub, handle },
        at,
      );
      return {
        handle,
        spawnId,
        owner,
        token: acq.token,
        ...(priorRun ? { priorRun } : {}),
      };
    },

    renew({ handle, now } = {}) {
      const parsed = parseHandle(handle);
      if (!parsed.ok) return { refused: "invalid-handle" };
      const h = parsed.handle;
      const row = leaseByHandle(db, h);
      const spawn = spawnByHandle(db, h);
      if (!row && !spawn) return { refused: "unknown-handle" };
      const job = row?.job ?? spawn?.job;
      const owner = row?.owner ?? spawn?.owner;
      const token = row?.token ?? spawn?.token;
      const r = lease.renew(db, job, owner, token, now);
      if (!r.ok) return { refused: "superseded" };
      return { ok: true };
    },

    close({ handle, outcome = "done", summary = null, refs = null, now } = {}) {
      const parsed = parseHandle(handle);
      if (!parsed.ok) return { refused: "invalid-handle" };
      const h = parsed.handle;
      const at = now ?? lease.dbNow(db);
      const spawn = spawnByHandle(db, h);
      const ep = episodeByHandle(edb, h);
      if (!spawn && !ep) return { refused: "unknown-handle" };

      const job = spawn?.job ?? ep?.job;
      const current = job ? leaseByJob(db, job) : null;
      if (current && current.handle && current.handle !== h) return { refused: "superseded" };
      if (current && spawn && current.token != null && spawn.token != null && current.token !== spawn.token) {
        return { refused: "superseded" };
      }

      if (ep && ep.outcome !== "open") return { refused: "already-closed" };

      const finalOutcome = outcome && outcome !== "open" ? outcome : "done";

      // Logbook first so a crash after this still has the summary; sweep heals the other order.
      if (ep) {
        episodes.close(
          edb,
          { episodeId: ep.episode_id, outcome: finalOutcome, summary, refs },
          at,
        );
      }
      if (spawn) {
        const state = finalOutcome === "failed" ? "failed" : "done";
        registry.markState(db, spawn.spawn_id, state, at);
      }
      if (current && (!current.handle || current.handle === h)) {
        lease.release(db, current.job, current.owner, current.token);
      }
      return { closed: true, outcome: finalOutcome };
    },

    sweep({ now } = {}) {
      const at = now ?? lease.dbNow(db);
      const open = edb.prepare("SELECT * FROM episode WHERE outcome = 'open'").all();
      const closed = [];
      for (const ep of open) {
        if (attemptLive(db, ep, at)) continue;
        episodes.close(
          edb,
          { episodeId: ep.episode_id, outcome: "ended-unknown", summary: ep.summary },
          at,
        );
        closed.push({ job: ep.job, handle: ep.handle ?? null, outcome: "ended-unknown" });
      }
      return closed;
    },

    openHandoffs({ now } = {}) {
      const at = now ?? lease.dbNow(db);
      const rows = edb.prepare("SELECT * FROM episode WHERE outcome = 'open' ORDER BY started_at").all();
      return rows.map((ep) => {
        const ticket = ep.handle ? leaseByHandle(db, ep.handle) : (ep.job ? leaseByJob(db, ep.job) : null);
        const expiresAt = ticket ? ticket.renewed_at + ticket.ttl_ms : null;
        return {
          job: ep.job,
          agent: ep.agent,
          handle: ep.handle ?? null,
          startedAt: ep.started_at,
          expiresAt,
          age: at - ep.started_at,
        };
      });
    },

    // ── extras for the tool layer (not HandoffPort) ──────────────────────────

    liveSpawns({ now } = {}) {
      const at = now ?? lease.dbNow(db);
      return registry.listByState(db, "running").filter((s) => lease.isLive(leaseByJob(db, s.job), at));
    },

    attachStatusFile({ handle, statusFile }) {
      const parsed = parseHandle(handle);
      if (!parsed.ok || !statusFile) return { ok: false };
      const r = db.prepare("UPDATE spawn SET status_file = ? WHERE handle = ?").run(statusFile, parsed.handle);
      return { ok: r.changes > 0 };
    },

    handleFromLegacy({ job, owner, token, spawnId, episodeId } = {}) {
      if (spawnId) {
        const s = registry.get(db, spawnId);
        if (s?.handle) return s.handle;
      }
      if (job != null && owner != null && token != null) {
        const s = db.prepare(
          "SELECT handle FROM spawn WHERE job = ? AND owner = ? AND token = ? ORDER BY created_at DESC LIMIT 1",
        ).get(job, owner, token);
        if (s?.handle) return s.handle;
        const l = db.prepare(
          "SELECT handle FROM lease WHERE job = ? AND owner = ? AND token = ?",
        ).get(job, owner, token);
        if (l?.handle) return l.handle;
      }
      if (job) {
        const s = db.prepare(
          "SELECT handle FROM spawn WHERE job = ? ORDER BY created_at DESC LIMIT 1",
        ).get(job);
        if (s?.handle) return s.handle;
      }
      if (episodeId) {
        const e = edb.prepare("SELECT handle FROM episode WHERE episode_id = ?").get(episodeId);
        if (e?.handle) return e.handle;
      }
      return null;
    },

    observe({ spawnId, job, handle, now, persist = true } = {}) {
      const at = now ?? lease.dbNow(db);
      let spawn = null;
      if (handle) {
        const parsed = parseHandle(handle);
        if (!parsed.ok) return { error: "invalid-handle" };
        spawn = spawnByHandle(db, parsed.handle);
      } else if (spawnId) {
        spawn = registry.get(db, spawnId);
      } else if (job) {
        spawn = db.prepare("SELECT * FROM spawn WHERE job = ? ORDER BY created_at DESC LIMIT 1").get(job) ?? null;
      }
      if (!spawn) return { error: "unknown-spawn", spawnId: spawnId ?? null, job: job ?? null };

      const leaseLive = lease.isLive(leaseByJob(db, spawn.job), at);
      const raw = spawn.status_file && existsSync(spawn.status_file)
        ? readFileSync(spawn.status_file, "utf8")
        : "";
      const parsed = parseStatus(raw, Date.now());
      const verdict = classify({ registryState: spawn.state, leaseLive, ...parsed });
      const via = spawn.status_file ? "detached (synapse)" : "harness-native (yours)";

      if (persist) {
        if ((verdict.state === "alive" || verdict.state === "waiting") && spawn.token != null) {
          lease.renew(db, spawn.job, spawn.owner, spawn.token, now);
        }
        if (verdict.state === "done" || verdict.state === "failed") {
          registry.markState(db, spawn.spawn_id, verdict.state, at);
        } else if (verdict.state === "orphaned") {
          registry.markState(db, spawn.spawn_id, "orphaned", at);
        }
      }
      return { spawnId: spawn.spawn_id, job: spawn.job, handle: spawn.handle ?? null, via, leaseLive, ...verdict };
    },

    listSpawns() {
      const running = registry.listByState(db, "running").map((s) => {
        const facts = this.observe({ spawnId: s.spawn_id, persist: false });
        return { spawnId: s.spawn_id, job: s.job, cli: undefined, ...facts };
      });
      const stale = registry.staleSpawns(db, epoch).map((s) => {
        const facts = this.observe({ spawnId: s.spawn_id, persist: false });
        return { spawnId: s.spawn_id, job: s.job, ...facts };
      });
      return { epoch, running, staleFromPriorBoot: stale };
    },
  };

  return HandoffPort.register(adapter);
}
