#!/usr/bin/env bash
# CloudOps Workspace launcher — single command to bring up the backend + frontend
# in development mode. Run from the repo root.

set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT="$(pwd)"
PI_WORKSPACE_ROOT="${PI_WORKSPACE_ROOT:-$HOME/.pi-workspace}"
KB_ROOT="${PI_WORKSPACE_KB_ROOT:-$REPO_ROOT/seed-skills}"
PORT="${PORT:-8766}"

mkdir -p "$PI_WORKSPACE_ROOT"

if [ ! -d node_modules ]; then
  echo "[start] installing server deps..."
  npm install --silent
fi
if [ ! -d web/node_modules ]; then
  echo "[start] installing web deps..."
  (cd web && npm install --silent)
fi

TOKEN_FILE="$PI_WORKSPACE_ROOT/dev-token.txt"
if [ -f "$TOKEN_FILE" ]; then
  echo "[start] dev token (paste this into the workspace login):"
  echo "  $(cat "$TOKEN_FILE")"
else
  echo "[start] no dev token yet — first server boot will generate one at $TOKEN_FILE"
fi

PIDS=()
cleanup() {
  echo
  echo "[start] shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Install the pi-bridge extension into ~/.pi/agent/extensions/. Idempotent.
EXT_SRC="$REPO_ROOT/extensions/mcp-bridge"
EXT_DEST="$HOME/.pi/agent/extensions/mcp-bridge"
if [ -d "$EXT_SRC" ]; then
  mkdir -p "$(dirname "$EXT_DEST")"
  if [ ! -d "$EXT_DEST" ] || [ "$EXT_SRC/index.ts" -nt "$EXT_DEST/index.ts" ]; then
    rm -rf "$EXT_DEST"
    cp -R "$EXT_SRC" "$EXT_DEST"
    echo "[start] installed mcp-bridge extension at $EXT_DEST"
  fi
fi

# REF_API_KEY: backend lifts from ~/.claude.json automatically; no prompt needed.
# Operator override: export REF_API_KEY=... before running this script.

echo "[start] backend → http://127.0.0.1:$PORT"
PORT="$PORT" \
  PI_WORKSPACE_ROOT="$PI_WORKSPACE_ROOT" \
  PI_WORKSPACE_KB_ROOT="$KB_ROOT" \
  node --import tsx src/server.ts &
PIDS+=($!)

# Vite host: defaults to localhost-only for dev safety. Set WEB_HOST=0.0.0.0
# (e.g. on the lab VM) to expose Vite on the LAN/public interface.
WEB_HOST="${WEB_HOST:-127.0.0.1}"
echo "[start] frontend (Vite) → http://${WEB_HOST}:5173"
(cd web && npm run dev -- --host "$WEB_HOST") &
PIDS+=($!)

# bash 3.2 (macOS) doesn't support `wait -n`; poll instead.
while true; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[start] child $pid exited; shutting down."
      exit 0
    fi
  done
  sleep 1
done
