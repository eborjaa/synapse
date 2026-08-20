// agents.test.mjs — brief/render tools + the CONTRACT that an on-demand "Fetch before you act" pointer
// recommends a call the surface can actually service. A live agent session hit the gap: the pointer said
// `synapse_brief(note: "<id>")` but the tool had no `note` param — the fetch failed and the agent fell
// back to reading files by hand. Tests passed anyway because none drove the recommended call.
//
// ONE shared vault, set up before importing the tools: mcp/vault.mjs pins `VAULT` at first import, so
// per-test temp vaults would break isolation (and that memoization is correct for the real one-shot
// server). This mirrors the server: one vault, imported once.
//   node --experimental-sqlite --test mcp/tools/agents.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const M = {
  repo: "t", logLabel: "synapse", vaultRoot: ".", skipDirs: ["node_modules"],
  roles: { CONSTRAINS: { field: "applies_rules", direction: "forward", mandatoryFull: true },
    ATTACHES: { field: "related", direction: "forward", endpointTypes: ["doc"] } },
  profiles: { lean: { roles: ["CONSTRAINS"], depth: {} }, standard: { roles: ["CONSTRAINS", "ATTACHES"], depth: { ATTACHES: 1 } }, fat: { roles: ["CONSTRAINS", "ATTACHES"], depth: {} } },
  tokenBudgets: { lean: 4000, standard: 15000, fat: 30000 }, excerptChars: { lean: 40, standard: 4000, fat: 0 },
  typePriority: ["agent", "rule", "doc"], trailers: { canary: false }, invariants: [],
};
const note = (id, type, fm = "", body = "body-" + id) =>
  `---\nid: ${id}\ntype: ${type}\ntitle: ${id}\ntags:\n  - type/${type}\n${fm}---\n${body}\n`;

const VAULT = mkdtempSync(join(tmpdir(), "agents-t-"));
mkdirSync(join(VAULT, "_meta", "tools"), { recursive: true });
writeFileSync(join(VAULT, "_meta", "tools", "context.manifest.json"), JSON.stringify(M));
const put = (rel, c) => { const p = join(VAULT, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
put("agents/agent-lead.md", note("agent-lead", "agent", "purpose: lead\napplies_rules: [[rule-r]]\n"));
put("rules/rule-r.md", note("rule-r", "rule", "related: [[doc-tmpl]]\n", "the binding rule"));
put("docs/doc-tmpl.md", note("doc-tmpl", "doc", 'on_demand: true\ntrigger: "before writing"\n', "TEMPLATE-BODY the real template"));
process.env.SYNAPSE_VAULT = VAULT;
process.on("exit", () => { try { rmSync(VAULT, { recursive: true, force: true }); } catch {} });

const { registerSkeletonTools, registerBriefTool } = await import("./agents.mjs");
const H = {};
const server = { registerTool: (n, _s, fn) => { H[n] = fn; } };
registerSkeletonTools(server); registerBriefTool(server);
const call = async (n, a) => { const r = await H[n](a); return { text: r.content?.[0]?.text || "", isError: !!r.isError }; };

test("synapse_brief(note) fetches a single note in FULL — the on-demand fetch path", async () => {
  const r = await call("synapse_brief", { note: "doc-tmpl" });
  assert.equal(r.isError, false);
  assert.match(r.text, /TEMPLATE-BODY the real template/, "the on-demand note renders its full body when fetched by id");
});

test("synapse_brief(agent) still briefs the agent (no regression)", async () => {
  const r = await call("synapse_brief", { agent: "lead" });
  assert.equal(r.isError, false);
  assert.match(r.text, /the binding rule/, "the agent's mandatory rule is in the briefing");
});

test("synapse_brief with neither agent nor note fails with a clear message, not a crash", async () => {
  const r = await call("synapse_brief", {});
  assert.equal(r.isError, true);
  assert.match(r.text, /needs .*agent.* or .*note/);
});

// THE CONTRACT: whatever call an on-demand "Fetch before you act" pointer recommends MUST be one the
// surface can actually service. This assertion's absence is what let the broken pointer ship.
test("the on-demand fetch pointer recommends a REAL, working call", async () => {
  const brief = await call("synapse_brief", { agent: "lead", profile: "standard" });
  const m = brief.text.match(/synapse_brief\(note: "([^"]+)"\)/);
  assert.ok(m, "the briefing carries a synapse_brief(note: <id>) pointer");
  const fetched = await call("synapse_brief", { note: m[1] });
  assert.equal(fetched.isError, false, "the recommended fetch call must succeed");
  assert.match(fetched.text, /TEMPLATE-BODY/, "and return the note it pointed at");
});
