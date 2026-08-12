// authoring.mjs — scaffold correctly-wired notes over MCP. FULL surface only.
//
// PROPOSE BY DEFAULT. Every tool returns the path + rendered content and writes nothing unless
// `write: true` is passed ([[rule-synapse-human-gated-push]]). That keeps a read-only agent honest:
// run oracle on the `standard` surface and these tools are not registered at all, so "the read front
// door never mutates" is a property of the surface rather than a line in a prompt.
//
// Same lib/scaffold.mjs core as `synapse new`, so CLI and MCP cannot diverge.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import { VAULT, manifest } from "../vault.mjs";
import { build, existingIds, wireInbound, DIR_FOR_TYPE, AUTHORABLE_TYPES } from "../../lib/scaffold.mjs";
import { fieldForLink } from "../../lib/schema.mjs";

const asText = (text, isError = false) => ({ isError, content: [{ type: "text", text }] });

/** Shared: build → validate → (optionally) write + wire. */
function run({ kind, args }) {
  const m = manifest();
  let out;
  try {
    out = build({ ...args, kind, manifest: m });
  } catch (err) {
    return asText(`Cannot scaffold: ${err.message}`, true);
  }

  const abs = join(VAULT, out.path);
  if (existsSync(abs)) return asText(`Already exists: ${out.path}`, true);
  if (out.type !== "handover" && existingIds(VAULT, m.skipDirs || []).has(out.id)) {
    return asText(`Id "${out.id}" already exists elsewhere — note ids are global. Pick another name.`, true);
  }

  // Resolve the inbound edges (agents that should cite this note) before deciding to write.
  const usedBy = (args.used_by || []).map((a) => (a.startsWith("agent-") ? a : `agent-${a}`));
  const plan = [];
  for (const id of usedBy) {
    const p = join(VAULT, DIR_FOR_TYPE.agent, `${id}.md`);
    if (!existsSync(p)) return asText(`used_by agent not found: ${DIR_FOR_TYPE.agent}/${id}.md`, true);
    plan.push({ id, p, field: fieldForLink({ sourceType: "agent", targetType: out.type, manifest: m }) });
  }

  const orphanWarning = !usedBy.length && !["agent", "handover"].includes(out.type)
    ? `\n\nNOTE: nothing links to ${out.id} yet, so it will lint as an orphan — pass `
      + `used_by: ["<agent-id>"] to add the inbound edge.`
    : "";
  const wiring = plan.length
    ? `\n\nInbound edges: ${plan.map((w) => `${w.id}.${w.field} += [[${out.id}]]`).join(" · ")}`
    : "";

  if (!args.write) {
    return asText(
      `PROPOSED (nothing written). Re-call with write: true to apply.\n\n`
      + `path: ${out.path}${wiring}${orphanWarning}\n\n--- content ---\n${out.content}`,
    );
  }

  const done = [];
  for (const { id, p, field } of plan) {
    try {
      const { content, changed } = wireInbound(readFileSync(p, "utf8"), field, out.id);
      if (changed) writeFileSync(p, content, "utf8");
      done.push(`${changed ? "wired" : "already wired"}: ${id}.${field}`);
    } catch (err) {
      return asText(`Created nothing — could not wire ${id}: ${err.message}`, true);
    }
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, out.content, "utf8");

  return asText(
    `Created ${out.path}${done.length ? `\n${done.join("\n")}` : ""}${orphanWarning}\n\n`
    + `Next: fill the TODOs, then run synapse_lint.${operatorSteps(out, args)}`,
  );
}

/**
 * Creating the note is only step 1 of standing up a runnable agent. The remaining steps belong to
 * the OPERATOR (Cortex), and every one of them fails silently when skipped — the agent looks healthy
 * while being un-runnable, unobservable, or toolless. Spelling them out here is the difference
 * between "an agent was created" and "an agent is running", which is what the caller actually wanted.
 */
function operatorSteps(out, args) {
  if (out.type !== "agent" || !args.addressable) return "";
  const name = out.id.replace(/^agent-/, "");
  return "\n\nThis agent is `addressable: true`, so an operator can run it. Remaining steps "
    + "(from the Cortex instance directory):\n"
    + `  1. cortex start ${name}          — provisions keys, registers on the relay, joins channels\n`
    + `  2. cortex attest ${name}         — owner attestation + kind:10100 directory record;\n`
    + "                                     needs the OWNER's secret key, so a human runs it.\n"
    + "                                     Skip it and the agent replies fine but its activity is\n"
    + "                                     invisible to the client — nothing logs the omission.\n"
    + `  3. cortex sync-mcp-auth          — copies MCP OAuth into the new agent's project store\n`
    + "                                     (auth is per-CWD; a human's login does not cover agents).\n"
    + "Run `cortex doctor` to confirm all three landed.";
}

const common = {
  title: z.string().optional().describe("Heading + frontmatter title (default: derived from the name)"),
  tags: z.array(z.string()).optional().describe("Extra tags; type/<type> and status/active are added for you"),
  links: z.array(z.string()).optional()
    .describe("Note ids to link; each is placed in the frontmatter field its target type requires"),
  used_by: z.array(z.string()).optional()
    .describe("Agent ids that should cite this note — adds the INBOUND edge, which is what prevents an orphan"),
  body: z.string().optional()
    .describe("Full Markdown body below the H1. When given, it replaces the TODO-stub scaffold; a "
      + "## Related section for the hub/parent links is appended unless you write your own. Omit it to "
      + "get the per-type stub."),
  write: z.boolean().optional().describe("false (default) proposes; true creates the file"),
};

export function registerAuthoringTools(server) {
  server.registerTool("synapse_create_hub", {
    title: "Create a hub",
    description:
      "Scaffold a new hub-<domain> note. Proposes by default — pass write:true to create. "
      + "Members are notes that link TO the hub; never hand-list them.",
    inputSchema: { slug: z.string().describe("Domain name, e.g. 'climbing'"),
      parent: z.string().optional().describe("Parent hub id for sub-hub composition"), ...common },
  }, async (args) => run({ kind: "hub", args }));

  server.registerTool("synapse_create_agent", {
    title: "Create an agent",
    description:
      "Scaffold a new agent-<id> note with the lint-required purpose + invokes_skills. Rules, tools, "
      + "skills and delegate agents passed in `links` are routed to applies_rules / uses_tools / "
      + "invokes_skills / delegates_to automatically. Proposes by default.\n\n"
      + "Pass addressable:true to make it a STANDING agent an operator (Cortex) will actually run — "
      + "without that flag the note is a valid agent that nothing ever starts. Creating the note is "
      + "step 1 of 3; the tool tells you the remaining operator steps.",
    inputSchema: { slug: z.string().describe("Agent id without the agent- prefix"),
      purpose: z.string().optional().describe("One sentence: what this agent is for"),
      addressable: z.boolean().optional()
        .describe("true = a standing agent Cortex should provision and run (adds `addressable: true`). "
          + "Default false: a role/persona note used only for rendering briefings."),
      ...common },
  }, async (args) => run({ kind: "agent", args }));

  server.registerTool("synapse_create_note", {
    title: "Create a typed note",
    description:
      `Scaffold any authorable typed note (${AUTHORABLE_TYPES.join(", ")}). The filename prefix and `
      + "`type:` are kept consistent, and per-type required fields are filled or TODO-stubbed. "
      + "Proposes by default.",
    inputSchema: {
      slug: z.string().describe("Name without the type prefix"),
      type: z.enum(AUTHORABLE_TYPES).optional().describe("Note type (default: note)"),
      hub: z.string().optional().describe("Hub to bind this note to, via related"),
      ...common,
    },
  }, async (args) => run({ kind: "note", args }));

  server.registerTool("synapse_create_handover", {
    title: "Create a handover note",
    description:
      "Scaffold inbox/handovers/<date>-<slug>.md — the context handoff shape (goal / done / what's "
      + "left / escalations). Proposes by default. Human-triggered: do not call unless asked.",
    inputSchema: { slug: z.string().describe("Short slug, e.g. 'continue-gate-6'"),
      plan: z.string().optional().describe("Plan note id to inherit first"), ...common },
  }, async (args) => run({ kind: "handover", args }));
}
