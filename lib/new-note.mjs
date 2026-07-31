#!/usr/bin/env node
// new-note.mjs — `synapse new <kind> …`: scaffold a correctly-wired note.
//
//   synapse new hub climbing [--parent hub-synapse]
//   synapse new agent scribe --purpose "Draft release notes" --rules rule-canary --tools tool-git
//   synapse new note zone2-pacing --type note --hub hub-health
//   synapse new handover continue-gate-6 --plan plan-buzz-gated-learning
//
// Dry-run by default; --write applies (same convention as `synapse install --write`).
// Refuses to overwrite, and refuses a duplicate basename anywhere in the vault — ids are global
// (conventions §1), so a duplicate silently shadows a note in both Obsidian and the renderer.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveVault } from "./vault-root.mjs";
import { build, existingIds, wireInbound, AUTHORABLE_TYPES, DIR_FOR_TYPE } from "./scaffold.mjs";
import { fieldForLink, typeForId } from "./schema.mjs";

const argv = process.argv.slice(2);
const KINDS = ["hub", "agent", "note", "handover"];

const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const list = (name) => (flag(name) || "").split(",").map((s) => s.trim()).filter(Boolean);
const write = argv.includes("--write");

const [kind, slug] = argv.filter((a) => !a.startsWith("--"));

if (!kind || !KINDS.includes(kind) || !slug || argv.includes("--help")) {
  console.log(`synapse new — scaffold a correctly-wired note

usage: synapse new <kind> <name> [options] [--write]

kinds:
  hub <domain>        a new domain hub            [--parent <hub-id>]
  agent <id>          a new agent                 --purpose "…" [--rules a,b] [--tools a,b]
                                                  [--skills a,b] [--delegates a,b]
  note <slug>         any authorable typed note   [--type <type>] [--hub <hub-id>]
  handover <slug>     an inbox/handovers entry    [--plan <plan-id>]

wiring:
  --used-by a,b       agents that should cite this note. Adds the INBOUND edge to each agent's
                      frontmatter, in the field its type requires (rule -> applies_rules,
                      tool -> uses_tools, skill -> invokes_skills). Without it a new rule/tool
                      is valid but unreachable, and lints as an orphan.

common:
  --title "…"         heading + frontmatter title (default: derived from the name)
  --tags a,b          extra tags (type/<type> and status/active are added for you)
  --link a,b          extra links; each is placed in the field its target type requires
  --write             actually create the file (default: print what would be created)

--type accepts: ${AUTHORABLE_TYPES.join(", ")}`);
  process.exit(kind ? 0 : 2);
}

// preferCwd: scaffolding is a WRITE, and a stale $SYNAPSE_VAULT exported in a shell rc would
// otherwise silently create the note in a different vault than the one you are standing in.
// `synapse install` guards the same way (install.mjs:41). The resolved vault is echoed on every
// run so the destination is never ambiguous.
const { root, vaultDir, manifest } = resolveVault({ preferCwd: true });

let out;
try {
  out = build({
    kind,
    slug,
    type: flag("type"),
    title: flag("title"),
    tags: list("tags"),
    links: [...list("link"), ...list("rules"), ...list("tools"), ...list("skills"), ...list("delegates")],
    hub: flag("hub"),
    parent: flag("parent"),
    purpose: flag("purpose"),
    plan: flag("plan"),
    manifest,
  });
} catch (err) {
  console.error(`synapse new: ${err.message}`);
  process.exit(2);
}

const abs = join(vaultDir, out.path);

if (existsSync(abs)) {
  console.error(`synapse new: already exists — ${out.path}`);
  process.exit(1);
}
if (out.type !== "handover" && existingIds(root, manifest.skipDirs || []).has(out.id)) {
  console.error(
    `synapse new: id "${out.id}" already exists elsewhere in the vault. `
    + "Note ids are global — pick another name.",
  );
  process.exit(1);
}

// --used-by: add the INBOUND edge from each named agent. Without it a rule/tool/skill is valid but
// unreachable — see wireInbound() in scaffold.mjs.
const usedBy = list("used-by");
const needsInbound = !usedBy.length && !["agent", "handover"].includes(out.type);
const inboundPlan = usedBy.map((agentId) => {
  const id = agentId.startsWith("agent-") ? agentId : `agent-${agentId}`;
  const p = join(vaultDir, DIR_FOR_TYPE.agent, `${id}.md`);
  if (!existsSync(p)) {
    console.error(`synapse new: --used-by agent not found — ${DIR_FOR_TYPE.agent}/${id}.md`);
    process.exit(1);
  }
  return { id, p, field: fieldForLink({ sourceType: "agent", targetType: out.type, manifest }) };
});

if (!write) {
  for (const { id, field } of inboundPlan) {
    console.log(`would wire: ${id}.${field} += [[${out.id}]]`);
  }
  if (needsInbound) {
    console.log(`note: nothing would link to ${out.id} — it will lint as an orphan. Consider --used-by <agent-id>.\n`);
  }
  console.log(`--- ${out.path} (dry-run, vault: ${vaultDir}) ---\n`);
  console.log(out.content);
  console.log(`--- re-run with --write to create ---`);
  process.exit(0);
}

const wired = [];
for (const { id, p, field } of inboundPlan) {
  try {
    const { content, changed } = wireInbound(readFileSync(p, "utf8"), field, out.id);
    if (changed) writeFileSync(p, content, "utf8");
    wired.push(changed ? `wired: ${id}.${field} += [[${out.id}]]` : `already wired: ${id}.${field}`);
  } catch (err) {
    console.error(`synapse new: could not wire ${id} — ${err.message}`);
    process.exit(1);
  }
}

mkdirSync(dirname(abs), { recursive: true });
writeFileSync(abs, out.content, "utf8");
console.log(`synapse new: created ${out.path}`);
console.log(`  vault: ${vaultDir}`);
for (const line of wired) console.log(`  ${line}`);
console.log(
  wired.length
    ? `next: fill the TODOs, then run 'synapse lint'`
    : `next: fill the TODOs, then run 'synapse lint'`
    + (needsInbound ? `\nnote: nothing links to ${out.id} yet — it will lint as an orphan. `
      + `Re-run with --used-by <agent-id>, or add the link by hand.` : ""),
);
