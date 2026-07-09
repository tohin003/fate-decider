import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "./db/pool.js";
import { registerErrorHandler } from "./errors.js";
import { registerWalletRoutes } from "./routes/wallets.js";
import { registerRewardRoutes } from "./routes/rewards.js";

export interface AppDeps {
  pool: Pool;
}

/**
 * Builds a Fastify instance wired to its dependencies.
 *
 * The app owns no global state — the Postgres pool is injected — so tests can
 * spin up an instance against a throwaway database and exercise the real HTTP
 * pipeline via `app.inject()` without opening a socket.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    // Reject bodies larger than our documented limit at the framework edge,
    // before any handler or JSON parse work happens.
    bodyLimit: 16 * 1024,
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  // Expose the pool to route handlers.
  app.decorate("db", deps.pool);

  registerErrorHandler(app);

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerWalletRoutes(app);
  registerRewardRoutes(app);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
  }
}
