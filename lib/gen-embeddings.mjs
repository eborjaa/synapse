#!/usr/bin/env node
// gen-embeddings.mjs — embed every vault note body via local Ollama → a generated `note_vectors` table.
//
//   synapse gen-embeddings            # incremental: re-embed only changed/new notes
//   synapse gen-embeddings --all      # force a full re-embed of every note
//   synapse gen-embeddings --selftest # offline math check (no Ollama, no DB writes)
//
// This is a GENERATED, derived projection of the vault — the same family as gen-traceability.mjs:
// rebuilt from the notes, never canonical, never hand-edited. Markdown is the source of truth;
// `note_vectors` is a rebuildable cache of float embeddings used by augment.mjs for semantic recall.
// The DB lives at <vaultDir>/db/synapse.db and is typically gitignored — like the on-demand
// generators, this runs on demand.
//
// Corpus = the SAME walk render.mjs/lint.mjs use: the resolved package `root` (spans note content +
// _meta), every `.md` with a `type:` field. Walking `root` (not just the vault content dir) means
// feature docs under components/<area>/<feature>/ are embedded too, so augment's "out-of-closure" set
// matches render's id space exactly.
//
// DE-BRANDING NOTES:
//   - The vault is located via resolveVault() (walk from `root`; DB under `vaultDir`), NOT a fixed
//     "N-up from __dirname" path.
//   - skipDirs come from the resolved manifest, NOT a hardcoded duplicate set.
//   - Env vars: SYNAPSE_OLLAMA_URL (fallback deprecated GENESIS_OLLAMA_URL) and SYNAPSE_EMBED_MODEL
//     (fallback deprecated GENESIS_EMBED_MODEL). localhost + mxbai-embed-large defaults are kept.
//   - Log prefix is manifest.logLabel (default "synapse"), e.g. `[synapse gen-embeddings]`.
//
// Embeddings come from a local Ollama (default http://localhost:11434, no API key). If Ollama is
// unreachable or the model is missing, this exits with a clear message and leaves existing vectors
// intact (fail loudly).
//
// v1 storage: plain Float32Array BLOB; cosine is computed in JS by augment.mjs (brute force is ample at
// vault scale). `sqlite-vec` is the documented drop-in scale-up swap when the corpus grows large.

import { readdirSync, readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { resolveVault } from "./vault-root.mjs";

const MAX_EMBED_CHARS = 8000;

// ===================================================================== shared helpers (also used by augment)

// Resolve the Ollama base URL: env SYNAPSE_OLLAMA_URL (fallback deprecated GENESIS_OLLAMA_URL), else the
// localhost default. NEVER hardcode a remote host or key — this runs against a local Ollama (no cloud,
// no API key).
export function resolveOllamaBase() {
  const url = process.env.SYNAPSE_OLLAMA_URL || process.env.GENESIS_OLLAMA_URL;
  if (url) return url.replace(/\/+$/, "");
  return "http://localhost:11434";
}

export function resolveEmbedModel() {
  return process.env.SYNAPSE_EMBED_MODEL || process.env.GENESIS_EMBED_MODEL || "mxbai-embed-large";
}

// Embed one text via Ollama. Tries the modern /api/embed ({model,input}); on a 404/older-server falls
// back to /api/embeddings ({model,prompt}). Returns Float32Array. Throws on any failure (caller decides
// how to degrade). `fetch` is built into modern Node — no npm dep.
export async function embedText(base, model, text) {
  // modern endpoint
  let res;
  try {
    res = await fetch(`${base}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: text }),
    });
  } catch (e) {
    throw new Error(`cannot reach Ollama at ${base} (${e.message})`);
  }
  if (res.ok) {
    const j = await res.json();
    // /api/embed returns { embeddings: [[...]] } (batched); older builds may return { embedding: [...] }.
    const vec = j.embeddings?.[0] || j.embedding;
    if (Array.isArray(vec) && vec.length) return Float32Array.from(vec);
    // a 200 with no vector usually means the model isn't present
    throw new Error(`Ollama returned no embedding for model "${model}" — is it pulled? (ollama pull ${model})`);
  }
  if (res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama /api/embed → HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  // fallback: legacy /api/embeddings ({model, prompt} → { embedding: [...] })
  let res2;
  try {
    res2 = await fetch(`${base}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
  } catch (e) {
    throw new Error(`cannot reach Ollama at ${base} (${e.message})`);
  }
  if (!res2.ok) {
    const body = await res2.text().catch(() => "");
    throw new Error(`Ollama /api/embeddings → HTTP ${res2.status} ${body.slice(0, 200)}`);
  }
  const j2 = await res2.json();
  const vec2 = j2.embedding || j2.embeddings?.[0];
  if (Array.isArray(vec2) && vec2.length) return Float32Array.from(vec2);
  throw new Error(`Ollama returned no embedding for model "${model}" — is it pulled? (ollama pull ${model})`);
}

// Cosine similarity of two Float32Array (or number[]). Returns 0 for a zero vector / dim mismatch.
export function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Float32Array <-> BLOB. node:sqlite stores/returns BLOBs as Uint8Array; reuse the underlying buffer.
export function vecToBlob(f32) {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
export function blobToVec(buf) {
  // Copy into an aligned buffer (a sqlite BLOB's byteOffset may not be 4-aligned for Float32Array).
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

// raw → frontmatter/body split + type/title (mirrors lint.mjs / render.mjs).
export function parseNote(raw) {
  const end = raw.indexOf("\n---", 4);
  const fm = end > 0 ? raw.slice(0, end) : "";
  const body = (end > 0 ? raw.slice(end + 4) : raw).trim();
  const type = (fm.match(/^type:\s*(.+)$/m) || [])[1]?.trim() || null;
  const title = (fm.match(/^title:\s*(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, "") || null;
  return { fm, body, type, title };
}

// The text we embed for a note: title + body, truncated. Shared shape so query/doc embeddings align.
export function embedTextFor(title, body) {
  return `${title || ""}\n\n${body || ""}`.slice(0, MAX_EMBED_CHARS);
}

// Only run the CLI (selftest / main) when invoked directly — NOT when augment.mjs imports the helpers.
const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

// ===================================================================== --selftest (offline, no Ollama/DB)
if (IS_MAIN && process.argv.includes("--selftest")) {
  let fail = 0;
  const approx = (x, y, eps = 1e-6) => Math.abs(x - y) < eps;
  const ok = (cond, msg) => { if (!cond) { console.error(`  ✗ ${msg}`); fail++; } else console.error(`  ✓ ${msg}`); };

  const a = Float32Array.from([1, 0, 0]);
  const b = Float32Array.from([1, 0, 0]);
  const c = Float32Array.from([0, 1, 0]);
  const d = Float32Array.from([-1, 0, 0]);
  ok(approx(cosine(a, b), 1), "cosine(identical) == 1");
  ok(approx(cosine(a, c), 0), "cosine(orthogonal) == 0");
  ok(approx(cosine(a, d), -1), "cosine(opposite) == -1");
  ok(cosine(a, Float32Array.from([1, 1])) === 0, "cosine(dim mismatch) == 0 (no crash)");
  ok(cosine(Float32Array.from([0, 0, 0]), a) === 0, "cosine(zero vector) == 0 (no NaN)");

  // BLOB round-trip preserves the vector.
  const rt = blobToVec(vecToBlob(Float32Array.from([0.5, -0.25, 3.0])));
  ok(approx(rt[0], 0.5) && approx(rt[1], -0.25) && approx(rt[2], 3.0), "Float32 BLOB round-trips");

  console.error(`[gen-embeddings] --selftest: ${fail} failure(s)`);
  process.exit(fail ? 1 : 0);
}

// ===================================================================== main (write path; needs Ollama)
async function main() {
  const forceAll = process.argv.includes("--all");
  const base = resolveOllamaBase();
  const model = resolveEmbedModel();

  // Locate the vault via the resolver: walk from `root` (spans content + _meta); DB under `vaultDir`.
  const { root: WALK_ROOT, vaultDir: VAULT_DIR, manifest: MANIFEST } = resolveVault();
  const LABEL = MANIFEST.logLabel || "synapse";
  const DB_PATH = join(VAULT_DIR, "db", "synapse.db");
  const SKIP = new Set(MANIFEST.skipDirs || []);

  // walk (mirror render/lint: skip dotdirs + manifest.skipDirs)
  function walk(dir) {
    const out = [];
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.name.endsWith(".md")) out.push(p);
    }
    return out;
  }

  // index every typed note (.md with a type: field)
  const notes = new Map(); // id → { title, body, mtime }
  for (const f of walk(WALK_ROOT)) {
    const raw = readFileSync(f, "utf8");
    const rec = parseNote(raw);
    if (!rec.type) continue;
    notes.set(basename(f, ".md"), {
      title: rec.title,
      body: rec.body,
      mtime: statSync(f).mtime.toISOString(),
    });
  }

  // The DB is a derived cache — create db/ on first run (no migrations layer; vectors-only DB).
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(
    `CREATE TABLE IF NOT EXISTS note_vectors (
       id TEXT PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL, mtime TEXT
     )`
  );

  // existing rows → for incremental skip + orphan cleanup
  const existing = new Map(); // id → { model, mtime }
  for (const r of db.prepare(`SELECT id, model, mtime FROM note_vectors`).all()) {
    existing.set(r.id, { model: r.model, mtime: r.mtime });
  }

  // remove vectors whose note no longer exists
  let removed = 0;
  const delStmt = db.prepare(`DELETE FROM note_vectors WHERE id = ?`);
  for (const id of existing.keys()) {
    if (!notes.has(id)) { delStmt.run(id); removed++; }
  }

  // decide what to embed (incremental: skip when stored mtime + model match)
  const todo = [];
  let skipped = 0;
  for (const [id, n] of notes) {
    const prev = existing.get(id);
    if (!forceAll && prev && prev.model === model && prev.mtime === n.mtime) { skipped++; continue; }
    todo.push(id);
  }

  if (!todo.length) {
    const dimRow = db.prepare(`SELECT dim FROM note_vectors LIMIT 1`).get();
    console.log(
      `[${LABEL} gen-embeddings] up to date — embedded 0, skipped ${skipped}, removed ${removed}` +
      ` (model ${model}, dim ${dimRow?.dim ?? "?"}, base ${base})`
    );
    db.close();
    return;
  }

  // upsert prepared once; embed sequentially (a local model; keep it gentle)
  const up = db.prepare(
    `INSERT INTO note_vectors (id, model, dim, vec, mtime) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET model=excluded.model, dim=excluded.dim, vec=excluded.vec, mtime=excluded.mtime`
  );

  let embedded = 0, dim = 0;
  for (const id of todo) {
    const n = notes.get(id);
    let vec;
    try {
      vec = await embedText(base, model, embedTextFor(n.title, n.body));
    } catch (e) {
      // Ollama failure: clear message, exit 1, leave existing vectors intact (we committed nothing destructive
      // beyond the orphan cleanup; those notes are genuinely gone, so that is correct either way).
      console.error(`[${LABEL} gen-embeddings] FAILED at note "${id}": ${e.message}`);
      console.error(`[${LABEL} gen-embeddings] existing vectors left intact. Embedded ${embedded} before failure.`);
      db.close();
      process.exit(1);
    }
    dim = vec.length;
    up.run(id, model, dim, vecToBlob(vec), n.mtime);
    embedded++;
  }

  console.log(
    `[${LABEL} gen-embeddings] embedded ${embedded}, skipped ${skipped}, removed ${removed}` +
    ` (model ${model}, dim ${dim}, base ${base})`
  );
  db.close();
}

if (IS_MAIN) main();
