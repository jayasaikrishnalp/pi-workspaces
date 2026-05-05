#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || { echo "[start] running npm install"; npm install --silent; }
exec npx tsx src/server.ts
