// Dumps embeddings from the production TypeScript path to JSON so an independent implementation can be compared.
import { readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "../../src/lib/env";
await loadEnv();
const { embedTexts } = await import("../../src/lib/embedding");
// argv[3] is a path to a JSON array of texts. (Passing the JSON itself as an argument broke on Windows, where the npx
// shim cuts a multi-line argument at the first newline.)
const texts: string[] = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
const out = await embedTexts(texts);
writeFileSync(process.argv[2]!, JSON.stringify(out.map((o) => ({ vector: o.vector, truncated: o.truncated }))));
console.log(`wrote ${out.length} embeddings`);
