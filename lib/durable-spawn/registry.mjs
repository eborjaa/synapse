// durable-spawn / registry.mjs
//
// Durable record of every spawned doer, so a RESTARTED orchestrator can
// reconcile in-flight jobs instead of losing them. M0 established that the only
// window where a doer's death goes unsignalled is when the *orchestrator itself*
// dies/restarts (the pending task-notification is in-memory to that session).
// This table is what survives that restart.
//
// Reconciliation is keyed on a per-boot EPOCH, not on the owner/session id: a
// restarted orchestrator may reuse its session id, so keying on owner alone
// would filter its own pre-crash spawns out of reconciliation (the exact leak
// this table exists to prevent). PRECONDITION: `epoch` MUST be a strong unique
// id minted fresh each boot (a UUID / crypto-random string) — NOT a low-res
// clock like timestamp-seconds, or a fast restart could mint the SAME epoch as
// its pre-crash incarnation and again filter its own dangling spawns out.
// Spawns from any other epoch are "stale" and must be reconciled.
//
// Shares the same DB file as lease.mjs (same process-crossing guarantees).

/** Create the spawn table on an already-open durable-spawn DB (see lease.openDb). */
export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS spawn(
    spawn_id     TEXT PRIMARY KEY,
    job          TEXT NOT NULL,
    owner        TEXT NOT NULL,
    epoch        TEXT NOT NULL,       -- per-boot id of the orchestrator that spawned this
    token        INTEGER,
    status_file  TEXT,
    task         TEXT,                 -- the doer's task text, for the semantic same-task pre-check
    handle       TEXT,                 -- checksummed handoff handle (decision-0019)
    state        TEXT NOT NULL,       -- running | done | failed | orphaned
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );`);
  // Forward-compat: a spawn table created before `task` / `handle` existed gets the column added.
  try { db.exec("ALTER TABLE spawn ADD COLUMN task TEXT;"); } catch { /* already present */ }
  try { db.exec("ALTER TABLE spawn ADD COLUMN handle TEXT;"); } catch { /* already present */ }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS spawn_handle ON spawn(handle) WHERE handle IS NOT NULL;");
  db.exec("CREATE INDEX IF NOT EXISTS spawn_state ON spawn(state);");
  db.exec("CREATE INDEX IF NOT EXISTS spawn_epoch ON spawn(epoch);");
  return db;
}

const TERMINAL = new Set(["done", "failed", "orphaned"]);

/** Record a freshly-spawned doer as `running`, stamped with the current boot epoch. */
export function record(db, { spawnId, job, owner, epoch, token, statusFile, task, handle }, now) {
  if (!epoch) throw new Error("record: epoch is required (per-boot id)");
  db.prepare(
    `INSERT INTO spawn(spawn_id, job, owner, epoch, token, status_file, task, handle, state, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?, 'running', ?, ?)
     ON CONFLICT(spawn_id) DO UPDATE SET
       job=excluded.job, owner=excluded.owner, epoch=excluded.epoch,
       token=excluded.token, status_file=excluded.status_file, task=excluded.task,
       handle=excluded.handle,
       state='running', updated_at=excluded.updated_at
     WHERE spawn.state = 'running'`, // never resurrect a terminal spawn
  ).run(spawnId, job, owner, epoch, token ?? null, statusFile ?? null, task ?? null, handle ?? null, now, now);
}

/** Transition a spawn's state. A terminal spawn (done/failed/orphaned) can never
 *  go back to running. Returns {ok} / {ok:false, reason}. */
export function markState(db, spawnId, state, now) {
  if (!TERMINAL.has(state) && state !== "running")
    return { ok: false, reason: "bad-state" };
  const cur = db.prepare("SELECT state FROM spawn WHERE spawn_id=?").get(spawnId);
  if (!cur) return { ok: false, reason: "unknown-spawn" };
  if (TERMINAL.has(cur.state) && state === "running")
    return { ok: false, reason: "terminal-locked" };
  db.prepare("UPDATE spawn SET state=?, updated_at=? WHERE spawn_id=?").run(state, now, spawnId);
  return { ok: true };
}

export function get(db, spawnId) {
  return db.prepare("SELECT * FROM spawn WHERE spawn_id=?").get(spawnId) ?? null;
}

export function listByState(db, state) {
  return db.prepare("SELECT * FROM spawn WHERE state=? ORDER BY created_at").all(state);
}

/**
 * Restart reconciliation. Given the CURRENT boot epoch, return every still-
 * `running` spawn stamped with a DIFFERENT epoch — i.e. spawns left dangling by
 * a previous orchestrator incarnation (even if it reused the same session/owner
 * id). The caller then decides per spawn: re-read its result artifact if it
 * finished, else let the lease TTL lapse and re-lease (fencing keeps a late
 * zombie safe). This function only *identifies* them; it does not guess fate.
 */
export function staleSpawns(db, currentEpoch) {
  return db
    .prepare("SELECT * FROM spawn WHERE state='running' AND epoch != ? ORDER BY created_at")
    .all(currentEpoch);
}
