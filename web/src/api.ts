// Thin typed client over the engine-backed API (proxied to :4178 via vite).

export interface Overview {
  tracks: number;
  albums: number;
  artists: number;
  totalBytes: number;
  totalHuman: string;
  totalDurationMs: number;
  losslessRatio: number;
  formats: Record<string, number>;
  topArtists: Array<{ name: string; tracks: number }>;
  topGenres: Array<{ name: string; tracks: number }>;
  topYears: Array<{ year: number; tracks: number }>;
  simulation: {
    tag: { groups: number; orphanTracks: number };
    folder: { groups: number; orphanTracks: number };
    verdict: string;
  } | null;
}

export interface ArtistSummary {
  name: string;
  trackCount: number;
  albumCount: number;
}

export interface AlbumSummary {
  id: string;
  title: string;
  year: number | null;
  coverPath: string | null;
  trackCount: number;
  flags: string[];
  confidence: number;
  lossless: boolean;
  discCount: number;
}

export interface ArtistDetail {
  name: string;
  trackCount: number;
  albumCount: number;
  albums: AlbumSummary[];
}

export interface TrackDetail {
  id: number;
  title: string;
  artistName: string;
  trackNo: number | null;
  discNo: number | null;
  durationMs: number | null;
  bitrateKbps: number | null;
  lossless: boolean;
  sizeBytes: number | null;
  genre: string | null;
  year: number | null;
  path: string;
}

export interface AlbumDetail {
  id: string;
  artistName: string;
  title: string;
  year: number | null;
  coverPath: string | null;
  lossless: boolean;
  flags: string[];
  confidence: number;
  evidence: string[];
  sourceDir: string;
  sizeBytes: number;
  discCount: number;
  completeness: number | null;
  tracks: TrackDetail[];
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) {
    let detail = '';
    try {
      detail = (await r.json())?.error ?? '';
    } catch {
      /* ignore */
    }
    throw new Error(`${r.status} ${detail || r.statusText}`);
  }
  return (await r.json()) as T;
}

export const api = {
  health: () => get<{ ok: boolean; db?: string }>('/api/health'),
  overview: () => get<Overview>('/api/overview'),
  artists: () => get<ArtistSummary[]>('/api/artists'),
  artist: (name: string) => get<ArtistDetail>(`/api/artist/${encodeURIComponent(name)}`),
  album: (id: string) => get<AlbumDetail>(`/api/album/${encodeURIComponent(id)}`),
  coverUrl: (albumId: string) => `/api/cover?albumId=${encodeURIComponent(albumId)}`,
};

// ---- formatting helpers ----
export function fmtDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '–';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtRuntime(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  return `${Math.round(hours)} hrs`;
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}
