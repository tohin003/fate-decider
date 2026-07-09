-- Schema for the durable wallet/economy service.
--
-- Every statement is idempotent (IF NOT EXISTS) so migrate() can run on every
-- boot without harming existing data: the state lives in the Postgres volume
-- and outlives the process, the schema is just re-asserted.
--
-- CORE INVARIANT (verified by the crash test):
--   for every player, SUM(ledger.amount) == wallets.balance
-- The ledger is append-only and is the audit trail; the wallet balance is a
-- derived running total kept in lock-step inside the same transaction.

CREATE TABLE IF NOT EXISTS wallets (
    player_id  TEXT PRIMARY KEY,
    -- CHECK is the last line of defence: even a logic bug cannot persist a
    -- negative balance — the transaction aborts instead.
    balance    BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only record of every currency movement. Never updated or deleted.
CREATE TABLE IF NOT EXISTS ledger (
    id              BIGSERIAL PRIMARY KEY,
    player_id       TEXT NOT NULL,
    entry_type      TEXT NOT NULL CHECK (entry_type IN ('credit', 'purchase_debit')),
    amount          BIGINT NOT NULL,          -- signed: credit > 0, purchase_debit < 0
    item_id         TEXT,                     -- set for purchase_debit
    reason          TEXT,                     -- set for credit
    idempotency_key TEXT,                     -- the key that produced this entry
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_player_idx ON ledger (player_id);

-- Items a player owns. Each row is tied to the ledger debit that paid for it,
-- so the crash test can assert no grant exists without its debit and vice versa.
CREATE TABLE IF NOT EXISTS inventory (
    id          BIGSERIAL PRIMARY KEY,
    player_id   TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    ledger_id   BIGINT NOT NULL REFERENCES ledger (id),
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_player_idx ON inventory (player_id);

-- Claim-once ledger for rewards. The natural primary key (reward_id, player_id)
-- makes a second claim by the same player physically impossible; this holds
-- permanently, independent of idempotency-key retention.
CREATE TABLE IF NOT EXISTS reward_claims (
    reward_id  TEXT NOT NULL,
    player_id  TEXT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (reward_id, player_id)
);
CREATE INDEX IF NOT EXISTS reward_claims_player_idx ON reward_claims (player_id);

-- Stored results of mutating requests, keyed by idempotency key + scope.
-- The row is written in the SAME transaction as the effect it describes, so a
-- key and its effect commit or roll back together. A retry that finds a
-- matching row replays the stored response verbatim instead of re-running.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key             TEXT NOT NULL,
    scope           TEXT NOT NULL,            -- "METHOD path", namespaces a key to one operation
    request_hash    TEXT NOT NULL,            -- SHA-256 of the canonical request body
    response_status INT  NOT NULL,
    response_body   JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (key, scope)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);
