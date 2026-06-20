/**
 * Cover art for a track — the modern take on apiserver's `APIC` extraction. Prefers embedded art
 * (ID3 APIC / FLAC picture / MP4 covr via music-metadata), then a folder image (cover.jpg, folder.jpg…).
 */
import { parseFile } from 'music-metadata';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Cover {
  mime: string;
  data: Buffer;
}

const FOLDER_ART = ['cover.jpg', 'folder.jpg', 'front.jpg', 'cover.png', 'folder.png', 'album.jpg', 'Cover.jpg', 'Folder.jpg'];

export async function readCover(path: string): Promise<Cover | null> {
  try {
    const m = await parseFile(path, { skipCovers: false, duration: false });
    const pic = m.common.picture?.[0];
    if (pic?.data) return { mime: pic.format || 'image/jpeg', data: Buffer.from(pic.data) };
  } catch {
    /* fall through to folder art */
  }
  const dir = dirname(path);
  for (const name of FOLDER_ART) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try {
        return { mime: name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg', data: await readFile(p) };
      } catch {
        /* try next */
      }
    }
  }
  return null;
}
