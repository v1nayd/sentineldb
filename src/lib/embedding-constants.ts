/**
 * The values our embedding PIPELINE assumes. They live in their own module (no imports) so that embedding.ts (which
 * uses them), embedding-spec.ts (which cross-checks them against models/MANIFEST.json and the model's own config
 * files) and qdrant.ts (which sizes the collection) all read ONE definition.
 */
export const EMBEDDING_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;
/** The model's documented max_seq_length; longer inputs are truncated (head kept, final [SEP] kept). */
export const EMBEDDING_MAX_TOKENS = 256;

/**
 * Exact versions of the libraries that execute the model. Their numerics can change vectors, so they are part of the
 * embedding fingerprint. tests/embedding-spec.test.ts fails if the installed versions differ from these pins; whoever
 * upgrades them must update the pins AND decide whether EMBEDDING_IMPL_VERSION must change, then rebuild the index.
 */
export const EMBEDDING_RUNTIME_PINS = {
  "@huggingface/transformers": "3.8.1",
  "onnxruntime-node": "1.21.0",
} as const;
