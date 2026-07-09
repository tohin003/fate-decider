import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "./pool.js";
import { loadConfig } from "../config.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Applies the schema. Idempotent (schema uses IF NOT EXISTS), so it runs on
 * every boot. Retries while the database is still starting up — under
 * docker-compose the app container can win the race against Postgres.
 */
export async function migrate(
  pool: Pool,
  opts: { retries?: number; delayMs?: number } = {},
): Promise<void> {
  const retries = opts.retries ?? 30;
  const delayMs = opts.delayMs ?? 1_000;
  const schema = readFileSync(join(here, "schema.sql"), "utf8");

  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(schema);
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// Allow running migrations standalone: `npm run migrate`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  migrate(pool)
    .then(() => {
      console.log("migration complete");
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("migration failed", err);
      process.exit(1);
    });
}
