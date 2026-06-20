/**
 * Chromaprint (`fpcalc`) adapter — computes an audio fingerprint for a file via the bundled binary.
 *
 * fpcalc DECODES the audio (it carries its own FFmpeg, LGPL build), so this is the expensive,
 * need-gated stage from the plan — run it only on files MusicBrainz-by-tags can't confidently match.
 * Isolated in a subprocess so a bad decode kills one call, not the app.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface Fingerprint {
  duration: number; // seconds (rounded)
  fingerprint: string; // Chromaprint base64
}

/** Resolve the fpcalc binary: FPCALC_PATH env → vendored copy → bare name on PATH. */
export function fpcalcPath(): string {
  const exe = process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc';
  if (process.env.FPCALC_PATH && existsSync(process.env.FPCALC_PATH)) return process.env.FPCALC_PATH;
  const vendored = join('vendor', 'fpcalc', exe);
  if (existsSync(vendored)) return vendored;
  return exe;
}

export async function fingerprintFile(path: string, timeoutMs = 30_000): Promise<Fingerprint> {
  const { stdout } = await execFileAsync(fpcalcPath(), ['-json', path], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const j = JSON.parse(stdout) as { duration: number; fingerprint: string };
  return { duration: Math.round(j.duration), fingerprint: j.fingerprint };
}

export function fpcalcAvailable(): boolean {
  const p = fpcalcPath();
  return p.includes('/') || p.includes('\\') ? existsSync(p) : true; // PATH-resolved names assumed present
}
