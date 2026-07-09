# fate-decider

A durable wallet/economy service for a game: players earn currency, spend it in a shop, and claim one-time rewards — built so that money and items are never lost or duplicated, even under crashes and retries.

> Work in progress — sections below are filled as the corresponding functionality lands.

## Requirements

**TBD** — Docker / docker-compose versions.

## Build & run

**TBD** — exact `docker compose` commands.

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

**Read wallet state** (read-only; unknown player returns the zero state):

```bash
curl localhost:3000/v1/wallets/player1
# → {"balance":100,"inventory":[],"claimedRewards":[]}
```

Purchase and claim examples are added as those endpoints land.

## Running the tests

**TBD** — unit/integration suites and the crash/restart test.

## Repository documents

- [`DESIGN.md`](DESIGN.md) — architecture, datastore choice, exactly-once & durability strategy, API details, limits
- [`RESILIENCE.md`](RESILIENCE.md) — exactly-once with a remote inventory service; incident detection & correction
- [`AI_DISCLOSURE.md`](AI_DISCLOSURE.md) — AI-tool usage declaration
