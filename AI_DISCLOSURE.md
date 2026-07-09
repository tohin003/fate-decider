# AI Disclosure

Honest declaration of AI-tool use on this assessment. Kept current as the work proceeds; finalized before submission.

## Tools used

- **Claude Code** (Anthropic CLI agent) — the primary AI tool used throughout.

## Where and how much

- **Planning & design discussion**: AI-assisted. Requirements were distilled from the brief and the architecture/idempotency/durability approach was designed in discussion with Claude Code; I made the final calls on stack, datastore, and design trade-offs.
- **Implementation**: AI-assisted. The scaffold (TypeScript + Fastify), the schema, the migration bootstrap, the idempotency layer (reserve-in-transaction with byte-exact replay), and all four endpoints (credit, purchase, claim, wallet-read) were written with Claude Code under my direction. I chose the datastore, the schema design, and the transaction/idempotency strategy — in particular the single atomic conditional debit for purchases — and I verified the behavior by hand (concurrent duplicates, the debit/grant atomicity, and a 10-way purchase race on one balance). _Updated as further code lands._
- **Tests**: AI-assisted. The Vitest suites (contract + input safety, duplicate/exactly-once, and single-wallet concurrency) run against a real Postgres, and the `kill -9` crash/durability script (`tests/crash/crash-test.sh`) were written with Claude Code. Writing the Vitest suites surfaced two genuine bugs — AJV was coercing `"100"` to `100` and accepting unknown fields — which I then fixed with strict validation. The crash test drives concurrent load through repeated hard kills and asserts nothing is lost or duplicated. I reviewed and understand every test.
- **Docker packaging**: AI-assisted. The multi-stage Dockerfile and the
  docker-compose setup were written with Claude Code; I verified the full stack
  runs and diagnosed a healthcheck issue (the container's `localhost` resolving
  to IPv6 while the app binds IPv4).
- **Documentation** (README, DESIGN, RESILIENCE): AI-assisted drafting under my
  direction, written in lock-step with the code so no document claims behavior
  the code does not implement. The design decisions, the resilience strategy
  (outbox + saga, ledger-based reconciliation), and the trade-offs are mine.

## My role

I direct the work, make the design decisions, and review the code and docs; I am responsible for, and can explain, everything in this repository.
