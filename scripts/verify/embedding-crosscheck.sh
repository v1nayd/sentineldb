#!/usr/bin/env bash
# Independent verification of the embedding pipeline: our TypeScript path vs onnxruntime + tokenizers in Python.
# Needs Python >= 3.9 with venv + pip access. Creates .data/venv-check on first run. Exits non-zero if worst cosine <= 0.9999.
# Portable: on Windows `python3` is often a Microsoft Store stub and venvs keep python in Scripts/ instead of bin/.
set -euo pipefail
cd "$(dirname "$0")/../.."
pick_python() {
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >/dev/null 2>&1; then echo "$c"; return; fi
  done
  echo "no working python3/python (>= 3.9) found" >&2; return 1
}
VENV=.data/venv-check
venv_python() { if [[ -x $VENV/bin/python ]]; then echo "$VENV/bin/python"; else echo "$VENV/Scripts/python.exe"; fi; }
if [[ ! -x $VENV/bin/python && ! -x $VENV/Scripts/python.exe ]]; then "$(pick_python)" -m venv "$VENV"; fi
# Check the packages import, not just that the venv exists: an interrupted pip download leaves a half-built venv.
if ! "$(venv_python)" -c "import onnxruntime, tokenizers, numpy" >/dev/null 2>&1; then
  "$(venv_python)" -m pip install -q -r scripts/verify/requirements.txt
fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
npx tsx scripts/verify/embed-dump.ts "$TMP/ts.json" scripts/verify/texts.json
"$(venv_python)" scripts/verify/embed-crosscheck.py models/all-MiniLM-L6-v2 "$TMP/ts.json" scripts/verify/texts.json
