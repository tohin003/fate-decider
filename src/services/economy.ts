import type { Pool, PoolClient } from "../db/pool.js";
import type { EffectResult } from "../idempotency.js";
import { errorBody } from "../errors.js";

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

/**
 * Atomically debit `price` and grant `itemId`. The debit is a single
 * conditional UPDATE: `SET balance = balance - price WHERE balance >= price`.
 * That one statement takes the row lock, guarantees the balance never goes
 * negative, and serialises concurrent purchases on the same wallet — two
 * requests racing a balance that affords one will see exactly one succeed.
 *
 * If it affects zero rows (no wallet, or too little balance) we reject with
 * INSUFFICIENT_FUNDS having written nothing: no debit, no grant, no partial
 * effect. On success the debit, the inventory grant, and the ledger entry are
 * all in the caller's single transaction, so a `kill -9` can never split the
 * debit from the grant.
 */
export async function purchaseEffect(
  client: PoolClient,
  playerId: string,
  itemId: string,
  price: number,
  idempotencyKey: string,
): Promise<EffectResult> {
  const debit = await client.query(
    `UPDATE wallets SET balance = balance - $2, updated_at = now()
     WHERE player_id = $1 AND balance >= $2
     RETURNING balance`,
    [playerId, price],
  );

  if (debit.rowCount === 0) {
    return {
      status: 409,
      body: errorBody("INSUFFICIENT_FUNDS", "Wallet balance is too low for this purchase."),
    };
  }

  const balance = debit.rows[0].balance as number;

  const ledger = await client.query(
    `INSERT INTO ledger (player_id, entry_type, amount, item_id, idempotency_key)
     VALUES ($1, 'purchase_debit', $2, $3, $4)
     RETURNING id`,
    [playerId, -price, itemId, idempotencyKey],
  );
  const ledgerId = ledger.rows[0].id as number;

  await client.query(
    `INSERT INTO inventory (player_id, item_id, ledger_id) VALUES ($1, $2, $3)`,
    [playerId, itemId, ledgerId],
  );

  return { status: 200, body: { playerId, balance, itemId } };
}

/**
 * Grant a reward once per player. The natural key (reward_id, player_id) makes a
 * second grant physically impossible: `ON CONFLICT DO NOTHING` returning zero
 * rows means this player already holds this reward, which we report as
 * ALREADY_CLAIMED. (A byte-identical retry never reaches here — the idempotency
 * layer replays the original success instead.)
 */
export async function claimEffect(
  client: PoolClient,
  rewardId: string,
  playerId: string,
): Promise<EffectResult> {
  const res = await client.query(
    `INSERT INTO reward_claims (reward_id, player_id) VALUES ($1, $2)
     ON CONFLICT (reward_id, player_id) DO NOTHING
     RETURNING claimed_at`,
    [rewardId, playerId],
  );

  if (res.rowCount === 0) {
    return {
      status: 409,
      body: errorBody("ALREADY_CLAIMED", "This reward has already been claimed by this player."),
    };
  }

  return { status: 200, body: { playerId, rewardId, claimed: true } };
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
