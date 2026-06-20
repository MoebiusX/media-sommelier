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
import { readFile, writeFile } from 'node:fs/promises';
import {
  parseDirListing,
  reconstruct,
  planOrganize,
  executePlan,
  renderHtml,
  computeInsights,
  MusicBrainzClient,
  enrichTop,
  walkToArray,
  humanBytes,
  type AlbumCandidate,
  type MediaFileRecord,
  type ReconstructionReport,
  type InsightsReport,
} from '../engine/index.js';

interface Args {
  cmd: string;
  target: string;
  fromListing: boolean;
  json: boolean;
  execute: boolean;
  offline: boolean;
  dest?: string;
  html?: string;
  minConfidence: number;
  limit?: number; // command-specific (e.g. # releases to enrich)
  scanLimit?: number; // hard cap on files walked (for huge trees)
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
    execute: flags.get('execute') === true,
    offline: flags.get('offline') === true,
    ...(typeof flags.get('dest') === 'string' ? { dest: flags.get('dest') as string } : {}),
    ...(typeof flags.get('html') === 'string' ? { html: flags.get('html') as string } : {}),
    minConfidence: Number(flags.get('min-confidence') ?? 0),
    ...(flags.get('limit') ? { limit: Number(flags.get('limit')) } : {}),
    ...(flags.get('scan-limit') ? { scanLimit: Number(flags.get('scan-limit')) } : {}),
  };
}

async function loadInventory(args: Args): Promise<MediaFileRecord[]> {
  if (args.fromListing) {
    const text = await readFile(args.target, 'utf8');
    return parseDirListing(text);
  }
  let skipped = 0;
  const records = await walkToArray(args.target, {
    include: ['music'],
    onSkip: () => skipped++,
    ...(args.scanLimit ? { limit: args.scanLimit } : {}),
  });
  if (skipped > 0) console.error(`[warn] ${skipped} path(s) unreadable after retries and skipped (network drive hiccup?) — counts may be low.`);
  return records;
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

function bar(ratio: number, width = 20): string {
  const n = Math.round(ratio * width);
  return '█'.repeat(n) + C.dim('░'.repeat(width - n));
}

function printInsights(ins: InsightsReport): void {
  const c = ins.collection;
  console.log(C.bold('\n🍷 Collection insights\n'));
  console.log(`Releases ${C.bold(String(c.releases))} · tracks ${C.bold(String(c.tracks))} · ${humanBytes(c.bytes)} · avg ${c.avgTrackMB.toFixed(1)} MB/track`);
  console.log(`Lossless  ${bar(c.losslessRatio)} ${(c.losslessRatio * 100).toFixed(0)}%   formats: ${Object.entries(c.formats).map(([k, v]) => `${k}×${v}`).join(', ')}`);
  console.log(`Compilations ${bar(c.compilationRatio)} ${(c.compilationRatio * 100).toFixed(0)}%   numbered ${(c.numberedReleaseRatio * 100).toFixed(0)}%   multi-disc ${c.multiDisc} · orphans ${c.orphans}`);
  if (Object.keys(c.decadeHistogram).length) console.log(`Decades: ${Object.entries(c.decadeHistogram).sort().map(([d, n]) => `${d}:${n}`).join(' ')}  ${C.dim(`(year known ${(c.knownYearRatio * 100).toFixed(0)}%)`)}`);
  console.log(C.dim(`Top artists: ${c.topArtists.slice(0, 5).map((a) => `${a.artist} (${a.tracks}t)`).join(', ')}`));

  const o = ins.owner;
  console.log(C.bold('\n👤 Owner profile') + C.dim('  (heuristic, 100% local)\n'));
  for (const a of o.archetypes) console.log(`  ${C.green('▸')} ${C.bold(a.label)} ${C.dim(`[${a.confidence.toFixed(2)}]`)}\n      ${C.dim(a.why)}`);
  console.log(`  ${o.buildHistory.reliable ? C.green('●') : C.yellow('●')} Build history: ${o.buildHistory.reliable ? 'reliable' : C.yellow('withheld')}\n      ${C.dim(o.buildHistory.reason)}`);
  console.log(`  ${o.classicVsNew.computable ? C.green('●') : C.yellow('●')} Classic-vs-new: ${o.classicVsNew.computable ? `${Math.round((o.classicVsNew.classicPct ?? 0) * 100)}% pre-${o.classicVsNew.cutoff}` : C.yellow('not computable')}\n      ${C.dim(o.classicVsNew.reason)}`);
  for (const s of o.signals) console.log(C.dim(`  · ${s.label} — ${s.why}`));
  console.log('');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === 'help' || !args.target) {
    console.log(`Media Sommelier CLI
  sommelier reconstruct <listing.txt> --from-listing [--json] [--html out.html]
  sommelier reconstruct <dir> [--scan-limit N] [--json] [--html out.html]
  sommelier plan <path> [--from-listing] --dest <out> [--min-confidence N] [--json]
  sommelier organize <path> [--from-listing] --dest <out> [--execute] [--min-confidence N]
    (organize is dry-run unless --execute; originals are never modified)
  sommelier insights <path> [--from-listing] [--json]   collection + owner profile
  sommelier enrich <path> [--from-listing] [--limit N] [--offline] [--json]
    (match top releases to MusicBrainz — corrects title/artist/year, adds MBIDs)`);
    process.exit(args.target ? 0 : 1);
  }

  const inventory = await loadInventory(args);
  const report = reconstruct(inventory);

  if (args.cmd === 'reconstruct') {
    if (args.html) {
      await writeFile(args.html, renderHtml(report), 'utf8');
      console.log(C.green(`Wrote HTML report → ${args.html}`));
    }
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
  } else if (args.cmd === 'plan') {
    const destRoot = args.dest ?? './organized';
    if (args.json) console.log(JSON.stringify(planOrganize(report.candidates, { destRoot, minConfidence: args.minConfidence }), null, 2));
    else printPlan(report, destRoot, args.minConfidence);
  } else if (args.cmd === 'organize') {
    const destRoot = args.dest ?? './organized';
    const plan = planOrganize(report.candidates, { destRoot, minConfidence: args.minConfidence });
    if (!args.execute) {
      printPlan(report, destRoot, args.minConfidence);
      console.log(C.yellow('Dry-run only. Pass --execute to copy (originals are never modified).'));
      return;
    }
    console.log(C.bold(`\nCopying ${plan.actions.length} files → ${destRoot} (verifying each by hash)…\n`));
    const result = await executePlan(plan, {
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
      },
    });
    console.log(
      `\n\n${C.green(`${result.copied} copied`)} · ${result.skipped} skipped · ` +
        `${result.failed ? C.red(`${result.failed} failed`) : '0 failed'} · ${humanBytes(result.bytesCopied)} written`,
    );
    for (const r of result.results.filter((x) => x.status === 'failed')) console.log(C.red(`  ✗ ${r.action.destRelPath}: ${r.error}`));
  } else if (args.cmd === 'insights') {
    const ins = computeInsights(inventory, report);
    if (args.json) console.log(JSON.stringify(ins, null, 2));
    else printInsights(ins);
  } else if (args.cmd === 'enrich') {
    const limit = args.limit ?? 6;
    const client = new MusicBrainzClient({ offline: args.offline });
    console.log(C.bold(`\n🔎 Enriching top ${limit} releases via MusicBrainz${args.offline ? ' (offline cache)' : ' (rate-limited ~1/s)'}…\n`));
    const enriched = await enrichTop(report, client, limit);
    if (args.json) {
      console.log(JSON.stringify(enriched, null, 2));
    } else {
      for (const e of enriched) {
        const head = `${C.bold(e.before.artist)} — ${e.before.album}${e.before.year ? C.dim(` (${e.before.year})`) : ''}`;
        if (e.status === 'matched' && e.match) {
          console.log(`${head}  ${C.green('✓')} ${C.dim(`[${e.match.score}]`)}`);
          const yr = e.match.year ? ` (${e.match.year})` : '';
          const ty = e.match.primaryType ? C.dim(` ${e.match.primaryType}`) : '';
          console.log(`    → ${C.cyan(`${e.match.artist} — ${e.match.album}${yr}`)}${ty}  ${C.dim(`${e.match.trackCount ?? '?'}t · mbid ${e.match.mbid.slice(0, 8)}`)}`);
        } else {
          console.log(`${head}  ${C.yellow('· no confident match')}`);
        }
      }
      console.log(C.dim(`\nMusicBrainz: ${client.stats.network} network · ${client.stats.cacheHits} cached · ${client.stats.errors} errors`));
    }
  } else {
    console.error(`Unknown command: ${args.cmd}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
