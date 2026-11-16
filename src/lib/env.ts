import { z } from "zod";

/**
 * Server-side configuration. Validated once; never imported from client components.
 * Values come from process.env (Next.js loads .env itself; CLI scripts call loadEnv() first).
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MYSQL_HOST: z.string().min(1).default("127.0.0.1"),
  MYSQL_PORT: z.coerce.number().int().positive().default(3306),
  MYSQL_DATABASE: z.string().regex(/^[A-Za-z0-9_]+$/, "database name must be [A-Za-z0-9_]"),
  MYSQL_MIGRATOR_USER: z.string().min(1).optional(),
  MYSQL_MIGRATOR_PASSWORD: z.string().min(1).optional(),
  MYSQL_APP_USER: z.string().min(1),
  MYSQL_APP_PASSWORD: z.string().min(1),
  MYSQL_APP_TEST_USER: z.string().min(1).optional(),
  MYSQL_APP_TEST_PASSWORD: z.string().min(1).optional(),
  QDRANT_URL: z.string().url().default("http://127.0.0.1:6333"),
  QDRANT_COLLECTION: z.string().regex(/^[A-Za-z0-9_-]+$/).default("incident_narratives"),
  EMBEDDING_MODEL_DIR: z.string().min(1).default("./models/all-MiniLM-L6-v2"),
  // The origin browsers use to reach the app. State-changing API requests must come from it (CSRF defence, src/lib/http.ts).
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  // Only behind a reverse proxy that sets X-Forwarded-For: then the first address is used for per-IP login limits.
  // Next.js route handlers do not expose the socket address, so without a proxy per-IP limiting is off (see docs).
  TRUST_PROXY_HEADERS: z.enum(["true", "false"]).default("false"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      // Report which variables are wrong, never their values (they may be secrets).
      const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid or missing environment variables: ${names}. See .env.example.`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** For CLI scripts (tsx): load .env into process.env before calling env(). */
export async function loadEnv(): Promise<void> {
  const { config } = await import("dotenv");
  config({ quiet: true });
  cached = undefined;
}
