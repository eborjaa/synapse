// recall.mjs — the DELTA a briefing cannot carry: what an agent needs when the task SHIFTS mid-session.
//
// A briefing is rendered ONCE, from (agent, hub, task) at dispatch. Ten turns later the agent has moved
// from "plan the cycle" to "triage a sensors failure" to "post a comment", with its context frozen at
// turn 1. `synapse_recall` is the top-up: given the CURRENT subtask, it returns only what changed —
// never the 29k spine the agent already has.
//
// It unifies the three memories synapse now holds, each answering a different question about "now":
//   1. SEMANTIC   (embeddings)      — what notes are relevant to this new subtask?
//   2. PROCEDURAL (on-demand rules) — which rules now APPLY? (deterministic keyword match on triggers)
//   3. EPISODIC   (history)         — has this been done before, and what came of it?
//
// The GATE is built in: if nothing clears the bars — no semantic hit above the floor, no trigger
// matched, no prior episode — recall says so plainly ("your current briefing already covers this")
// instead of manufacturing filler. That is the "does this turn need memory at all?" check, answered
// from the result rather than a separate model call.
import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { resolveVault } from "./vault-root.mjs";
import { walkNoteFiles, noteSkipSet } from "./note-walk.mjs";
import {
  resolveOllamaBase, resolveEmbedModel, embedText, cosine, blobToVec, embedTextFor, parseNote,
} from "./gen-embeddings.mjs";

const EXCERPT_CHARS = 500;
const DEFAULT_K = 6;
const MIN_SIM = (() => {
  const raw = process.env.SYNAPSE_MIN_SIM ?? process.env.GENESIS_MIN_SIM ?? process.env.RELQA_MIN_SIM;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0.45;
})();

let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* semantic layer degrades to skip */ }

/** Tokens of a task, lowercased, for keyword matching. Punctuation is a separator, never a token. */
function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || []).filter((t) => t.length > 2);
}

/**
 * Which on-demand notes does THIS task trigger? Deterministic, offline, no model: the same keyword
 * logic validated for hub inference (matches the vault's own vocabulary, so a wrong guess is visible).
 * A note fires when its trigger shares a content word with the task, or the task names it by id/title.
 */
export function triggeredRules(vault, task) {
  const { root, manifest } = vault;
  const taskToks = new Set(tokenize(task));
  if (!taskToks.size) return [];
  const out = [];
  for (const f of walkNoteFiles(root, noteSkipSet(manifest))) {
    let raw;
    try { raw = readFileSync(f, "utf8"); } catch { continue; }
    if (!/^on_demand:\s*true\s*$/m.test(raw.slice(0, 4000))) continue;
    const id = basename(f, ".md");
    const trigger = (raw.match(/^trigger:\s*"?(.+?)"?\s*$/m) || [])[1] || "";
    const title = (raw.match(/^title:\s*"?(.+?)"?\s*$/m) || [])[1] || "";
    // Score = distinct trigger/title words the task also contains. Content words only, so "the",
    // "a", "before" never carry a match on their own.
    const vocab = new Set([...tokenize(trigger), ...tokenize(title), ...tokenize(id.replace(/-/g, " "))]);
    let score = 0;
    for (const w of vocab) {
      for (const t of taskToks) {
        if (t === w || (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t))) { score++; break; }
      }
    }
    if (score > 0) out.push({ id, trigger, score });
  }
  return out.sort((a, b) => b.score - a.score);
}


/** Suite names declared anywhere in the corpus, as `suite/<name>` tags. Cheap: reads frontmatter only. */
function knownSuites(vault) {
  const suites = new Set();
  for (const f of walkNoteFiles(vault.root, noteSkipSet(vault.manifest))) {
    let head;
    try { head = readFileSync(f, "utf8").slice(0, 1500); } catch { continue; }
    for (const m of head.matchAll(/suite\/([a-z0-9][a-z0-9-]*)/g)) suites.add(m[1]);
  }
  return suites;
}

/** Which known suites does the task NAME? Deterministic keyword match against the suite vocabulary. */
export function suitesNamedBy(vault, task) {
  const toks = new Set(tokenize(task));
  const named = new Set();
  for (const suite of knownSuites(vault)) {
    // a suite is "named" if the task contains its whole slug, or every hyphen-part of it
    const parts = suite.split("-").filter((p) => p.length > 2);
    if (parts.length && parts.every((p) => [...toks].some((t) => t === p || (p.length >= 4 && t.startsWith(p)) || (t.length >= 4 && p.startsWith(t))))) {
      named.add(suite);
    }
  }
  return named;
}

/** The `suite/<x>` tags on ONE note (frontmatter only). */
function suiteTagsOf(path) {
  try {
    const head = readFileSync(path, "utf8").slice(0, 1500);
    return new Set([...head.matchAll(/suite\/([a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]));
  } catch { return new Set(); }
}

/** Semantic top-K for the task over note_vectors. Fails to `{skipped:reason}` — never throws. */
export function semanticHits(vault, task, { k = DEFAULT_K, named = null } = {}) {
  const dbPath = join(vault.vaultDir, "db", "synapse.db");
  if (!DatabaseSync) return { skipped: "node:sqlite unavailable — needs Node >= 22.5", hits: [] };
  if (!existsSync(dbPath)) return { skipped: "no index — run `synapse embeddings`", hits: [] };
  if (!task || !task.trim()) return { skipped: "no task", hits: [] };

  let rows;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='note_vectors'`).get();
    if (!has) { db.close(); return { skipped: "note_vectors absent", hits: [] }; }
    rows = db.prepare(`SELECT id, model, vec FROM note_vectors`).all();
    db.close();
  } catch (e) { return { skipped: `could not read note_vectors (${e.message})`, hits: [] }; }
  if (!rows.length) return { skipped: "index empty", hits: [] };

  const base = resolveOllamaBase();
  const model = resolveEmbedModel();
  return embedText(base, model, task.slice(0, 8000))
    .then((qvec) => {
      const scored = rows
        .filter((r) => r.model === model)
        .map((r) => ({ id: r.id, score: cosine(qvec, blobToVec(r.vec)) }))
        .filter((h) => h.score >= MIN_SIM)
        .sort((a, b) => b.score - a.score);

      // Suite affinity: when the task NAMES a suite (e.g. "alerts"), the raw cosine can rank an adjacent
      // suite's notes higher (a sensors note about notifications for an "alerts" task). A soft boost on
      // in-suite hits corrects the ORDER without hard-filtering — a genuinely relevant cross-suite note
      // still surfaces. We resolve suite tags for a POOL of the top candidates only (cheap disk reads),
      // never the whole corpus.
      const suites = named || suitesNamedBy(vault, task);
      const POOL = Math.max(k * 4, 24);
      const pool = scored.slice(0, POOL);
      const idPath = new Map();
      if (suites.size) {
        for (const f of walkNoteFiles(vault.root, noteSkipSet(vault.manifest))) idPath.set(basename(f, ".md"), f);
        for (const h of pool) {
          const tags = suiteTagsOf(idPath.get(h.id) || "");
          h.inSuite = [...tags].some((t) => suites.has(t));
          if (h.inSuite) h.score += 0.15;   // ~2-3 rank slots at typical cosine spreads; never absolute
        }
        pool.sort((a, b) => b.score - a.score);
      }
      const ranked = pool.slice(0, k);

      // attach an excerpt from disk (recall owns no second copy of the bodies)
      const want = new Map(ranked.map((h) => [h.id, h]));
      for (const f of walkNoteFiles(vault.root, noteSkipSet(vault.manifest))) {
        const id = basename(f, ".md");
        const h = want.get(id); if (!h) continue;
        try {
          const rec = parseNote(readFileSync(f, "utf8"));
          h.type = rec.type; h.title = rec.title || id;
          h.excerpt = (rec.body || "").slice(0, EXCERPT_CHARS) + ((rec.body || "").length > EXCERPT_CHARS ? " …" : "");
        } catch { /* keep the id-only hit */ }
      }
      return { skipped: null, hits: ranked };
    })
    .catch((e) => ({ skipped: `Ollama unreachable (${e.message})`, hits: [] }));
}

/**
 * The full recall. `episodesFn` is injected (the episode DB lives in the MCP layer) so this lib stays
 * free of durable-spawn coupling and is unit-testable without it.
 */
export async function recall({ vault = resolveVaultCtx(), task, k = DEFAULT_K, episodesFn = null } = {}) {
  const named = suitesNamedBy(vault, task);          // deterministic — reported even with no index
  const rules = triggeredRules(vault, task);
  const sem = await semanticHits(vault, task, { k, named });
  const prior = episodesFn ? episodesFn(task) : [];

  const empty = !rules.length && !sem.hits.length && !prior.length;
  return {
    task,
    applicableRules: rules.map((r) => ({ id: r.id, trigger: r.trigger })),
    hits: sem.hits.map((h) => ({ id: h.id, type: h.type, score: Number(h.score.toFixed(3)), title: h.title, excerpt: h.excerpt })),
    priorWork: prior,
    semanticSkipped: sem.skipped,
    routedToSuites: [...named],
    guidance: empty
      ? "Nothing new — your current briefing already covers this subtask."
      : "Top-up for the current subtask. Fetch any applicable rule before acting; treat hits as leads, not authority.",
  };
}

function resolveVaultCtx() {
  const v = resolveVault();
  return { root: v.root, vaultDir: v.vaultDir, manifest: v.manifest || {} };
}
