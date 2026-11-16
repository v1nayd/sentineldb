#!/usr/bin/env bash
# Runs a locally downloaded Qdrant server binary (for machines/sandboxes without Docker).
# Usage: scripts/qdrant-native.sh /path/to/qdrant      (default: ./.data/bin/qdrant)
# With Docker, prefer `docker compose up -d qdrant` instead.
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="${1:-.data/bin/qdrant}"
mkdir -p .data/qdrant
export QDRANT__STORAGE__STORAGE_PATH="$PWD/.data/qdrant/storage"
export QDRANT__STORAGE__SNAPSHOTS_PATH="$PWD/.data/qdrant/snapshots"
export QDRANT__SERVICE__HOST=127.0.0.1
export QDRANT__TELEMETRY_DISABLED=true
exec "$BIN"
