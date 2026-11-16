import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { env } from "./env";
import { EMBEDDING_DIM, EMBEDDING_MAX_TOKENS, EMBEDDING_MODEL_NAME, EMBEDDING_RUNTIME_PINS } from "./embedding-constants";

/**
 * Embedding specification fingerprint.
 *
 * Two different models (or two different preprocessing choices) can both emit 384-d cosine vectors that are
 * numerically incomparable. So a vector's identity is NOT "384 floats": it is the full recipe that produced them.
 * The fingerprint hashes the ACTUAL bytes of every model file on disk plus every behavioural setting of our own
 * pipeline. It names the Qdrant collection (a changed recipe => a different collection => full rebuild, never silent
 * mixing) and is stamped in every point's payload so contamination is detectable.
 *
 * Files are also checked against models/MANIFEST.json at load time, so a tampered or half-updated model directory
 * fails loudly instead of producing quietly different vectors.
 */

/** Bump when the algorithm in embedding.ts changes in a way that alters output vectors. */
export const EMBEDDING_IMPL_VERSION = "embed-v1";

export interface EmbeddingSpec {
  model_id: string;
  files_sha256: Record<string, string>; // actual bytes on disk
  dimensions: number;
  pooling: "mean";
  normalize: "l2";
  max_tokens: number;
  truncation: "head-keep-final-sep";
  input_preprocessing: "none (raw text; BERT lowercasing is inside the tokenizer)";
  distance: "cosine";
  impl_version: string;
  /** Pinned versions of the libraries that run the model (see embedding-constants.ts). */
  runtime: Record<string, string>;
}

export interface ResolvedSpec {
  spec: EmbeddingSpec;
  /** Full sha256 of canonical JSON of `spec`. */
  fingerprint: string;
  /** First 12 hex chars; used in collection names and payloads. */
  short: string;
}

export class ModelIntegrityError extends Error {}
/** The manifest, the model's own config files and the pipeline's constants disagree. */
export class SpecMismatchError extends ModelIntegrityError {}

const cache = new Map<string, ResolvedSpec>();
const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Canonical JSON: keys sorted recursively, so the hash does not depend on property insertion order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function fingerprintOf(spec: EmbeddingSpec): string {
  return createHash("sha256").update(canonical(spec)).digest("hex");
}

/** Synchronous and memoised (hashes ~90 MB once per process, ~0.2 s). */
export function embeddingSpec(modelDir: string = env().EMBEDDING_MODEL_DIR): ResolvedSpec {
  const dir = path.resolve(modelDir);
  const hit = cache.get(dir);
  if (hit) return hit;

  const manifestPath = path.join(path.dirname(dir), "MANIFEST.json");
  if (!existsSync(manifestPath)) throw new ModelIntegrityError(`Model manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    model: string; dimensions: number; max_seq_length: number; files: Record<string, string>;
  };

  const actual: Record<string, string> = {};
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const p = path.join(dir, rel);
    if (!existsSync(p)) throw new ModelIntegrityError(`Model file missing: ${rel}. Run "npm run model:setup".`);
    actual[rel] = sha256File(p);
    if (actual[rel] !== expected) {
      throw new ModelIntegrityError(`Model file ${rel} does not match models/MANIFEST.json (expected ${expected.slice(0, 12)}…, found ${actual[rel].slice(0, 12)}…). Refusing to embed with an unverified model.`);
    }
  }

  assertAgreement(manifest, dir);

  const spec: EmbeddingSpec = {
    model_id: manifest.model,
    files_sha256: Object.fromEntries(Object.entries(actual).sort(([a], [b]) => a.localeCompare(b))),
    dimensions: manifest.dimensions,
    pooling: "mean",
    normalize: "l2",
    max_tokens: manifest.max_seq_length,
    truncation: "head-keep-final-sep",
    input_preprocessing: "none (raw text; BERT lowercasing is inside the tokenizer)",
    distance: "cosine",
    impl_version: EMBEDDING_IMPL_VERSION,
    runtime: { ...EMBEDDING_RUNTIME_PINS },
  };
  const fingerprint = fingerprintOf(spec);
  const resolved: ResolvedSpec = { spec, fingerprint, short: fingerprint.slice(0, 12) };
  cache.set(dir, resolved);
  return resolved;
}

/**
 * The fingerprint DESCRIBES a configuration; this proves the running code actually uses it. Three independent
 * sources must agree: (1) models/MANIFEST.json, (2) the model's own config files (which the manifest pins by hash),
 * (3) the constants embedding.ts executes with. Any disagreement means the fingerprint would be describing something
 * other than what produces the vectors, so we refuse to start rather than index under a false identity.
 */
function assertAgreement(manifest: { model: string; dimensions: number; max_seq_length: number }, dir: string): void {
  const problems: string[] = [];
  const eq = (what: string, a: unknown, b: unknown) => { if (a !== b) problems.push(`${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); };
  eq("model id (manifest vs code)", manifest.model, EMBEDDING_MODEL_NAME);
  eq("dimensions (manifest vs code)", manifest.dimensions, EMBEDDING_DIM);
  eq("max_seq_length (manifest vs code)", manifest.max_seq_length, EMBEDDING_MAX_TOKENS);
  const cfg = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8")) as { hidden_size?: number };
  eq("hidden_size (config.json vs code dimensions)", cfg.hidden_size, EMBEDDING_DIM);
  const tok = JSON.parse(readFileSync(path.join(dir, "tokenizer_config.json"), "utf8")) as { model_max_length?: number };
  eq("model_max_length (tokenizer_config.json vs code max tokens)", tok.model_max_length, EMBEDDING_MAX_TOKENS);
  if (problems.length) throw new SpecMismatchError(`Embedding configuration disagrees with itself; refusing to fingerprint it:\n  - ${problems.join("\n  - ")}`);
}
