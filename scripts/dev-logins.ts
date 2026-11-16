import { randomBytes } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { hashPassword } from "../src/lib/auth/password";
import { migratorConn } from "../src/lib/db";
import { env, loadEnv } from "../src/lib/env";

/**
 * Development only: give seeded accounts a real password so the app can be tried out.
 * Seeds deliberately ship accounts that CANNOT log in ('!SEED-NO-LOGIN!'); no password is ever committed to the repo.
 * This generates a fresh random password per account, stores only its scrypt hash and prints the password once.
 *   npm run dev:logins                                    one admin + one analyst of the loaded seed
 *   npm run dev:logins -- someone@sentinel.example ...    specific accounts
 * Refuses to run with NODE_ENV=production. Uses the import (migrator) account's bootstrap path; the change is still
 * recorded in User_Account_History (source = import) and ends the account's existing sessions.
 */
await loadEnv();
if (env().NODE_ENV === "production") { console.error("dev:logins refuses to run in production"); process.exit(1); }
const conn = await migratorConn();
try {
  let emails = process.argv.slice(2);
  if (emails.length === 0) {
    const [rows] = await conn.query<RowDataPacket[]>(
      `(SELECT email FROM Users WHERE role = 'admin' AND is_active ORDER BY user_id LIMIT 1)
       UNION ALL (SELECT email FROM Users WHERE role = 'analyst' AND is_active ORDER BY user_id LIMIT 1)`);
    emails = rows.map((r) => String(r.email));
  }
  if (emails.length === 0) throw new Error("no users in the database; load a seed first (npm run db:seed -- demo)");
  await conn.query("SET @sentinel_actor = NULL");
  console.log(`Development logins for ${env().MYSQL_DATABASE} (shown once; not stored anywhere in plain text):`);
  for (const email of emails) {
    const password = randomBytes(12).toString("base64url"); // 16 characters
    const [r] = await conn.query("UPDATE Users SET password_hash = ? WHERE email = ?", [await hashPassword(password), email]);
    if ((r as { affectedRows: number }).affectedRows !== 1) { console.error(`  ${email}: no such account`); continue; }
    const [[u]] = await conn.query<RowDataPacket[][]>("SELECT name, role FROM Users WHERE email = ?", [email]) as unknown as [[RowDataPacket]];
    console.log(`  ${u.role.padEnd(7)}  ${email}  ${password}   (${u.name})`);
  }
} finally {
  await conn.end();
}
