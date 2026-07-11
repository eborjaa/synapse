#!/usr/bin/env node
// render.mjs — synapse canonical context-vault renderer.
//
//   synapse render <id> [<id> …] [--profile lean|standard|fat] [--mode <alias>] \
//        [--include-tag t] [--exclude-tag t] [--dry-run] [--copy]
//   synapse render --lint
//
// Manifest-driven, role-based: walks ONLY typed frontmatter relationships (never prose [[links]]) into
// a selected, budgeted closure, then concatenates linked bodies into one context blob. Roles, fields,
// profiles, depths, budgets, excerpting, priorities and invariants ALL come from the consumer's
// context.manifest.json — nothing package-specific is hardcoded.
//
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveVault } from "./vault-root.mjs";
import { buildTrailers } from "./trailers.mjs";

const { root: ROOT, manifest: MANIFEST } = resolveVault();
const SKIP = new Set(MANIFEST.skipDirs || []);
const LABEL = MANIFEST.logLabel || "synapse"; // de-branded, manifest-driven log prefix

// ---- arg parse: ids (positional) + flags + option values ----
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--profile", "--mode", "--include-tag", "--exclude-tag"]);
const ids = [];
const optval = {};
const flags = new Set();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) { optval[a] = argv[++i]; continue; }
  if (a.startsWith("--")) { flags.add(a); continue; }
  ids.push(a);
}
// --profile is canonical; --mode is the harness alias. A non-profile --mode value falls back to lean.
let profile = optval["--profile"] || optval["--mode"] || "lean";
if (!MANIFEST.profiles?.[profile]) profile = "lean";
const includeTag = optval["--include-tag"];
const excludeTag = optval["--exclude-tag"];
const dryRun = flags.has("--dry-run");
const copy = flags.has("--copy");
const lint = flags.has("--lint");

if (!ids.length && !lint) {
  console.error(`usage: synapse render <id> [<id> …] [--profile lean|standard|fat] [--include-tag t] [--exclude-tag t] [--dry-run] [--copy] | synapse render --lint`);
  process.exit(2);
}

// ---- walk + index (deterministic order; bodies/fields cached) ----
function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// A role field key may be a string or an array (canonical schema normalizes both).
const roleFieldsOf = (role) => Array.isArray(role.field) ? role.field
  : role.field ? [role.field]
  : Array.isArray(role.fields) ? role.fields
  : role.fields ? [role.fields] : [];
const ROLE_FIELDS = new Set();
for (const r of Object.values(MANIFEST.roles || {})) for (const f of roleFieldsOf(r)) ROLE_FIELDS.add(f);

const wikiRe = /\[\[([^\]]+)\]\]/g;
// Extract [[basename]] tokens from ONE frontmatter field (inline `[a,b]`, multi-line array, or `- item`
// block). Scoped to the field — never the body.
function linksInField(fm, field) {
  const m = new RegExp(`^${field}:[ \\t]*(.*)$`, "m").exec(fm);
  if (!m) return [];
  let val = m[1];
  const after = fm.slice(fm.indexOf(m[0]) + m[0].length);
  if (val.includes("[") && !val.includes("]")) {
    for (const line of after.split("\n")) { val += "\n" + line; if (line.includes("]")) break; }
  } else if (val.trim() === "") {
    for (const line of after.split("\n")) { if (/^\s+-\s+/.test(line) || line.trim() === "") val += "\n" + line; else break; }
  }
  const out = [];
  let w; while ((w = wikiRe.exec(val)) !== null) {
    const t = w[1].split("|")[0].split("#")[0].trim();
    if (t && !t.includes("...") && !t.includes("<")) out.push(t);
  }
  return out;
}

function parseNote(raw) {
  const end = raw.indexOf("\n---", 4);
  const fm = end > 0 ? raw.slice(0, end) : "";
  const body = (end > 0 ? raw.slice(end + 4) : raw).trim();
  const type = (fm.match(/^type:\s*(.+)$/m) || [])[1]?.trim() || "note";
  const tags = [...fm.matchAll(/-\s*([a-z][a-z0-9]*\/[a-z0-9.\-]+)/g)].map((m) => m[1]);
  const sp = (fm.match(/^short_purpose:\s*"?(.+?)"?\s*$/m) || [])[1] || "";
  const fields = {};
  for (const f of ROLE_FIELDS) fields[f] = linksInField(fm, f);
  return { type, tags, body, sp, fields };
}

const index = new Map(); // basename → { type, tags, body, sp, fields }
for (const f of walk(ROOT)) index.set(basename(f, ".md"), parseNote(readFileSync(f, "utf8")));

// forward/reverse typed-edge indexes over the role fields
const forward = new Map(), reverse = new Map();
for (const [src, rec] of index) for (const field of ROLE_FIELDS) {
  const targets = (rec.fields[field] || []).filter((t) => index.has(t));
  if (!targets.length) continue;
  if (!forward.has(src)) forward.set(src, new Map());
  forward.get(src).set(field, targets);
  for (const tgt of targets) {
    if (!reverse.has(tgt)) reverse.set(tgt, new Map());
    const rm = reverse.get(tgt);
    if (!rm.has(field)) rm.set(field, []);
    rm.get(field).push(src);
  }
}
const edgesOf = (idx, node, field) => idx.get(node)?.get(field) || [];
// role.reverse:true → reverse edges (hub <- members); role.direction "both" → both; else forward.
function roleNeighbors(role, node) {
  const out = [];
  const dir = role.direction || (role.reverse === true ? "reverse" : "forward");
  for (const f of roleFieldsOf(role)) {
    if (dir === "forward" || dir === "both") out.push(...edgesOf(forward, node, f));
    if (dir === "reverse" || dir === "both") out.push(...edgesOf(reverse, node, f));
  }
  return out;
}
// The role whose reverseName === "members" (resolved generically, never hardcoded).
const MEMBERS_ROLE = Object.keys(MANIFEST.roles || {}).find((n) => MANIFEST.roles[n].reverseName === "members");

// ---- closure for a set of start ids at a profile ----
// profile = { roles:[...], pointerRoles:[...], depth:{ROLE:cap}, transitive:bool }.
// depth cap: role in profile.depth uses that cap (0 = skip); otherwise a single hop from the roots.
// Returns { seen:Set, addedBy:Map(node→roleName) }.
function closure(startIds, prof) {
  const pcfg = MANIFEST.profiles[prof] || {};
  const seen = new Set(startIds);
  const addedBy = new Map();
  const drop = (cand) => {
    const rec = index.get(cand);
    if (!rec) return true;
    if ((MANIFEST.dropTagsAtLean || []).length && prof === "lean" &&
        (MANIFEST.dropTagsAtLean).some((t) => rec.tags.includes(t))) return true;
    if (includeTag && !rec.tags.includes(includeTag)) return true;
    if (excludeTag && rec.tags.includes(excludeTag)) return true;
    return false;
  };
  const tryAdd = (cand, role, roleName) => {
    if (!index.has(cand) || seen.has(cand)) return false;
    if (role.endpointTypes && !role.endpointTypes.includes(index.get(cand).type)) return false;
    if (drop(cand)) return false;
    seen.add(cand); addedBy.set(cand, roleName); return true;
  };
  const depthOf = (rn) => (pcfg.depth && rn in pcfg.depth) ? pcfg.depth[rn] : 1;
  for (const roleName of pcfg.roles || []) {
    const role = MANIFEST.roles[roleName]; if (!role) continue;
    const cap = depthOf(roleName); if (cap <= 0) continue;
    let frontier = [...startIds];
    for (let d = 0; d < cap && frontier.length; d++) {
      const next = [];
      for (const n of frontier) for (const c of roleNeighbors(role, n)) if (tryAdd(c, role, roleName)) next.push(c);
      frontier = next;
    }
  }
  if (pcfg.transitive) {
    let frontier = [...seen];
    while (frontier.length) {
      const next = [];
      for (const n of frontier) for (const roleName of (pcfg.roles || [])) {
        const role = MANIFEST.roles[roleName]; if (!role) continue;
        for (const c of roleNeighbors(role, n)) if (tryAdd(c, role, roleName)) next.push(c);
      }
      frontier = next;
    }
  }
  return { seen, addedBy };
}

// ---- ordering: start ids first (given order), then manifest typePriority, tie-break codepoint ----
const cp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const PRIO = (t) => { const i = (MANIFEST.typePriority || []).indexOf(t); return i === -1 ? 999 : i; };
function order(seen, startIds) {
  return [...seen].sort((a, b) => {
    const sa = startIds.indexOf(a), sb = startIds.indexOf(b);
    if (sa !== -1 || sb !== -1) return (sa === -1 ? 1e9 : sa) - (sb === -1 ? 1e9 : sb);
    return PRIO(index.get(a).type) - PRIO(index.get(b).type) || cp(a, b);
  });
}
const tokensOf = (nodes) => Math.ceil(nodes.reduce((s, n) => s + index.get(n).body.length, 0) / 4);

// ====================================================================== --lint mode (invariants)
// Invariants may be an ARRAY [{when,assert,onFail}] (canonical) — a threshold RHS is a literal int or a
// dynamic cohort stat (`3*median`, `p90`, `mean`, `max`). Metrics: members|tokens. `when.excludeIds`
// drops ids from cohort + checks.
if (lint) {
  const invariants = Array.isArray(MANIFEST.invariants) ? MANIFEST.invariants : [];
  let failures = 0, checked = 0;
  const stat = (sorted, kind) => {
    if (!sorted.length) return 0;
    if (kind === "median") return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    if (kind === "mean") return sorted.reduce((s, x) => s + x, 0) / sorted.length;
    if (kind === "max") return sorted[sorted.length - 1];
    const pm = kind.match(/^p(\d{1,3})$/);
    if (pm) return sorted[Math.max(0, Math.ceil((Math.min(100, +pm[1]) / 100) * sorted.length) - 1)];
    return NaN;
  };
  for (const inv of invariants) {
    const { targetType, profile: invProfile, excludeIds = [] } = inv.when;
    const skip = new Set(excludeIds);
    const targets = [...index.keys()].filter((n) => index.get(n).type === targetType && !skip.has(n));
    const metrics = new Map();
    for (const node of targets) {
      const { seen, addedBy } = closure([node], invProfile);
      metrics.set(node, {
        members: [...addedBy.values()].filter((r) => r === MEMBERS_ROLE).length,
        tokens: tokensOf(order(seen, [node])),
      });
    }
    const cohort = (metric) => [...metrics.values()].map((m) => m[metric]).sort((a, b) => a - b);
    const threshold = (metric, rhs) => {
      if (/^\d+$/.test(rhs)) return parseInt(rhs, 10);
      const m = rhs.match(/^(?:([0-9]*\.?[0-9]+)\s*\*\s*)?(median|mean|max|p\d{1,3})$/);
      return m ? (m[1] ? parseFloat(m[1]) : 1) * stat(cohort(metric), m[2]) : NaN;
    };
    for (const node of targets) {
      checked++;
      const mv = metrics.get(node);
      for (const assert of inv.assert) {
        const am = assert.match(/^(members|tokens)(>=|<=)(.+)$/);
        if (!am) { console.error(`  ✗ ${node}: unsupported assert "${assert}"`); failures++; continue; }
        const [, metric, op, rhsRaw] = am;
        const N = threshold(metric, rhsRaw.trim());
        if (Number.isNaN(N)) { console.error(`  ✗ ${node}: unsupported threshold "${rhsRaw.trim()}"`); failures++; continue; }
        const actual = mv[metric];
        const ok = op === ">=" ? actual >= N : actual <= N;
        if (!ok) { console.error(`  ✗ ${node} (${targetType}@${invProfile}): ${assert} FAILED — actual ${metric}=${actual} vs ${Math.round(N)}`); failures++; }
      }
    }
  }
  console.error(`[${LABEL} render] --lint: ${checked} target(s) across ${invariants.length} invariant(s) — ${failures} violation(s)`);
  process.exit(failures ? 1 : 0);
}

// ====================================================================== render mode
const unknown = ids.filter((x) => !index.has(x));
if (unknown.length) { console.error(`unknown artifact(s): ${unknown.join(", ")}`); process.exit(2); }

// Auto-upgrade: lean + any start id's type is a key in autoUpgrade → bump profile (idempotent).
if (profile === "lean") for (const id of ids) {
  const up = MANIFEST.autoUpgrade?.[index.get(id).type];
  if (up) { profile = up; break; }
}

const { seen, addedBy } = closure(ids, profile);
const ord = order(seen, ids);

// ---- render form + role-aware budget trim ----
const pcfg = MANIFEST.profiles[profile] || {};
const pointerRoles = new Set(pcfg.pointerRoles || []);
const excerptCap = (MANIFEST.excerptChars || {})[profile] ?? 0;
const budget = (MANIFEST.tokenBudgets || {})[profile] ?? Infinity;
const CONSTRAIN_ROLE = Object.keys(MANIFEST.roles || {}).find((n) => (MANIFEST.roles[n].mandatoryFull === true));
const isStart = (nid) => ids.includes(nid);
const isMandatory = (nid) => isStart(nid) || (CONSTRAIN_ROLE && addedBy.get(nid) === CONSTRAIN_ROLE);
function renderBody(nid) {
  const rec = index.get(nid);
  if (isMandatory(nid)) return rec.body;
  const roleName = addedBy.get(nid);
  if (roleName && pointerRoles.has(roleName)) return rec.sp ? `→ ${rec.sp}` : (rec.body.split("\n").find((l) => l.trim()) || "").trim();
  if (excerptCap > 0 && rec.body.length > excerptCap) return rec.body.slice(0, excerptCap).replace(/\s+\S*$/, "").trimEnd() + " …";
  return rec.body;
}
const nodes = ord.map((nid) => ({ nid, type: index.get(nid).type, body: renderBody(nid) }));
const REFERENCE_ROLES = new Set(MANIFEST.referenceRoles || []);
if (budget !== Infinity) {
  const tot = () => Math.ceil(nodes.reduce((s, r) => s + (r._drop ? 0 : r.body.length), 0) / 4);
  const sacrifice = nodes.map((r, i) => ({ r, i })).filter(({ r }) => !isMandatory(r.nid)).sort((a, b) => {
    const ra = REFERENCE_ROLES.has(addedBy.get(a.r.nid)) ? 0 : 1;
    const rb = REFERENCE_ROLES.has(addedBy.get(b.r.nid)) ? 0 : 1;
    return ra - rb || b.i - a.i;
  });
  for (const { r } of sacrifice) { if (tot() <= budget) break; r._drop = true; }
}
const finalNodes = nodes.filter((r) => !r._drop);
const trimmed = nodes.length - finalNodes.length;
const contentTok = Math.ceil(finalNodes.reduce((s, r) => s + r.body.length, 0) / 4);
console.error(`[${LABEL} render] roots=${ids.join("+")} profile=${profile} closure=${finalNodes.length} notes ~${contentTok} content-tok${trimmed ? ` (+${trimmed} budget-trimmed)` : ""}${includeTag ? ` +tag=${includeTag}` : ""}${excludeTag ? ` -tag=${excludeTag}` : ""}`);

if (dryRun) {
  for (const r of finalNodes) console.error(`  - ${r.nid} (${r.type})${isMandatory(r.nid) ? " [full]" : pointerRoles.has(addedBy.get(r.nid)) ? " [pointer]" : excerptCap > 0 && index.get(r.nid).body.length > excerptCap ? " [excerpt]" : ""}`);
  process.exit(0);
}

const body = finalNodes.map((r) => `\n<!-- ${r.nid} (${r.type}) -->\n${r.body}`).join("\n");
const trailers = buildTrailers(MANIFEST, { root: ROOT });
const out = body + "\n" + trailers;

if (copy) {
  const tool = process.platform === "darwin" ? ["pbcopy", []]
    : process.platform === "win32" ? ["clip", []]
    : ["xclip", ["-selection", "clipboard"]];
  const r = spawnSync(tool[0], tool[1], { input: out });
  if (r.error || r.status !== 0) {
    console.error(`[${LABEL} render] --copy: '${tool[0]}' unavailable — stdout fallback. (${r.error?.message || `exit ${r.status}`})`);
    process.stdout.write(out);
  } else {
    console.error(`[${LABEL} render] ✓ copied ${finalNodes.length} notes (~${contentTok} tok) to clipboard.`);
  }
} else {
  process.stdout.write(out);
}
