import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } }, // same "@/*" mapping as tsconfig.json (Next.js routes use it)
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    fileParallelism: false, // tests share one MySQL test schema and one Qdrant server
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
