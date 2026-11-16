import type { Connection, RowDataPacket } from "mysql2/promise";

/**
 * A seed is a baseline for an EMPTY database. "Empty" means EVERY application table, not just Users/Incidents:
 * a stray Assets/IOCs/Playbooks row would otherwise slip past and collide (or silently merge) with seeded keys.
 * The table list comes from the live catalog, so tables added by later migrations are covered automatically.
 * Reference tables that migrations themselves fill (e.g. Status_Transitions) are marked with a table COMMENT starting
 * with "reference:" and are skipped; that marker is also catalog-driven, so no list of names is kept here.
 * Names are reported as the catalog stores them (lower case on Windows, where lower_case_table_names = 1).
 */
export async function nonEmptyTables(conn: Connection): Promise<string[]> {
  const [tables] = await conn.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> 'schema_migrations'
        AND TABLE_COMMENT NOT LIKE 'reference:%' ORDER BY TABLE_NAME`,
  );
  const populated: string[] = [];
  for (const { t } of tables as Array<{ t: string }>) {
    if (!/^[A-Za-z0-9_]+$/.test(t)) throw new Error(`Unexpected table name: ${t}`);
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT 1 FROM \`${t}\` LIMIT 1`);
    if (rows.length > 0) populated.push(t);
  }
  return populated;
}

export class DatabaseNotEmptyError extends Error {
  constructor(readonly tables: string[]) {
    super(`Database is not empty (${tables.join(", ")}). Run \`npm run db:reset\` first to restore the baseline.`);
  }
}

export async function assertEmptyForSeed(conn: Connection): Promise<void> {
  const populated = await nonEmptyTables(conn);
  if (populated.length > 0) throw new DatabaseNotEmptyError(populated);
}
