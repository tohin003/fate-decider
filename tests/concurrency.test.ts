import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeTestPool, truncateAll, post, get } from "./helpers.js";
import type { Pool } from "../src/db/pool.js";

let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = makeTestPool();
  app = buildApp({ pool });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
});

const key = (k: string) => ({ "idempotency-key": k });

/** The core invariant: a player's balance equals the sum of their ledger entries. */
async function assertLedgerMatchesBalance(playerId: string): Promise<void> {
  const res = await pool.query(
    `SELECT (SELECT balance FROM wallets WHERE player_id = $1) AS balance,
            (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE player_id = $1)::int AS ledger_sum`,
    [playerId],
  );
  expect(res.rows[0].ledger_sum).toBe(res.rows[0].balance);
}

describe("concurrency correctness on a single wallet", () => {
  it("two purchases racing a balance that affords one → exactly one succeeds", async () => {
    await post(app, "/v1/wallets/w1/credit", { amount: 100, reason: "seed" });
    const [a, b] = await Promise.all([
      post(app, "/v1/wallets/w1/purchase", { itemId: "grail", price: 100 }, key("a")),
      post(app, "/v1/wallets/w1/purchase", { itemId: "grail", price: 100 }, key("b")),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const wallet = (await get(app, "/v1/wallets/w1")).json();
    expect(wallet.balance).toBe(0);
    expect(wallet.inventory).toEqual(["grail"]);
    await assertLedgerMatchesBalance("w1");
  });

  it("ten purchases @30 against a balance of 100 → exactly three succeed, never negative", async () => {
    await post(app, "/v1/wallets/w2/credit", { amount: 100, reason: "seed" });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        post(app, "/v1/wallets/w2/purchase", { itemId: `slot-${i}`, price: 30 }, key(`p-${i}`)),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 200).length;
    const rejected = results.filter((r) => r.statusCode === 409).length;
    expect(ok).toBe(3);
    expect(rejected).toBe(7);

    const wallet = (await get(app, "/v1/wallets/w2")).json();
    expect(wallet.balance).toBe(10);
    expect(wallet.inventory).toHaveLength(3);
    await assertLedgerMatchesBalance("w2");
  });

  it("fifty concurrent credits sum exactly, with no lost updates", async () => {
    const amounts = Array.from({ length: 50 }, (_, i) => i + 1); // 1..50, total 1275
    await Promise.all(
      amounts.map((amount, i) =>
        post(app, "/v1/wallets/w3/credit", { amount, reason: "c" }, key(`c-${i}`)),
      ),
    );
    expect((await get(app, "/v1/wallets/w3")).json().balance).toBe(1275);
    await assertLedgerMatchesBalance("w3");
  });

  it("twenty concurrent claims of one reward → exactly one succeeds", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post(app, "/v1/rewards/gold/claim", { playerId: "w4" }, key(`claim-${i}`)),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(19);
    expect((await get(app, "/v1/wallets/w4")).json().claimedRewards).toEqual(["gold"]);
  });

  it("interleaved credits and purchases keep balance == ledger sum and never negative", async () => {
    await post(app, "/v1/wallets/w5/credit", { amount: 200, reason: "seed" });
    const ops = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? post(app, "/v1/wallets/w5/credit", { amount: 10, reason: "c" }, key(`m-c-${i}`))
        : post(app, "/v1/wallets/w5/purchase", { itemId: `i-${i}`, price: 15 }, key(`m-p-${i}`)),
    );
    await Promise.all(ops);

    const wallet = (await get(app, "/v1/wallets/w5")).json();
    expect(wallet.balance).toBeGreaterThanOrEqual(0);
    await assertLedgerMatchesBalance("w5");
  });
});
