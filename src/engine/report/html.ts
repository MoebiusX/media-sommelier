/**
 * Render a ReconstructionReport as a self-contained static HTML page.
 *
 * A shareable, nicer-than-terminal view of the reconstructed library — and an early step toward the
 * desktop review UI. No external assets; inline CSS; safe-escaped content.
 */
import type { AlbumCandidate, ReconstructionReport } from '../types.js';
import { humanBytes } from '../text.js';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function confClass(c: number): string {
  return c >= 0.6 ? 'hi' : c >= 0.4 ? 'mid' : 'lo';
}

function card(c: AlbumCandidate): string {
  const year = c.year ? ` <span class="year">(${c.year})</span>` : '';
  const flags = c.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join(' ');
  const evidence = c.evidence.map((e) => `<li>${esc(e)}</li>`).join('');
  const discs = c.discs
    .map((d) => {
      const rows = d.tracks
        .map((t) => `<tr><td class="pos">${t.position}</td><td>${esc(t.title)}</td><td class="sz">${humanBytes(t.file.sizeBytes)}</td></tr>`)
        .join('');
      const head = c.discs.length > 1 ? `<div class="disc">Disc ${d.discNo} · ${d.tracks.length} tracks</div>` : '';
      return `${head}<table class="tracks">${rows}</table>`;
    })
    .join('');
  return `<details class="card ${confClass(c.confidence)}">
  <summary>
    <span class="artist">${esc(c.albumArtist)}</span> — <span class="album">${esc(c.albumTitle)}</span>${year}
    <span class="meta">${c.totalTracks}t · ${c.discs.length}d · ${humanBytes(c.sizeBytes)}</span>
    <span class="conf ${confClass(c.confidence)}">${c.confidence.toFixed(2)}</span>
  </summary>
  <div class="flags">${flags}</div>
  <ul class="evidence">${evidence}</ul>
  ${discs}
</details>`;
}

export function renderHtml(report: ReconstructionReport, title = 'Media Sommelier'): string {
  const s = report.summary;
  const cards = report.candidates.map(card).join('\n');
  const dups = report.duplicates.length
    ? `<section class="dups"><h2>Duplicate candidates (verify by fingerprint)</h2><ul>${report.duplicates
        .map((d) => `<li><b>${esc(d.titleKey)}</b> ×${d.occurrences.length}: ${esc(d.occurrences.map((o) => o.album).join(' · '))}</li>`)
        .join('')}</ul></section>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:dark light}
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#0f1115;color:#e6e6e6}
header{padding:24px;background:#171a21;border-bottom:1px solid #262b36}
h1{margin:0 0 6px;font-size:22px}.kpis{color:#9aa4b2;font-size:14px}
main{max-width:980px;margin:0 auto;padding:20px}
.card{background:#171a21;border:1px solid #262b36;border-radius:10px;margin:10px 0;padding:6px 14px}
.card.hi{border-left:4px solid #2ecc71}.card.mid{border-left:4px solid #f1c40f}.card.lo{border-left:4px solid #e74c3c}
summary{cursor:pointer;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0}
.artist{font-weight:700}.album{color:#cdd6e0}.year{color:#7f8a99}
.meta{color:#7f8a99;font-size:13px;margin-left:auto}
.conf{font-variant-numeric:tabular-nums;padding:2px 8px;border-radius:20px;font-size:12px;font-weight:700}
.conf.hi{background:#10371f;color:#2ecc71}.conf.mid{background:#3a3210;color:#f1c40f}.conf.lo{background:#3a1717;color:#e74c3c}
.flag{display:inline-block;background:#222834;color:#9aa4b2;border-radius:6px;padding:1px 7px;font-size:11px;margin:2px}
.evidence{color:#8b95a3;font-size:13px;margin:6px 0 10px;padding-left:18px}
.disc{color:#9aa4b2;font-size:13px;margin:8px 0 4px;font-weight:600}
table.tracks{width:100%;border-collapse:collapse;margin-bottom:8px}
.tracks td{padding:3px 6px;border-bottom:1px solid #20252f}.tracks .pos{color:#7f8a99;width:32px;text-align:right}.tracks .sz{color:#7f8a99;text-align:right;width:80px}
.dups{margin-top:24px}.dups li{color:#cdd6e0}
</style></head><body>
<header>
  <h1>🍷 ${esc(title)}</h1>
  <div class="kpis">${s.candidates} releases · ${s.audioFiles} files · ${humanBytes(s.audioBytes)} · ${s.multiDisc} multi-disc · ${s.orphans} orphan · ${s.needsReview} need review · lossless ${(s.losslessRatio * 100).toFixed(0)}%</div>
</header>
<main>
${cards}
${dups}
</main></body></html>`;
}
