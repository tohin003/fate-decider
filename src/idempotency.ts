import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "./db/pool.js";
import { errorBody } from "./errors.js";

/** What an effect returns. `body` is serialized once and both sent and stored. */
export interface EffectResult {
  status: number;
  body: unknown;
}

export interface IdempotentOutcome {
  status: number;
  /** The exact response bytes — a replay returns the stored original verbatim. */
  bodyText: string;
  /** True when this response was replayed from a prior identical request. */
  replayed: boolean;
}

export interface IdempotencyContext {
  key: string;
  scope: string;
  requestHash: string;
}

/** Stable JSON: object keys sorted recursively, so logically-equal bodies hash equal. */
function canonicalize(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sort((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Derives the idempotency identity of a request:
 *  - scope   = "METHOD /concrete/path" — namespaces the key to this exact
 *              operation+resource (player A's credit ≠ player B's credit).
 *  - requestHash = SHA-256 of the canonical body — used to detect a key reused
 *              with a different payload.
 *  - key     = the client's `Idempotency-Key` header if supplied, otherwise the
 *              body fingerprint, so a byte-identical retry with no header still
 *              deduplicates.
 */
export function idempotencyContext(req: FastifyRequest): IdempotencyContext {
  const path = req.url.split("?")[0] ?? req.url;
  const scope = `${req.method} ${path}`;
  const requestHash = sha256(canonicalize(req.body ?? {}));
  const header = req.headers["idempotency-key"];
  const key = typeof header === "string" && header.length > 0 ? header : requestHash;
  return { key, scope, requestHash };
}

/**
 * Runs `effect` exactly once per (key, scope), even under concurrent duplicates
 * and crashes.
 *
 * The key row is reserved with INSERT ... ON CONFLICT DO NOTHING *inside* the
 * same transaction as the effect. Postgres makes a concurrent duplicate block
 * on the unique index until the first transaction commits or rolls back:
 *   - reserved (1 row inserted) → we own the key: run the effect, store its
 *     response, COMMIT. If the process dies before COMMIT, the reservation and
 *     the effect roll back together, so a post-crash retry runs exactly once.
 *   - not reserved (0 rows)     → another request already committed this key:
 *     read the stored response and replay it verbatim. A different body under
 *     the same key is rejected rather than silently applied.
 */
export async function runIdempotent(
  pool: Pool,
  ctx: IdempotencyContext,
  effect: (client: PoolClient) => Promise<EffectResult>,
): Promise<IdempotentOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const reserve = await client.query(
      `INSERT INTO idempotency_keys (key, scope, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, 0, '{}'::json)
       ON CONFLICT (key, scope) DO NOTHING`,
      [ctx.key, ctx.scope, ctx.requestHash],
    );

    if (reserve.rowCount === 0) {
      // The key is already committed (we blocked until the owner finished).
      // Read it in this same transaction — the committed row is now visible.
      // Cast to text so we replay the stored response byte-for-byte.
      const existing = await client.query(
        `SELECT request_hash, response_status, response_body::text AS response_text
         FROM idempotency_keys WHERE key = $1 AND scope = $2`,
        [ctx.key, ctx.scope],
      );
      await client.query("ROLLBACK");

      const row = existing.rows[0] as
        | { request_hash: string; response_status: number; response_text: string }
        | undefined;

      if (!row) {
        // Effectively unreachable: a just-conflicted key is fresh and cannot
        // have been pruned. Surface rather than risk re-applying the effect.
        return {
          status: 409,
          bodyText: JSON.stringify(
            errorBody("IDEMPOTENCY_RESULT_UNAVAILABLE", "Prior result is no longer available; retry."),
          ),
          replayed: true,
        };
      }
      if (row.request_hash !== ctx.requestHash) {
        return {
          status: 422,
          bodyText: JSON.stringify(
            errorBody(
              "IDEMPOTENCY_KEY_REUSED",
              "This idempotency key was already used with a different request body.",
            ),
          ),
          replayed: true,
        };
      }
      return { status: row.response_status, bodyText: row.response_text, replayed: true };
    }

    // We reserved the key: perform the effect and persist its response so future
    // duplicates replay it. Business failures (e.g. insufficient funds) are
    // returned as results and stored too, so a retried failure replays identically.
    const result = await effect(client);
    const bodyText = JSON.stringify(result.body);
    await client.query(
      `UPDATE idempotency_keys SET response_status = $1, response_body = $2::json
       WHERE key = $3 AND scope = $4`,
      [result.status, bodyText, ctx.key, ctx.scope],
    );
    await client.query("COMMIT");
    return { status: result.status, bodyText, replayed: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Deletes idempotency rows older than the retention window. Claim-once is
 * unaffected — it is enforced permanently by reward_claims, not by these keys. */
export async function pruneExpiredKeys(pool: Pool, ttlHours: number): Promise<number> {
  const res = await pool.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - ($1 || ' hours')::interval`,
    [String(ttlHours)],
  );
  return res.rowCount ?? 0;
}
