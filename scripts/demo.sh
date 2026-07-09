#!/usr/bin/env bash
#
# End-to-end walkthrough of the wallet service against a running instance.
# Start the service first:  docker compose up --build
# Then run:                 ./scripts/demo.sh
#
set -euo pipefail
BASE=${BASE:-http://localhost:3000}
P=demo_player
R=welcome_bonus

step() { echo; echo "== $* =="; }
# Print status code + body for a request.
call() {
  local method=$1 path=$2 data=${3:-} ; shift 3 || true
  local out
  out=$(curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
        -H 'Content-Type: application/json' "$@" ${data:+-d "$data"})
  echo "  $method $path  ->  HTTP ${out##*$'\n'}"
  echo "  ${out%$'\n'*}"
}

step "1. Credit 100 (simulated battle payout)"
call POST "/v1/wallets/$P/credit" '{"amount":100,"reason":"battle_win"}'

step "2. Purchase a sword for 30 (atomic debit + grant)"
call POST "/v1/wallets/$P/purchase" '{"itemId":"sword","price":30}'

step "3. Purchase something unaffordable -> rejected, no partial effect"
call POST "/v1/wallets/$P/purchase" '{"itemId":"castle","price":9999}'

step "4. Claim a one-time reward"
call POST "/v1/rewards/$R/claim" '{"playerId":"'"$P"'"}'

step "5. Claim the same reward again (new key) -> already claimed"
call POST "/v1/rewards/$R/claim" '{"playerId":"'"$P"'"}' -H 'Idempotency-Key: second-attempt'

step "6. Retry a credit with the SAME idempotency key -> applied once, replayed"
call POST "/v1/wallets/$P/credit" '{"amount":25,"reason":"quest"}' -H 'Idempotency-Key: quest-1'
call POST "/v1/wallets/$P/credit" '{"amount":25,"reason":"quest"}' -H 'Idempotency-Key: quest-1'

step "7. Invalid input (negative amount) -> rejected at the boundary"
call POST "/v1/wallets/$P/credit" '{"amount":-5,"reason":"cheat"}'

step "8. Final wallet state"
call GET "/v1/wallets/$P" ''

echo
echo "Expected final state: balance 95 (100 - 30 + 25, dup ignored), inventory [sword], claimedRewards [$R]"
