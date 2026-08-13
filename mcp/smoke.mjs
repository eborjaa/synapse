#!/usr/bin/env node
// smoke.mjs — drive synapse-mcp over stdio.
//   npm run smoke                  # full (default)
//   node mcp/smoke.mjs --skeleton
//   node mcp/smoke.mjs --standard
//
// Runs against THIS repo as the vault (it is itself a Synapse vault). Consumer-specific tools are
// plugins and are deliberately not asserted here — see SYNAPSE_MCP_PLUGINS in server.mjs.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "server.mjs");
// This repo is itself a vault (flat layout): mcp/ → repo root.
const vault = join(HERE, "..");

const surface = process.argv.includes("--skeleton")
  ? "skeleton"
  : process.argv.includes("--standard")
    ? "standard"
    : process.argv.includes("--orchestrator")
      ? "orchestrator"
      : "full";

const EXPECTED = {
  skeleton: ["synapse_list_agents", "synapse_list_hubs", "synapse_render"],
  standard: [
    "synapse_list_agents", "synapse_list_hubs", "synapse_render",
    "synapse_brief", "synapse_augment",
    "synapse_embeddings_status", "synapse_embeddings_rebuild",
    "synapse_lint",
  ],
  full: [
    "synapse_list_agents", "synapse_list_hubs", "synapse_render",
    "synapse_brief", "synapse_augment",
    "synapse_embeddings_status", "synapse_embeddings_rebuild",
    "synapse_lint",
    "synapse_handover_list", "synapse_handover_resolve", "synapse_handover_read",
    "synapse_handover_write", "synapse_resume_from_handover",
    "synapse_create_hub", "synapse_create_agent", "synapse_create_note", "synapse_create_handover",
  ],
};
// orchestrator = full + the durable-spawn tools.
EXPECTED.orchestrator = [
  ...EXPECTED.full,
  "synapse_spawn", "synapse_spawn_status", "synapse_spawn_list",
  "synapse_spawn_renew", "synapse_spawn_release",
];

const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
let failures = 0;

const client = new Client({ name: "synapse-smoke", version: "0.1.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ["--experimental-sqlite", SERVER],
  stderr: "ignore",
  env: {
    ...process.env,
    SYNAPSE_VAULT: vault,
    SYNAPSE_MCP_SURFACE: surface,
  },
}));

const text = (r) => (r.content || []).map((c) => c.text ?? "").join("\n");

console.log(`\nsurface=${surface}`);
console.log("\ntools/list");
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(`  ${names.length} tools: ${names.join(", ")}`);

const expected = EXPECTED[surface];
for (const n of expected) {
  names.includes(n) ? pass(`${n} registered`) : fail(`${n} missing`);
}
// Built-ins must be an EXACT match; plugin tools are additive and named separately, so we assert
// "no unexpected built-ins" rather than a bare count that a plugin would break.
const extra = names.filter((n) => !expected.includes(n));
if (!process.env.SYNAPSE_MCP_PLUGINS) {
  extra.length === 0
    ? pass(`exactly ${expected.length} tools`)
    : fail(`unexpected tools: ${extra.join(", ")}`);
} else {
  pass(`${expected.length} built-ins + ${extra.length} plugin tool(s): ${extra.join(", ") || "none"}`);
}

console.log("\nsynapse_list_agents");
const agents = text(await client.callTool({ name: "synapse_list_agents", arguments: {} }));
/oracle/.test(agents) ? pass("oracle present") : fail(agents.slice(0, 200));

if (surface !== "skeleton") {
  console.log("\nsynapse_lint");
  const lint = text(await client.callTool({ name: "synapse_lint", arguments: {} }));
  /synapse lint|errors=|WARNINGS|clean/i.test(lint)
    ? pass(`lint ok (${lint.length} bytes)`)
    : fail(lint.slice(0, 300));

  console.log("\nsynapse_brief");
  const brief = text(await client.callTool({
    name: "synapse_brief",
    arguments: { agent: "oracle", hub: "hub-career", profile: "lean" },
  }));
  brief.length > 800 ? pass(`brief ${brief.length} bytes`) : fail(`brief short ${brief.length}`);
}

if (surface === "full" || surface === "orchestrator") {
  console.log("\nsynapse_handover_list");
  await client.callTool({ name: "synapse_handover_list", arguments: { limit: 5 } });
  pass("handover_list ok");

  // The human gate: a create call without write:true must render the note and touch nothing.
  console.log("\nsynapse_create_note (propose-only)");
  const probe = join(vault, "rules", "rule-smoke-probe.md");
  const proposed = text(await client.callTool({
    name: "synapse_create_note",
    arguments: { slug: "smoke-probe", type: "rule", used_by: ["curator"] },
  }));
  /PROPOSED \(nothing written\)/.test(proposed) ? pass("proposes") : fail(proposed.slice(0, 200));
  /applies_rules \+= \[\[rule-smoke-probe\]\]/.test(proposed)
    ? pass("plans the inbound edge into agent-curator.applies_rules")
    : fail("inbound edge not planned");
  existsSync(probe) ? fail("propose WROTE a file — the human gate leaks") : pass("nothing written to disk");
}

await client.close();
console.log(failures ? `\nFAILED (${failures})` : "\nOK");
process.exit(failures ? 1 : 0);
