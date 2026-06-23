/**
 * Organize worker — the actual library reorg, run as a CHILD PROCESS of the API server.
 *
 * The server spawns this (node --import tsx organize-worker.ts <source> <dest> <preset> <writeTags> [mode])
 * so the heavy, long-running file copy runs isolated from the server event loop: it can be killed, it
 * can't block API requests, and it streams progress back as newline-delimited JSON on stdout:
 *   {"type":"plan","actions":N,"collisions":N,"skipped":N}
 *   {"type":"progress","done":N,"total":N}
 *   {"type":"done","copied":N,"skipped":N,"failed":N,"tagged":N,"bytes":N}
 *   {"type":"error","message":"…"}
 *
 * mode 'folder' (default): walk <source> → reconstruct() (group by folders).
 * mode 'metadata': group the indexed catalog by embedded album tags (metadataCandidates) — <source> is
 *   ignored and the indexed root is used as the dest-outside-source guard.
 *
 * SOURCE MEDIA IS NEVER MUTATED — executePlan only copies into the new tree and refuses a destination
 * inside the source (sourceRoot guard) and any collision.
 */
import {
  walkToArray,
  reconstruct,
  planOrganize,
  executePlan,
  metadataCandidates,
  ORGANIZE_PRESETS,
  type AlbumCandidate,
} from '../engine/index.js';
import { openDb, DEFAULT_DB_PATH } from './db.js';

function emit(o: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(o) + '\n');
}

/** Resolve the album candidates + the source-root guard for the chosen mode. */
function candidatesFor(mode: string, source: string): { candidates: AlbumCandidate[]; sourceRoot: string } {
  if (mode === 'metadata') {
    const db = openDb(process.env.SOMMELIER_DB ?? DEFAULT_DB_PATH);
    try {
      const rows = db
        .prepare('SELECT path, artistName AS artist, album, title, trackNo, discNo, year, sizeBytes FROM tracks')
        .all() as Array<{
        path: string;
        artist: string | null;
        album: string | null;
        title: string | null;
        trackNo: number | null;
        discNo: number | null;
        year: number | null;
        sizeBytes: number | null;
      }>;
      const ov = db.prepare("SELECT value FROM meta WHERE key = 'overview'").get() as { value?: string } | undefined;
      let root = '';
      try {
        root = (JSON.parse(ov?.value ?? '{}') as { root?: string }).root ?? '';
      } catch {
        /* no root recorded */
      }
      return { candidates: metadataCandidates(rows), sourceRoot: root };
    } finally {
      db.close();
    }
  }
  // folder mode handled by the caller (async walk) — return empty so the caller branches
  return { candidates: [], sourceRoot: source };
}

async function main(): Promise<void> {
  const [source, dest, presetKey, writeTagsStr, modeArg] = process.argv.slice(2);
  const mode = modeArg === 'metadata' ? 'metadata' : 'folder';
  if (!dest || (mode === 'folder' && !source)) {
    emit({ type: 'error', message: 'worker needs <source> <dest> (source optional for metadata mode)' });
    process.exit(1);
    return;
  }

  let candidates: AlbumCandidate[];
  let sourceRoot: string;
  if (mode === 'metadata') {
    emit({ type: 'progress', done: 0, total: 0, phase: 'reading catalog' });
    ({ candidates, sourceRoot } = candidatesFor('metadata', source ?? ''));
  } else {
    emit({ type: 'progress', done: 0, total: 0, phase: 'scanning source' });
    const records = await walkToArray(source!, { include: ['music'] });
    candidates = reconstruct(records).candidates;
    sourceRoot = source!;
  }

  const preset = ORGANIZE_PRESETS[presetKey ?? 'artist-year-album'];
  const plan = planOrganize(candidates, {
    destRoot: dest,
    ...(preset ? { template: preset.template } : {}),
  });
  emit({
    type: 'plan',
    actions: plan.actions.length,
    collisions: plan.collisions.length,
    skipped: plan.skipped.length,
  });

  const total = plan.actions.length;
  const rep = await executePlan(plan, {
    ...(sourceRoot ? { sourceRoot } : {}),
    writeTags: writeTagsStr === 'true',
    onProgress: (done, t) => {
      // throttle: every 5 files + the last, so a 10k-file run doesn't flood stdout
      if (done === t || done % 5 === 0) emit({ type: 'progress', done, total: t });
    },
  });
  emit({ type: 'progress', done: total, total });
  emit({
    type: 'done',
    copied: rep.copied,
    skipped: rep.skipped,
    failed: rep.failed,
    tagged: rep.tagged,
    bytes: rep.bytesCopied,
  });
}

main().catch((e) => {
  emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
