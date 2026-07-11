#!/usr/bin/env node
// journal-new.mjs — scaffold a dated journal entry (one file per work session).
//   synapse journal "short slug"
// Creates <vault>/journal/<YYYY-MM-DD>-<slug>.md from a template (no-op if it already exists).

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveVault } from "./vault-root.mjs";

const { vaultDir } = resolveVault({ readManifest: false });
const slug = (process.argv.slice(2).join(" ") || "session").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "session";
const date = new Date().toISOString().slice(0, 10);
const dir = join(vaultDir, "journal");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const path = join(dir, `${date}-${slug}.md`);
if (existsSync(path)) { console.error(`journal: already exists — ${path}`); process.exit(0); }

writeFileSync(path, `# ${date} — ${slug.replace(/-/g, " ")}

> Work-session log. Keep it short: what changed, why, how verified, what's next. Link [[notes]] you touched.

## What changed
-

## Why
-

## Verification
- lint:

## Next
- [ ]
`);
console.log(`journal: created journal/${date}-${slug}.md`);
