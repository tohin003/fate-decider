# Design

> This document grows alongside the implementation — each section is filled in the same change as the code it describes. Sections marked **TBD** describe code that does not exist yet.

## 1. Overview & architecture

**TBD** — service shape, request lifecycle, module layout, and how state flows from HTTP boundary to datastore.

## 2. Datastore: choice and why

**TBD** — what was chosen, the specific mechanisms relied on (transactions, constraints, locking, write-ahead durability), and the alternatives considered with trade-offs.

## 3. Exactly-once: deduplication strategy

**TBD** — how a duplicate request is identified, how the dedup record relates transactionally to the effect, what a duplicate receives in response, conflict handling, and **how long keys are retained**.

## 4. Atomicity, durability & isolation

**TBD** — what is atomic; what happens on `kill -9` at any moment (including mid-purchase); the isolation level used and why it is sufficient.

## 5. API contract details

**TBD** — chosen status codes, exact success/error response bodies, currency units, and input limits.

## 6. Deliberate decisions & trade-offs

**TBD** — the under-specified calls the brief leaves open (key retention, ledger representation, error codes, limits, catalog vs request-priced purchases), each with a decision and its trade-off.
