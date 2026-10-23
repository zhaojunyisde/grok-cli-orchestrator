#!/usr/bin/env bash
# Full mock e2e matrix (no network, no real grok).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TSX="$ROOT/node_modules/.bin/tsx"
[[ -x "$TSX" ]] || { echo "run npm install first" >&2; exit 1; }

pass=0
fail=0
log() { printf '[e2e] %s\n' "$*"; }

run_case() {
  local name="$1"; shift
  log "CASE $name"
  local out ec=0
  set +e
  out="$("$@" 2>&1)"
  ec=$?
  set -e
  printf '%s\n' "$out" | sed 's/^/  | /' | tail -n 40
  if [[ $ec -ne 0 ]]; then
    log "FAIL $name (exit $ec)"
    fail=$((fail+1))
    return 0
  fi
  log "PASS $name"
  pass=$((pass+1))
}

expect_exit() {
  local name="$1" want="$2"; shift 2
  log "CASE $name (expect exit $want)"
  set +e
  local out ec
  out="$("$@" 2>&1)"
  ec=$?
  set -e
  printf '%s\n' "$out" | sed 's/^/  | /' | tail -n 20
  if [[ "$ec" -eq "$want" ]]; then
    log "PASS $name"
    pass=$((pass+1))
  else
    log "FAIL $name (got exit $ec, want $want)"
    fail=$((fail+1))
  fi
}

contains() {
  local hay="$1" needle="$2"
  printf '%s\n' "$hay" | grep -F "$needle" >/dev/null
}

# 1) unit+integration suite
run_case "npm-test" npm test

# 2) shipped demo
run_case "demo-allow" bash scripts/demo-mock.sh

# 3) HITL deny path
log "CASE hitl-deny"
OUT="$("$TSX" src/index.ts --mock --hitl deny --once "Research ACP, then write scripts/healthcheck.sh")"
printf '%s\n' "$OUT" | sed 's/^/  | /' | tail -n 30
if contains "$OUT" "deny" || contains "$OUT" "denied" || contains "$OUT" "Reject"; then
  if contains "$OUT" "Approved write"; then
    log "FAIL hitl-deny (still approved write)"
    fail=$((fail+1))
  else
    log "PASS hitl-deny"
    pass=$((pass+1))
  fi
else
  log "FAIL hitl-deny (no deny signal)"
  fail=$((fail+1))
fi

# 4) HITL cancel
log "CASE hitl-cancel"
OUT="$("$TSX" src/index.ts --mock --hitl cancel --once "Research ACP, then write scripts/healthcheck.sh")"
printf '%s\n' "$OUT" | sed 's/^/  | /' | tail -n 30
if contains "$OUT" "cancel" || contains "$OUT" "cancelled" || contains "$OUT" "canceled"; then
  if contains "$OUT" "Approved write"; then
    log "FAIL hitl-cancel (still approved write)"
    fail=$((fail+1))
  else
    log "PASS hitl-cancel"
    pass=$((pass+1))
  fi
else
  log "FAIL hitl-cancel (no cancel signal)"
  fail=$((fail+1))
fi

# 5) research-only routing
log "CASE research-only"
OUT="$("$TSX" src/index.ts --mock --hitl allow --once "hello, just say hi")"
printf '%s\n' "$OUT" | sed 's/^/  | /' | tail -n 20
if contains "$OUT" "researcher" && contains "$OUT" "finished"; then
  log "PASS research-only"
  pass=$((pass+1))
else
  log "FAIL research-only"
  fail=$((fail+1))
fi

# 6) multi-step research+code plan
log "CASE research-then-code"
OUT="$("$TSX" src/index.ts --mock --hitl allow --once "Research how ACP works then implement a tiny healthcheck script")"
printf '%s\n' "$OUT" | sed 's/^/  | /' | tail -n 40
if contains "$OUT" "researcher -> coder" && contains "$OUT" "finished 2 steps"; then
  log "PASS research-then-code"
  pass=$((pass+1))
else
  log "FAIL research-then-code"
  fail=$((fail+1))
fi

# 7) missing binary without mock
expect_exit "missing-bin-real" 1 env GROK_BIN=/no/such/grok "$TSX" src/index.ts --once "hi"

# 8) missing binary with mock still works
expect_exit "missing-bin-mock" 0 env GROK_BIN=/no/such/grok "$TSX" src/index.ts --mock --hitl allow --once "hi"

log "SUMMARY pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]]
