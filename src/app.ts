import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "./db/pool.js";

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

  // Expose the pool to route handlers registered in later phases.
  app.decorate("db", deps.pool);

  app.get("/health", async () => {
    // Liveness only for now; a readiness probe that pings the DB is added
    // once the pool is exercised by real routes.
    return { status: "ok" };
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
  }
}
