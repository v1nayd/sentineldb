import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDemoSeed } from "./seed/demo";
import { buildSpikeSeed } from "./seed/spike";

/**
 * Regenerates the seed files from their generators (deterministic: same input, same bytes).
 *   npm run db:seed:generate            write db/seed/{spike_seed.sql, demo_seed.sql, demo_labels.json}
 *   npm run db:seed:generate -- --check exit 1 if the committed files differ from a fresh generation
 * The generated SQL is committed so it can be reviewed and loaded without running TypeScript.
 */
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/seed");

export function generatedFiles(): Record<string, string> {
  const demo = buildDemoSeed();
  return {
    "spike_seed.sql": buildSpikeSeed(),
    "demo_seed.sql": demo.sql,
    "demo_labels.json": JSON.stringify(demo.labels, null, 2) + "\n",
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [name, content] of Object.entries(generatedFiles())) {
    const file = path.join(dir, name);
    if (check) {
      const current = await readFile(file, "utf8").catch(() => "");
      if (current !== content) { console.error(`${name}: differs from a fresh generation (run npm run db:seed:generate)`); stale++; }
      else console.log(`${name}: up to date`);
    } else {
      await writeFile(file, content, "utf8");
      console.log(`wrote db/seed/${name} (${content.split("\n").length} lines)`);
    }
  }
  if (stale) process.exit(1);
}
