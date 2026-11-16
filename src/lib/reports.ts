import { readFile } from "node:fs/promises";

/**
 * Named SQL blocks in db/reports/*.sql:
 *   -- name: <id>
 *   -- why: / shows: <free text>       (any number of comment lines)
 *   SELECT ... ;
 */
export interface NamedQuery {
  name: string;
  notes: string[];
  sql: string;
}

export function parseNamedQueries(text: string): NamedQuery[] {
  const out: NamedQuery[] = [];
  for (const block of text.split(/^-- name: /m).slice(1)) {
    const [first, ...rest] = block.split("\n");
    const name = first!.trim();
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`bad query name: ${name}`);
    const notes = rest.filter((l) => l.startsWith("-- ")).map((l) => l.slice(3).trim());
    const sql = rest.filter((l) => !l.startsWith("--")).join("\n").trim().replace(/;\s*$/, "");
    if (!sql || sql.includes(";")) throw new Error(`query ${name} must be exactly one statement`);
    out.push({ name, notes, sql });
  }
  return out;
}

export async function loadNamedQueries(file: string): Promise<NamedQuery[]> {
  return parseNamedQueries(await readFile(file, "utf8"));
}
