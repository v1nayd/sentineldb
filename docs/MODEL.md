# Embedding model

| Property | Value |
|---|---|
| Model | `sentence-transformers/all-MiniLM-L6-v2` |
| License | Apache-2.0 |
| Output | 384-d, mean-pooled, L2-normalised (so cosine = dot product) |
| Max input | 256 word-pieces; longer text is truncated and flagged (`truncated: true`) |
| Runtime | `@huggingface/transformers` 3.8.1 → `onnxruntime-node` 1.21.0, CPU, fp32 |
| Network at runtime | None (`allowRemoteModels = false`) |

## Provenance — read this

`huggingface.co` is not reachable from the workspace where Milestone 1 was built, so the two weight/tokenizer files were taken from the npm package `@xcidos/genesis-memory-model@0.1.0-alpha.1` (Apache-2.0), whose README claims upstream revision `c9745ed1d9f207416be6d2e6f8de32d1f16199bf`. That claim is **the packager's, not verified by us**. What *was* verified: the model loads, and our TypeScript path reproduces an independent onnxruntime + tokenizers implementation to cosine 1.000000 (`scripts/verify/`).

To remove the trust gap on an unrestricted machine:

```bash
# download the same two files from Hugging Face at the pinned revision
REV=c9745ed1d9f207416be6d2e6f8de32d1f16199bf
curl -L -o /tmp/model.onnx   https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/$REV/onnx/model.onnx
curl -L -o /tmp/tokenizer.json https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/$REV/tokenizer.json
sha256sum /tmp/model.onnx /tmp/tokenizer.json   # compare with models/MANIFEST.json
```

If the hashes match, provenance is confirmed. If they do not, report it and use the Hugging Face files (copy them into `models/all-MiniLM-L6-v2/`, then update the manifest) before running any evaluation.

`config.json` and `tokenizer_config.json` are hand-written (standard BERT-L6-H384 values; `model_max_length: 256`) and committed.

## Two different claims — do not conflate them

| Claim | Established by | Status |
|---|---|---|
| **A. The files on disk are the ones this repository pinned** | `bash scripts/setup-model.sh --verify-only` (and the load-time check in `embedding-spec.ts`) compares sha256 with `models/MANIFEST.json` | Verified on every run |
| **B. The pinned files equal the official Hugging Face release** | Only the download-and-compare procedure above, on a machine that can reach huggingface.co | **NOT verified** — do this before publishing any retrieval-evaluation numbers |

`verify-all.sh` reports A under `[integrity]` and lists B under `[not verified by this script]`. The TypeScript-vs-Python cross-check below shows two *implementations* agree on the packaged model; it says nothing about where the model came from.

## Cross-check procedure (reproducible)

```bash
npm run verify:embedding     # creates .data/venv-check on first run (needs python3 + pip); exits non-zero if worst cosine <= 0.9999
```

It uses the committed fixture `scripts/verify/texts.json` (6 texts: short, paraphrase-style, non-ASCII, and a >256-token input that exercises truncation), dumps vectors from the production TypeScript path, and compares them with an independent onnxruntime + `tokenizers` implementation (`scripts/verify/embed-crosscheck.py`).

At runtime the same four files are re-hashed and compared with `models/MANIFEST.json` (`src/lib/embedding-spec.ts`), and their hashes are part of the embedding-spec fingerprint that names the Qdrant collection. **Provenance relative to the official Hugging Face release remains unverified until you run the comparison above on a machine that can reach huggingface.co.**
