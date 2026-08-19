// index-freshness.test.mjs — staleness detection + the embed lock.
//
//   node --experimental-sqlite --test lib/index-freshness.test.mjs
//
// Hermetic: each test builds a throwaway vault and writes note_vectors rows BY HAND (the same shape
// gen-embeddings writes). No Ollama, no network, no consumer vault.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  embeddingsStatus, refreshIfStale, acquireEmbedLock, releaseEmbedLock, freshnessPaths,
} from "./index-freshness.mjs";

const MODEL = "test-embed-model";
process.env.SYNAPSE_EMBED_MODEL = MODEL;

const MANIFEST = { logLabel: "synapse", vaultRoot: ".", skipDirs: ["inbox"] };

function note(id, type = "note") {
  return `---\nid: ${id}\ntype: ${type}\ntitle: ${id}\n---\nbody of ${id}\n`;
}

/** A vault with `ids` typed notes under notes/, plus whatever `extra` files the test wants. */
function makeVault({ ids = ["note-a", "note-b", "note-c"], extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "syn-fresh-"));
  mkdirSync(join(root, "_meta", "tools"), { recursive: true });
  writeFileSync(join(root, "_meta", "tools", "context.manifest.json"), JSON.stringify(MANIFEST));
  mkdirSync(join(root, "notes"), { recursive: true });
  for (const id of ids) writeFileSync(join(root, "notes", `${id}.md`), note(id));
  for (const [rel, body] of Object.entries(extra)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  const paths = freshnessPaths({ root, vaultDir: root, manifest: MANIFEST });
  return { root, paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Write note_vectors rows for `ids`, stamped with each file's CURRENT mtime (i.e. "freshly indexed"). */
function indexNotes(paths, ids, { model = MODEL, mtimeOverride = null, files = {} } = {}) {
  mkdirSync(join(paths.vaultDir, "db"), { recursive: true });
  const db = new DatabaseSync(paths.dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS note_vectors (
     id TEXT PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL, mtime TEXT)`);
  const up = db.prepare(
    `INSERT INTO note_vectors (id, model, dim, vec, mtime) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET model=excluded.model, mtime=excluded.mtime`);
  for (const id of ids) {
    const rel = files[id] || join("notes", `${id}.md`);
    const mtime = mtimeOverride || statSync(join(paths.root, rel)).mtime.toISOString();
    up.run(id, model, 3, Buffer.from(new Float32Array([0, 0, 0]).buffer), mtime);
  }
  db.close();
}

/** Rewrite a note so its mtime moves forward (whole seconds, so an ISO comparison is unambiguous). */
function touchLater(paths, rel, secondsAhead = 5) {
  const p = join(paths.root, rel);
  writeFileSync(p, `${String(Date.now())}\n`, { flag: "a" });
  const t = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(p, t, t);
}

test("absent index → stale, and every typed note counts as behind", () => {
  const v = makeVault();
  try {
    const st = embeddingsStatus({ paths: v.paths });
    assert.equal(st.present, false);
    assert.equal(st.stale, true);
    assert.equal(st.staleCount, 3);
    assert.match(st.reason, /index absent/);
  } finally { v.cleanup(); }
});

test("empty note_vectors → stale (an existing DB file is not an index)", () => {
  const v = makeVault();
  try {
    indexNotes(v.paths, []);                       // creates the table, inserts nothing
    const st = embeddingsStatus({ paths: v.paths });
    assert.equal(st.stale, true);
    assert.equal(st.rows, 0);
    assert.match(st.reason, /empty/);
  } finally { v.cleanup(); }
});

test("fully indexed → not stale", () => {
  const v = makeVault();
  try {
    indexNotes(v.paths, ["note-a", "note-b", "note-c"]);
    const st = embeddingsStatus({ paths: v.paths });
    assert.equal(st.stale, false);
    assert.equal(st.staleCount, 0);
    assert.equal(st.rows, 3);
    assert.equal(st.model, MODEL);
  } finally { v.cleanup(); }
});

test("an edited note → stale, counted exactly", () => {
  const v = makeVault();
  try {
    indexNotes(v.paths, ["note-a", "note-b", "note-c"]);
    touchLater(v.paths, "notes/note-b.md");
    const st = embeddingsStatus({ paths: v.paths });
    assert.equal(st.stale, true);
    assert.equal(st.staleCount, 1);
    assert.equal(st.precise, true);
  } finally { v.cleanup(); }
});

test("a new note → stale even though the others are current", () => {
  const v = makeVault();
  try {
    indexNotes(v.paths, ["note-a", "note-b", "note-c"]);
    const p = join(v.root, "notes", "note-d.md");
    writeFileSync(p, note("note-d"));
    const t = new Date(Date.now() + 5000);
    utimesSync(p, t, t);
    const st = embeddingsStatus({ paths: v.paths });
    assert.equal(st.staleCount, 1);
  } finally { v.cleanup(); }
});

// THE REGRESSION THIS MODULE EXISTS TO AVOID. A stat-only check (newest .md vs the index) calls this
// vault stale forever: README.md is never indexed, so no rebuild can ever clear it — every launch would
// re-run gen-embeddings, which would skip everything, and report stale again on the next launch.
test("newest file is UNTYPED → not stale, and the verdict is cached", () => {
  const v = makeVault();
  try {
    indexNotes(v.paths, ["note-a", "note-b", "note-c"]);
    const p = join(v.root, "README.md");
    writeFileSync(p, "# no frontmatter, never indexed\n");
    const t = new Date(Date.now() + 60_000);
    utimesSync(p, t, t);

    const st = embeddingsStatus({ paths: v.paths });
    assert.equal(st.stale, false, "an untyped newest file must not read as stale");
    assert.equal(st.precise, true, "the exact pass is what proves it");
    assert.ok(existsSync(v.paths.markerPath), "the cleared high-water mark is cached");

    const again = embeddingsStatus({ paths: v.paths });
    assert.equal(again.stale, false);
    assert.equal(again.precise, false, "the second call is served from the cached verdict");
  } finally { v.cleanup(); }
});

test("a different embed model → everything is stale (vectors are not comparable across models)", () => {
  const v = makeVault();
  try {
    indexNotes(v.paths, ["note-a", "note-b", "note-c"], { model: "some-older-model" });
    const st = embeddingsStatus({ paths: v.paths });
    assert.equal(st.stale, true);
    assert.equal(st.staleCount, 3);
  } finally { v.cleanup(); }
});

test("typed notes vendored under node_modules are never part of the corpus", () => {
  const v = makeVault({ extra: { "node_modules/@x/pkg/agents/agent-demo.md": note("agent-demo", "agent") } });
  try {
    indexNotes(v.paths, ["note-a", "note-b", "note-c"]);
    const st = embeddingsStatus({ paths: v.paths });
    assert.equal(st.corpusNotes, 3, "node_modules is hard-skipped");
    assert.equal(st.stale, false, "a vendored note must not force a rebuild");
  } finally { v.cleanup(); }
});

test("skipDirs from the manifest are honoured", () => {
  const v = makeVault({ extra: { "inbox/scratch.md": note("scratch") } });
  try {
    indexNotes(v.paths, ["note-a", "note-b", "note-c"]);
    assert.equal(embeddingsStatus({ paths: v.paths }).corpusNotes, 3);
  } finally { v.cleanup(); }
});

test("embed lock: one holder at a time; released is re-acquirable", () => {
  const v = makeVault();
  try {
    mkdirSync(join(v.root, "db"), { recursive: true });
    const a = acquireEmbedLock(v.paths.lockDir);
    assert.equal(a.ok, true);
    const b = acquireEmbedLock(v.paths.lockDir);
    assert.equal(b.ok, false);
    assert.equal(b.reason, "held");
    releaseEmbedLock(v.paths.lockDir);
    assert.equal(acquireEmbedLock(v.paths.lockDir).ok, true);
    releaseEmbedLock(v.paths.lockDir);
  } finally { v.cleanup(); }
});

test("embed lock: an expired lock is broken, so one dead process cannot wedge the fleet", () => {
  const v = makeVault();
  try {
    mkdirSync(join(v.root, "db"), { recursive: true });
    assert.equal(acquireEmbedLock(v.paths.lockDir).ok, true);
    const later = { now: Date.now() + 60 * 60 * 1000 };          // an hour on
    const taken = acquireEmbedLock(v.paths.lockDir, later);
    assert.equal(taken.ok, true);
    assert.equal(taken.brokeStale, true);
    releaseEmbedLock(v.paths.lockDir);
  } finally { v.cleanup(); }
});

test("refreshIfStale is a no-op on a fresh index (it must not shell out for nothing)", () => {
  const v = makeVault();
  try {
    indexNotes(v.paths, ["note-a", "note-b", "note-c"]);
    const r = refreshIfStale({ paths: v.paths });
    assert.equal(r.refreshed, false);
    assert.equal(r.reason, "fresh");
  } finally { v.cleanup(); }
});

test("SYNAPSE_NO_REFRESH disables the self-heal but still reports the status", () => {
  const v = makeVault();
  const prev = process.env.SYNAPSE_NO_REFRESH;
  process.env.SYNAPSE_NO_REFRESH = "1";
  try {
    const r = refreshIfStale({ paths: v.paths });        // index absent → would otherwise refresh
    assert.equal(r.refreshed, false);
    assert.match(r.reason, /SYNAPSE_NO_REFRESH/);
  } finally {
    if (prev === undefined) delete process.env.SYNAPSE_NO_REFRESH; else process.env.SYNAPSE_NO_REFRESH = prev;
    v.cleanup();
  }
});

test("a held lock blocks a concurrent refresh instead of running a second gen-embeddings", () => {
  const v = makeVault();
  try {
    mkdirSync(join(v.root, "db"), { recursive: true });
    acquireEmbedLock(v.paths.lockDir);                   // pretend another agent is mid-rebuild
    const r = refreshIfStale({ paths: v.paths });        // index absent → stale → wants to refresh
    assert.equal(r.refreshed, false);
    assert.match(r.reason, /another refresh is in progress/);
    releaseEmbedLock(v.paths.lockDir);
  } finally { v.cleanup(); }
});

// ── end-to-end: the warning has to reach the BRIEFING, not just a status command ────────────────────
// This is the whole point of slice 2. A caller who never runs `embeddings-status` must still be told,
// in the output they are already reading, that recall is degraded.

const AUGMENT_MANIFEST = {
  repo: "test", logLabel: "synapse", vaultRoot: ".", skipDirs: ["inbox"],
  roles: {
    CONSTRAINS: { field: "applies_rules", direction: "forward" },
    NAVIGATES: { field: "related", direction: "forward", endpointTypes: ["hub"] },
  },
  referenceRoles: ["NAVIGATES"],
  profiles: {
    lean: { roles: ["CONSTRAINS"], pointerRoles: [], depth: {} },
    standard: { roles: ["CONSTRAINS", "NAVIGATES"], pointerRoles: [], depth: { NAVIGATES: 1 } },
    fat: { roles: ["CONSTRAINS", "NAVIGATES"], depth: { NAVIGATES: 99 } },
  },
  tokenBudgets: { lean: 4000, standard: 15000, fat: 30000 },
  excerptChars: { lean: 40, standard: 4000, fat: 0 },
  typePriority: ["agent", "hub", "rule", "note"],
  trailers: { canary: false, handover: false },
  invariants: [],
};

test("e2e: a stale index is called out IN the augment output", async () => {
  const root = mkdtempSync(join(tmpdir(), "syn-fresh-e2e-"));
  try {
    mkdirSync(join(root, "_meta", "tools"), { recursive: true });
    writeFileSync(join(root, "_meta", "tools", "context.manifest.json"), JSON.stringify(AUGMENT_MANIFEST));
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "agents", "agent-a.md"),
      `---\nid: agent-a\ntype: agent\ntitle: agent-a\npurpose: test\n---\nthe agent\n`);
    writeFileSync(join(root, "notes", "note-x.md"), note("note-x"));

    const paths = freshnessPaths({ root, vaultDir: root, manifest: AUGMENT_MANIFEST });
    indexNotes(paths, ["agent-a", "note-x"], { files: { "agent-a": join("agents", "agent-a.md") } });
    touchLater(paths, "notes/note-x.md");                 // now exactly 1 note behind

    const { spawnSync } = await import("node:child_process");
    const SYN = new URL("../bin/synapse.mjs", import.meta.url).pathname;
    const env = { ...process.env, SYNAPSE_VAULT: root, SYNAPSE_NO_REFRESH: "1", VAULT_USER: "Tester" };
    const r = spawnSync(process.execPath, [SYN, "augment", "agent-a", "--task", "anything"], {
      cwd: root, encoding: "utf8", env,
    });

    assert.equal(r.status, 0, `augment must never fail on a stale index:\n${r.stderr}`);
    assert.match(r.stdout, /the agent/, "the deterministic briefing still comes through");
    assert.match(r.stdout, /semantic index is 1 note\(s\) behind the vault/,
      `the stale warning must appear in the briefing itself:\n${r.stdout.slice(-400)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("e2e: a CURRENT index adds no warning noise", async () => {
  const root = mkdtempSync(join(tmpdir(), "syn-fresh-e2e2-"));
  try {
    mkdirSync(join(root, "_meta", "tools"), { recursive: true });
    writeFileSync(join(root, "_meta", "tools", "context.manifest.json"), JSON.stringify(AUGMENT_MANIFEST));
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "agents", "agent-a.md"),
      `---\nid: agent-a\ntype: agent\ntitle: agent-a\npurpose: test\n---\nthe agent\n`);
    writeFileSync(join(root, "notes", "note-x.md"), note("note-x"));

    const paths = freshnessPaths({ root, vaultDir: root, manifest: AUGMENT_MANIFEST });
    indexNotes(paths, ["agent-a", "note-x"], { files: { "agent-a": join("agents", "agent-a.md") } });

    const { spawnSync } = await import("node:child_process");
    const SYN = new URL("../bin/synapse.mjs", import.meta.url).pathname;
    const r = spawnSync(process.execPath, [SYN, "augment", "agent-a", "--task", "anything"], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, SYNAPSE_VAULT: root, SYNAPSE_NO_REFRESH: "1", VAULT_USER: "Tester" },
    });

    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /semantic index is/, "no warning when the index is current");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
