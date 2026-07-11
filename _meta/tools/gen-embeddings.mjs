#!/usr/bin/env node
// Backward-compat shim — engine lives in @eborja/synapse (lib/gen-embeddings.mjs). Prefer: `synapse <cmd>`
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
const lib = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "lib", "gen-embeddings.mjs");
process.argv[1] = lib; // so IS_MAIN checks in the real tool still fire
await import(pathToFileURL(lib).href);
