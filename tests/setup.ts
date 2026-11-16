// Runs before every test file. Points the code under test at the TEST schema/collection, never at dev data,
// and runs the "application" as the test account (same grants as the runtime account, test schema only).
import { config } from "dotenv";
config({ quiet: true });
const base = (process.env.MYSQL_DATABASE ?? "sentineldb").replace(/_test$/, "");
process.env.DEV_APP_USER = process.env.MYSQL_APP_USER; // kept so tests can prove the dev account cannot reach the test schema
process.env.DEV_APP_PASSWORD = process.env.MYSQL_APP_PASSWORD;
process.env.MYSQL_DATABASE = `${base}_test`;
process.env.MYSQL_APP_USER = process.env.MYSQL_APP_TEST_USER;
process.env.MYSQL_APP_PASSWORD = process.env.MYSQL_APP_TEST_PASSWORD;
process.env.QDRANT_COLLECTION = "incident_narratives_test";
