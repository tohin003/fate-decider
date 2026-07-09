# fate-decider

A durable wallet/economy service for a game: players earn currency, spend it in a shop, and claim one-time rewards — built so that money and items are never lost or duplicated, even under crashes and retries.

> Work in progress — sections below are filled as the corresponding functionality lands.

## Requirements

- Docker with Compose v2 (`docker compose …`). That is all you need to run the
  service.
- For running the tests locally without Docker for the app: Node.js 22+.

## Build & run

```bash
docker compose up --build
```

This builds the service image and starts two containers — the wallet service and
Postgres 16. The service listens on **http://localhost:3000**; Postgres is
published on host port **5433** (off the default 5432 to avoid clashing with a
local Postgres). The schema is applied automatically on startup, and a named
volume persists the data across restarts.

Stop with `docker compose down`; add `-v` to also discard the data volume.

## API

Full contract details (status codes, limits, error envelope) are in
[`DESIGN.md`](DESIGN.md). Examples below use `localhost:3000`.

**Credit currency** (simulated battle payout). Send `Idempotency-Key` to make a
retry safe; without it, a byte-identical retry still deduplicates.

```bash
curl -X POST localhost:3000/v1/wallets/player1/credit \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: credit-001' \
  -d '{"amount": 100, "reason": "battle_win"}'
# → {"playerId":"player1","balance":100}
```

**Purchase an item** (atomic debit + grant; insufficient funds is rejected with
no partial effect):

```bash
curl -X POST localhost:3000/v1/wallets/player1/purchase \
  -H 'Content-Type: application/json' \
  -d '{"itemId": "sword", "price": 30}'
# → {"playerId":"player1","balance":70,"itemId":"sword"}
```

**Claim a one-time reward** (once per player):

```bash
curl -X POST localhost:3000/v1/rewards/daily_bonus/claim \
  -H 'Content-Type: application/json' \
  -d '{"playerId": "player1"}'
# → {"playerId":"player1","rewardId":"daily_bonus","claimed":true}
```

**Read wallet state** (read-only; unknown player returns the zero state):

```bash
curl localhost:3000/v1/wallets/player1
# → {"balance":70,"inventory":["sword"],"claimedRewards":["daily_bonus"]}
```

## Running the tests

The tests run against a **real Postgres** (the money paths are not mocked). Start
the database, then run the suite — it uses a dedicated `fate_decider_test`
database, created automatically, so your dev data is untouched.

```bash
docker compose up -d db      # Postgres on host port 5433
npm install
npm test
```

The suites cover the contract and input safety (`tests/api.test.ts`),
exactly-once under duplicate and concurrent-duplicate requests
(`tests/duplicates.test.ts`), and concurrency races on a single wallet
(`tests/concurrency.test.ts`). Override the target database with
`TEST_DATABASE_URL` if needed.

## Repository documents

- [`DESIGN.md`](DESIGN.md) — architecture, datastore choice, exactly-once & durability strategy, API details, limits
- [`RESILIENCE.md`](RESILIENCE.md) — exactly-once with a remote inventory service; incident detection & correction
- [`AI_DISCLOSURE.md`](AI_DISCLOSURE.md) — AI-tool usage declaration
