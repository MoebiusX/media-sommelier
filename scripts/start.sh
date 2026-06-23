#!/usr/bin/env bash
# Start Media Sommelier in dev mode: API (server2 :4178) + web (Vite :5180).
# The app opens at http://localhost:5180  (Vite proxies /api -> :4178).
# Usage:  ./scripts/start.sh [--no-open]
# Ctrl+C stops both services.
set -euo pipefail

# Run from the repo root regardless of where this is invoked.
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || {
  echo 'Node.js not found on PATH. Install Node >= 22 (see package.json "engines").' >&2
  exit 1
}

# Ensure both dependency trees exist (npm run dev needs root AND web deps).
[ -d node_modules ] || { echo '[start] installing root dependencies...'; npm install; }
[ -d web/node_modules ] || { echo '[start] installing web dependencies...'; npm --prefix web install; }

# A missing/empty catalog means the UI will render but show nothing — hint, don't auto-scan.
db="${SOMMELIER_DB:-data/sommelier.db}"
if [ ! -s "$db" ]; then
  echo "[start] No catalog DB at $db yet -- the app will be empty until you ingest a folder:"
  echo "[start]   npm run ingest -- '/path/to/Music'"
fi

if [ "${1:-}" != "--no-open" ]; then
  # Open the browser shortly after Vite comes up, without blocking the dev servers.
  ( sleep 3; (xdg-open http://localhost:5180 || open http://localhost:5180) >/dev/null 2>&1 || true ) &
fi

echo '[start] launching API (:4178) + web (:5180)... http://localhost:5180  (Ctrl+C stops both)'
exec npm run dev
