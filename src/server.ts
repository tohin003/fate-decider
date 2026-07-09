import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { pruneExpiredKeys } from "./idempotency.js";
import { buildApp } from "./app.js";

/**
 * Process entrypoint: load config, connect to Postgres, apply the schema, then
 * start serving. Migration runs before we accept traffic so no request ever
 * hits a half-initialised database.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  const app = buildApp({ pool });

  // Retention: periodically drop idempotency rows past the TTL. Claim-once is
  // permanent (reward_claims), so it is unaffected by this cleanup.
  const pruneTimer = setInterval(() => {
    pruneExpiredKeys(pool, config.idempotencyTtlHours).catch((err) =>
      app.log.warn({ err }, "idempotency prune failed"),
    );
  }, 60 * 60 * 1000);
  pruneTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    clearInterval(pruneTimer);
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
