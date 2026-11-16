#!/usr/bin/env bash
# Applies db/grants.sql.tpl to the runtime accounts. Run AFTER migrations, as a privileged DB admin (MYSQL_ROOT_CMD).
# Idempotent and authoritative: it first REVOKES ALL from each runtime account (all levels), then re-grants.
#   dev   schema <db>       -> account MYSQL_APP_USER       (the account the web app uses)
#   test  schema <db>_test  -> account MYSQL_APP_TEST_USER  (same grants, test schema only; never the dev account)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
ROOT_CMD="${MYSQL_ROOT_CMD:-mysql -uroot}"
run_root() { env -u MYSQL_HOST -u MYSQL_PORT $ROOT_CMD; }

apply() { # $1 = schema, $2 = account
  local db="$1" app="$2"
  echo "revoke + grant: $app on $db"
  { echo "REVOKE ALL PRIVILEGES, GRANT OPTION FROM '${app}'@'%';"
    sed -e "s/{{DB}}/${db}/g" -e "s/{{APP}}/${app}/g" db/grants.sql.tpl; } | run_root
}

# The test schema is disposable: rebuild it so table-level grants have tables to attach to.
MYSQL_DATABASE="${MYSQL_DATABASE}_test" NODE_ENV=development npx tsx scripts/migrate.ts --reset >/dev/null
# The dev schema must already be migrated (we never reset dev data from here).
npx tsx scripts/migrate.ts >/dev/null

apply "${MYSQL_DATABASE}"       "${MYSQL_APP_USER}"
apply "${MYSQL_DATABASE}_test"  "${MYSQL_APP_TEST_USER}"
echo "grants applied"
