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

async function ledgerCount(playerId: string, type: string): Promise<number> {
  const res = await pool.query(
    "SELECT count(*)::int AS n FROM ledger WHERE player_id = $1 AND entry_type = $2",
    [playerId, type],
  );
  return res.rows[0].n as number;
}

describe("exactly-once under duplicate requests", () => {
  it("a repeated credit (same key) applies once and replays the exact response", async () => {
    const first = await post(app, "/v1/wallets/p1/credit", { amount: 100, reason: "b" }, key("k1"));
    const second = await post(app, "/v1/wallets/p1/credit", { amount: 100, reason: "b" }, key("k1"));

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Byte-identical body; only the replay header differs.
    expect(second.body).toBe(first.body);
    expect(first.headers["idempotency-replayed"]).toBeUndefined();
    expect(second.headers["idempotency-replayed"]).toBe("true");

    expect((await get(app, "/v1/wallets/p1")).json().balance).toBe(100);
    expect(await ledgerCount("p1", "credit")).toBe(1);
  });

  it("a byte-identical credit with NO key deduplicates via the body fingerprint", async () => {
    await post(app, "/v1/wallets/p2/credit", { amount: 40, reason: "same" });
    await post(app, "/v1/wallets/p2/credit", { amount: 40, reason: "same" });
    expect((await get(app, "/v1/wallets/p2")).json().balance).toBe(40);
    expect(await ledgerCount("p2", "credit")).toBe(1);
  });

  it("a repeated purchase (same key) debits and grants once", async () => {
    await post(app, "/v1/wallets/p3/credit", { amount: 100, reason: "seed" });
    const a = await post(app, "/v1/wallets/p3/purchase", { itemId: "axe", price: 30 }, key("buy"));
    const b = await post(app, "/v1/wallets/p3/purchase", { itemId: "axe", price: 30 }, key("buy"));
    expect(a.body).toBe(b.body);
    const wallet = (await get(app, "/v1/wallets/p3")).json();
    expect(wallet.balance).toBe(70);
    expect(wallet.inventory).toEqual(["axe"]);
    expect(await ledgerCount("p3", "purchase_debit")).toBe(1);
  });

  it("a repeated claim (same key) grants once and replays success", async () => {
    const a = await post(app, "/v1/rewards/r1/claim", { playerId: "p4" }, key("c"));
    const b = await post(app, "/v1/rewards/r1/claim", { playerId: "p4" }, key("c"));
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.body).toBe(a.body);
    expect((await get(app, "/v1/wallets/p4")).json().claimedRewards).toEqual(["r1"]);
  });

  it("a retried insufficient-funds purchase replays the identical rejection", async () => {
    await post(app, "/v1/wallets/p5/credit", { amount: 5, reason: "seed" });
    const a = await post(app, "/v1/wallets/p5/purchase", { itemId: "yacht", price: 500 }, key("nf"));
    const b = await post(app, "/v1/wallets/p5/purchase", { itemId: "yacht", price: 500 }, key("nf"));
    expect(a.statusCode).toBe(409);
    expect(b.statusCode).toBe(409);
    expect(b.body).toBe(a.body);
    expect(b.headers["idempotency-replayed"]).toBe("true");
    // Balance untouched throughout.
    expect((await get(app, "/v1/wallets/p5")).json().balance).toBe(5);
  });

  it("reuses a key with a different body → 422, applies nothing", async () => {
    const a = await post(app, "/v1/wallets/p6/credit", { amount: 10, reason: "a" }, key("dup"));
    expect(a.statusCode).toBe(200);
    const b = await post(app, "/v1/wallets/p6/credit", { amount: 999, reason: "b" }, key("dup"));
    expect(b.statusCode).toBe(422);
    expect(b.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    // The second, conflicting request applied nothing.
    expect((await get(app, "/v1/wallets/p6")).json().balance).toBe(10);
  });

  it("20 concurrent identical credits (same key) apply exactly once", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        post(app, "/v1/wallets/p7/credit", { amount: 50, reason: "race" }, key("hot")),
      ),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    // Every response body is identical to the first.
    const bodies = new Set(results.map((r) => r.body));
    expect(bodies.size).toBe(1);
    expect((await get(app, "/v1/wallets/p7")).json().balance).toBe(50);
    expect(await ledgerCount("p7", "credit")).toBe(1);
  });
});
