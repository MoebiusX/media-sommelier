#!/usr/bin/env node
// Fetch the Chromaprint `fpcalc` binary into vendor/fpcalc/ (gitignored).
// fpcalc is the LGPL/FFmpeg-backed build (license-safe to redistribute with notices).
// Usage: node tools/fetch-fpcalc.mjs
//
// Windows note: this script downloads the zip; extract with PowerShell:
//   Expand-Archive vendor/fpcalc.zip vendor/fpcalc -Force
// (kept minimal/dependency-free; the desktop app will bundle per-OS binaries properly.)

import { mkdir, writeFile } from 'node:fs/promises';

const V = '1.5.1';
const platform = process.platform; // win32 | darwin | linux
const arch = process.arch; // x64 | arm64
const asset =
  platform === 'win32'
    ? `chromaprint-fpcalc-${V}-windows-x86_64.zip`
    : platform === 'darwin'
      ? `chromaprint-fpcalc-${V}-macos-${arch === 'arm64' ? 'arm64' : 'x86_64'}.zip`
      : `chromaprint-fpcalc-${V}-linux-x86_64.tar.gz`;
const url = `https://github.com/acoustid/chromaprint/releases/download/v${V}/${asset}`;

console.log(`Downloading ${url}`);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) {
  console.error(`Failed: HTTP ${res.status}`);
  process.exit(1);
}
await mkdir('vendor', { recursive: true });
const out = `vendor/${asset}`;
await writeFile(out, Buffer.from(await res.arrayBuffer()));
console.log(`Saved ${out}. Now extract it into vendor/fpcalc/ and ensure vendor/fpcalc/fpcalc(.exe) exists.`);
