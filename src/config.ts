/**
 * Runtime configuration, read once from the environment at startup.
 *
 * Everything here has a safe local default so the service (and tests) can run
 * without a hand-written .env; docker-compose overrides these for the
 * containerised setup.
 */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got "${raw}"`);
  }
  return value;
}

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  /** How long a stored idempotency result is honoured before it may be pruned. */
  idempotencyTtlHours: number;
}

export function loadConfig(): Config {
  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: intFromEnv("PORT", 3000),
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgres://fate:fate@localhost:5432/fate_decider",
    idempotencyTtlHours: intFromEnv("IDEMPOTENCY_TTL_HOURS", 24),
  };
}
