import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { EMBEDDING_DIM, EMBEDDING_MAX_TOKENS, EMBEDDING_MODEL_NAME, EMBEDDING_RUNTIME_PINS } from "../src/lib/embedding-constants";
import { embeddingSpec, fingerprintOf, ModelIntegrityError, SpecMismatchError } from "../src/lib/embedding-spec";

const modelDir = path.resolve("models/all-MiniLM-L6-v2");
const tmp = mkdtempSync(path.join(os.tmpdir(), "sdb-spec-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A copy of the model directory (big files symlinked) rooted at tmp/<name>, with its own MANIFEST.json. */
function cloneModel(name: string): string {
  const root = path.join(tmp, name);
  const dir = path.join(root, "model");
  mkdirSync(path.join(dir, "onnx"), { recursive: true });
  cpSync("models/MANIFEST.json", path.join(root, "MANIFEST.json"));
  for (const f of ["config.json", "tokenizer_config.json"]) cpSync(path.join(modelDir, f), path.join(dir, f));
  symlinkSync(path.join(modelDir, "tokenizer.json"), path.join(dir, "tokenizer.json"));
  symlinkSync(path.join(modelDir, "onnx/model.onnx"), path.join(dir, "onnx/model.onnx"));
  return dir;
}

describe("embedding spec fingerprint", () => {
  it("is deterministic, hashes actual file bytes, and does not depend on where the model directory lives", () => {
    const a = embeddingSpec(modelDir);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.short).toBe(a.fingerprint.slice(0, 12));
    expect(a.spec.files_sha256["onnx/model.onnx"]).toBe(JSON.parse(readFileSync("models/MANIFEST.json", "utf8")).files["onnx/model.onnx"]);
    expect(embeddingSpec(cloneModel("same")).fingerprint).toBe(a.fingerprint);
  });

  it("changes when ANY behavioural setting changes (so a different recipe can never share an index)", () => {
    const { spec, fingerprint } = embeddingSpec(modelDir);
    const variants = [
      { ...spec, max_tokens: 128 },
      { ...spec, impl_version: "embed-v2" },
      { ...spec, dimensions: 768 },
      { ...spec, model_id: "other/model" },
      { ...spec, runtime: { ...spec.runtime, "onnxruntime-node": "9.9.9" } },
      { ...spec, files_sha256: { ...spec.files_sha256, "tokenizer.json": "0".repeat(64) } },
    ];
    const prints = variants.map(fingerprintOf);
    for (const p of prints) expect(p).not.toBe(fingerprint);
    expect(new Set(prints).size).toBe(prints.length);
  });

  it("is independent of property order", () => {
    const { spec, fingerprint } = embeddingSpec(modelDir);
    const shuffled = Object.fromEntries(Object.entries(spec).reverse()) as typeof spec;
    expect(fingerprintOf(shuffled)).toBe(fingerprint);
  });

  it("refuses a model directory whose files differ from models/MANIFEST.json (hand-edited config, swapped weights)", () => {
    const dir = cloneModel("tampered-config");
    writeFileSync(path.join(dir, "tokenizer_config.json"), readFileSync(path.join(dir, "tokenizer_config.json"), "utf8").replace('"model_max_length": 256', '"model_max_length": 512'));
    expect(() => embeddingSpec(dir)).toThrow(ModelIntegrityError);
    expect(() => embeddingSpec(dir)).toThrow(/tokenizer_config\.json does not match/);
  });

  it("refuses a model directory with a missing file or no manifest", () => {
    const dir = cloneModel("missing");
    rmSync(path.join(dir, "config.json"));
    expect(() => embeddingSpec(dir)).toThrow(/missing/);
    expect(() => embeddingSpec(path.join(tmp, "nowhere", "model"))).toThrow(/manifest not found/i);
  });
});

describe("manifest, model config and runtime implementation must agree (a fingerprint may not describe a configuration the code does not use)", () => {
  /** Rewrites a manifest field and/or a model config file and re-pins its hash, so ONLY the agreement check can object. */
  function variant(name: string, edit: { manifest?: Record<string, unknown>; file?: [string, (text: string) => string] }): string {
    const dir = cloneModel(name);
    const mpath = path.join(path.dirname(dir), "MANIFEST.json");
    const manifest = JSON.parse(readFileSync(mpath, "utf8"));
    Object.assign(manifest, edit.manifest ?? {});
    if (edit.file) {
      const [rel, fn] = edit.file;
      const text = fn(readFileSync(path.join(dir, rel), "utf8"));
      writeFileSync(path.join(dir, rel), text);
      manifest.files[rel] = createHash("sha256").update(text).digest("hex");
    }
    writeFileSync(mpath, JSON.stringify(manifest));
    return dir;
  }

  it("the shipped configuration agrees (precondition for everything else)", () => {
    const { spec } = embeddingSpec(modelDir);
    expect([spec.model_id, spec.dimensions, spec.max_tokens]).toEqual([EMBEDDING_MODEL_NAME, EMBEDDING_DIM, EMBEDDING_MAX_TOKENS]);
  });
  it("rejects a manifest whose dimensions, max_seq_length or model id differ from what the code runs with", () => {
    expect(() => embeddingSpec(variant("m-dim", { manifest: { dimensions: 768 } }))).toThrow(SpecMismatchError);
    expect(() => embeddingSpec(variant("m-len", { manifest: { max_seq_length: 512 } }))).toThrow(/max_seq_length/);
    expect(() => embeddingSpec(variant("m-id", { manifest: { model: "other/model" } }))).toThrow(/model id/);
  });
  it("rejects a model whose own config files (even if re-pinned in the manifest) contradict the code", () => {
    expect(() => embeddingSpec(variant("c-hidden", { file: ["config.json", (t) => t.replace('"hidden_size": 384', '"hidden_size": 768')] }))).toThrow(/hidden_size/);
    expect(() => embeddingSpec(variant("c-maxlen", { file: ["tokenizer_config.json", (t) => t.replace('"model_max_length": 256', '"model_max_length": 512')] }))).toThrow(/model_max_length/);
  });
  it("installed output-affecting library versions equal the pins recorded in the fingerprint (upgrade => bump pins + decide impl_version)", () => {
    for (const [pkg, pinned] of Object.entries(EMBEDDING_RUNTIME_PINS)) {
      const installed = JSON.parse(readFileSync(path.join("node_modules", pkg, "package.json"), "utf8")).version;
      expect(installed, `${pkg} installed ${installed} but pinned ${pinned} in src/lib/embedding-constants.ts`).toBe(pinned);
    }
    expect(embeddingSpec(modelDir).spec.runtime).toEqual(EMBEDDING_RUNTIME_PINS);
  });
});
