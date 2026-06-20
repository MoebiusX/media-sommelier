// Print common tags of an audio file. Usage: npx tsx tools/_readtags.ts <file>
import { parseFile } from 'music-metadata';
const m = await parseFile(process.argv[2]!);
console.log({
  albumArtist: m.common.albumartist,
  album: m.common.album,
  title: m.common.title,
  track: m.common.track?.no,
  disc: m.common.disk?.no,
  year: m.common.year,
});
