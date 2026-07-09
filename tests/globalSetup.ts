import pg from "pg";
import { createPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { TEST_DATABASE_URL } from "./helpers.js";

/**
 * Runs once before the whole suite: ensures the dedicated test database exists
 * (so tests never touch dev data) and applies the schema to it. Tests then
 * truncate between cases rather than re-migrating.
 */
export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);

  // Connect to the maintenance database to create the test DB if missing.
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  }
  await admin.end();

  const pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
  await pool.end();
}
