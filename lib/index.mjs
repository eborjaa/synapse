// index.mjs — @eborjaa/synapse programmatic entry point.
//
// The tools are primarily CLI (bin/synapse.mjs) + npm scripts, but the reusable primitives are exported
// here so a consumer can build on them in code (e.g. a custom dashboard or a CI check).

export { resolveVault } from "./vault-root.mjs";
export { buildTrailers } from "./trailers.mjs";
export {
  resolveOllamaBase, resolveEmbedModel, embedText, cosine, vecToBlob, blobToVec, parseNote, embedTextFor,
} from "./gen-embeddings.mjs";
