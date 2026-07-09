# fate-decider

A durable wallet/economy service for a game: players earn currency, spend it in a shop, and claim one-time rewards — built so that money and items are never lost or duplicated, even under crashes and retries.

> Work in progress — sections below are filled as the corresponding functionality lands.

## Requirements

**TBD** — Docker / docker-compose versions.

## Build & run

**TBD** — exact `docker compose` commands.

## API

**TBD** — endpoint summary with curl examples for credit, purchase, claim, and wallet read (see `DESIGN.md` for the full contract details).

## Running the tests

**TBD** — unit/integration suites and the crash/restart test.

## Repository documents

- [`DESIGN.md`](DESIGN.md) — architecture, datastore choice, exactly-once & durability strategy, API details, limits
- [`RESILIENCE.md`](RESILIENCE.md) — exactly-once with a remote inventory service; incident detection & correction
- [`AI_DISCLOSURE.md`](AI_DISCLOSURE.md) — AI-tool usage declaration
