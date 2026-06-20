#!/usr/bin/env node
/**
 * Media Sommelier CLI — a thin shell over @engine that proves the engine is UI-decoupled.
 *
 *   sommelier reconstruct <listing.txt> --from-listing      reconstruct from a `dir /s` dump
 *   sommelier reconstruct <dir>                               reconstruct from a real folder (fs walk)
 *   sommelier plan <path> [--from-listing] --dest <out>       dry-run copy plan into a new tree
 *
 * Flags: --json (machine output), --min-confidence <n>, --limit <n> (walk cap).
 */
import { readFile } from 'node:fs/promises';
import {
  parseDirListing,
  reconstruct,
  planOrganize,
  walkToArray,
  humanBytes,
  type AlbumCandidate,
  type MediaFileRecord,
  type ReconstructionReport,
} from '../engine/index.js';

interface Args {
  cmd: string;
  target: string;
  fromListing: boolean;
  json: boolean;
  dest?: string;
  minConfidence: number;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else flags.set(key, true);
    } else positionals.push(a);
  }
  return {
    cmd: positionals[0] ?? 'help',
    target: positionals[1] ?? '',
    fromListing: flags.get('from-listing') === true,
    json: flags.get('json') === true,
    ...(typeof flags.get('dest') === 'string' ? { dest: flags.get('dest') as string } : {}),
    minConfidence: Number(flags.get('min-confidence') ?? 0),
    ...(flags.get('limit') ? { limit: Number(flags.get('limit')) } : {}),
  };
}

async function loadInventory(args: Args): Promise<MediaFileRecord[]> {
  if (args.fromListing) {
    const text = await readFile(args.target, 'utf8');
    return parseDirListing(text);
  }
  return walkToArray(args.target, { include: ['music'], ...(args.limit ? { limit: args.limit } : {}) });
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function confColor(c: number): string {
  const s = c.toFixed(2);
  return c >= 0.6 ? C.green(s) : c >= 0.4 ? C.yellow(s) : C.red(s);
}

function printReport(report: ReconstructionReport): void {
  const s = report.summary;
  console.log(C.bold('\n🍷 Media Sommelier — reconstruction\n'));
  console.log(
    `${C.bold(String(s.candidates))} releases from ${C.bold(String(s.audioFiles))} audio files ` +
      `(${humanBytes(s.audioBytes)})  ·  ${s.multiDisc} multi-disc  ·  ${s.orphans} orphan  ·  ` +
      `${C.yellow(String(s.needsReview))} need review  ·  lossless ${(s.losslessRatio * 100).toFixed(0)}%`,
  );
  console.log(C.dim('schemes: ' + Object.entries(s.schemes).map(([k, v]) => `${k}×${v}`).join(', ')) + '\n');

  for (const c of report.candidates) {
    printCandidate(c);
  }

  if (report.duplicates.length) {
    console.log(C.bold('\n⚠ Duplicate candidates (verify by fingerprint):'));
    for (const d of report.duplicates) {
      console.log(`  ${C.cyan(d.titleKey)} ×${d.occurrences.length}: ${d.occurrences.map((o) => o.album).join(' · ')}`);
    }
  }
  console.log('');
}

function printCandidate(c: AlbumCandidate): void {
  const year = c.year ? C.dim(` (${c.year})`) : '';
  const flags = c.flags.length ? '  ' + C.yellow(c.flags.join(' ')) : '';
  console.log(
    `${C.bold(c.albumArtist)} — ${c.albumTitle}${year}  [${confColor(c.confidence)}]  ` +
      `${c.totalTracks}t/${c.discs.length}d${flags}`,
  );
  for (const e of c.evidence) console.log(C.dim(`    · ${e}`));
}

function printPlan(report: ReconstructionReport, destRoot: string, minConfidence: number): void {
  const plan = planOrganize(report.candidates, { destRoot, minConfidence });
  console.log(C.bold(`\n📂 Dry-run organize plan → ${destRoot}\n`));
  console.log(`${plan.actions.length} files would be copied (originals untouched).`);
  if (plan.skipped.length) console.log(C.dim(`${plan.skipped.length} candidate(s) skipped (below min-confidence)`));
  if (plan.collisions.length) console.log(C.red(`${plan.collisions.length} destination collision(s)!`));
  console.log('');
  const sample = plan.actions.slice(0, 24);
  for (const a of sample) console.log(C.dim('  ' + a.destRelPath));
  if (plan.actions.length > sample.length) console.log(C.dim(`  … and ${plan.actions.length - sample.length} more`));
  console.log('');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === 'help' || !args.target) {
    console.log(`Media Sommelier CLI
  sommelier reconstruct <listing.txt> --from-listing [--json]
  sommelier reconstruct <dir> [--limit N] [--json]
  sommelier plan <path> [--from-listing] --dest <out> [--min-confidence N] [--json]`);
    process.exit(args.target ? 0 : 1);
  }

  const inventory = await loadInventory(args);
  const report = reconstruct(inventory);

  if (args.cmd === 'reconstruct') {
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
  } else if (args.cmd === 'plan') {
    const destRoot = args.dest ?? './organized';
    if (args.json) console.log(JSON.stringify(planOrganize(report.candidates, { destRoot, minConfidence: args.minConfidence }), null, 2));
    else printPlan(report, destRoot, args.minConfidence);
  } else {
    console.error(`Unknown command: ${args.cmd}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
