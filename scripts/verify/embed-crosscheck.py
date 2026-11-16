"""Independent re-implementation of the embedding path (onnxruntime + tokenizers, no transformers.js).
Compares against vectors dumped by scripts/verify/embed-dump.ts. Usage:
  python embed-crosscheck.py <model_dir> <ts_vectors.json> <texts.json>
"""
import json, sys
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

model_dir, ts_json, texts_json = sys.argv[1:4]
# Explicit UTF-8: on Windows open() defaults to the ANSI code page (cp1252), which turned "Café" into "CafÃ©" and made
# the accented test text disagree (cosine 0.74) although the TypeScript path was correct (found in M2).
texts = json.load(open(texts_json, encoding="utf-8"))
ts = json.load(open(ts_json, encoding="utf-8"))

tok = Tokenizer.from_file(f"{model_dir}/tokenizer.json")
tok.no_padding()
tok.enable_truncation(max_length=256)
sess = ort.InferenceSession(f"{model_dir}/onnx/model.onnx", providers=["CPUExecutionProvider"])
names = {i.name for i in sess.get_inputs()}

worst = 1.0
for text, ref in zip(texts, ts):
    enc = tok.encode(text)
    ids = np.array([enc.ids], dtype=np.int64)
    mask = np.array([enc.attention_mask], dtype=np.int64)
    feeds = {"input_ids": ids, "attention_mask": mask}
    if "token_type_ids" in names:
        feeds["token_type_ids"] = np.zeros_like(ids)
    hidden = sess.run(None, feeds)[0]                     # [1, T, 384]
    m = mask[..., None].astype(np.float32)
    pooled = (hidden * m).sum(1) / np.clip(m.sum(1), 1e-9, None)
    pooled = pooled / np.linalg.norm(pooled, axis=1, keepdims=True)
    a, b = pooled[0], np.array(ref["vector"], dtype=np.float32)
    cos = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))
    worst = min(worst, cos)
    print(f"cos(py, ts)={cos:.6f}  max|diff|={np.abs(a-b).max():.2e}  tokens={len(enc.ids)}  {text[:50]!r}")
print("WORST COSINE:", f"{worst:.6f}")
sys.exit(0 if worst > 0.9999 else 1)
