# Resilience

> Written against the implemented design — filled once the purchase path is real, so the reasoning refers to actual code, not intentions.

## 1. Exactly-once purchase with a remote inventory service

**TBD** — assuming the item grant moves to a separate inventory service (can time out, fail, or process a request twice; cannot share a transaction with the currency store): the partial-failure window, the chosen approach, and how the purchase stays exactly-once end-to-end.

## 2. Incident: currency double-granted to some players

**TBD** — how to detect and correct it without downtime, and the invariant / audit trail that would have caught it sooner.
