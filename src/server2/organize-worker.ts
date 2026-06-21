/**
 * Organize worker — the actual library reorg, run as a CHILD PROCESS of the API server.
 *
 * The server spawns this (node --import tsx organize-worker.ts <source> <dest> <preset> <writeTags>) so
 * the heavy, long-running file copy runs isolated from the server event loop: it can be killed, it can't
 * block API requests, and it streams progress back as newline-delimited JSON on stdout:
 *   {"type":"plan","actions":N,"collisions":N,"skipped":N}
 *   {"type":"progress","done":N,"total":N}
 *   {"type":"done","copied":N,"skipped":N,"failed":N,"tagged":N,"bytes":N}
 *   {"type":"error","message":"…"}
 *
 * SOURCE MEDIA IS NEVER MUTATED — executePlan only copies into the new tree and refuses a destination
 * inside the source (sourceRoot guard) and any collision.
 */
import {
  walkToArray,
  reconstruct,
  planOrganize,
  executePlan,
  ORGANIZE_PRESETS,
} from '../engine/index.js';

function emit(o: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(o) + '\n');
}

async function main(): Promise<void> {
  const [source, dest, presetKey, writeTagsStr] = process.argv.slice(2);
  if (!source || !dest) {
    emit({ type: 'error', message: 'worker needs <source> <dest>' });
    process.exit(1);
    return;
  }

  emit({ type: 'progress', done: 0, total: 0, phase: 'scanning source' });
  const records = await walkToArray(source, { include: ['music'] });
  const report = reconstruct(records);
  const preset = ORGANIZE_PRESETS[presetKey ?? 'artist-year-album'];
  const plan = planOrganize(report.candidates, {
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
    sourceRoot: source,
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
