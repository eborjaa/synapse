#!/usr/bin/env node
// Backward-compat shim — engine lives in @eborjaa/synapse (lib/render.mjs). Prefer: `synapse <cmd>`
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
const lib = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "lib", "render.mjs");
process.argv[1] = lib; // so IS_MAIN checks in the real tool still fire
await import(pathToFileURL(lib).href);
