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

describe("contract happy paths", () => {
  it("credits currency and reflects it in the wallet", async () => {
    const credit = await post(app, "/v1/wallets/p1/credit", { amount: 100, reason: "battle" });
    expect(credit.statusCode).toBe(200);
    expect(credit.json()).toEqual({ playerId: "p1", balance: 100 });

    const wallet = await get(app, "/v1/wallets/p1");
    expect(wallet.statusCode).toBe(200);
    expect(wallet.json()).toEqual({ balance: 100, inventory: [], claimedRewards: [] });
  });

  it("purchases atomically: debits and grants together", async () => {
    await post(app, "/v1/wallets/p1/credit", { amount: 100, reason: "seed" });
    const buy = await post(app, "/v1/wallets/p1/purchase", { itemId: "sword", price: 30 });
    expect(buy.statusCode).toBe(200);
    expect(buy.json()).toEqual({ playerId: "p1", balance: 70, itemId: "sword" });

    const wallet = await get(app, "/v1/wallets/p1");
    expect(wallet.json()).toEqual({ balance: 70, inventory: ["sword"], claimedRewards: [] });
  });

  it("rejects an unaffordable purchase with no partial effect", async () => {
    await post(app, "/v1/wallets/p1/credit", { amount: 20, reason: "seed" });
    const buy = await post(app, "/v1/wallets/p1/purchase", { itemId: "castle", price: 999 });
    expect(buy.statusCode).toBe(409);
    expect(buy.json().error.code).toBe("INSUFFICIENT_FUNDS");

    // Nothing changed: balance intact, no item, no debit ledger row.
    const wallet = await get(app, "/v1/wallets/p1");
    expect(wallet.json()).toEqual({ balance: 20, inventory: [], claimedRewards: [] });
    const debits = await pool.query(
      "SELECT count(*)::int AS n FROM ledger WHERE player_id = 'p1' AND entry_type = 'purchase_debit'",
    );
    expect(debits.rows[0].n).toBe(0);
  });

  it("claims a reward once per player", async () => {
    const first = await post(app, "/v1/rewards/daily/claim", { playerId: "p1" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ playerId: "p1", rewardId: "daily", claimed: true });

    const wallet = await get(app, "/v1/wallets/p1");
    expect(wallet.json().claimedRewards).toEqual(["daily"]);
  });

  it("returns the zero state for an unknown player", async () => {
    const wallet = await get(app, "/v1/wallets/nobody");
    expect(wallet.statusCode).toBe(200);
    expect(wallet.json()).toEqual({ balance: 0, inventory: [], claimedRewards: [] });
  });

  it("lists a duplicated item twice in acquisition order", async () => {
    await post(app, "/v1/wallets/p1/credit", { amount: 100, reason: "seed" });
    // Two *intentional* identical purchases require distinct idempotency keys —
    // without them, byte-identical requests are treated as a retry of one.
    await post(app, "/v1/wallets/p1/purchase", { itemId: "potion", price: 10 }, { "idempotency-key": "buy-1" });
    await post(app, "/v1/wallets/p1/purchase", { itemId: "potion", price: 10 }, { "idempotency-key": "buy-2" });
    const wallet = await get(app, "/v1/wallets/p1");
    expect(wallet.json().inventory).toEqual(["potion", "potion"]);
    expect(wallet.json().balance).toBe(80);
  });
});

describe("input safety — malformed input is rejected, never corrupts state", () => {
  const badCredits: Array<[string, unknown]> = [
    ["negative amount", { amount: -5, reason: "x" }],
    ["zero amount", { amount: 0, reason: "x" }],
    ["float amount", { amount: 1.5, reason: "x" }],
    ["string amount", { amount: "100", reason: "x" }],
    ["overflowing amount", { amount: 1_000_000_001, reason: "x" }],
    ["missing amount", { reason: "x" }],
    ["missing reason", { amount: 10 }],
    ["extra field", { amount: 10, reason: "x", admin: true }],
    ["null amount", { amount: null, reason: "x" }],
  ];

  for (const [name, body] of badCredits) {
    it(`rejects ${name} with 400`, async () => {
      const res = await post(app, "/v1/wallets/p1/credit", body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    });
  }

  it("rejects garbage JSON with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/wallets/p1/credit",
      headers: { "content-type": "application/json" },
      payload: "{not valid json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an oversized body with 413", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/wallets/p1/credit",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ amount: 10, reason: "x".repeat(20_000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects an unsupported content-type with 415", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/wallets/p1/credit",
      headers: { "content-type": "application/xml" },
      payload: "<amount>10</amount>",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects an over-long playerId with 400", async () => {
    const res = await post(app, `/v1/wallets/${"p".repeat(65)}/credit`, { amount: 10, reason: "x" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an unknown route with 404", async () => {
    const res = await get(app, "/v1/nonsense");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("survives a barrage of bad input and still works afterwards", async () => {
    for (const [, body] of badCredits) {
      await post(app, "/v1/wallets/survivor/credit", body);
    }
    // The wallet was never touched, and a valid request still succeeds.
    expect((await get(app, "/v1/wallets/survivor")).json()).toEqual({
      balance: 0,
      inventory: [],
      claimedRewards: [],
    });
    const ok = await post(app, "/v1/wallets/survivor/credit", { amount: 5, reason: "ok" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().balance).toBe(5);
  });
});
