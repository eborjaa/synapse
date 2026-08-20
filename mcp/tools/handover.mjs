// handover.mjs — list / resolve / read / write / resume.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import {
  HANDOVER_DIR, join, listHandoverFiles, ensureHandoverDir, writeHandoverNote,
  normalizeAgentId, runSynapse, asToolResult,
} from "../vault.mjs";

function resolveRef(ref) {
  ensureHandoverDir();
  const needle = String(ref).replace(/\.md$/, "").toLowerCase();
  const files = readdirSync(HANDOVER_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
  const exact = files.filter((f) => f.replace(/\.md$/, "").toLowerCase() === needle);
  if (exact.length === 1) return { status: "unique", file: exact[0] };
  const partial = files.filter((f) => f.toLowerCase().includes(needle));
  if (partial.length === 1) return { status: "unique", file: partial[0] };
  if (partial.length === 0) return { status: "missing", matches: [] };
  return { status: "ambiguous", matches: partial };
}

export function registerHandoverTools(server) {
  server.registerTool(
    "synapse_handover_list",
    {
      title: "List handover notes",
      description: "List notes in inbox/handovers/, newest-ish first (filename sort reverse).",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Max entries (default 20)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const n = limit ?? 20;
      const files = listHandoverFiles().slice(0, n);
      if (!files.length) {
        return { content: [{ type: "text", text: "No handover notes in inbox/handovers/." }] };
      }
      return {
        content: [{
          type: "text",
          text: files.map((f) => `- ${f}`).join("\n"),
        }],
      };
    },
  );

  server.registerTool(
    "synapse_handover_resolve",
    {
      title: "Resolve a handover ref",
      description: "Fuzzy ref → unique | ambiguous | missing.",
      inputSchema: {
        ref: z.string().describe("Filename or substring without requiring .md"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ref }) => {
      const r = resolveRef(ref);
      if (r.status === "unique") {
        return { content: [{ type: "text", text: `unique: ${r.file}` }] };
      }
      if (r.status === "ambiguous") {
        return {
          content: [{
            type: "text",
            text: `ambiguous (${r.matches.length}):\n${r.matches.map((m) => `- ${m}`).join("\n")}`,
          }],
        };
      }
      return {
        isError: true,
        content: [{ type: "text", text: `missing: no handover matching '${ref}'` }],
      };
    },
  );

  server.registerTool(
    "synapse_handover_read",
    {
      title: "Read a handover note",
      description: "Read one handover note by unique ref.",
      inputSchema: {
        ref: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ref }) => {
      const r = resolveRef(ref);
      if (r.status !== "unique") {
        return {
          isError: true,
          content: [{ type: "text", text: `Cannot read: ${r.status}` }],
        };
      }
      const path = join(HANDOVER_DIR, r.file);
      const body = readFileSync(path, "utf8");
      return {
        content: [{ type: "text", text: `# file: ${r.file}\n\n${body}` }],
      };
    },
  );

  server.registerTool(
    "synapse_handover_write",
    {
      title: "Write a handover note",
      description:
        "Write inbox/handovers/<filename>. Explicit human request only — does not commit or authorize work.",
      inputSchema: {
        filename: z.string().describe("e.g. handover-2026-07-30-buzz-mcp.md"),
        body: z.string().describe("Full markdown body including frontmatter if desired"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ filename, body }) => {
      const path = writeHandoverNote(filename, body);
      return {
        content: [{ type: "text", text: `Wrote ${path}\n(Commit yourself — this tool does not git-add.)` }],
      };
    },
  );

  server.registerTool(
    "synapse_resume_from_handover",
    {
      title: "Resume from a handover note",
      description:
        "Resolve a handover, prepend a short successor protocol, then brief an agent (render).",
      inputSchema: {
        ref: z.string(),
        agent: z.string().default("oracle").describe("Agent to brief for succession"),
        profile: z.enum(["lean", "standard", "fat"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ref, agent, profile }) => {
      // Resolve via the shared lib: a path anywhere (incl. a skipDir like journal/) OR a fuzzy slug in
      // inbox/handovers/ — matching the CLI (`synapse handover-task`) and launcher (`--handover`) exactly.
      const { resolveVault } = await import("../../lib/vault-root.mjs");
      const { noteAsTask } = await import("../../lib/note-as-task.mjs");
      const { vaultDir } = resolveVault();
      const nt = noteAsTask(ref, { vaultDir, handover: true });
      if (!nt.ok) return { isError: true, content: [{ type: "text", text: `Cannot resume: ${nt.reason}` }] };

      // The note IS the task: augment briefs the agent AND uses the note text as the recall query, so
      // the briefing surfaces notes relevant to the handover — render alone would miss that.
      const id = normalizeAgentId(agent || "oracle");
      const args = ["augment", id, "--task", nt.task];
      if (profile) args.push("--profile", profile);
      const brief = asToolResult(await runSynapse(args));
      const briefText = brief.content?.[0]?.text || "";
      return {
        content: [{
          type: "text",
          text: `${briefText}\n\n---\n\n# Your task (from ${basename(nt.path)})\n\n${nt.task}`,
        }],
      };
    },
  );
}
