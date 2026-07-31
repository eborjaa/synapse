// agents.mjs — Gate 1 skeleton (list agents/hubs, render) + optional brief (full surface).

import { join, relative } from "node:path";
import { z } from "zod";
import {
  AGENTS_DIR, VAULT, listAgentFiles, listHubFiles, readFrontmatter,
  normalizeAgentId, runSynapse, asToolResult,
} from "../vault.mjs";

const PROFILE = z.enum(["lean", "standard", "fat"]);

/** Gate 1: discovery + deterministic render (one hub in the happy path). */
export function registerSkeletonTools(server) {
  server.registerTool(
    "synapse_list_agents",
    {
      title: "List Synapse agents",
      description:
        "List every agent defined in the vault (agents/agent-*.md) with id, title, purpose. "
        + "Call this first when you don't know which agent id to use.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const agents = listAgentFiles().map((f) => {
        const fm = readFrontmatter(join(AGENTS_DIR, f));
        return {
          id: fm.id || f.replace(/\.md$/, ""),
          short: (fm.id || f).replace(/^agent-/, "").replace(/\.md$/, ""),
          title: fm.title || "",
          purpose: fm.purpose || "",
        };
      });
      return {
        content: [{
          type: "text",
          text: `${agents.length} agents:\n\n`
            + agents.map((a) => `- **${a.short}** (\`${a.id}\`) — ${a.purpose || a.title}`).join("\n"),
        }],
      };
    },
  );

  server.registerTool(
    "synapse_list_hubs",
    {
      title: "List Synapse hubs",
      description:
        "List hub ids (hub-*.md) for use as the single domain target in synapse_render. "
        + "Happy path: pick one parent hub (e.g. hub-finances), not several.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const hubs = listHubFiles().map(({ id, path }) => {
        const fm = readFrontmatter(path);
        return {
          id,
          title: fm.title || id,
          path: relative(VAULT, path),
        };
      });
      return {
        content: [{
          type: "text",
          text: `${hubs.length} hubs:\n\n`
            + hubs.map((h) => `- **${h.id}** — ${h.title} (\`${h.path}\`)`).join("\n"),
        }],
      };
    },
  );

  server.registerTool(
    "synapse_render",
    {
      title: "Render a Synapse closure",
      description:
        "Render the deterministic wikilink closure — offline, byte-stable, no semantic recall. "
        + "Happy path: ids = [agent-id, one-hub-id], e.g. ['agent-oracle','hub-career']. "
        + "Prefer one hub so typed context stays coherent. dryRun lists the closure without bodies.",
      inputSchema: {
        ids: z.array(z.string()).min(1)
          .describe("Start ids. Prefer [agent, one hub], e.g. ['agent-oracle','hub-finances']"),
        profile: PROFILE.optional().describe("lean | standard | fat"),
        dryRun: z.boolean().optional().describe("List closure without emitting bodies"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ids, profile, dryRun }) => {
      const args = ["render", ...ids];
      if (profile) args.push("--profile", profile);
      if (dryRun) args.push("--dry-run");
      return asToolResult(await runSynapse(args));
    },
  );
}

/** Gate 2: convenience wrapper — one optional hub; task enables augment. */
export function registerBriefTool(server) {
  server.registerTool(
    "synapse_brief",
    {
      title: "Brief a Synapse agent (render + optional augment)",
      description:
        "Build an agent briefing TEXT and return it — does NOT start a chat/session and does NOT "
        + "mutate the vault. Without task: deterministic render only. With task: render + semantic "
        + "augment. Pass exactly one hub (e.g. hub-finances) — do not stack hubs; use task/augment "
        + "for cross-domain hints.",
      inputSchema: {
        agent: z.string().describe("Agent id short or full (e.g. 'oracle' or 'agent-oracle')"),
        hub: z.string().optional().describe("Exactly one hub target, e.g. 'hub-career'"),
        profile: PROFILE.optional(),
        task: z.string().optional()
          .describe("Question/task — enables semantic augment for cross-domain suggestions"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agent, hub, profile, task }) => {
      const id = normalizeAgentId(agent);
      const ids = hub ? [id, hub] : [id];
      if (task) {
        const args = ["augment", ...ids, "--task", task];
        if (profile) args.push("--profile", profile);
        return asToolResult(await runSynapse(args));
      }
      const args = ["render", ...ids];
      if (profile) args.push("--profile", profile);
      return asToolResult(await runSynapse(args));
    },
  );
}
