import type { Pool, PoolClient } from "../db/pool.js";
import type { EffectResult } from "../idempotency.js";

/**
 * The transactional core. Every function here runs inside a caller-provided
 * transaction (via runIdempotent) so the effect and its idempotency record
 * commit or roll back together. All money SQL lives in this module.
 */

/** Add currency to a wallet (simulated battle payout). Creates the wallet on first credit. */
export async function creditEffect(
  client: PoolClient,
  playerId: string,
  amount: number,
  reason: string,
  idempotencyKey: string,
): Promise<EffectResult> {
  const { rows } = await client.query(
    `INSERT INTO wallets (player_id, balance) VALUES ($1, $2)
     ON CONFLICT (player_id)
       DO UPDATE SET balance = wallets.balance + EXCLUDED.balance, updated_at = now()
     RETURNING balance`,
    [playerId, amount],
  );
  const balance = rows[0].balance as number;

  await client.query(
    `INSERT INTO ledger (player_id, entry_type, amount, reason, idempotency_key)
     VALUES ($1, 'credit', $2, $3, $4)`,
    [playerId, amount, reason, idempotencyKey],
  );

  return { status: 200, body: { playerId, balance } };
}

export interface WalletView {
  balance: number;
  inventory: string[];
  claimedRewards: string[];
}

/**
 * Read-only wallet snapshot for state assertions. Uses a REPEATABLE READ
 * read-only transaction so balance, inventory, and claims come from one
 * consistent snapshot even while writes are happening. An unknown player
 * returns the zero state rather than 404, keeping black-box assertions simple.
 */
export async function readWallet(pool: Pool, playerId: string): Promise<WalletView> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const balanceRes = await client.query(`SELECT balance FROM wallets WHERE player_id = $1`, [playerId]);
    const inventoryRes = await client.query(
      `SELECT item_id FROM inventory WHERE player_id = $1 ORDER BY id`,
      [playerId],
    );
    const claimsRes = await client.query(
      `SELECT reward_id FROM reward_claims WHERE player_id = $1 ORDER BY reward_id`,
      [playerId],
    );
    await client.query("COMMIT");

    return {
      balance: balanceRes.rows.length > 0 ? (balanceRes.rows[0].balance as number) : 0,
      inventory: inventoryRes.rows.map((r) => r.item_id as string),
      claimedRewards: claimsRes.rows.map((r) => r.reward_id as string),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
