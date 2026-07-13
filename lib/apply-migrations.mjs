#!/usr/bin/env node
// apply-migrations.mjs — apply forward-only SQL migrations to db/synapse.db (the records substrate).
//   synapse migrate            # apply pending migrations (read-write)
//   synapse migrate --status   # list applied / pending, apply nothing
//
// Migrations (migrations/NNNN-*.sql) are the DB's source of truth and audit log. Forward-only: never edit
// or delete an applied migration — add a compensating one. Idempotent: only files not in _migrations run.
// This is the ONLY writer of canonical records; the query path opens the DB read-only.

import { readdirSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveVault } from "./vault-root.mjs";

const { vaultDir: ROOT } = resolveVault({ readManifest: false });
const MIG_DIR = join(ROOT, "migrations");
const DB_DIR = join(ROOT, "db");
const DB_PATH = join(DB_DIR, "synapse.db");
const statusOnly = process.argv.includes("--status");

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON;");
db.exec("CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL);");

const applied = new Set(db.prepare("SELECT filename FROM _migrations").all().map((r) => r.filename));
const files = existsSync(MIG_DIR) ? readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort() : [];
const pending = files.filter((f) => !applied.has(f));

if (statusOnly) {
  console.log(`[migrations] ${applied.size} applied, ${pending.length} pending`);
  for (const f of files) console.log(`  ${applied.has(f) ? "✓" : "·"} ${f}`);
  process.exit(0);
}

if (!pending.length) { console.log("[migrations] up to date — nothing to apply"); process.exit(0); }

const record = db.prepare("INSERT INTO _migrations (filename, applied_at) VALUES (?, datetime('now'))");
for (const f of pending) {
  const sql = readFileSync(join(MIG_DIR, f), "utf8");
  try {
    db.exec("BEGIN");
    db.exec(sql);
    record.run(f);
    db.exec("COMMIT");
    console.log(`[migrations] applied ${f}`);
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    console.error(`[migrations] FAILED on ${f} — rolled back. ${e.message}`);
    process.exit(1);
  }
}
console.log(`[migrations] done — ${pending.length} applied`);
