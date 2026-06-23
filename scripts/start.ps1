#!/usr/bin/env pwsh
# Start Media Sommelier in dev mode: API (server2 :4178) + web (Vite :5180).
# The app opens at http://localhost:5180  (Vite proxies /api -> :4178).
# Usage:  ./scripts/start.ps1 [-NoOpen]
#   -NoOpen   don't auto-open the browser
# Ctrl+C stops both services.

param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'

# Run from the repo root regardless of where this is invoked.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Node.js not found on PATH. Install Node >= 22 (see package.json "engines").'
  exit 1
}

# Ensure both dependency trees exist (npm run dev needs root AND web deps).
if (-not (Test-Path 'node_modules')) {
  Write-Host '[start] installing root dependencies...' -ForegroundColor Yellow
  npm install
}
if (-not (Test-Path 'web/node_modules')) {
  Write-Host '[start] installing web dependencies...' -ForegroundColor Yellow
  npm --prefix web install
}

# A missing/empty catalog means the UI will render but show nothing — hint, don't auto-scan.
$db = if ($env:SOMMELIER_DB) { $env:SOMMELIER_DB } else { 'data/sommelier.db' }
if (-not (Test-Path $db) -or (Get-Item $db).Length -eq 0) {
  Write-Host "[start] No catalog DB at $db yet -- the app will be empty until you ingest a folder:" -ForegroundColor Yellow
  Write-Host "[start]   npm run ingest -- 'Y:\\'   (point it at your music root)" -ForegroundColor Yellow
}

if (-not $NoOpen) {
  # Open the browser shortly after Vite comes up, without blocking the dev servers.
  Start-Job { Start-Sleep -Seconds 3; Start-Process 'http://localhost:5180' } | Out-Null
}

Write-Host '[start] launching API (:4178) + web (:5180)... http://localhost:5180  (Ctrl+C stops both)' -ForegroundColor Cyan
npm run dev
