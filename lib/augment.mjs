#!/usr/bin/env node
// augment.mjs — Phase-2 hybrid retrieval: deterministic render + semantic recall over `note_vectors`.
//
//   synapse augment <id> [<id> …] [--profile P] --task "<text>" [--k N] [--no-semantic]
//   (start ids = an agent + any number of hub-<domain> targets, exactly like render.mjs)
//
// Phase 1 (deterministic seed): run render.mjs as a child with the same <agent> [<target>] --profile P
// and capture its byte-identical briefing. render.mjs stays PURE and offline — augment never imports or
// modifies it; it shells out and parses the `<!-- <id> (<type>) -->` markers it already emits. So the
// deterministic spine is untouched and reproducible.
//
// Phase 2 (semantic augment): embed the query (the user's task) via the SAME local Ollama path as
// gen-embeddings.mjs, open `note_vectors` READ-ONLY, cosine-rank notes NOT already in the closure, take
// the top-K under a token budget, and APPEND a clearly-labeled "## Semantically related (not yet linked)"
// section. Results are additive, labeled, never authoritative.
//
// Graceful degradation: --no-semantic, Ollama unreachable, Node<22.5 (no node:sqlite), or an
// empty/absent note_vectors → print the deterministic briefing plus a "(semantic augment skipped:
// <reason>)" note. NEVER crash; never block the deterministic spine.
//
// v1 ranking is plain cosine top-K of out-of-closure notes. It is structured so a second retriever
// (keyword/BM25) can be Reciprocal-Rank-Fusion-fused later — see rrfFuse() and the RRF SEAM comment.
//
// DE-BRANDING NOTES:
//   - The vault is located via resolveVault() (walk from `root`; DB under `vaultDir`), NOT a fixed
//     "N-up from __dirname" path.
//   - render.mjs is the sibling in this lib dir: join(HERE, "render.mjs").
//   - skipDirs come from the resolved manifest; log prefix is manifest.logLabel (default "synapse").
//   - Similarity floor env: SYNAPSE_MIN_SIM (fallback deprecated GENESIS_MIN_SIM, then RELQA_MIN_SIM),
//     default 0.45, NaN-guarded.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  resolveOllamaBase, resolveEmbedModel, embedText, cosine, blobToVec, embedTextFor,
} from "./gen-embeddings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDER = join(HERE, "render.mjs");

const QUERY_MAX_CHARS = 8000;   // matches gen-embeddings truncation
const DEFAULT_K = 6;
const BUDGET_TOKENS = 3500;     // ~3–4K tokens of appended bodies
const EXCERPT_CHARS = 600;      // per-hit excerpt cap (a suggestion scan, not a content dump)
// similarity floor: skip weak/irrelevant hits (tune per embed model). SYNAPSE_MIN_SIM, fall back to the
// deprecated GENESIS_MIN_SIM then RELQA_MIN_SIM; NaN-guard the parse so a garbage env can never poison it.
const MIN_SIM = (() => {
  const raw = process.env.SYNAPSE_MIN_SIM ?? process.env.GENESIS_MIN_SIM ?? process.env.RELQA_MIN_SIM;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0.45;
})();

// ===================================================================== RRF helper (the fusion seam)
// Reciprocal Rank Fusion: fuse N ranked id-lists into one score map. v1 uses a SINGLE ranker (cosine), so
// this is an identity-shaped pass-through — but augment is wired so a second retriever (e.g. a keyword/BM25
// list) is added to `rankings` with ZERO change to the consumer. RRF SEAM: add the second ranking here.
export function rrfFuse(rankings, k = 60) {
  const score = new Map();
  for (const ranked of rankings) {
    ranked.forEach((id, i) => {
      score.set(id, (score.get(id) || 0) + 1 / (k + i + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]); // [ [id, fusedScore], … ] desc
}

// --selftest: offline checks of the ranking/RRF/budget logic (no Ollama, no DB, no vault needed).
if (process.argv.includes("--selftest")) {
  let fail = 0;
  const ok = (cond, msg) => { if (!cond) { console.error(`  ✗ ${msg}`); fail++; } else console.error(`  ✓ ${msg}`); };

  // cosine top-K selection over hardcoded vectors, excluding closure members.
  const query = Float32Array.from([1, 0, 0]);
  const corpus = {
    "note-a": Float32Array.from([0.9, 0.1, 0]),  // closest
    "note-b": Float32Array.from([0.2, 0.9, 0]),  // far
    "note-c": Float32Array.from([0.8, 0.2, 0]),  // close
    "note-d": Float32Array.from([1, 0, 0]),      // identical but in-closure → excluded
  };
  const closure = new Set(["note-d"]);
  const scored = Object.entries(corpus)
    .filter(([id]) => !closure.has(id))
    .map(([id, v]) => [id, cosine(query, v)])
    .sort((a, b) => b[1] - a[1]);
  ok(scored[0][0] === "note-a", "top hit is note-a (closest, out-of-closure)");
  ok(!scored.some(([id]) => id === "note-d"), "in-closure note-d excluded");
  ok(scored.length === 3, "3 candidates ranked (d excluded)");
  const topK = scored.slice(0, 2).map(([id]) => id);
  ok(topK.length === 2 && topK[0] === "note-a" && topK[1] === "note-c", "top-K=2 → [note-a, note-c]");

  // RRF seam: single ranking → preserves order; fusing a 2nd ranking lifts a shared id.
  const r1 = ["x", "y", "z"];
  const single = rrfFuse([r1]).map(([id]) => id);
  ok(single[0] === "x" && single[2] === "z", "RRF single-ranking preserves order");
  const fused = rrfFuse([["x", "y", "z"], ["y", "x", "w"]]).map(([id]) => id);
  ok(fused[0] === "y" || fused[0] === "x", "RRF fuses two rankings (shared top rises)");
  ok(fused.includes("w"), "RRF includes ids unique to the 2nd ranking");

  console.error(`[augment] --selftest: ${fail} failure(s)`);
  process.exit(fail ? 1 : 0);
}

// ===================================================================== vault resolution
// Located via the resolver: walk from `root` (for the bodies index); DB under `vaultDir`. Manifest gives
// skipDirs + the de-branded log label. Deferred until AFTER --selftest so the offline check needs no vault.
import { resolveVault } from "./vault-root.mjs";
const { root: WALK_ROOT, vaultDir: VAULT_DIR, manifest: MANIFEST } = resolveVault();
const LABEL = MANIFEST.logLabel || "synapse";
const DB_PATH = join(VAULT_DIR, "db", "synapse.db");
const SKIP = new Set(MANIFEST.skipDirs || []);

// node:sqlite is a Node >=22.5 built-in; import lazily so a too-old Node degrades gracefully rather than
// crashing at module-eval time (the semantic phase is optional; the deterministic spine must survive).
let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* handled in augment() as a skip */ }

// ===================================================================== arg parse
const argv = process.argv.slice(2);
const positional = [];
let profile = null, task = null, k = DEFAULT_K, noSemantic = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--profile") { profile = argv[++i]; continue; }
  if (a === "--task") { task = argv[++i]; continue; }
  if (a === "--k") { k = parseInt(argv[++i], 10) || DEFAULT_K; continue; }
  if (a === "--no-semantic") { noSemantic = true; continue; }
  if (a.startsWith("--")) { continue; } // ignore unknown flags
  positional.push(a);
}
if (!positional.length) {
  console.error('usage: synapse augment <id> [<id> …] [--profile P] --task "<text>" [--k N] [--no-semantic]');
  process.exit(2);
}

// ===================================================================== Phase 1: deterministic render (child)
// Forward ALL start ids to render — render.mjs accepts N start ids (agent + any number of hub-<domain>
// targets) and builds one deduped closure. A cap would silently drop the 3rd+ id and mis-classify its
// notes as "out-of-closure" semantic hits.
const renderArgs = [RENDER, ...positional];
if (profile) renderArgs.push("--profile", profile);
const r = spawnSync(process.execPath, renderArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (r.status !== 0) {
  // render itself failed (unknown id, etc.) — surface its stderr and stop.
  process.stderr.write(r.stderr || "");
  process.exit(r.status || 1);
}
const briefing = r.stdout;
process.stderr.write(r.stderr || ""); // pass render's [<label> render …] log line through to stderr

// Parse closure ids from the `<!-- <id> (<type>) -->` markers render emits.
const closure = new Set();
for (const m of briefing.matchAll(/<!--\s+(\S+)\s+\(([^)]+)\)\s+-->/g)) closure.add(m[1]);

// emit the deterministic briefing + a skip note, then exit cleanly
function skip(reason) {
  process.stdout.write(briefing);
  process.stdout.write(`\n<!-- semantic augment -->\n> (semantic augment skipped: ${reason})\n`);
  process.exit(0);
}

if (noSemantic) skip("--no-semantic");
if (!DatabaseSync) skip("node:sqlite unavailable — needs Node >=22.5");

// ===================================================================== Phase 2: semantic augment
async function augment() {
  if (!existsSync(DB_PATH)) return skip("db/synapse.db not found — run gen-embeddings");

  // load note_vectors READ-ONLY (the query path can never mutate the DB)
  let rows;
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    // table may not exist yet → guard
    const has = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='note_vectors'`)
      .get();
    if (!has) { db.close(); return skip("note_vectors absent — run gen-embeddings"); }
    rows = db.prepare(`SELECT id, model, dim, vec FROM note_vectors`).all();
    db.close();
  } catch (e) {
    return skip(`could not read note_vectors (${e.message})`);
  }
  if (!rows.length) return skip("note_vectors empty — run gen-embeddings");

  const base = resolveOllamaBase();
  const model = resolveEmbedModel();

  // Embed the USER'S TASK, not the briefing. The briefing is already the deterministic context; the
  // augment's job is to find notes relevant to what the user ASKED. Embedding the (far larger) briefing
  // swamps the task signal and just returns notes similar to the briefing. Fall back to the briefing only
  // when no task was supplied.
  const queryText = (task && task.trim())
    ? task.slice(0, QUERY_MAX_CHARS)
    : embedTextFor("", briefing).slice(0, QUERY_MAX_CHARS);
  let qvec;
  try {
    qvec = await embedText(base, model, queryText);
  } catch (e) {
    return skip(`Ollama unreachable (${e.message})`);
  }

  // cosine-rank out-of-closure notes. NOTE we only score rows embedded with the query's model
  // (a mixed-model index would otherwise compare incomparable spaces).
  const ranked = rows
    .filter((row) => !closure.has(row.id) && row.model === model)
    .map((row) => ({ id: row.id, score: cosine(qvec, blobToVec(row.vec)) }))
    .filter((h) => h.score >= MIN_SIM)   // floor: drop weak/irrelevant hits (tune via SYNAPSE_MIN_SIM)
    .sort((a, b) => b.score - a.score);

  // RRF SEAM: today `ranked` is the sole retriever. To add BM25/keyword recall, build a second ranked
  // id-list and fuse: rrfFuse([ranked.map(h=>h.id), keywordRanked]). The top-K consumer below is unchanged.
  const top = ranked.slice(0, k);

  if (!top.length) return skip(`no out-of-closure notes above the similarity floor (${MIN_SIM})`);

  // Pull bodies for the hits from the notes index (read-only; reuse render's marker source = the files).
  // We re-derive bodies straight from disk so augment owns no second copy of the parse logic divergence.
  const bodies = loadBodies(top.map((h) => h.id));

  // Build the labeled section under a token budget (~BUDGET_TOKENS of appended bodies).
  const lines = [];
  lines.push("");
  lines.push("<!-- semantic augment (not authoritative — see rule-semantic-suggests-links-decide) -->");
  lines.push("## Semantically related (not yet linked)");
  lines.push("");
  lines.push(
    "> These are embedding-similarity suggestions, NOT typed links — additive and non-authoritative. " +
    "Verify before relying on one; if a hit is genuinely relevant, propose promoting it to a typed " +
    "`related:` link so future briefings reach it deterministically (rule-semantic-suggests-links-decide)."
  );
  lines.push("");

  let usedTokens = 0;
  let shown = 0;
  for (const hit of top) {
    const b = bodies.get(hit.id);
    const type = b?.type || "?";
    const fullBody = b?.body || "";
    lines.push(`### ${hit.id} (${type}) — similarity ${hit.score.toFixed(3)}`);
    lines.push("");
    // A suggestion section is a SCAN of candidates, not a content dump: cap each hit to a short excerpt
    // (render the full note if a hit proves relevant). Stop excerpting once the overall budget is spent.
    if (usedTokens >= BUDGET_TOKENS) {
      lines.push("_(excerpt omitted — budget reached; render this note directly if relevant)_");
    } else {
      let excerpt = fullBody.slice(0, EXCERPT_CHARS);
      if (fullBody.length > EXCERPT_CHARS) excerpt += " …";
      usedTokens += Math.ceil(excerpt.length / 4);
      lines.push(excerpt);
    }
    lines.push("");
    shown++;
  }

  process.stdout.write(briefing);
  process.stdout.write(lines.join("\n") + "\n");
  process.stderr.write(
    `[${LABEL} augment] semantic: ${shown}/${ranked.length} out-of-closure hit(s) appended ` +
    `(top-K=${k}, ~${usedTokens} tok, model ${model})\n`
  );
}

// Load bodies for a set of ids by walking the vault once (skip dotdirs + manifest.skipDirs).
function loadBodies(ids) {
  const want = new Set(ids);
  const out = new Map();
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) {
        const id = e.name.slice(0, -3);
        if (!want.has(id) || out.has(id)) continue;
        const raw = readFileSync(p, "utf8");
        const end = raw.indexOf("\n---", 4);
        const fm = end > 0 ? raw.slice(0, end) : "";
        const body = (end > 0 ? raw.slice(end + 4) : raw).trim();
        const type = (fm.match(/^type:\s*(.+)$/m) || [])[1]?.trim() || "?";
        out.set(id, { body, type });
      }
    }
  }
  walk(WALK_ROOT);
  return out;
}

augment();
