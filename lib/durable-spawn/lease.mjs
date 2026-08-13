// durable-spawn / lease.mjs
//
// Dedup lease + fencing tokens — the enforced safety from the RCA fix: it makes
// a duplicate/zombie doer *harmless*, not merely improbable.
//
// Cross-process: the orchestrator and its doers are separate OS processes on one
// host sharing one SQLite DB. `BEGIN IMMEDIATE` gives single-writer atomicity;
// WAL + busy_timeout make concurrent openers wait rather than error.
//
// Preconditions a correct caller MUST honour (each learned from a review that
// broke the naive version):
//   • `owner` is a per-DOER-INSTANCE unique id, minted fresh on every dispatch —
//     NEVER the orchestrator's stable session id or the job id. A live lease is
//     refused for ANY owner; the holder extends only via renew() (which requires
//     the token). This is why a re-dispatch cannot admit a second live writer.
//   • Time comes from the DB, not the caller. acquire/renew/validateFence take an
//     OPTIONAL `now` for tests only; in production OMIT it so time is read from
//     the shared DB (dbNow), never from a possibly-frozen zombie's own clock.
//     Residual honesty: a whole-VM freeze stops every process incl. its DB
//     queries, so the clock-independent TOKEN check is the primary guarantee
//     (it rejects any writer once a takeover has minted a higher token); the
//     liveness check is defense-in-depth for the pre-takeover expiry gap.
//   • A thrown exception (e.g. SQLITE_BUSY past busy_timeout) means NOT acquired
//     / NOT valid — treat it as failure (fail-closed), never as success.

import { DatabaseSync } from "node:sqlite";

/** Open (and migrate) a durable-spawn DB. Safe to call from every process. */
export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`CREATE TABLE IF NOT EXISTS lease(
    job         TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    token       INTEGER NOT NULL,
    ttl_ms      INTEGER NOT NULL,
    renewed_at  INTEGER NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS fence(
    id   INTEGER PRIMARY KEY CHECK (id = 0),
    next INTEGER NOT NULL
  );`);
  db.exec("INSERT OR IGNORE INTO fence(id, next) VALUES (0, 1);");
  return db;
}

/** Milliseconds since epoch, read from the shared DB — the single time
 *  authority. Never trust a process's own wall clock for a liveness decision. */
export function dbNow(db) {
  return db.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS ms").get().ms;
}

/** A lease is live iff it has not passed its TTL relative to `now` (ms epoch). */
export function isLive(lease, now) {
  return !!lease && lease.renewed_at + lease.ttl_ms > now;
}

function mintToken(db) {
  const { next } = db.prepare("SELECT next FROM fence WHERE id = 0").get();
  db.prepare("UPDATE fence SET next = next + 1 WHERE id = 0").run();
  return next;
}

/**
 * Acquire the lease for `job`. A LIVE lease is refused for ANY owner (the dedup
 * gate — no second doer for the same logical job, and no same-owner re-admit
 * that would hand a duplicate a valid token). An expired/absent lease is taken
 * with a fresh, strictly-higher token. Extend a held lease with renew(), not
 * acquire(). Returns {ok:true, token} | {ok:false, reason:"held"|"bad-ttl"}.
 */
export function acquire(db, job, owner, ttlMs, now) {
  if (!(ttlMs > 0)) return { ok: false, reason: "bad-ttl" };
  db.exec("BEGIN IMMEDIATE");
  try {
    const at = now ?? dbNow(db);
    const cur = db
      .prepare("SELECT owner, token, ttl_ms, renewed_at FROM lease WHERE job = ?")
      .get(job);
    if (isLive(cur, at)) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "held", holder: cur.owner, token: cur.token };
    }
    const token = mintToken(db);
    db.prepare(
      `INSERT INTO lease(job, owner, token, ttl_ms, renewed_at) VALUES (?,?,?,?,?)
       ON CONFLICT(job) DO UPDATE SET
         owner = excluded.owner, token = excluded.token,
         ttl_ms = excluded.ttl_ms, renewed_at = excluded.renewed_at`,
    ).run(job, owner, token, ttlMs, at);
    db.exec("COMMIT");
    return { ok: true, token };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

/** Extend the lease. Succeeds only if (owner, token) match AND it is still live
 *  — an expired lease must be re-taken through acquire()'s dedup gate, never
 *  silently revived. {ok} | {ok:false, reason:"lost"|"expired"}. */
export function renew(db, job, owner, token, now) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const at = now ?? dbNow(db);
    const cur = db
      .prepare("SELECT owner, token, ttl_ms, renewed_at FROM lease WHERE job = ?")
      .get(job);
    if (!cur || cur.owner !== owner || cur.token !== token) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "lost" };
    }
    if (!isLive(cur, at)) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "expired" };
    }
    db.prepare("UPDATE lease SET renewed_at = ? WHERE job = ?").run(at, job);
    db.exec("COMMIT");
    return { ok: true };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

/** Release the lease (only the current holder can). */
export function release(db, job, owner, token) {
  const r = db
    .prepare("DELETE FROM lease WHERE job = ? AND owner = ? AND token = ?")
    .run(job, owner, token);
  return { ok: r.changes > 0 };
}

/**
 * Write-path guard. Allowed only if `token` is the CURRENT lease token AND that
 * lease is still live. A stale token means a re-lease happened (rejected); a
 * current token on an expired lease means the holder is presumed dead and must
 * re-acquire (rejected). `now` defaults to the DB clock — do not pass a caller
 * clock in production. NOTE: this is a check; for a SAME-DB resource, use
 * withFence() so the check and the mutation are one transaction (no TOCTOU).
 * For an EXTERNAL resource the fence↔write gap is best-effort against the large
 * pre-takeover window; the token check remains authoritative post-takeover.
 */
export function validateFence(db, job, token, now) {
  const cur = db
    .prepare("SELECT token, ttl_ms, renewed_at FROM lease WHERE job = ?")
    .get(job);
  if (!cur) return { ok: false, reason: "no-lease" };
  if (cur.token !== token)
    return { ok: false, reason: "stale-token", current: cur.token, presented: token };
  if (!isLive(cur, now ?? dbNow(db))) return { ok: false, reason: "lease-expired" };
  return { ok: true };
}

/**
 * Atomically fence-check and mutate a SAME-DB resource: runs `mutate(db)` only
 * if the fence is valid, inside one BEGIN IMMEDIATE, so no takeover can slip
 * between the check and the write (closes the fencing TOCTOU for same-DB state).
 * Returns {ok:true, result} or the validateFence failure. `mutate` runs inside
 * the open transaction; if it throws, the whole thing rolls back.
 */
export function withFence(db, job, token, mutate, now) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const v = validateFence(db, job, token, now ?? dbNow(db));
    if (!v.ok) {
      db.exec("ROLLBACK");
      return v;
    }
    const result = mutate(db);
    db.exec("COMMIT");
    return { ok: true, result };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}
