# AI Disclosure

Honest declaration of AI-tool use on this assessment. Kept current as the work proceeds; finalized before submission.

## Tools used

- **Claude Code** (Anthropic CLI agent) — the primary AI tool used throughout.

## Where and how much

- **Planning & design discussion**: AI-assisted. Requirements were distilled from the brief and the architecture/idempotency/durability approach was designed in discussion with Claude Code; I made the final calls on stack, datastore, and design trade-offs.
- **Implementation**: AI-assisted. The scaffold (TypeScript + Fastify), the schema, the migration bootstrap, the idempotency layer (reserve-in-transaction with byte-exact replay), and the credit + wallet-read endpoints were written with Claude Code under my direction. I chose the datastore, the schema design, and the transaction/idempotency strategy, and I verified the behavior (including concurrent-duplicate handling) by hand. _Updated as further code lands._
- **Tests**: _in progress._
- **Documentation** (README, DESIGN, RESILIENCE): _in progress._

## My role

I direct the work, make the design decisions, and review the code and docs; I am responsible for, and can explain, everything in this repository.
