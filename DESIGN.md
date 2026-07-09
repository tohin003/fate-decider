# Design

> This document grows alongside the implementation — each section is filled in the same change as the code it describes. Sections marked **TBD** describe code that does not exist yet.

## 1. Overview & architecture

The service is a stateless HTTP layer over a single Postgres database. All durable
state lives in Postgres; the process holds nothing that matters across a restart.

```
   HTTP client
       │
       ▼
  Fastify app  ──►  economy service  ──►  Postgres (wallets, ledger,
  (validation,      (one transaction         inventory, reward_claims,
   routing)          per mutation)            idempotency_keys)
```

- **`src/server.ts`** — process entrypoint: load config → create pool → run
  migration → start listening. Traffic is only accepted after the schema is in
  place, so no request ever meets a half-initialised database.
- **`src/app.ts`** — `buildApp({ pool })` returns a Fastify instance with the
  pool injected. The app owns no global singletons, so a test can build an
  instance against a throwaway database and drive the real HTTP pipeline via
  `app.inject()`.
- **`src/db/`** — `pool.ts` (the `pg` pool + int8 parsing), `schema.sql` (the
  single source of truth for the schema), `migrate.ts` (applies it, idempotently,
  with startup retries for the compose race).
- Route handlers and the transactional economy service are added in later
  phases; the request lifecycle (validate at the edge → one DB transaction →
  respond) is documented in §3–§5 as those land.

## 2. Datastore: choice and why

**Chosen: PostgreSQL 16**, run as a container via `docker-compose.yml`, accessed
with the raw `pg` driver and hand-written SQL (no ORM — the locking and isolation
strategy should be visible in the code, not hidden behind an abstraction).

This is what one would genuinely reach for to hold money: every correctness
requirement in the brief maps to a concrete, well-understood Postgres mechanism.

| Requirement | Mechanism this design uses |
|---|---|
| Never negative balance | `CHECK (balance >= 0)` on `wallets` — a hard backstop even against a logic bug |
| Atomic multi-row effect (debit + grant) | A single SQL transaction; commit is all-or-nothing |
| No lost updates / no double-spend under races | Atomic conditional `UPDATE ... WHERE balance >= price` takes the row lock (detailed in §4) |
| Claim-once | Natural primary key `(reward_id, player_id)` makes a second claim physically impossible |
| Exactly-once dedup | Unique key on `idempotency_keys (key, scope)`, written in the same transaction as the effect (detailed in §3) |
| Durability across `kill -9` | Write-ahead log + `fsync`/`synchronous_commit` on by default; a named Docker volume persists the data directory |
| Auditability | Append-only `ledger`; invariant `SUM(ledger.amount) == wallets.balance` per player |

**Schema** (`src/db/schema.sql`): `wallets` (authoritative balance),
`ledger` (append-only currency-movement audit trail), `inventory` (owned items,
each tied to the ledger debit that paid for it), `reward_claims` (claim-once
records), and `idempotency_keys` (stored responses for replay). The migration is
idempotent (`CREATE TABLE IF NOT EXISTS`) and re-runs on every boot; the data
survives in the volume, the schema is simply re-asserted.

**Alternatives considered.**
- *SQLite (WAL)* — genuinely durable and one less container, but its single-writer
  model makes the "many requests hammer one wallet" story weaker; Postgres is the
  honest production choice here.
- *Redis / a KV store* — fast, but durability needs careful AOF tuning and there
  are no multi-key ACID transactions with constraints, which is exactly what a
  purchase needs. Wrong tool for money.
- *Hand-rolled in-memory + append-only file* — maximal "look how much I understand"
  signal, but high risk of subtle durability bugs; the brief rewards correct
  judgment over heroics.

## 3. Exactly-once: deduplication strategy

**TBD** — how a duplicate request is identified, how the dedup record relates transactionally to the effect, what a duplicate receives in response, conflict handling, and **how long keys are retained**.

## 4. Atomicity, durability & isolation

**TBD** — what is atomic; what happens on `kill -9` at any moment (including mid-purchase); the isolation level used and why it is sufficient.

## 5. API contract details

**TBD** — chosen status codes, exact success/error response bodies, currency units, and input limits.

## 6. Deliberate decisions & trade-offs

**TBD** — the under-specified calls the brief leaves open (key retention, ledger representation, error codes, limits, catalog vs request-priced purchases), each with a decision and its trade-off.
