// vault-root.test.mjs — vault resolution priority. The bug this pins: an exported $SYNAPSE_VAULT
// silently overriding the vault you cd'd into (a render read the WRONG vault mid-session because of it).
//   node --test lib/vault-root.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVault } from "./vault-root.mjs";

const MANIFEST = JSON.stringify({ logLabel: "synapse", vaultRoot: ".", skipDirs: [], roles: {}, profiles: {} });

/** A minimal flat vault at a fresh temp dir. */
function vault(tag) {
  const root = mkdtempSync(join(tmpdir(), `vr-${tag}-`));
  mkdirSync(join(root, "_meta", "tools"), { recursive: true });
  writeFileSync(join(root, "_meta", "tools", "context.manifest.json"), MANIFEST);
  return root;
}

function withEnv(val, fn) {
  const prev = process.env.SYNAPSE_VAULT;
  if (val === null) delete process.env.SYNAPSE_VAULT; else process.env.SYNAPSE_VAULT = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.SYNAPSE_VAULT; else process.env.SYNAPSE_VAULT = prev;
  }
}

test("DEFAULT (interactive): cwd WINS over a conflicting exported $SYNAPSE_VAULT", () => {
  const here = vault("here");
  const elsewhere = vault("elsewhere");
  try {
    withEnv(elsewhere, () => {
      const hit = resolveVault({ cwd: here, readManifest: false });
      assert.equal(hit.root, here, "you cd'd into `here` — a stale env pointing `elsewhere` must not override");
    });
  } finally { rmSync(here, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
});

test("DEFAULT: $SYNAPSE_VAULT is the FALLBACK when cwd is not inside any vault", () => {
  const pinned = vault("pinned");
  const nowhere = mkdtempSync(join(tmpdir(), "vr-nowhere-"));   // no manifest anywhere above
  try {
    withEnv(pinned, () => {
      const hit = resolveVault({ cwd: nowhere, readManifest: false });
      assert.equal(hit.root, pinned, "cwd is not a vault → fall back to the env override");
    });
  } finally { rmSync(pinned, { recursive: true, force: true }); rmSync(nowhere, { recursive: true, force: true }); }
});

test("MCP server (preferCwd:false): env WINS — a config-pinned process is authoritative", () => {
  const pinned = vault("mcp-pinned");
  const cwdVault = vault("mcp-cwd");
  try {
    withEnv(pinned, () => {
      const hit = resolveVault({ cwd: cwdVault, readManifest: false, preferCwd: false });
      assert.equal(hit.root, pinned, "the server is pinned by .mcp.json env — that wins over its launch cwd");
    });
  } finally { rmSync(pinned, { recursive: true, force: true }); rmSync(cwdVault, { recursive: true, force: true }); }
});

test("no env, cwd inside a vault → resolves from cwd", () => {
  const here = vault("solo");
  try {
    withEnv(null, () => assert.equal(resolveVault({ cwd: here, readManifest: false }).root, here));
  } finally { rmSync(here, { recursive: true, force: true }); }
});

test("no env, cwd not a vault → throws loudly, never guesses", () => {
  const nowhere = mkdtempSync(join(tmpdir(), "vr-void-"));
  try {
    withEnv(null, () => assert.throws(() => resolveVault({ cwd: nowhere, readManifest: false }), /could not locate a vault/));
  } finally { rmSync(nowhere, { recursive: true, force: true }); }
});
