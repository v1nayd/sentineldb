#!/usr/bin/env bash
# Live demo of the HTTP API: login, visibility (IDOR -> 404), roles (403), strict bodies (400), CSRF (403), logout.
# Needs the dev server (`npm run dev`) and the demo seed, plus passwords from `npm run dev:logins`:
#   npm run dev:logins -- priya.raman@sentinel.example aisha.khan@sentinel.example
#   bash scripts/demo-api.sh '<aisha password>' '<priya password>'
# Optional: OTHER_ID (an incident Aisha neither reported nor owns, default 1), OWN_ID (one of hers, default 21).
set -uo pipefail
BASE="${BASE:-http://localhost:3000}"
ANALYST_PW="${1:?usage: demo-api.sh <aisha password> <priya password>}"
ADMIN_PW="${2:?usage: demo-api.sh <aisha password> <priya password>}"
OTHER_ID="${OTHER_ID:-1}"; OWN_ID="${OWN_ID:-21}"
JAR=$(mktemp -d); trap 'rm -rf "$JAR"' EXIT
ORIGIN=(-H "Origin: $BASE")
JSON=(-H "Content-Type: application/json")

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
call() { # jar, method, path, [body], [extra curl args...] -> prints "HTTP <status>" and the body (first 400 chars)
  local jar="$1" method="$2" path="$3" body="${4:-}"; shift 4 2>/dev/null || shift $#
  local out; out=$(curl -s -w '\n%{http_code}' -X "$method" -b "$JAR/$jar" -c "$JAR/$jar" "$@" ${body:+--data "$body"} "$BASE$path")
  printf 'HTTP %s  %s\n' "$(tail -n1 <<<"$out")" "$(sed '$d' <<<"$out" | head -c 400)"
}

step "1. No session: the API refuses"
call anon GET /api/incidents

step "2. Wrong password: the same generic 401 for every failure"
call aisha POST /api/auth/login '{"email":"aisha.khan@sentinel.example","password":"wrong-password-1"}' "${ORIGIN[@]}" "${JSON[@]}"

step "3. Aisha (analyst) logs in"
call aisha POST /api/auth/login "{\"email\":\"aisha.khan@sentinel.example\",\"password\":\"$ANALYST_PW\"}" "${ORIGIN[@]}" "${JSON[@]}"

step "4. Her incident list: only incidents she reported or is assigned to"
call aisha GET "/api/incidents?page_size=3"

step "5. IDOR: Aisha changes the id to someone else's incident (#$OTHER_ID) -> 404, as if it did not exist"
call aisha GET "/api/incidents/$OTHER_ID"

step "6. One of her own incidents (#$OWN_ID) works, with the moves she is allowed to make"
call aisha GET "/api/incidents/$OWN_ID"

step "7. Mass assignment: trying to set the status through an edit -> 400 (unknown field)"
call aisha PATCH "/api/incidents/$OWN_ID" '{"status":"closed"}' "${ORIGIN[@]}" "${JSON[@]}"

step "8. Cross-site request (wrong Origin) -> 403"
call aisha POST /api/incidents '{"title":"x","narrative":"x","severity":"low"}' -H "Origin: https://evil.example" "${JSON[@]}"

step "9. Admin-only endpoint as an analyst -> 403"
call aisha GET /api/users

step "10. Priya (admin) logs in and reads the analytics; user list has no password hashes"
call priya POST /api/auth/login "{\"email\":\"priya.raman@sentinel.example\",\"password\":\"$ADMIN_PW\"}" "${ORIGIN[@]}" "${JSON[@]}"
call priya GET /api/analytics
call priya GET /api/users

step "11. Aisha logs out; a copy of her old cookie, replayed afterwards, is refused (revoked server-side)"
cp "$JAR/aisha" "$JAR/aisha-copy"
call aisha POST /api/auth/logout '' "${ORIGIN[@]}"
call aisha-copy GET /api/auth/me
