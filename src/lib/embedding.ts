import path from "node:path";
import { env } from "./env";
import { EMBEDDING_DIM, EMBEDDING_MAX_TOKENS, EMBEDDING_MODEL_NAME } from "./embedding-constants";
import { embeddingSpec } from "./embedding-spec";

export { EMBEDDING_DIM, EMBEDDING_MAX_TOKENS, EMBEDDING_MODEL_NAME };

/**
 * Local sentence embeddings (all-MiniLM-L6-v2, 384-d, mean pooling, L2-normalised) via transformers.js + ONNX
 * Runtime. No network access at runtime: allowRemoteModels is off, so a missing model fails loudly instead of
 * silently downloading something.
 *
 * Because vectors are L2-normalised, cosine similarity == dot product. Qdrant is configured with Cosine anyway.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Extractor = any;
let extractorPromise: Promise<Extractor> | undefined;

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      embeddingSpec(); // verifies every model file against models/MANIFEST.json before anything is loaded
      const { pipeline, env: tfEnv } = await import("@huggingface/transformers");
      const dir = path.resolve(env().EMBEDDING_MODEL_DIR);
      tfEnv.allowRemoteModels = false;
      tfEnv.allowLocalModels = true;
      tfEnv.localModelPath = path.dirname(dir);
      return pipeline("feature-extraction", path.basename(dir), { dtype: "fp32" });
    })().catch((err) => {
      extractorPromise = undefined; // allow a retry after the operator fixes the model directory
      throw new Error(`Embedding model failed to load from ${env().EMBEDDING_MODEL_DIR}: ${(err as Error).message}. Run "npm run model:setup".`);
    });
  }
  return extractorPromise;
}

export interface EmbeddingResult {
  vector: number[];
  /** True when the input exceeded EMBEDDING_MAX_TOKENS and the tail was ignored by the model. */
  truncated: boolean;
}

export async function embedTexts(texts: string[]): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];
  if (texts.some((t) => typeof t !== "string" || t.trim().length === 0)) {
    throw new Error("Cannot embed an empty narrative.");
  }
  const { Tensor } = await import("@huggingface/transformers");
  const ex = await getExtractor();
  const out: EmbeddingResult[] = [];
  // One text per forward pass: no padding at all, so a vector never depends on what else was in the batch.
  for (const text of texts) {
    const enc = ex.tokenizer(text, { truncation: false, padding: false });
    let ids: bigint[] = Array.from(enc.input_ids.data as BigInt64Array);
    const truncated = ids.length > EMBEDDING_MAX_TOKENS;
    if (truncated) {
      // transformers.js 3.8.1 truncates by slicing, which drops the closing [SEP]; the reference implementation
      // (sentence-transformers / HF tokenizers) keeps it. Truncate ourselves so we match the reference exactly.
      ids = [...ids.slice(0, EMBEDDING_MAX_TOKENS - 1), ids[ids.length - 1]!];
    }
    const n = ids.length;
    const inputs = {
      input_ids: new Tensor("int64", BigInt64Array.from(ids), [1, n]),
      attention_mask: new Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]),
      token_type_ids: new Tensor("int64", new BigInt64Array(n), [1, n]),
    };
    const hidden = (await ex.model(inputs)).last_hidden_state; // [1, n, 384]
    const data = hidden.data as Float32Array;
    // Mean pooling over all n tokens (every position is real: attention mask is all ones), then L2-normalise.
    const vec = new Array<number>(EMBEDDING_DIM).fill(0);
    for (let t = 0; t < n; t++) for (let d = 0; d < EMBEDDING_DIM; d++) vec[d]! += data[t * EMBEDDING_DIM + d]!;
    let norm = 0;
    for (let d = 0; d < EMBEDDING_DIM; d++) { vec[d]! /= n; norm += vec[d]! * vec[d]!; }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < EMBEDDING_DIM; d++) vec[d]! /= norm;
    out.push({ vector: vec, truncated });
  }
  return out;
}

export async function embedText(text: string): Promise<EmbeddingResult> {
  const [r] = await embedTexts([text]);
  return r!;
}
