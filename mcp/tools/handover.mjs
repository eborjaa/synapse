// handover.mjs — list / resolve / read / write / resume.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { normalizeAgentId, asToolResult } from "../vault.mjs";
import { envPinnedContext } from "../vault-context.mjs";

function resolveRef(vault, ref) {
  vault.ensureHandoverDir();
  const needle = String(ref).replace(/\.md$/, "").toLowerCase();
  const files = readdirSync(vault.handoverDir).filter((f) => f.endsWith(".md") && f !== "README.md");
  const exact = files.filter((f) => f.replace(/\.md$/, "").toLowerCase() === needle);
  if (exact.length === 1) return { status: "unique", file: exact[0] };
  const partial = files.filter((f) => f.toLowerCase().includes(needle));
  if (partial.length === 1) return { status: "unique", file: partial[0] };
  if (partial.length === 0) return { status: "missing", matches: [] };
  return { status: "ambiguous", matches: partial };
}

export function registerHandoverTools(server, vault = envPinnedContext()) {
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
      const files = vault.listHandoverFiles().slice(0, n);
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
      const r = resolveRef(vault, ref);
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
      const r = resolveRef(vault, ref);
      if (r.status !== "unique") {
        return {
          isError: true,
          content: [{ type: "text", text: `Cannot read: ${r.status}` }],
        };
      }
      const path = join(vault.handoverDir, r.file);
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
      const path = vault.writeHandoverNote(filename, body);
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
      // The vaultDir comes from the BOUND context, not a fresh resolveVault(): that default is cwd-first,
      // so this tool used to read handovers from the server's working directory rather than the vault
      // the request was for — invisible on stdio where they coincide, a cross-vault read once they do not.
      const { noteAsTask } = await import("../../lib/note-as-task.mjs");
      const nt = noteAsTask(ref, { vaultDir: vault.vaultDir, handover: true });
      if (!nt.ok) return { isError: true, content: [{ type: "text", text: `Cannot resume: ${nt.reason}` }] };

      // The note IS the task: augment briefs the agent AND uses the note text as the recall query, so
      // the briefing surfaces notes relevant to the handover — render alone would miss that.
      const id = normalizeAgentId(agent || "oracle");
      const args = ["augment", id, "--task", nt.task];
      if (profile) args.push("--profile", profile);
      const brief = asToolResult(await vault.runSynapse(args));
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
