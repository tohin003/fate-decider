#!/usr/bin/env bash
#
# Durability / exactly-once-under-crash test.
#
# Drives concurrent credits and purchases while SIGKILL-ing the app container
# several times mid-flight, restarts it, re-sends every attempted request with
# its original idempotency key, then asserts that nothing was lost or duplicated:
#
#   * every attempted operation applied EXACTLY once (balance and ledger match
#     the number of distinct idempotency keys)
#   * SUM(ledger.amount) == wallets.balance for every player
#   * no negative balances
#   * no purchase debit without its item grant (atomicity survived the kill)
#
# Usage:  ./tests/crash/crash-test.sh          (from the repo root)
#         KILL_DB=1 ./tests/crash/crash-test.sh   also SIGKILLs Postgres once
#
set -uo pipefail

BASE=${BASE:-http://localhost:3000}
CREDIT_PLAYER=crash_cp
SHOP_PLAYER=crash_shop
SEED_CP=1000
SEED_SHOP=100000
CYCLES=${CYCLES:-3}
WORKDIR=$(mktemp -d)
CREDIT_KEYS="$WORKDIR/credit_keys.txt"
PURCHASE_KEYS="$WORKDIR/purchase_keys.txt"
: >"$CREDIT_KEYS"
: >"$PURCHASE_KEYS"

fail() { echo "FAIL: $*"; exit 1; }
psql_q() { docker compose exec -T db psql -U fate -d fate_decider -tAc "$1" | tr -d '[:space:]'; }
app_cid() { docker compose ps -q app; }

wait_app_healthy() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect --format '{{.State.Health.Status}}' "$(app_cid)" 2>/dev/null)" = "healthy" ] && return 0
    sleep 1
  done
  fail "app did not become healthy"
}

credit() { # key
  curl -s --max-time 3 -o /dev/null -X POST "$BASE/v1/wallets/$CREDIT_PLAYER/credit" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $1" \
    -d '{"amount":1,"reason":"crashload"}'
}
purchase() { # key itemId
  curl -s --max-time 3 -o /dev/null -X POST "$BASE/v1/wallets/$SHOP_PLAYER/purchase" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $1" \
    -d "{\"itemId\":\"$2\",\"price\":1}"
}

echo "== 1. fresh stack =="
docker compose down -v >/dev/null 2>&1
docker compose up -d --build >/dev/null 2>&1 || fail "compose up failed"
wait_app_healthy

echo "== 2. seed wallets =="
curl -s -o /dev/null -X POST "$BASE/v1/wallets/$CREDIT_PLAYER/credit" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: seed-cp' \
  -d "{\"amount\":$SEED_CP,\"reason\":\"seed\"}"
curl -s -o /dev/null -X POST "$BASE/v1/wallets/$SHOP_PLAYER/credit" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: seed-shop' \
  -d "{\"amount\":$SEED_SHOP,\"reason\":\"seed\"}"

echo "== 3. concurrent load while crashing the app $CYCLES times =="
LOAD_ON="$WORKDIR/load_on"
touch "$LOAD_ON"
(
  i=0
  while [ -f "$LOAD_ON" ]; do
    i=$((i + 1))
    ck="cc-$i"; pk="sp-$i"
    echo "$ck" >>"$CREDIT_KEYS"
    echo "$pk item-$i" >>"$PURCHASE_KEYS"
    credit "$ck" &
    purchase "$pk" "item-$i" &
    if [ $((i % 8)) -eq 0 ]; then sleep 0.05; fi
  done
) &
LOAD_PID=$!

for c in $(seq 1 "$CYCLES"); do
  sleep 1
  echo "   -- cycle $c: SIGKILL app --"
  docker kill -s SIGKILL "$(app_cid)" >/dev/null 2>&1
  sleep 0.5
  docker compose up -d app >/dev/null 2>&1
  wait_app_healthy
done

if [ "${KILL_DB:-0}" = "1" ]; then
  echo "   -- bonus: SIGKILL postgres --"
  docker kill -s SIGKILL "$(docker compose ps -q db)" >/dev/null 2>&1
  sleep 0.5
  docker compose up -d db >/dev/null 2>&1
  wait_app_healthy
fi

echo "== 4. stop load, let stray requests drain =="
rm -f "$LOAD_ON"
kill "$LOAD_PID" 2>/dev/null
wait "$LOAD_PID" 2>/dev/null
sleep 3

echo "== 5. reconciliation: re-send every attempted request with its original key =="
sort -u "$CREDIT_KEYS" >"$WORKDIR/credit_uniq.txt"
sort -u "$PURCHASE_KEYS" >"$WORKDIR/purchase_uniq.txt"
N_CREDITS=$(wc -l <"$WORKDIR/credit_uniq.txt" | tr -d ' ')
N_PURCHASES=$(wc -l <"$WORKDIR/purchase_uniq.txt" | tr -d ' ')
while read -r k; do credit "$k"; done <"$WORKDIR/credit_uniq.txt"
while read -r k item; do purchase "$k" "$item"; done <"$WORKDIR/purchase_uniq.txt"
echo "   attempted: $N_CREDITS credits, $N_PURCHASES purchases"

echo "== 6. assert invariants =="
CP_BAL=$(psql_q "SELECT balance FROM wallets WHERE player_id='$CREDIT_PLAYER'")
CP_LEDGER=$(psql_q "SELECT count(*) FROM ledger WHERE player_id='$CREDIT_PLAYER' AND idempotency_key LIKE 'cc-%'")
EXPECT_CP=$((SEED_CP + N_CREDITS))
[ "$CP_BAL" = "$EXPECT_CP" ] || fail "credit player balance $CP_BAL != expected $EXPECT_CP (lost or duplicated credits)"
[ "$CP_LEDGER" = "$N_CREDITS" ] || fail "credit ledger rows $CP_LEDGER != $N_CREDITS distinct keys"

SHOP_BAL=$(psql_q "SELECT balance FROM wallets WHERE player_id='$SHOP_PLAYER'")
SHOP_ITEMS=$(psql_q "SELECT count(*) FROM inventory WHERE player_id='$SHOP_PLAYER'")
SHOP_DEBITS=$(psql_q "SELECT count(*) FROM ledger WHERE player_id='$SHOP_PLAYER' AND entry_type='purchase_debit'")
EXPECT_SHOP=$((SEED_SHOP - N_PURCHASES))
[ "$SHOP_BAL" = "$EXPECT_SHOP" ] || fail "shop balance $SHOP_BAL != expected $EXPECT_SHOP (lost or duplicated debits)"
[ "$SHOP_ITEMS" = "$N_PURCHASES" ] || fail "shop items $SHOP_ITEMS != $N_PURCHASES (lost or duplicated grants)"
[ "$SHOP_DEBITS" = "$N_PURCHASES" ] || fail "shop debit rows $SHOP_DEBITS != $N_PURCHASES"

ORPHAN_DEBITS=$(psql_q "SELECT count(*) FROM ledger l WHERE l.entry_type='purchase_debit' AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.ledger_id=l.id)")
[ "$ORPHAN_DEBITS" = "0" ] || fail "$ORPHAN_DEBITS purchase debit(s) without an item grant (atomicity broken)"

MISMATCH=$(psql_q "SELECT count(*) FROM wallets w WHERE w.balance <> COALESCE((SELECT SUM(amount) FROM ledger l WHERE l.player_id=w.player_id),0)")
[ "$MISMATCH" = "0" ] || fail "$MISMATCH wallet(s) where balance != SUM(ledger)"

NEGATIVE=$(psql_q "SELECT count(*) FROM wallets WHERE balance < 0")
[ "$NEGATIVE" = "0" ] || fail "$NEGATIVE wallet(s) with a negative balance"

echo
echo "PASS — every operation applied exactly once across $CYCLES hard kills:"
echo "  credit player: balance=$CP_BAL  (seed $SEED_CP + $N_CREDITS credits)"
echo "  shop player:   balance=$SHOP_BAL  items=$SHOP_ITEMS  debits=$SHOP_DEBITS"
echo "  balance==SUM(ledger) for all wallets, no orphan debits, no negatives"
rm -rf "$WORKDIR"
