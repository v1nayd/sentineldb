#!/usr/bin/env bash
# Installs the embedding model files into models/all-MiniLM-L6-v2 and verifies their sha256 against
# models/MANIFEST.json. config.json / tokenizer_config.json are committed in the repo.
#
# Source used by this script: the npm package named in the manifest (works behind restrictive proxies).
# Preferred on an unrestricted machine: download the same two files from huggingface.co at the manifest's
# upstream revision and run `bash scripts/setup-model.sh --verify-only` — see docs/MODEL.md.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=models/all-MiniLM-L6-v2
verify() {
  node -e '
    const fs=require("fs"),c=require("crypto");
    const m=JSON.parse(fs.readFileSync("models/MANIFEST.json","utf8"));
    let bad=0;
    for (const [f,h] of Object.entries(m.files)) {
      const p="'"$DEST"'/"+f;
      if(!fs.existsSync(p)){console.error("missing",p);bad=1;continue}
      const got=c.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      if(got!==h){console.error("HASH MISMATCH",f,"expected",h,"got",got);bad=1}else console.log("ok",f)
    }
    process.exit(bad)'
}
if [[ "${1:-}" == "--verify-only" ]]; then verify; exit; fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
( cd "$TMP" && npm pack "@xcidos/genesis-memory-model@0.1.0-alpha.1" --ignore-scripts --silent >/dev/null && tar xzf ./*.tgz )
mkdir -p "$DEST/onnx"
cp "$TMP/package/onnx/model.onnx" "$DEST/onnx/model.onnx"
cp "$TMP/package/tokenizer.json" "$DEST/tokenizer.json"
verify
