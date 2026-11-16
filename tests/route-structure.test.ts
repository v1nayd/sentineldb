import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./fixtures";

/**
 * Structural rules for API routes (ADR-7 rule 1 and the src/lib/http.ts wrapper), checked on the source so that a new
 * route cannot quietly skip them:
 *   - a route handler never obtains a database connection itself (no imports of lib/db, mysql2, lib/actor): writes go
 *     through repository functions that use withActor(), so session variables are always set AND cleared;
 *   - every exported HTTP method is built with api(...), which applies CSRF, authentication, roles and error mapping.
 * The health probe is the one documented exception (read-only reachability check, no user context).
 */
async function routeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await routeFiles(full)));
    else if (e.name === "route.ts") out.push(full);
  }
  return out;
}

describe("API route structure", async () => {
  const files = (await routeFiles(path.join(ROOT, "src/app/api"))).filter((f) => !f.includes(`${path.sep}health${path.sep}`));
  it("finds the routes", () => expect(files.length).toBeGreaterThanOrEqual(20));
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    it(`${rel}: no direct database access, every handler wrapped in api()`, async () => {
      const src = await readFile(f, "utf8");
      expect(src).not.toMatch(/from\s+["'](?:mysql2[^"']*|[^"']*lib\/(?:db|actor))["']/);
      expect(src).not.toMatch(/\bappPool\b|\bmigratorConn\b|\bwithActor\b/);
      const exported = [...src.matchAll(/export\s+(?:const|async function|function)\s+(GET|POST|PATCH|PUT|DELETE)\b\s*(=?)/g)];
      expect(exported.length).toBeGreaterThan(0);
      for (const m of exported) expect(src).toMatch(new RegExp(`export const ${m[1]}\\s*=\\s*api(?:<[^>]*>)?\\(`));
    });
  }
});
