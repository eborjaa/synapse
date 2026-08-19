#!/usr/bin/env node
// index-freshness.mjs — is the embeddings index current with the corpus, and refresh it when it isn't.
//
//   synapse embeddings-status [--json] [--refresh] [--force]
//
// The problem this fixes: a MISSING index is loud (augment.mjs prints a skip note), but a STALE one is
// silent — recall quietly ranks against the vault as it was, and nothing says so. This module supplies
// the missing signal plus a self-healing refresh, modelled on the REL vault's launcher-side auto-refresh
// (rel-context _meta/harness/lib.mjs, Javier 2026-07-08) and hardened for a multi-agent fleet.
//
// TWO-TIER staleness, because exactness is not free:
//   Tier 1 (~25ms, stat only): newest corpus mtime vs MAX(mtime) stored in note_vectors. If no file is
//     newer than the newest indexed note, we are done.
//   Tier 2 (~400ms, reads frontmatter): per-note comparison against the stored (mtime, model) — the same
//     predicate gen-embeddings uses to decide what to re-embed. Yields an EXACT count.
//
// Why compare against the stored mtimes rather than the DB FILE's mtime (which is what the REL launcher
// does): gen-embeddings is incremental, so a run with nothing to do writes nothing and the DB file's
// mtime never advances — leaving "stale" true forever and re-refreshing on every launch. REL patches
// that by touching the DB file afterwards. Comparing stored mtimes needs no such patch: after any run,
// indexed == corpus by construction.
//
// The one case tier 1 gets wrong: the newest `.md` is an UNTYPED file (a README), which gen-embeddings
// never indexes, so the stored max can never catch up. Tier 2 resolves it to "0 notes behind", and the
// verdict is cached in db/.embed-check.json so the 400ms is paid once, not on every call.
import { existsSync, statSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveVault } from "./vault-root.mjs";
import { walkNoteFiles, noteSkipSet, maxMtime } from "./note-walk.mjs";
import { parseNote, resolveEmbedModel } from "./gen-embeddings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN = join(HERE, "gen-embeddings.mjs");
const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

// A refresh over a few thousand notes on a local model takes minutes; a lock older than this is assumed
// to belong to a process that died mid-run rather than one still working.
const LOCK_TTL_MS = 30 * 60 * 1000;

// node:sqlite is a Node >=22.5 built-in behind a flag on some versions. Import lazily so an old Node
// degrades to "unknown" instead of crashing the caller (augment must survive this).
let DatabaseSync = null;
let sqliteOk = false;
try { ({ DatabaseSync } = await import("node:sqlite")); sqliteOk = true; } catch { /* reported below */ }

/** Everything path-shaped, resolved once. Exposed so tests can point the whole module at a fixture. */
export function freshnessPaths(v = resolveVault()) {
  const dbDir = join(v.vaultDir, "db");
  return {
    root: v.root,
    vaultDir: v.vaultDir,
    manifest: v.manifest || {},
    label: v.manifest?.logLabel || "synapse",
    dbPath: join(dbDir, "synapse.db"),
    lockDir: join(dbDir, ".embed.lock"),
    markerPath: join(dbDir, ".embed-check.json"),
  };
}

// ===================================================================== status

/**
 * @returns {{
 *   ok: boolean, present: boolean, stale: boolean, staleCount: number|null, precise: boolean,
 *   rows: number, model: string|null, corpusNotes: number, corpusMaxMtime: string|null,
 *   newestPath: string|null, storedMaxMtime: string|null, dbPath: string, reason: string
 * }}
 * Never throws: any failure resolves to a described, non-stale status so a caller cannot be blocked by
 * the freshness check itself.
 */
export function embeddingsStatus({ paths = freshnessPaths(), precise = true } = {}) {
  const base = {
    ok: true, present: false, stale: false, staleCount: null, precise: false,
    rows: 0, model: null, corpusNotes: 0, corpusMaxMtime: null, newestPath: null,
    storedMaxMtime: null, dbPath: paths.dbPath, reason: "",
  };

  if (!sqliteOk) {
    return { ...base, ok: false, reason: "node:sqlite unavailable — needs Node >= 22.5" };
  }

  const files = walkNoteFiles(paths.root, noteSkipSet(paths.manifest));
  const newest = maxMtime(files);
  base.corpusNotes = files.length;
  base.corpusMaxMtime = newest.ms ? new Date(newest.ms).toISOString() : null;
  base.newestPath = newest.path;

  if (!existsSync(paths.dbPath)) {
    return {
      ...base, present: false, stale: true, staleCount: files.length, precise: true,
      reason: "index absent — semantic recall is OFF until `synapse embeddings` runs",
    };
  }

  let rows = 0, storedMax = null, model = null, stored = null;
  try {
    const db = new DatabaseSync(paths.dbPath, { readOnly: true });
    const has = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='note_vectors'`,
    ).get();
    if (!has) {
      db.close();
      return {
        ...base, present: false, stale: true, staleCount: files.length, precise: true,
        reason: "note_vectors table absent — run `synapse embeddings`",
      };
    }
    rows = db.prepare(`SELECT COUNT(*) AS c FROM note_vectors`).get().c;
    storedMax = db.prepare(`SELECT MAX(mtime) AS m FROM note_vectors`).get().m ?? null;
    model = db.prepare(
      `SELECT model, COUNT(*) AS c FROM note_vectors GROUP BY model ORDER BY c DESC LIMIT 1`,
    ).get()?.model ?? null;
    if (precise) {
      stored = new Map();
      for (const r of db.prepare(`SELECT id, mtime, model FROM note_vectors`).all()) {
        stored.set(r.id, { mtime: r.mtime, model: r.model });
      }
    }
    db.close();
  } catch (e) {
    return { ...base, ok: false, reason: `could not read note_vectors (${e.message})` };
  }

  base.present = true;
  base.rows = rows;
  base.model = model;
  base.storedMaxMtime = storedMax;

  if (!rows) {
    return {
      ...base, stale: true, staleCount: files.length, precise: true,
      reason: "index is empty — run `synapse embeddings`",
    };
  }

  // ---- tier 1: no file newer than the newest indexed note → provably nothing to do.
  const storedMaxMs = storedMax ? Date.parse(storedMax) : 0;
  if (Number.isFinite(storedMaxMs) && newest.ms <= storedMaxMs) {
    return { ...base, stale: false, staleCount: 0, precise: false, reason: `index is current (${rows} notes)` };
  }

  // ---- cached tier-2 verdict: this exact corpus high-water mark was already cleared.
  if (readMarker(paths.markerPath) === newest.ms) {
    return { ...base, stale: false, staleCount: 0, precise: false, reason: `index is current (${rows} notes, cached check)` };
  }

  if (!precise) {
    return {
      ...base, stale: true, staleCount: null, precise: false,
      reason: `at least one note is newer than the index (newest indexed ${storedMax})`,
    };
  }

  // ---- tier 2: the exact predicate gen-embeddings re-embeds on (missing row, changed mtime, or a
  // different embed model). `stale` here means "gen-embeddings would do work", nothing looser.
  const embedModel = safeEmbedModel();
  let staleCount = 0;
  for (const f of files) {
    let raw, mtime;
    try { raw = readFileSync(f, "utf8"); mtime = statSync(f).mtime.toISOString(); } catch { continue; }
    if (!parseNote(raw).type) continue;                  // untyped files are never indexed
    const prev = stored.get(basename(f, ".md"));
    if (!prev || prev.mtime !== mtime || (embedModel && prev.model !== embedModel)) staleCount++;
  }

  if (!staleCount) {
    // The newest file is untyped (or otherwise not indexable). Remember it so the next caller skips
    // tier 2 entirely; best-effort, a failed write only costs the check again.
    writeMarker(paths.markerPath, newest.ms);
    return { ...base, stale: false, staleCount: 0, precise: true, reason: `index is current (${rows} notes)` };
  }

  return {
    ...base, stale: true, staleCount, precise: true,
    reason: `${staleCount} note(s) added or edited since the index was built`,
  };
}

function safeEmbedModel() {
  try { return resolveEmbedModel(); } catch { return null; }
}

function readMarker(path) {
  try { return JSON.parse(readFileSync(path, "utf8")).clearedCorpusMaxMtimeMs ?? null; } catch { return null; }
}

function writeMarker(path, ms) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ clearedCorpusMaxMtimeMs: ms, at: new Date().toISOString() }), "utf8");
  } catch { /* best-effort cache */ }
}

// ===================================================================== lock
// A cooperative mutex so N standing agents sharing one vault cannot all launch gen-embeddings at once
// (it takes no lock of its own, and concurrent writers to one SQLite file is not a state worth entering).
// mkdir is atomic on every filesystem we care about; the loser skips and uses the index that exists.

export function acquireEmbedLock(lockDir, { ttlMs = LOCK_TTL_MS, now = Date.now() } = {}) {
  try {
    mkdirSync(lockDir, { recursive: false });
    try { writeFileSync(join(lockDir, "owner"), `${process.pid} ${new Date(now).toISOString()}\n`, "utf8"); } catch { /* informational */ }
    return { ok: true, lockDir };
  } catch (e) {
    if (e.code !== "EEXIST") return { ok: false, reason: e.code || "mkdir-failed" };
    let age = 0;
    try { age = now - statSync(lockDir).mtimeMs; } catch { return { ok: false, reason: "held" }; }
    if (age <= ttlMs) return { ok: false, reason: "held", ageMs: age };
    // Expired: the holder died mid-run. Break it and retry ONCE. Two processes can in principle break
    // the same expired lock together — that is the pre-existing (unlocked) behaviour, not a regression.
    try { rmSync(lockDir, { recursive: true, force: true }); mkdirSync(lockDir, { recursive: false }); } catch { return { ok: false, reason: "held" }; }
    return { ok: true, lockDir, brokeStale: true };
  }
}

export function releaseEmbedLock(lockDir) {
  try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ===================================================================== refresh

/**
 * Rebuild the index when (and only when) it is stale. Best-effort by contract: it NEVER throws and never
 * blocks its caller's real work — a missing tool, an old Node, a held lock, or a dead Ollama all resolve
 * to `{refreshed:false, reason}` and the caller proceeds against whatever index exists.
 *
 * gen-embeddings runs as a CHILD PROCESS, which is what lets augment call this without breaking its own
 * "the query path never mutates the DB" invariant.
 */
export function refreshIfStale({
  paths = freshnessPaths(), force = false, all = false, status = null, log = () => {},
} = {}) {
  if (process.env.SYNAPSE_NO_REFRESH && !force) {
    return { refreshed: false, reason: "SYNAPSE_NO_REFRESH is set", status: status || null };
  }
  if (!sqliteOk) return { refreshed: false, reason: "node:sqlite unavailable — needs Node >= 22.5", status: null };
  if (!existsSync(GEN)) return { refreshed: false, reason: "gen-embeddings.mjs not found", status: null };

  const st = status || embeddingsStatus({ paths, precise: true });
  if (!st.stale && !force) return { refreshed: false, reason: "fresh", status: st };

  const lock = acquireEmbedLock(paths.lockDir);
  if (!lock.ok) return { refreshed: false, reason: `another refresh is in progress (${lock.reason})`, status: st };

  const what = st.present ? `${st.staleCount ?? "some"} note(s) behind` : "absent";
  log(`[${paths.label}] embedding index is ${what} — refreshing (incremental)…`);
  try {
    const flags = sqliteOk ? [] : ["--experimental-sqlite"];
    const r = spawnSync(process.execPath, [...flags, GEN, ...(all ? ["--all"] : [])], {
      cwd: paths.root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, SYNAPSE_VAULT: paths.vaultDir },
    });
    const summary = pickSummary(r);
    if (r.status === 0) {
      // The corpus high-water mark is cleared by definition now; cache it so an untyped-newest file
      // does not send the next caller through tier 2 again.
      writeMarker(paths.markerPath, maxMtime(walkNoteFiles(paths.root, noteSkipSet(paths.manifest))).ms);
      log(`[${paths.label}] index refreshed. ${summary}`);
      return { refreshed: true, reason: "refreshed", summary, status: st };
    }
    log(`[${paths.label}] index refresh failed (${summary || `exit ${r.status}`}) — using the existing index.`);
    return { refreshed: false, reason: `refresh failed: ${summary || `exit ${r.status}`}`, status: st };
  } catch (e) {
    return { refreshed: false, reason: `refresh threw: ${e.message}`, status: st };
  } finally {
    releaseEmbedLock(paths.lockDir);
  }
}

/** gen-embeddings' own one-line summary, preferred over a trailing node ExperimentalWarning. */
function pickSummary(r) {
  const lines = `${r.stdout || ""}\n${r.stderr || ""}`.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  return [...lines].reverse().find((l) => l.includes("gen-embeddings")) || lines.pop() || "";
}

/** One human line for a status object — shared by the CLI, augment's in-band note, and the MCP tool. */
export function formatStatus(st) {
  if (!st.ok) return `embeddings: unknown — ${st.reason}`;
  const head = st.stale ? "STALE" : "current";
  return `embeddings: ${head} — ${st.reason} `
    + `(indexed ${st.rows}, corpus ${st.corpusNotes}, model ${st.model || "?"}${st.precise ? "" : ", fast check"})`;
}

// ===================================================================== CLI
if (IS_MAIN) {
  const argv = process.argv.slice(2);
  const paths = freshnessPaths();
  const json = argv.includes("--json");
  const wantRefresh = argv.includes("--refresh") || argv.includes("--force");
  const force = argv.includes("--force");
  const all = argv.includes("--all");

  let st = embeddingsStatus({ paths, precise: !argv.includes("--fast") });
  let refresh = null;
  if (wantRefresh) {
    refresh = refreshIfStale({ paths, force, all, status: force ? null : st, log: (m) => console.error(m) });
    if (refresh.refreshed) st = embeddingsStatus({ paths, precise: true });
  }

  if (json) console.log(JSON.stringify({ ...st, refresh }, null, 2));
  else {
    console.log(formatStatus(st));
    if (st.stale && !refresh?.refreshed) console.log(`  fix: synapse embeddings   (or: synapse embeddings-status --refresh)`);
    if (st.newestPath) console.log(`  newest note: ${st.newestPath}`);
  }
  process.exit(0);
}
