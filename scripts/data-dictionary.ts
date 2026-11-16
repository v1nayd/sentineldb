import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { loadEnv, env } from "../src/lib/env";
import { migratorConn } from "../src/lib/db";

/**
 * Generates docs/DATA_DICTIONARY.md from the LIVE catalog (information_schema) of the migrated dev schema, so the
 * dictionary cannot drift from the database: types, nullability, defaults, keys, foreign-key rules, CHECK constraints,
 * indexes, triggers, views and routines are read, not typed. Only the one-line purposes below are hand-written.
 *   npm run db:dictionary
 */
const PURPOSE: Record<string, string> = {
  users: "People who use SentinelDB. role = analyst | admin. Never deleted (audit rows reference them).",
  assets: "Inventory of servers, workstations, network devices and applications that incidents can affect.",
  incidents: "The central entity: one security incident, its narrative (embedded into Qdrant) and its lifecycle state.",
  iocs: "Indicators of compromise (IP, domain, file hash, email, URL), unique per (type, value).",
  incident_ioc: "M:N link incident-IOC, with the analyst's review decision (closure requires no pending review).",
  incident_asset: "M:N link incident-asset, with the impact on that asset (closure requires it to be described).",
  playbooks: "Response procedures, by incident type.",
  incident_playbook: "M:N record of which playbook was applied to which incident, and when.",
  incident_status_history: "Audit: one row per real status change (and the NULL -> open origin). Written only by triggers; immutable.",
  incident_assignment_history: "Audit: one row per assignment / reassignment. Written only by triggers; immutable.",
  incident_evidence_history: "Audit: IOC/asset linked, unlinked, IOC reviewed. Written only by triggers; immutable.",
  notes: "Analyst notes on an incident. Append-only; the author is always the acting user.",
  status_transitions: "Reference data: the lifecycle state machine (allowed from -> to, who may, reason required?).",
  schema_migrations: "Migration bookkeeping (version, checksum). Not accessible to the runtime account.",
  user_account_history: "Audit: account created, role changed, (de)activated, password or e-mail changed. Trigger-written; immutable.",
  sessions: "Server-side login sessions. Only SHA-256 of the cookie token is stored; 8 h absolute, 30 min idle; revocable.",
  auth_events: "Append-only log of logins / failures / blocks / logouts; the login rate limiter counts from it.",
  embedding_jobs: "Outbox (M4): MySQL -> Qdrant propagation jobs, written by triggers in the changing transaction; processed by the sync worker.",
};
const COLUMN_NOTES: Record<string, string> = {
  "incidents.status": "Changed only through transition_incident / close_incident (validated against Status_Transitions).",
  "incidents.assigned_to": "Changed only through reassign_incident (admin).",
  "incidents.resolved_at": "Maintained by trigger: set on resolving, kept on closing, cleared on reopening.",
  "incidents.updated_at": "Maintained by trigger: last real change (a no-op UPDATE does not move it).",
  "incidents.narrative_version": "Maintained by trigger: +1 per narrative change; fences vector-index writes (M4).",
  "incidents.created_at": "Set by trigger from the DB clock (import sessions may replay history with @sentinel_clock).",
  "incidents.archived_at": "Set by archive_incident (admin, closed incidents only). Archived incidents are read-only.",
  "incident_ioc.review_status": "pending | confirmed | dismissed. reviewed_by / reviewed_at are stamped by the trigger.",
  "incident_status_history.changed_by": "Acting end user asserted by the application (@sentinel_actor), FK RESTRICT.",
  "incident_status_history.db_account": "The real MySQL account (USER()) that made the change.",
  "incident_status_history.source": "import = the migrator/import account (seed replay); runtime = any other account.",
  "notes.author_id": "Must equal the acting user (trigger SDB21).",
  "users.password_hash": "scrypt hash ($scrypt$ln=17,r=8,p=1$...). NOT readable by the runtime account; login uses auth_lookup().",
  "users.is_active": "Deactivated users cannot log in, act (SDB02) or be assigned (SDB42); their sessions are revoked.",
  "sessions.token_hash": "SHA-256 hex of the random cookie token; the token itself is never stored.",
  "sessions.expires_at": "Set by trigger: created_at + 8 hours. Not writable by the runtime account.",
  "embedding_jobs.status": "pending -> running -> done | superseded | failed (after 5 attempts); running iff locked_at/locked_by set.",
  "embedding_jobs.narrative_version": "The Incidents.narrative_version this job propagates; (incident_id, narrative_version, action) is unique.",
};

async function q(conn: Connection, sql: string, db: string): Promise<RowDataPacket[]> {
  return (await conn.query<RowDataPacket[]>(sql, [db]))[0];
}
const lc = (s: unknown) => String(s).toLowerCase();
const cell = (s: unknown) => (s === null || s === undefined || s === "" ? "" : String(s).replace(/\|/g, "\\|").replace(/\s+/g, " "));

export async function buildDictionary(conn: Connection, db: string): Promise<string> {
  const tables = await q(conn, "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_TYPE, TABLE_NAME", db);
  const cols = await q(conn, "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION", db);
  const fks = await q(conn, `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE
    FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
    WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME`, db);
  const checks = await q(conn, `SELECT t.TABLE_NAME, c.CONSTRAINT_NAME, c.CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS c
    JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME = c.CONSTRAINT_NAME
    WHERE c.CONSTRAINT_SCHEMA = ? ORDER BY t.TABLE_NAME, c.CONSTRAINT_NAME`, db);
  const idx = await q(conn, `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE ORDER BY TABLE_NAME, INDEX_NAME`, db);
  const trg = await q(conn, "SELECT EVENT_OBJECT_TABLE, TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING DESC, EVENT_MANIPULATION, ACTION_ORDER", db);
  const routines = await q(conn, "SELECT ROUTINE_NAME, ROUTINE_TYPE, SECURITY_TYPE, ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE DESC, ROUTINE_NAME", db);
  const [[ver]] = await conn.query<RowDataPacket[]>("SELECT MAX(version) AS v FROM schema_migrations");

  const out: string[] = [
    "# SentinelDB data dictionary",
    "",
    `> **Generated** by \`npm run db:dictionary\` from the live catalog (information_schema) of a database migrated to version ${String(ver!.v).padStart(4, "0")}. Do not edit by hand; regenerate after a migration.`,
    "> Table names appear in lower case when generated on Windows (MySQL `lower_case_table_names = 1`); SQL in this project is written in the original mixed case and works on both.",
    "",
    `Base tables: ${tables.filter((t) => t.TABLE_TYPE === "BASE TABLE").length} · views: ${tables.filter((t) => t.TABLE_TYPE === "VIEW").length} · triggers: ${trg.length} · procedures/functions: ${routines.length}`,
    "",
  ];
  for (const t of tables.filter((x) => x.TABLE_TYPE === "BASE TABLE")) {
    const name = String(t.TABLE_NAME);
    out.push(`## ${name}`, "", PURPOSE[lc(name)] ?? "", "", "| Column | Type | Null | Default | Key | Notes |", "|---|---|---|---|---|---|");
    for (const c of cols.filter((x) => x.TABLE_NAME === name)) {
      out.push(`| ${c.COLUMN_NAME} | ${cell(c.COLUMN_TYPE)} | ${c.IS_NULLABLE === "YES" ? "yes" : "no"} | ${cell(c.COLUMN_DEFAULT)} | ${cell(c.COLUMN_KEY)}${c.EXTRA ? ` ${cell(c.EXTRA)}` : ""} | ${cell(COLUMN_NOTES[`${lc(name)}.${lc(c.COLUMN_NAME)}`])} |`);
    }
    const f = fks.filter((x) => x.TABLE_NAME === name);
    if (f.length) { out.push("", "Foreign keys: " + f.map((x) => `\`${x.COLUMN_NAME}\` → ${x.REFERENCED_TABLE_NAME}.${x.REFERENCED_COLUMN_NAME} (ON DELETE ${x.DELETE_RULE})`).join("; ")); }
    const ch = checks.filter((x) => x.TABLE_NAME === name);
    if (ch.length) { out.push("", "CHECK constraints:", ...ch.map((x) => `- \`${x.CONSTRAINT_NAME}\`: \`${cell(x.CHECK_CLAUSE)}\``)); }
    const ix = idx.filter((x) => x.TABLE_NAME === name);
    if (ix.length) { out.push("", "Indexes: " + ix.map((x) => `\`${x.INDEX_NAME}\` (${x.cols})${Number(x.NON_UNIQUE) === 0 ? " unique" : ""}`).join("; ")); }
    const tr = trg.filter((x) => lc(x.EVENT_OBJECT_TABLE) === lc(name));
    if (tr.length) { out.push("", "Triggers: " + tr.map((x) => `\`${x.TRIGGER_NAME}\` (${x.ACTION_TIMING} ${x.EVENT_MANIPULATION})`).join("; ")); }
    out.push("");
  }
  out.push("## Views", "", "| View | Columns |", "|---|---|");
  for (const v of tables.filter((x) => x.TABLE_TYPE === "VIEW")) {
    out.push(`| ${v.TABLE_NAME} | ${cols.filter((c) => c.TABLE_NAME === v.TABLE_NAME).map((c) => c.COLUMN_NAME).join(", ")} |`);
  }
  out.push("", "## Stored procedures and functions", "", "| Name | Type | Security | Purpose |", "|---|---|---|---|");
  for (const r of routines) out.push(`| ${r.ROUTINE_NAME} | ${r.ROUTINE_TYPE} | ${r.SECURITY_TYPE} | ${cell(r.ROUTINE_COMMENT)} |`);
  out.push("");
  return out.join("\n");
}

// Canonical (mixed-case) table names for the diagram; the catalog reports lower case on Windows.
const CANON = ["Users", "Assets", "Incidents", "IOCs", "Incident_IOC", "Incident_Asset", "Playbooks", "Incident_Playbook", "Notes",
  "Incident_Status_History", "Incident_Assignment_History", "Incident_Evidence_History", "Status_Transitions", "User_Account_History",
  "Sessions", "Auth_Events", "Embedding_Jobs", "schema_migrations"];
const canon = (t: unknown) => CANON.find((c) => c.toLowerCase() === lc(t)) ?? String(t);

/** Mermaid erDiagram of every base table, its keys and every foreign key, read from the live catalog. */
export async function buildEr(conn: Connection, db: string): Promise<string> {
  const tables = (await q(conn, "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", db)).map((t) => String(t.TABLE_NAME));
  const cols = await q(conn, "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION", db);
  const fks = await q(conn, `SELECT k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.CONSTRAINT_NAME, c.IS_NULLABLE
    FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = k.TABLE_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME AND c.COLUMN_NAME = k.COLUMN_NAME
    WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME`, db);
  const fkCols = new Set(fks.map((f) => `${lc(f.TABLE_NAME)}.${lc(f.COLUMN_NAME)}`));
  const out = ["erDiagram"];
  for (const t of tables) {
    out.push(`  ${canon(t)} {`);
    for (const c of cols.filter((c) => lc(c.TABLE_NAME) === lc(t))) {
      const keys = [c.COLUMN_KEY === "PRI" ? "PK" : null, fkCols.has(`${lc(t)}.${lc(c.COLUMN_NAME)}`) ? "FK" : null, c.COLUMN_KEY === "UNI" ? "UK" : null].filter(Boolean).join(", ");
      out.push(`    ${c.DATA_TYPE} ${c.COLUMN_NAME}${keys ? ` ${keys}` : ""}`);
    }
    out.push("  }");
  }
  for (const f of fks) {
    // child }o--|| parent: many children per parent; "o|" on the parent side when the FK column is nullable.
    out.push(`  ${canon(f.REFERENCED_TABLE_NAME)} ${f.IS_NULLABLE === "YES" ? "|o" : "||"}--o{ ${canon(f.TABLE_NAME)} : "${String(f.COLUMN_NAME)}"`);
  }
  return out.join("\n");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await loadEnv();
  const conn = await migratorConn(env().MYSQL_DATABASE);
  try {
    const md = await buildDictionary(conn, env().MYSQL_DATABASE);
    await writeFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/DATA_DICTIONARY.md"), md, "utf8");
    console.log("written: docs/DATA_DICTIONARY.md");
    const er = await buildEr(conn, env().MYSQL_DATABASE);
    const doc = [
      "# SentinelDB entity-relationship diagram (as built)", "",
      "> **Generated** by `npm run db:dictionary` from the live catalog: every base table, its primary (PK), foreign (FK) and",
      "> unique (UK) key columns, and every foreign key. `||--o{` = one parent, many children; `|o--o{` = the foreign key is",
      "> optional (nullable). All foreign keys are `ON DELETE RESTRICT` (migration 0003): users are deactivated and",
      "> incidents archived, never deleted. The Phase 1 diagram is kept unchanged in `phase1/`. Column details:",
      "> [DATA_DICTIONARY.md](DATA_DICTIONARY.md).", "",
      "```mermaid", er, "```", "",
    ].join("\n");
    await writeFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/ER.md"), doc, "utf8");
    console.log("written: docs/ER.md");
  } finally {
    await conn.end();
  }
}
