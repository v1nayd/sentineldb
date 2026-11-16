#!/usr/bin/env bash
# One command that re-runs every verification and stores raw output in docs/evidence/ (plain text + machine-readable).
# Prerequisites: services running, .env filled, `npm ci`, `npm run model:setup`, bootstrap, then
#   npm run db:reset && npm run db:grants && npm run db:seed -- spike      (the spike step needs the spike seed in dev)
# Exits non-zero if any FUNCTIONAL step fails or the SECURITY AUDIT exceeds its threshold. The summary keeps the three
# kinds of claim apart so "ALL PASS" cannot be read as more than it is:
#   [functional]  typecheck, tests, spike, M2 database checks (seed files, audit integrity, DDL demo, EXPLAIN review),
#                 embedding cross-check, production build, end-to-end smoke through `next start`
#   [integrity]   model files match the LOCAL pinned manifest (does NOT prove they equal the official release)
#   [security]    npm audit of production dependencies against an explicit threshold (AUDIT_MAX_HIGH, default 0 high/critical)
#   [not verified by this script] things this environment cannot establish; listed so they are never silently implied.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
unset NODE_ENV   # a stray NODE_ENV from the shell/.env breaks `next build`; each step sets what it needs
# On Windows `python3` is often a Microsoft Store stub that only prints "Python was not found"; use whichever works.
PY=python3; python3 -c "import sys" >/dev/null 2>&1 || PY=python
OUT=docs/evidence; mkdir -p "$OUT"
FAIL=0; SEC_FAIL=0; : > "$OUT/SUMMARY.txt"
say() { echo "$@" | tee -a "$OUT/SUMMARY.txt"; }
step() { # name, command...
  local name="$1"; shift
  echo "== $name"; "$@" > "$OUT/$name.txt" 2>&1; local rc=$?
  say "$name: $([ $rc -eq 0 ] && echo PASS || echo "FAIL (exit $rc)")"
  [ $rc -eq 0 ] || FAIL=1
}
{
  echo "date_utc: $(date -u +%FT%TZ)"
  echo "node: $(node -v)  npm: $(npm -v)"
  echo "mysql server: $(mysql -h"${MYSQL_HOST:-127.0.0.1}" -P"${MYSQL_PORT:-3306}" -u"$MYSQL_MIGRATOR_USER" -p"$MYSQL_MIGRATOR_PASSWORD" -N -e 'SELECT CONCAT(VERSION(), "  log_bin=", @@log_bin, "  lower_case_table_names=", @@lower_case_table_names)' 2>/dev/null)"
  echo "qdrant server: $(curl -s "${QDRANT_URL:-http://127.0.0.1:6333}/" | tr -d '\n')"
  echo "os: $(uname -sr)"
  echo; npm ls --depth=0 2>&1
} > "$OUT/versions.txt"
say "[functional]"
step typecheck  npm run -s typecheck
step tests      npx vitest run --reporter=verbose
step spike      npm run -s spike
# Milestone 2 database checks (none of them modifies dev data: the DDL demo leaves no trace, EXPLAIN uses the scratch schema)
step seed-files npx tsx scripts/generate-seed.ts --check
step integrity  npx tsx scripts/reports.ts integrity
step ddl-demo   npx tsx scripts/ddl-demo.ts
step explain    npx tsx scripts/explain.ts
step embedding-crosscheck bash scripts/verify/embedding-crosscheck.sh
step build      env NODE_ENV=production npm run -s build
step e2e-smoke  npx tsx scripts/e2e-smoke.ts   # needs the build above; runs against the TEST schema

say "[integrity]"
step model-manifest bash scripts/setup-model.sh --verify-only
say "  (model-manifest = files equal the hashes pinned in models/MANIFEST.json; it is NOT a comparison with the official release)"

say "[security]"
MAX_HIGH="${AUDIT_MAX_HIGH:-0}"
npm audit --omit=dev --json > "$OUT/npm-audit-prod.json" 2>/dev/null
npm audit --json > "$OUT/npm-audit-all.json" 2>/dev/null
"$PY" -I - "$OUT/npm-audit-prod.json" "$OUT/npm-audit-all.json" "$MAX_HIGH" <<'PY' | tee -a "$OUT/SUMMARY.txt"
import json, sys
prod, allp, max_high = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), int(sys.argv[3])
v = prod["metadata"]["vulnerabilities"]; a = allp["metadata"]["vulnerabilities"]
hc = v.get("high", 0) + v.get("critical", 0)
print(f"npm-audit-prod: critical={v.get('critical',0)} high={v.get('high',0)} moderate={v.get('moderate',0)} low={v.get('low',0)}"
      f"  threshold: high+critical <= {max_high}  -> {'PASS' if hc <= max_high else 'FAIL'}")
print(f"npm-audit-all (incl. dev, informational): critical={a.get('critical',0)} high={a.get('high',0)} moderate={a.get('moderate',0)} low={a.get('low',0)}")
print("  (moderate findings are accepted and documented with reachability in docs/DEPENDENCY_AUDIT.md)")
sys.exit(0 if hc <= max_high else 1)
PY
[ "${PIPESTATUS[0]}" -eq 0 ] || SEC_FAIL=1

say "[not verified by this script]"
say "model-upstream-provenance: NOT VERIFIED (needs huggingface.co; procedure in docs/MODEL.md)"
say "docker-compose-path: NOT EXERCISED BY THIS SCRIPT (services here ran natively; the Docker Compose run is logged in docs/evidence/docker-run.txt)"
say "clean-machine-install: NOT VERIFIED (this ran on a developer workstation, not a fresh machine)"
say "binlog-on-mysql: check versions.txt; with log_bin=1 the migrator needs log_bin_trust_function_creators=1 (README)"

say "overall-functional: $([ $FAIL -eq 0 ] && echo PASS || echo FAIL)"
say "overall-security-audit: $([ $SEC_FAIL -eq 0 ] && echo PASS || echo FAIL)"
exit $(( FAIL || SEC_FAIL ))
