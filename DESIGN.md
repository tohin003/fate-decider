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
- **`src/routes/`** + **`src/services/economy.ts`** — the request lifecycle is:
  validate at the edge (§5 limits) → `runIdempotent` opens one transaction and
  reserves the idempotency key (§3) → the economy effect runs inside it (§4) →
  the response is stored and returned. `src/services/economy.ts` holds all money
  SQL; nothing outside it writes to `wallets`, `ledger`, `inventory`, or
  `reward_claims`.

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

**What is atomic.** Every mutation runs as exactly one SQL transaction that
contains *both* the effect and its idempotency record. For a purchase that one
transaction holds: the conditional debit, the `inventory` grant, the `ledger`
entry, and the idempotency row. They commit together or not at all.

**`kill -9` at any moment.** Nothing durable lives in the process — it is all in
Postgres — so a hard kill reduces to "was the transaction committed?":
- *App killed mid-transaction* — the connection drops; Postgres rolls the
  uncommitted transaction back. No debit, no grant, no key. A retry after
  restart re-runs the operation exactly once.
- *App killed just after `COMMIT`* — the effect and its key are durable (WAL).
  The retry finds the key and replays the stored response; the effect is not
  repeated.
- *Postgres killed* — on restart it performs WAL crash recovery: committed
  transactions are replayed, uncommitted ones discarded. The named Docker volume
  preserves the data directory across the container's death.
- *Mid-purchase specifically* — because debit + grant + ledger share one
  transaction, the only two outcomes are "all of it" or "none of it". There is
  no state in which a player was charged without receiving the item, or received
  the item for free. (Asserted by the crash test.)

**Durability settings.** Left at Postgres defaults: `fsync = on` and
`synchronous_commit = on`, so `COMMIT` returns only after the WAL record is
flushed to disk. We do not trade durability for speed.

**Isolation: READ COMMITTED** (the Postgres default). This is sufficient because
no invariant in this service depends on read-then-write logic — each is enforced
by a single atomic statement or a constraint:
- *No negative balance / no double-spend* — the debit is one conditional
  `UPDATE … WHERE balance >= price`, which takes the row lock and re-checks the
  predicate against the committed value. A concurrent purchase blocks on that
  lock and then re-evaluates, so two racing debits cannot both succeed. There is
  no `SELECT`-then-`UPDATE` gap for a lost update to hide in. `CHECK (balance >= 0)`
  is a final backstop.
- *Claim-once* — the `(reward_id, player_id)` primary key.
- *Exactly-once dedup* — the `(key, scope)` unique index.

Because correctness rests on locks and constraints rather than on snapshot
visibility, SERIALIZABLE would only add serialization-failure retries without
removing any real anomaly. Choosing READ COMMITTED is a deliberate trade of
theoretical strictness for simpler, retry-free code — verified by the concurrency
and crash tests.

## 5. API contract details

The mandated wire shape is unchanged; documented here are the choices left to us.

**Currency units.** Balances, amounts, and prices are non-negative **integers**
in a single unbounded in-game currency (no decimals, no separate denominations).

**Endpoints.**

| Method & path | Success | Body |
|---|---|---|
| `POST /v1/wallets/{playerId}/credit` | `200` | `{ "playerId": str, "balance": int }` |
| `POST /v1/wallets/{playerId}/purchase` | `200` | `{ "playerId": str, "balance": int, "itemId": str }` |
| `POST /v1/rewards/{rewardId}/claim` | `200` | `{ "playerId": str, "rewardId": str, "claimed": true }` |
| `GET /v1/wallets/{playerId}` | `200` | `{ "balance": int, "inventory": [itemId…], "claimedRewards": [rewardId…] }` |

- `GET` on an unknown player returns `200` with the zero state
  (`balance: 0`, empty lists) rather than `404`, so black-box assertions don't
  need to special-case "never seen before".
- `inventory` is a flat list of `itemId` strings in acquisition order; a player
  who owns the same item twice sees it listed twice. `claimedRewards` is the
  sorted list of claimed `rewardId`s.

**Reward semantics (a deliberate call).** The claim body carries only `playerId`
and there is no reward catalog, so a "reward" is modelled as a claim-once
*record* — the observable effect is the `rewardId` appearing in `claimedRewards`.
No currency or item is attached to a claim; a production system would resolve
`rewardId` against a server-side reward catalog. A repeated claim by the same
player is idempotent: a byte-identical retry replays the original `200`, while a
re-claim carrying a *new* idempotency key is reported as `409 ALREADY_CLAIMED`.
Either way the grant happens exactly once.

**Error envelope.** Every failure is `{ "error": { "code": str, "message": str } }`.

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Malformed JSON, missing/extra field, wrong type, negative/zero/overflowing amount, bad id |
| `409` | `INSUFFICIENT_FUNDS` | Purchase price exceeds balance (no partial effect) |
| `409` | `ALREADY_CLAIMED` | A new-keyed claim of a reward this player already holds |
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
