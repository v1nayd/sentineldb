#!/usr/bin/env bash
# Creates the databases and the two MySQL accounts. Needs a root-capable shell (MYSQL_ROOT_CMD in .env).
# Idempotent: safe to re-run (it also re-syncs account passwords with .env).
#
# Accounts
#   migrator  : ALL on the dev/test/scratch schemas (no GRANT OPTION). Used only by migrations, seeds and tests.
#   app       : runtime account for the Next.js server. Created with NO privileges; scripts/apply-grants.sh gives it
#               per-table/column grants after migrations.
#   app_test  : same grants as app, but ONLY on the test schema. Integration tests run as this account so the
#               runtime account never touches test data and test grants never widen the runtime account.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

: "${MYSQL_DATABASE:?}"; : "${MYSQL_MIGRATOR_USER:?}"; : "${MYSQL_MIGRATOR_PASSWORD:?}"
: "${MYSQL_APP_USER:?}"; : "${MYSQL_APP_PASSWORD:?}"; : "${MYSQL_APP_TEST_USER:?}"; : "${MYSQL_APP_TEST_PASSWORD:?}"
ROOT_CMD="${MYSQL_ROOT_CMD:-mysql -uroot}"

# Passwords are interpolated into SQL, so refuse anything that could break out of the string literal.
for v in "$MYSQL_MIGRATOR_PASSWORD" "$MYSQL_APP_PASSWORD" "$MYSQL_APP_TEST_PASSWORD"; do
  [[ "$v" =~ ^[A-Za-z0-9._@%+=-]+$ ]] || { echo "Password contains characters outside [A-Za-z0-9._@%+=-]; pick another." >&2; exit 1; }
done

# MYSQL_HOST/MYSQL_PORT from .env are also read by the mysql client; unset them so a socket root login still works.
env -u MYSQL_HOST -u MYSQL_PORT $ROOT_CMD <<SQL
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\`          CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}_test\`     CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}_p1check\`  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS '${MYSQL_MIGRATOR_USER}'@'%' IDENTIFIED BY '${MYSQL_MIGRATOR_PASSWORD}';
ALTER  USER               '${MYSQL_MIGRATOR_USER}'@'%' IDENTIFIED BY '${MYSQL_MIGRATOR_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.*         TO '${MYSQL_MIGRATOR_USER}'@'%';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}_test\`.*    TO '${MYSQL_MIGRATOR_USER}'@'%';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}_p1check\`.* TO '${MYSQL_MIGRATOR_USER}'@'%';

CREATE USER IF NOT EXISTS '${MYSQL_APP_USER}'@'%' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
ALTER  USER               '${MYSQL_APP_USER}'@'%' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
CREATE USER IF NOT EXISTS '${MYSQL_APP_TEST_USER}'@'%' IDENTIFIED BY '${MYSQL_APP_TEST_PASSWORD}';
ALTER  USER               '${MYSQL_APP_TEST_USER}'@'%' IDENTIFIED BY '${MYSQL_APP_TEST_PASSWORD}';
-- Runtime accounts get NO privileges here. Table/column-level grants are applied after migrations by
-- scripts/apply-grants.sh from db/grants.sql.tpl (see the header of that file for why).
SQL
echo "bootstrap ok: databases ${MYSQL_DATABASE}, ${MYSQL_DATABASE}_test, ${MYSQL_DATABASE}_p1check; accounts ${MYSQL_MIGRATOR_USER}, ${MYSQL_APP_USER}, ${MYSQL_APP_TEST_USER} (run scripts/apply-grants.sh after migrating)"
