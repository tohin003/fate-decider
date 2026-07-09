import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/pool.js";

/**
 * Tests run against a real Postgres — the money paths are exactly what must not
 * be mocked. Defaults to the compose database on host port 5433; override with
 * TEST_DATABASE_URL (e.g. in CI).
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://fate:fate@localhost:5433/fate_decider_test";

export function makeTestPool(): Pool {
  return createPool(TEST_DATABASE_URL);
}

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE wallets, ledger, inventory, reward_claims, idempotency_keys");
}

/** JSON POST helper for app.inject with the correct content-type. */
export function post(
  app: FastifyInstance,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify(body),
  });
}

export function get(app: FastifyInstance, url: string) {
  return app.inject({ method: "GET", url });
}
