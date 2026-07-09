import pg from "pg";

/**
 * BIGINT columns (balances, ledger amounts) come back from pg as strings by
 * default to avoid precision loss above 2^53. Our documented ceiling for any
 * single amount is 1e9 and balances are bounded well within Number.MAX_SAFE_INTEGER,
 * so parsing OID 20 (int8) to a JS number is safe and keeps the money code simple.
 * If the ceiling were ever raised past 2^53 this decision must be revisited.
 */
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    // Fail fast rather than hanging a request forever if the DB is unreachable.
    connectionTimeoutMillis: 5_000,
  });
}
