import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { buildApp } from "./app.js";

/**
 * Process entrypoint: load config, connect to Postgres, then start serving.
 * Schema migration is wired in here in the next commit.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const app = buildApp({ pool });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error("fatal: failed to start", err);
  process.exit(1);
});
