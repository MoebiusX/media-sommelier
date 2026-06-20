/**
 * Import a Windows `dir /s` text dump into MediaFileRecords.
 *
 * This is how we run the engine against the user's REAL collection sample without mounting the drive:
 * the committed `test/fixtures/real-world/*.dir.txt` is parsed into the same record shape the
 * filesystem walker produces, so reconstruction logic is exercised end-to-end on real data.
 */
import type { MediaFileRecord } from '../types.js';
import { extOf, mediaTypeForExt } from '../text.js';

const DIR_OF = /^\s*Directory of\s+(.+?)\s*$/;
// 04/02/2023  04:29 PM         6,811,288 101-led_zeppelin-rock_and_roll.mp3
const FILE_LINE = /^(\d{2})\/(\d{2})\/(\d{4})\s+\d{2}:\d{2}\s+(?:AM|PM)\s+([\d,]+)\s+(.+?)\s*$/;

export function parseDirListing(text: string): MediaFileRecord[] {
  const records: MediaFileRecord[] = [];
  let curDir: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    const d = line.match(DIR_OF);
    if (d) {
      curDir = d[1] ?? null;
      continue;
    }
    if (line.includes('<DIR>')) continue;
    const m = line.match(FILE_LINE);
    if (!m || !curDir) continue;

    const [, mm, dd, yyyy, sizeStr, rawName] = m;
    const name = rawName!.trim();
    if (name === '.' || name === '..') continue;

    const ext = extOf(name);
    const sep = curDir.includes('\\') ? '\\' : '/';
    records.push({
      path: `${curDir}${sep}${name}`,
      dir: curDir,
      name,
      ext,
      sizeBytes: Number(sizeStr!.replace(/,/g, '')),
      mtime: `${yyyy}-${mm}-${dd}`,
      mediaType: mediaTypeForExt(ext),
    });
  }
  return records;
}
