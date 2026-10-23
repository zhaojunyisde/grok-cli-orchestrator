#!/usr/bin/env bash
# Non-interactive mock scenario. Does not call grok or the network.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TSX="$ROOT/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "tsx is not installed. From the repo root, run: npm install" >&2
  exit 1
fi

MESSAGE="Research how ACP permission requests work, then sketch a tiny shell health check. Writing the file needs approval."
OUT="$("$TSX" src/index.ts --mock --hitl allow --once "$MESSAGE")"
printf '%s\n' "$OUT"

require() {
  local needle="$1"
  if ! printf '%s\n' "$OUT" | grep -F "$needle" >/dev/null; then
    echo "demo-mock: missing expected text: $needle" >&2
    exit 1
  fi
}

require "plan (deterministic): researcher -> coder"
require "session/request_permission"
require "allow once"
require "scripts/healthcheck.sh"
require "finished 2 steps."
echo "demo-mock: ok"
