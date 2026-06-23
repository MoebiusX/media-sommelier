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

export interface BrowseAlbum extends AlbumSummary {
  artistName: string;
  sizeBytes: number;
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

export interface Preset {
  label: string;
  template: string;
}

export interface ScanStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  source?: string;
  phase: string;
  done: number;
  total: number;
  result?: { tracks: number; albums: number; artists: number };
  error?: string;
}

export interface OrganizeStatus {
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  source?: string;
  dest?: string;
  phase: string;
  done: number;
  total: number;
  pid?: number;
  result?: { copied: number; skipped: number; failed: number; tagged: number; bytes: number; dest: string };
  error?: string;
}

export interface PlanSummary {
  actions: number;
  collisions: number;
  skipped: number;
  sample: string[];
}

export interface SchemeStat {
  key: string;
  label: string;
  template: string;
  folders: number;
  tracks: number;
  singletonFolders: number;
  sparseFolders: number;
  sparseTracks: number;
  medianPerFolder: number;
  largestFolder: number;
  collisions: number;
  skipped: number;
  hist: Array<{ label: string; folders: number }>;
}

export interface SimulateResult {
  source: string;
  schemes: SchemeStat[];
  recommended: string | null;
}

export interface SmartCondition {
  field: string;
  op: string;
  value: string;
}
export interface SmartRules {
  match: 'all' | 'any';
  conditions: SmartCondition[];
  sort?: string;
  limit?: number;
}

export interface PlaylistSummary {
  id: number;
  name: string;
  createdAt: number;
  trackCount: number;
  smart: boolean;
  rules: SmartRules | null;
}
export interface PlaylistTrack {
  id: number;
  title: string;
  artistName: string | null;
  album: string | null;
  albumId: string | null;
  path: string;
  durationMs: number | null;
  bitrateKbps: number | null;
  lossless: boolean;
  sizeBytes: number;
  position: number;
}
export interface PlaylistDetail {
  id: number;
  name: string;
  createdAt: number;
  smart: boolean;
  rules: SmartRules | null;
  tracks: PlaylistTrack[];
}

export interface SearchResults {
  artists: Array<{ name: string; trackCount: number; albumCount: number }>;
  albums: Array<{ id: string; title: string; artistName: string; year: number | null; trackCount: number }>;
  tracks: Array<{ id: number; title: string; artistName: string | null; albumId: string | null; path: string; durationMs: number | null }>;
}

export interface DupTrack {
  id: number;
  album: string | null;
  albumId: string | null;
  path: string;
  durationMs: number | null;
  bitrateKbps: number | null;
  lossless: boolean;
  sizeBytes: number;
  ext: string;
  keeper: boolean;
}
export interface DupGroup {
  title: string;
  artist: string;
  count: number;
  wastedBytes: number;
  tracks: DupTrack[];
}
export interface DuplicatesResult {
  totalGroups: number;
  wastedBytes: number;
  groups: DupGroup[];
}

export interface ProfileSummary {
  id: number;
  name: string;
  target: string;
  preset: string;
  transcodeTo: string;
  createdAt: number;
  lastSyncAt: number | null;
  albumCount: number;
  trackCount: number;
  bytes: number;
}

export interface ProfileAlbum {
  id: string;
  title: string;
  artistName: string;
  year: number | null;
  trackCount: number;
  sizeBytes: number;
  lossless: boolean;
  coverPath: string | null;
}

export interface ProfileDetail extends ProfileSummary {
  albums: ProfileAlbum[];
  formats: Record<string, number>;
  riskTracks: number;
}

export interface SyncStatus {
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  profileId?: number;
  dest?: string;
  phase: string;
  done: number;
  total: number;
  result?: { copied: number; transcoded?: number; skipped: number; failed: number; bytes: number; dest: string };
  error?: string;
}

export interface RefreshMatch {
  mbid: string;
  releaseGroupMbid?: string;
  artist: string;
  album: string;
  year?: number;
  trackCount?: number;
  score: number;
}

export interface RefreshPreview {
  ok: boolean;
  matched: boolean;
  before: { title: string; year: number | null };
  match?: RefreshMatch;
  coverFetched: boolean;
}

export interface Completeness {
  ok: boolean;
  matched: boolean;
  mbAlbum?: string;
  expected?: number;
  have?: number;
  missing?: Array<{ disc: number; position: number; title: string }>;
  extra?: Array<{ title: string; trackNo: number | null; discNo: number | null }>;
}

export interface RefreshProposal {
  albumId: string;
  artistName: string;
  title: string;
  year: number | null;
  match: { album: string; year?: number; score: number; mbid: string };
  coverFetched: boolean;
}

export interface RefreshBatchJob {
  state: 'idle' | 'running' | 'done' | 'error';
  phase: string;
  done: number;
  total: number;
  proposals: RefreshProposal[];
  error?: string;
}

export interface LyricLine {
  time: number;
  text: string;
}
export interface LyricsResult {
  ok: boolean;
  source: 'sidecar' | 'embedded' | 'lrclib' | null;
  synced: LyricLine[] | null;
  plain: string | null;
}

export interface LoudnessResult {
  ok: boolean;
  /** Track gain in dB (negative = attenuate a loud master), or null when the file has no RG tags. */
  trackGainDb: number | null;
  albumGainDb: number | null;
  /** Sample peak as a linear ratio (~0..1), used to clamp positive gain so it never clips. */
  trackPeak: number | null;
  albumPeak: number | null;
  source: 'tag' | null;
}

export interface DjVibe {
  key: string;
  label: string;
  tracks: number;
}
export interface DjQueueTrack {
  id: number;
  title: string;
  artistName: string;
  path: string;
  durationMs: number | null;
  albumId?: string;
  albumTitle?: string;
  reason: string[];
}
export interface DjQueueResult {
  target: { label: string; mood?: string; style?: string };
  tracks: DjQueueTrack[];
}
export interface DjMoodsResult {
  moods: DjVibe[];
  styles: DjVibe[];
  classifiedTracks: number;
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

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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
  allAlbums: () => get<BrowseAlbum[]>('/api/albums'),
  search: (q: string) => get<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`),
  duplicates: () => get<DuplicatesResult>('/api/duplicates'),

  // ---- playlists ----
  playlists: () => get<PlaylistSummary[]>('/api/playlists'),
  createPlaylist: (name: string, rules?: SmartRules) =>
    post<{ ok: boolean; id: number }>('/api/playlists', { name, ...(rules ? { rules } : {}) }),
  updatePlaylistRules: (id: number, rules: SmartRules) =>
    post<{ ok: boolean }>('/api/playlists/rules', { id, rules }),
  renamePlaylist: (id: number, name: string) => post<{ ok: boolean }>('/api/playlists/rename', { id, name }),
  deletePlaylist: (id: number) => post<{ ok: boolean }>('/api/playlists/delete', { id }),
  playlist: (id: number) => get<PlaylistDetail>(`/api/playlist?id=${id}`),
  addToPlaylist: (b: { id: number; trackPath?: string; trackPaths?: string[]; albumId?: string }) =>
    post<{ ok: boolean; added: number }>('/api/playlist/add', b),
  removeFromPlaylist: (id: number, trackPath: string) =>
    post<{ ok: boolean }>('/api/playlist/remove', { id, trackPath }),
  artist: (name: string) => get<ArtistDetail>(`/api/artist/${encodeURIComponent(name)}`),
  album: (id: string) => get<AlbumDetail>(`/api/album/${encodeURIComponent(id)}`),
  coverUrl: (albumId: string) => `/api/cover?albumId=${encodeURIComponent(albumId)}`,
  lyrics: (path: string) => get<LyricsResult>(`/api/lyrics?path=${encodeURIComponent(path)}`),
  loudness: (path: string) => get<LoudnessResult>(`/api/loudness?path=${encodeURIComponent(path)}`),

  // ---- auto dj (mood/style radio) ----
  djMoods: () => get<DjMoodsResult>('/api/dj/moods'),
  djQueue: (b: { seedPath?: string; mood?: string; style?: string; artist?: string; exclude?: string[]; limit?: number }) =>
    post<DjQueueResult>('/api/dj/queue', b),

  // ---- controls ----
  presets: () => get<Record<string, Preset>>('/api/presets'),
  pickFolder: () => get<{ path: string }>('/api/pick-folder'),
  startScan: (source: string) => post<{ ok: boolean }>('/api/scan', { source }),
  scanStatus: () => get<ScanStatus>('/api/scan/status'),
  organizePlan: (b: { source: string; dest: string; preset: string }) =>
    post<PlanSummary>('/api/organize/plan', b),
  simulateSchemes: (source: string) => post<SimulateResult>('/api/organize/simulate', { source }),
  startOrganize: (b: { source: string; dest: string; preset: string; writeTags: boolean }) =>
    post<{ ok: boolean }>('/api/organize/run', b),
  organizeStatus: () => get<OrganizeStatus>('/api/organize/status'),
  cancelOrganize: () => post<{ ok: boolean }>('/api/organize/cancel', {}),

  // ---- sync profiles ----
  profiles: () => get<ProfileSummary[]>('/api/profiles'),
  createProfile: (b: { name: string; target?: string; preset?: string; transcodeTo?: string }) =>
    post<{ ok: boolean; id: number }>('/api/profiles', b),
  updateProfile: (b: { id: number; name?: string; target?: string; preset?: string; transcodeTo?: string }) =>
    post<{ ok: boolean }>('/api/profiles/update', b),
  deleteProfile: (id: number) => post<{ ok: boolean }>('/api/profiles/delete', { id }),
  profile: (id: number) => get<ProfileDetail>(`/api/profile?id=${id}`),
  addToProfile: (b: { id: number; albumId?: string; artist?: string }) =>
    post<{ ok: boolean; added: number }>('/api/profile/add', b),
  removeFromProfile: (b: { id: number; albumId: string }) =>
    post<{ ok: boolean }>('/api/profile/remove', b),
  syncProfile: (id: number) => post<{ ok: boolean; error?: string; job: SyncStatus }>('/api/profile/sync', { id }),
  syncStatus: () => get<SyncStatus>('/api/profile/sync/status'),
  cancelSync: () => post<{ ok: boolean }>('/api/profile/sync/cancel', {}),

  // ---- online refresh (metadata + cover) ----
  refreshAlbum: (albumId: string) => post<RefreshPreview>('/api/album/refresh', { albumId }),
  applyRefresh: (b: { albumId: string; title?: string; year?: number; cover?: boolean; mbid?: string }) =>
    post<{ ok: boolean }>('/api/album/refresh/apply', b),
  cancelRefresh: (albumId: string) => post<{ ok: boolean }>('/api/album/refresh/cancel', { albumId }),
  checkCompleteness: (albumId: string) => post<Completeness>('/api/album/completeness', { albumId }),
  pendingCoverUrl: (albumId: string) =>
    `/api/album/refresh/cover?albumId=${encodeURIComponent(albumId)}&pending=1`,
  refreshCandidates: () => get<{ missing: number; attempted: number; total: number }>('/api/refresh/candidates'),
  startRefreshBatch: (b: { onlyMissing?: boolean; force?: boolean; limit?: number }) =>
    post<{ ok: boolean; error?: string; job: RefreshBatchJob }>('/api/refresh/start', b),
  refreshBatchStatus: () => get<RefreshBatchJob>('/api/refresh/status'),
  cancelRefreshBatch: () => post<{ ok: boolean }>('/api/refresh/cancel', {}),
  applyRefreshBatch: (items: Array<{ albumId: string; title?: string; year?: number; cover?: boolean; mbid?: string }>) =>
    post<{ ok: boolean; applied: number }>('/api/refresh/apply-batch', { items }),

  // ---- global jobs view ----
  activeJobs: () => get<Array<{ type: string; phase: string; done: number; total: number }>>('/api/jobs/active'),
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

export function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
