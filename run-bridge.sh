#!/usr/bin/env bash
# Start de funda-bridge lokaal.
#
# Kiest automatisch een vrije poort (8765 is op deze machine bezet door de
# claudecodebrowser-MCP) en print welke dat is. De extensie zoekt dezelfde
# poort zelf op via /health, dus je hoeft niets in te stellen.
#
#   ./run-bridge.sh              # eerste vrije poort uit de lijst
#   FUNDA_BRIDGE_PORT=9999 ./run-bridge.sh
set -euo pipefail
cd "$(dirname "$0")"

PY="bridge/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "Geen venv. Eenmalig aanmaken:" >&2
  echo "  python3 -m venv bridge/.venv" >&2
  echo "  bridge/.venv/bin/pip install -e ./pyfunda" >&2
  exit 1
fi

poort="${FUNDA_BRIDGE_PORT:-}"
if [[ -z "$poort" ]]; then
  for p in 8765 8767 8768 8769 8770; do
    if ! ss -tln 2>/dev/null | grep -q ":$p "; then
      poort="$p"
      break
    fi
  done
fi
if [[ -z "$poort" ]]; then
  echo "Geen vrije poort in 8765/8767-8770. Zet FUNDA_BRIDGE_PORT expliciet." >&2
  exit 1
fi

echo "funda-bridge op http://127.0.0.1:$poort  (Ctrl-C om te stoppen)"
exec env FUNDA_BRIDGE_PORT="$poort" "$PY" bridge/bridge.py
