#!/usr/bin/env node
// init.mjs — scaffold a new Synapse vault from the content this package ships.
//
//   synapse init            # dry-run into the current directory
//   synapse init ./my-vault --write
//
// Copies the generic layer — the manifest, conventions, the four agents, the rules, the tool and
// skill notes, and the master hub — into a target directory, then creates the empty domain dirs.
// NEVER overwrites an existing file, so it is safe to re-run to pick up newly shipped notes.
//
// The source is this package's OWN content (rules/, agents/, …), not a duplicated starter/ tree:
// a second copy inside the repo would drift from the notes the framework actually lints
// ([[rule-synapse-single-source-of-truth]]).

import { cpSync, mkdirSync, existsSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const write = argv.includes("--write");
const target = resolve(argv.find((a) => !a.startsWith("--")) || process.cwd());

// What a usable vault needs from the package. Files are copied verbatim; dirs are merged.
const SOURCES = [
  "_meta/tools/context.manifest.json",
  "_meta/conventions.md",
  "_meta/capture-philosophy.md",
  "_meta/context-engine-guide.md",
  "_meta/decomposition-recipe.md",
  "_meta/tools/pre-commit.sh",
  "agents",
  "rules",
  "tools",
  "skills",
  "hub-synapse.md",
];

// Domain dirs a vault is expected to have; created empty with a .gitkeep so links resolve later.
const DIRS = [
  "hub", "notes", "journal", "plans", "projects", "decisions", "docs", "people",
  "inbox", "inbox/handovers", "inbox/attention", "migrations", "db", "_meta/mcp-plugins",
];

const isVault = existsSync(join(target, "_meta", "tools", "context.manifest.json"));

const planned = [];
const skipped = [];

function planFile(rel) {
  const src = join(PKG, rel);
  const dst = join(target, rel);
  if (!existsSync(src)) return;
  if (existsSync(dst)) { skipped.push(rel); return; }
  planned.push({ src, dst, rel, dir: false });
}

function planDir(rel) {
  const src = join(PKG, rel);
  if (!existsSync(src)) return;
  for (const name of readdirSync(src)) {
    if (name.startsWith(".")) continue;
    const child = join(rel, name);
    if (statSync(join(PKG, child)).isDirectory()) planDir(child);
    else planFile(child);
  }
}

for (const s of SOURCES) {
  const src = join(PKG, s);
  if (!existsSync(src)) continue;
  statSync(src).isDirectory() ? planDir(s) : planFile(s);
}

const PKG_VERSION = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version;

console.log(`target: ${target}${isVault ? "  (already a vault — filling in only what is missing)" : ""}`);
console.log(`source: @eborja/synapse ${PKG_VERSION}\n`);

if (!planned.length) {
  console.log(`Nothing to copy — all ${skipped.length} shipped notes already exist.`);
} else {
  console.log(`${planned.length} file(s) to create${skipped.length ? `, ${skipped.length} already present (left alone)` : ""}:`);
  for (const p of planned.slice(0, 40)) console.log(`  + ${p.rel}`);
  if (planned.length > 40) console.log(`  … and ${planned.length - 40} more`);
}

if (!write) {
  console.log(`\nRe-run with --write to apply.`);
  process.exit(0);
}

for (const { src, dst } of planned) {
  mkdirSync(join(dst, ".."), { recursive: true });
  cpSync(src, dst);
}
for (const d of DIRS) {
  const p = join(target, d);
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, ".gitkeep"), "");
  }
}

const pkgJson = join(target, "package.json");
if (!existsSync(pkgJson)) {
  const version = PKG_VERSION;
  writeFileSync(pkgJson, `${JSON.stringify({
    name: "my-synapse-vault",
    private: true,
    type: "module",
    description: "Synapse vault — depends on @eborja/synapse for the engine.",
    dependencies: { "@eborja/synapse": `^${version}` },
  }, null, 2)}\n`);
  console.log(`  + package.json`);
}

console.log(`\nCreated ${planned.length} file(s) in ${relative(process.cwd(), target) || "."}`);
console.log(`
next:
  cd ${relative(process.cwd(), target) || "."}
  npm install                    # installs the engine + the synapse-mcp bin
  npx synapse mcp-config --write # wire Claude Code / Cursor / opencode to THIS vault
     # ...or the superset, which also installs the shell CLI (one verb per agent) and one
     # /synapse-<agent> harness skill apiece:  npx synapse install --write && exec $SHELL
  npx synapse lint               # should be clean
  npx synapse new hub <domain> --write
`);
