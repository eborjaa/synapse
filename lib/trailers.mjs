// trailers.mjs — always-on session-health trailers appended to EVERY render.
//
// A render's leading sections are cache-pinned; these fixed trailers are appended AFTER the closure so
// they never disturb prompt-cache. They carry cross-cutting protocols (canary, handover, and any the
// consumer opts into) so every agent/skill/recipe inherits them without per-note wiring.
//
// DATA-DRIVEN: the consumer's context.manifest.json controls which trailers render, via
//   "trailers": { "canary": true, "handover": true, "loop": false, "commentIntegrity": false,
//                 "custom": [ { "id": "...", "text": "..." } ] }
// Defaults: canary + handover on (the universally-safe pair); the rest off. The canary NAME is
// resolved per-user at render time so the shared, committed vault stays name-neutral.

import { spawnSync } from "node:child_process";

function resolveUserName(root) {
  const env = (process.env.VAULT_USER || "").trim();
  if (env) return env;
  const r = spawnSync("git", ["config", "user.email"], { cwd: root, encoding: "utf8" });
  const email = (r.status === 0 ? r.stdout : "").trim();
  const first = (email.split("@")[0] || "").split(/[.\-_]/)[0];
  if (first) return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  return null;
}

function canaryTrailer(name) {
  const addr = name ? `by name ("${name}")` : "by their name (set $VAULT_USER or git user.email so renders resolve it)";
  return [
    "",
    "<!-- session-health canary — always on -->",
    "## ⚠️ Session-health canaries (honor every turn)",
    `1. **Address the user ${addr} at least once in every response.** A turn that silently drops`,
    "   this is a degradation signal — flag it and suggest a refresh/handover.",
  ].join("\n");
}

const HANDOVER_TRAILER = [
  "",
  "<!-- context-handover protocol — always on -->",
  "## ⟳ Context-window handover protocol",
  "Handover is human-triggered: you cannot read your own context-window % — never claim to self-monitor.",
  "On request: finish the current atomic step (no half-done files), write a handover note capturing goal,",
  "locked decisions, work done, exact next actions, open questions, and key files/links; then hand back the",
  "relaunch command. A handover moves context, not authorization — every normal gate still holds.",
].join("\n");

// Render the enabled trailers in a fixed order for byte-stability.
export function buildTrailers(manifest, { root } = {}) {
  const cfg = manifest.trailers || {};
  const on = (k, def) => (k in cfg ? !!cfg[k] : def);
  const parts = [];
  if (on("canary", true)) parts.push(canaryTrailer(resolveUserName(root)));
  if (on("handover", true)) parts.push(HANDOVER_TRAILER);
  for (const c of cfg.custom || []) if (c && c.text) parts.push("\n<!-- custom trailer: " + (c.id || "") + " -->\n" + c.text);
  return parts.length ? parts.join("\n") + "\n" : "";
}
