# Resilience

## 1. Exactly-once purchase when the item grant moves to a remote inventory service

Today a purchase is one Postgres transaction: debit currency, grant the item,
write the ledger entry, store the idempotency result — all commit together, so
`kill -9` can never split the debit from the grant. If the grant moves to a
**separate inventory service** reached over an API that can time out, fail, or
process a request twice, and which **cannot join our transaction**, that single
atomic step is gone. The naive fix — commit the debit, then call the inventory
service — is a dual write with two failure modes: crash after the debit commits
but before the call (money taken, no item), or the call succeeds but our commit
rolls back (free item). Both must be impossible.

**Approach: transactional outbox + idempotent consumer (a saga).**

- In the **same transaction** as the debit, insert an `outbox` row describing the
  intended grant: `(operation_id, player_id, item_id, status='pending')`. The
  `operation_id` is the purchase's idempotency key. Debit and outbox row commit
  atomically — so an intent to grant exists **iff** the debit is durable.
- A **background dispatcher** reads `pending` outbox rows and calls the inventory
  service, passing `operation_id`. It **retries until acknowledged** (with
  backoff), then marks the row `delivered`. Because the row is committed with the
  debit, it survives any crash — the grant is never lost.
- The inventory service is an **idempotent consumer**: it dedupes on
  `operation_id`, so a retry after a timeout (where our first call actually
  succeeded but we never saw the response) grants the item only once. Delivery is
  at-least-once; the consumer's dedup makes the *effect* exactly-once.

**The partial-failure window** is between "debit + outbox committed" and "grant
acknowledged": the player has paid but does not yet hold the item. It is bounded
by dispatcher latency and **always resolves forward** — the outbox row persists
until acked. It is a delay, never a loss. If the grant is *permanently*
impossible (the inventory service rejects the item as invalid), the saga
**compensates**: append a refund credit to the ledger (keyed
`refund-<operation_id>`, so the refund itself is exactly-once) and mark the
outbox row `failed`. The debit is never left dangling.

This keeps the guarantee we have now — a purchase applies exactly once
end-to-end — with money and item eventually consistent instead of instantly
atomic, which is the best achievable once the two stores can't share a
transaction.

## 2. Incident: currency was double-granted to some players last week

**Detecting it (without downtime).** The append-only `ledger` is the audit
trail, and every legitimate credit carries the idempotency key that produced it,
so double-grants are queryable:

- *Same operation applied twice* — a key that produced two effects:
  ```sql
  SELECT idempotency_key, count(*) FROM ledger
  WHERE entry_type = 'credit' AND idempotency_key IS NOT NULL
  GROUP BY idempotency_key HAVING count(*) > 1;
  ```
- *Grants that bypassed the key path* — reconcile the ledger against the
  authoritative payout source (battle-result log): any credit with no matching
  payout, or two credits for one payout, is spurious. This is a read-only query
  against production; no downtime.

Note `balance == SUM(ledger)` alone would **not** catch this if the bug wrote a
duplicate ledger row *and* inflated the balance — both sides move together. The
cross-check against the source of truth (conservation of currency: total issued
== total earned) is what exposes it.

**Correcting it (without downtime).** The ledger is append-only, so we never
edit or delete history. For each over-credited player we append a **compensating
negative entry** and decrement the balance in one transaction, keyed
`correction-<incident_id>-<player>` so the repair job is itself idempotent and
safe to re-run. Players who already spent the phantom currency can't go negative
(the `CHECK` forbids it): those are clawed back to zero and flagged for manual
review rather than forced negative. The correction is a controlled batch, not a
schema change, so the service keeps serving throughout.

**What would have caught it sooner.** (a) The `(key, scope)` unique index on the
payout path already makes double-applying *the same operation* physically
impossible — the bug must have minted fresh keys or bypassed the path, which is
the real lesson: route **all** currency issuance through the idempotent ledger
writer, with no side door. (b) A continuous **reconciliation monitor** asserting,
per player and in aggregate, that issued currency equals earned currency from the
authoritative source — alerting on drift — turns a week-long silent bug into a
minutes-long alert.
