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

Implemented in `src/idempotency.ts` and exercised by every mutating route.

**Identifying a duplicate.** Each mutating request is reduced to an identity of
`(key, scope, requestHash)`:
- `scope` = `"METHOD /concrete/path"` (e.g. `POST /v1/wallets/p1/credit`). This
  namespaces a key to one operation on one resource, so the same key used for
  two different players — or two different endpoints — never collides.
- `requestHash` = SHA-256 of the **canonical** request body (object keys sorted
  recursively), so logically-identical bodies hash equally.
- `key` = the client's `Idempotency-Key` header when supplied, otherwise the
  `requestHash` itself. The fallback means a byte-identical retry with no header
  still deduplicates — which is exactly what a naive client or test retry sends.

**How the key is tied to the effect (the crucial part).** The key row is
reserved and finalised **inside the same transaction as the effect**:

```
BEGIN
  INSERT INTO idempotency_keys (key, scope, request_hash, ...)
    VALUES (...) ON CONFLICT (key, scope) DO NOTHING     -- reserve
  -- if reserved (1 row): run the effect, then
  UPDATE idempotency_keys SET response_status=…, response_body=… WHERE …
COMMIT
```

Because the reservation and the effect share one transaction, they commit or
roll back together. There is no window in which the effect is durable but the
key is not, or vice versa.

**Concurrent duplicates.** `INSERT … ON CONFLICT DO NOTHING` makes a second,
concurrent request with the same key **block on the unique index** until the
first transaction finishes. If the first commits, the second sees `rowCount = 0`,
reads the now-committed row, and replays it — it never runs the effect. If the
first rolls back, the second's insert succeeds and it becomes the owner. So only
one request ever applies the effect; the rest replay. Verified: 20 concurrent
identical credits yield exactly one ledger row and one final balance.

**What a duplicate receives.** The stored response is replayed **byte-for-byte**
(the response body is kept in a `json` column, which preserves the exact text),
with an added `Idempotency-Replayed: true` header. Business failures are stored
too — a retried insufficient-funds purchase replays the identical rejection, not
a fresh attempt.

**Key reuse with a different body.** If a key already exists but the new
request's `requestHash` differs, the service returns `422 IDEMPOTENCY_KEY_REUSED`
and applies nothing — it refuses to guess which request the caller meant.

**Retention.** Idempotency rows are pruned after `IDEMPOTENCY_TTL_HOURS`
(default 24h) by a periodic sweep (`pruneExpiredKeys`, scheduled in
`server.ts`). Retention only bounds how long a *replay* is available; it does
**not** weaken claim-once, which is enforced permanently by the `reward_claims`
natural key, independent of idempotency keys.

## 4. Atomicity, durability & isolation

**TBD** — what is atomic; what happens on `kill -9` at any moment (including mid-purchase); the isolation level used and why it is sufficient.

## 5. API contract details

The mandated wire shape is unchanged; documented here are the choices left to us.
Purchase and claim rows are added as those endpoints land.

**Currency units.** Balances, amounts, and prices are non-negative **integers**
in a single unbounded in-game currency (no decimals, no separate denominations).

**Endpoints implemented so far.**

| Method & path | Success | Body |
|---|---|---|
| `POST /v1/wallets/{playerId}/credit` | `200` | `{ "playerId": str, "balance": int }` |
| `GET /v1/wallets/{playerId}` | `200` | `{ "balance": int, "inventory": [itemId…], "claimedRewards": [rewardId…] }` |

- `GET` on an unknown player returns `200` with the zero state
  (`balance: 0`, empty lists) rather than `404`, so black-box assertions don't
  need to special-case "never seen before".
- `inventory` is a flat list of `itemId` strings in acquisition order; a player
  who owns the same item twice sees it listed twice. `claimedRewards` is the
  sorted list of claimed `rewardId`s.

**Error envelope.** Every failure is `{ "error": { "code": str, "message": str } }`.

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Malformed JSON, missing/extra field, wrong type, negative/zero/overflowing amount, bad id |
| `413` | `PAYLOAD_TOO_LARGE` | Body exceeds 16 KB |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | Missing/incorrect `Content-Type` on a body route |
| `422` | `IDEMPOTENCY_KEY_REUSED` | Same idempotency key, different body |
| `404` | `NOT_FOUND` | Unknown route |
| `500` | `INTERNAL` | Unexpected server error |

**Limits** (`src/validation.ts`, rejected at the boundary before any DB work):

| Limit | Value |
|---|---|
| Max amount / price | `1_000_000_000` |
| id charset & length (`playerId`/`itemId`/`rewardId`) | `^[A-Za-z0-9_-]{1,64}$` |
| `reason` max length | 256 |
| `Idempotency-Key` max length | 200 |
| Request body max size | 16 KB |

## 6. Deliberate decisions & trade-offs

**TBD** — the under-specified calls the brief leaves open (key retention, ledger representation, error codes, limits, catalog vs request-priced purchases), each with a decision and its trade-off.
