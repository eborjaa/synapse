// durable-spawn / episodes.mjs — EPISODIC MEMORY: what agents actually did.
//
// Synapse has procedural memory (agents, rules, skills — how to act) and semantic memory (notes +
// embeddings — what is true). It has had NO record of what already HAPPENED. Every session starts
// amnesiac: a lead re-plans work a doer finished yesterday, and the only cure was a human writing a
// handover note by hand.
//
// This is that third store. Design constraints that shaped it:
//
//   1. WRITTEN BY TOOLS THE AGENT ALREADY MUST CALL. An episode opens inside `synapse_claim_and_brief`
//      and closes inside `synapse_spawn_release` — the two calls a delegation cannot skip, because the
//      briefing is only obtainable through the claim. Memory that depends on an agent REMEMBERING to
//      record something is the same discipline problem that makes agents drift; this one cannot be
//      forgotten without also failing to get a briefing.
//
//   2. PRIMARY DATA, NOT A CACHE. It lives in the durable-spawn DB (alongside leases and the spawn
//      registry — same file, same crash guarantees), NEVER in db/synapse.db, which is a rebuildable
//      embeddings cache that any `synapse embeddings --all` may discard.
//
//   3. KEYWORD RETRIEVAL (FTS5), NOT EMBEDDINGS. Episodes are short, recent, and full of exact tokens
//      that matter — ticket ids, branch names, spec paths. Keyword search finds "REL-38837" reliably;
//      cosine similarity does not. It also works offline, with no Ollama and no index to keep fresh.
//      `searchEpisodes` is structured so an embedding ranker can be fused in later.
//
//   4. FACTUAL, NOT NORMATIVE. An episode records what happened, so it needs no human review gate —
//      unlike an authored note, which synapse deliberately proposes rather than writes.
import { randomUUID } from "node:crypto";
import { dbNow } from "./lease.mjs";

/** Create the episode tables on an already-open durable-spawn DB (see lease.openDb). */
export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS episode(
    episode_id  TEXT PRIMARY KEY,
    agent       TEXT,                 -- who did it (agent id, or null for a human/unknown caller)
    job         TEXT,                 -- canonical job id — ties an episode to its lease + spawn
    spawn_id    TEXT,                 -- set when the episode came from a spawn/claim
    task        TEXT NOT NULL,        -- what was asked, verbatim
    hub         TEXT,                 -- the domain it happened in
    branch      TEXT,                 -- repo/vault branch, when the caller knows it
    outcome     TEXT,                 -- open | done | failed | abandoned
    summary     TEXT,                 -- what actually happened (the part a future agent needs)
    refs        TEXT,                 -- JSON array of ids/urls/paths produced or touched
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER
  );`);
  db.exec("CREATE INDEX IF NOT EXISTS episode_job ON episode(job);");
  db.exec("CREATE INDEX IF NOT EXISTS episode_outcome ON episode(outcome);");
  db.exec("CREATE INDEX IF NOT EXISTS episode_started ON episode(started_at);");
  // Contentless-external FTS: the episode row stays the single source of truth; the index is a
  // projection kept in step by the writers below. Rebuildable with reindex() if it ever drifts.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(
    task, summary, refs, agent, hub, job, content='episode', content_rowid='rowid'
  );`);
  return db;
}

const FTS_COLS = "(rowid, task, summary, refs, agent, hub, job)";

function ftsInsert(db, rowid, r) {
  db.prepare(`INSERT INTO episode_fts ${FTS_COLS} VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(rowid, r.task ?? "", r.summary ?? "", r.refs ?? "", r.agent ?? "", r.hub ?? "", r.job ?? "");
}

function ftsDelete(db, rowid, r) {
  db.prepare(`INSERT INTO episode_fts (episode_fts, rowid, task, summary, refs, agent, hub, job) `
    + `VALUES ('delete', ?, ?, ?, ?, ?, ?, ?)`)
    .run(rowid, r.task ?? "", r.summary ?? "", r.refs ?? "", r.agent ?? "", r.hub ?? "", r.job ?? "");
}

const rowOf = (db, id) => db.prepare("SELECT rowid, * FROM episode WHERE episode_id = ?").get(id);

/**
 * Start an episode. Called when work is CLAIMED, not when it finishes — so an episode exists even for
 * work that dies mid-flight, which is exactly the case a future agent most needs to know about.
 */
export function open(db, { agent = null, job = null, spawnId = null, task, hub = null, branch = null }, now) {
  if (!task || !String(task).trim()) throw new Error("episodes.open: task is required");
  const at = now ?? dbNow(db);
  const episodeId = randomUUID();
  db.prepare(
    `INSERT INTO episode (episode_id, agent, job, spawn_id, task, hub, branch, outcome, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).run(episodeId, agent, job, spawnId, String(task), hub, branch, at);
  const r = rowOf(db, episodeId);
  ftsInsert(db, r.rowid, r);
  return { episodeId, startedAt: at };
}

/**
 * Finish an episode. `summary` is the whole point — an episode with no summary records that something
 * happened without recording what, which is the failure mode of every automatic activity log.
 * Idempotent: closing an already-closed episode updates it rather than erroring, since a doer's own
 * terminal line and its orchestrator's release can both arrive.
 */
export function close(db, { episodeId = null, job = null, outcome = "done", summary = null, refs = null }, now) {
  const at = now ?? dbNow(db);
  const target = episodeId
    ? rowOf(db, episodeId)
    : db.prepare("SELECT rowid, * FROM episode WHERE job = ? ORDER BY started_at DESC LIMIT 1").get(job);
  if (!target) return { ok: false, reason: "no-such-episode" };

  ftsDelete(db, target.rowid, target);
  const refsJson = refs == null ? target.refs : JSON.stringify(Array.isArray(refs) ? refs : [refs]);
  db.prepare("UPDATE episode SET outcome = ?, summary = COALESCE(?, summary), refs = ?, ended_at = ? WHERE rowid = ?")
    .run(outcome, summary, refsJson, at, target.rowid);
  const after = db.prepare("SELECT rowid, * FROM episode WHERE rowid = ?").get(target.rowid);
  ftsInsert(db, after.rowid, after);
  return { ok: true, episodeId: after.episode_id, outcome, endedAt: at };
}

/** Record something already finished, in one call — the escape hatch for work no spawn wrapped. */
export function log(db, { agent = null, job = null, task, hub = null, branch = null, outcome = "done", summary = null, refs = null }, now) {
  const at = now ?? dbNow(db);
  const { episodeId } = open(db, { agent, job, task, hub, branch }, at);
  close(db, { episodeId, outcome, summary, refs }, at);
  return { episodeId, at };
}

/** FTS5 needs a bare-token query; user text with punctuation is a syntax error, not a no-match. */
function ftsQuery(text) {
  const toks = String(text).toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || [];
  return toks.length ? toks.map((t) => `"${t}"`).join(" OR ") : null;
}

/**
 * Recall episodes. `query` is keyword-matched over task/summary/refs; the rest are exact filters.
 * Ranked by FTS relevance, then recency. Returns [] rather than throwing on a malformed query — a
 * memory lookup must never be the thing that fails a turn.
 */
export function searchEpisodes(db, { query = null, agent = null, hub = null, job = null, outcome = null, since = null, limit = 10 } = {}) {
  const where = [];
  const args = [];
  if (agent) { where.push("e.agent = ?"); args.push(agent); }
  if (hub) { where.push("e.hub = ?"); args.push(hub); }
  if (job) { where.push("e.job = ?"); args.push(job); }
  if (outcome) { where.push("e.outcome = ?"); args.push(outcome); }
  if (since) { where.push("e.started_at >= ?"); args.push(since); }

  const q = query ? ftsQuery(query) : null;
  let sql;
  if (q) {
    sql = `SELECT e.*, bm25(episode_fts) AS rank FROM episode_fts
           JOIN episode e ON e.rowid = episode_fts.rowid
           WHERE episode_fts MATCH ?${where.length ? ` AND ${where.join(" AND ")}` : ""}
           ORDER BY rank ASC, e.started_at DESC LIMIT ?`;
    args.unshift(q);
  } else {
    sql = `SELECT e.*, NULL AS rank FROM episode e
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY e.started_at DESC LIMIT ?`;
  }
  args.push(Math.max(1, Math.min(100, limit)));
  try { return db.prepare(sql).all(...args).map(shape); } catch { return []; }
}

/** The most recent episode for a job — "has this exact work been done before?" */
export function lastForJob(db, job) {
  const r = db.prepare("SELECT * FROM episode WHERE job = ? ORDER BY started_at DESC LIMIT 1").get(job);
  return r ? shape(r) : null;
}

function shape(r) {
  let refs = [];
  try { refs = r.refs ? JSON.parse(r.refs) : []; } catch { refs = []; }
  return {
    episodeId: r.episode_id, agent: r.agent, job: r.job, spawnId: r.spawn_id,
    task: r.task, hub: r.hub, branch: r.branch, outcome: r.outcome, summary: r.summary,
    refs, startedAt: r.started_at, endedAt: r.ended_at,
  };
}

/** Rebuild the FTS projection from the episode table (recovery only; writers keep it in step). */
export function reindex(db) {
  db.exec("INSERT INTO episode_fts(episode_fts) VALUES('delete-all');");
  for (const r of db.prepare("SELECT rowid, * FROM episode").all()) ftsInsert(db, r.rowid, r);
  return db.prepare("SELECT COUNT(*) AS c FROM episode").get().c;
}
