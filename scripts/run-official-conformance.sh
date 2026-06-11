#!/usr/bin/env bash
# Run the GENUINE upstream UCP conformance suite
# (github.com/Universal-Commerce-Protocol/conformance, vendored in
#  ./conformance-official) against our merchant's REST binding.
#
# Prereqs (one-time): pip install ucp-sdk absl-py fastapi httpx uvicorn pydantic
# Usage: bash scripts/run-official-conformance.sh
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PORT=4101
BASE="http://localhost:${PORT}/m/wavelength"

echo "▶ booting merchant with UCP_REST=1 …"
UCP_REST=1 npx tsx apps/merchant-portal/src/server.ts > /tmp/mc-rest.log 2>&1 &
MPID=$!
trap 'kill $MPID 2>/dev/null' EXIT
sleep 6

echo "▶ sanity: discovery advertises a REST shopping service"
curl -s "${BASE}/.well-known/ucp" | python3 -c "import sys,json;s=json.load(sys.stdin)['ucp']['services']['dev.ucp.shopping'];print('  rest endpoint:',[x.get('endpoint') for x in s if x.get('transport')=='rest'])"
curl -s -o /dev/null -w "  healthz: %{http_code}\n" "${BASE}/rest/healthz"

cd conformance-official
PASS=0; FAIL=0; ERR=0
declare -a RESULTS
for tf in checkout_lifecycle_test order_test idempotency_test fulfillment_test invalid_input_test validation_test binding_test business_logic_test webhook_test ap2_test protocol_test card_credential_test simulation_url_security_test; do
  [ -f "${tf}.py" ] || continue
  OUT=$(python3 "${tf}.py" \
      --server_url="${BASE}" \
      --simulation_secret="super-secret-sim-key" \
      --conformance_input="conformance_input.json" \
      --test_data_dir="." 2>&1)
  # absltest prints "Ran N tests" and "OK"/"FAILED (failures=.. errors=..)"
  RAN=$(echo "$OUT" | grep -oE "Ran [0-9]+ test" | grep -oE "[0-9]+" | head -1)
  if echo "$OUT" | grep -qE "^OK"; then
    RESULTS+=("✓ ${tf}: ${RAN:-?}/${RAN:-?} passed")
    PASS=$((PASS + ${RAN:-0}))
  else
    F=$(echo "$OUT" | grep -oE "failures=[0-9]+" | grep -oE "[0-9]+" | head -1); F=${F:-0}
    E=$(echo "$OUT" | grep -oE "errors=[0-9]+" | grep -oE "[0-9]+" | head -1); E=${E:-0}
    OKN=$(( ${RAN:-0} - F - E ))
    RESULTS+=("✗ ${tf}: ${OKN}/${RAN:-?} passed (failures=${F} errors=${E})")
    PASS=$((PASS + OKN)); FAIL=$((FAIL + F)); ERR=$((ERR + E))
    echo "$OUT" | grep -E "FAIL:|ERROR:" | sed "s/^/    ${tf} /" | head -8
  fi
done

echo ""
echo "════════ OFFICIAL UCP CONFORMANCE — REST binding ════════"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "  ─────────────────────────────────────────────"
echo "  TOTAL: ${PASS} passed · ${FAIL} failures · ${ERR} errors"
