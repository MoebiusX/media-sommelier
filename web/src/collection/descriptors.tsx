// Per-surface adapters: map a raw API item (albums, artists) into the descriptor the generic collection
// system consumes. Kept tiny and declarative — the only place that knows a BrowseAlbum from an ArtistSummary.
import { FlagBadges } from '../ui';
import { fmtBytes, fmtInt, type AlbumSummary, type ArtistSummary } from '../api';
import type { CollectionDescriptor, SortDef, ColumnDef, FacetDef } from './types';

/** Navigation targets these descriptors emit (a subset of LibraryView; App's navigate is a supertype). */
type NavTarget = { kind: 'album'; id: string; artistName?: string } | { kind: 'artist'; name: string };
type Navigate = (v: NavTarget) => void;

/** All-albums rows carry artistName+sizeBytes; an artist page's albums (AlbumSummary) omit them. */
type AlbumRow = AlbumSummary & { artistName?: string; sizeBytes?: number };

function initialOf(name: string): string {
  return name.replace(/^the\s+/i, '').trim().slice(0, 1).toUpperCase() || '?';
}
function decadeOf(year: number | null): string | null {
  return year ? `${Math.floor(year / 10) * 10}s` : null;
}
/** The decades an artist is active across (minYear..maxYear), for the "Active in" facet. */
function decadesSpanned(minY: number | null | undefined, maxY: number | null | undefined): string[] {
  if (minY == null || maxY == null) return [];
  const out: string[] = [];
  for (let d = Math.floor(minY / 10) * 10; d <= Math.floor(maxY / 10) * 10; d += 10) out.push(`${d}s`);
  return out;
}

export function albumsDescriptor(
  navigate: Navigate,
  opts: { viewKey: string; fallbackArtist?: string; hasArtist: boolean; hasSize: boolean },
): CollectionDescriptor<AlbumRow> {
  const artistOf = (a: AlbumRow) => a.artistName ?? opts.fallbackArtist ?? 'Unknown Artist';
  const sizeOf = (a: AlbumRow) => a.sizeBytes ?? 0;

  const sorts: SortDef<AlbumRow>[] = [
    ...(opts.hasArtist ? [{ key: 'artist', label: 'Artist', sortValue: artistOf }] : []),
    { key: 'title', label: 'Title', sortValue: (a) => a.title },
    { key: 'year', label: 'Newest', sortValue: (a) => a.year, defaultDir: 'desc' },
    { key: 'tracks', label: 'Most tracks', sortValue: (a) => a.trackCount, defaultDir: 'desc' },
    ...(opts.hasSize ? [{ key: 'size', label: 'Largest', sortValue: sizeOf, defaultDir: 'desc' as const }] : []),
  ];

  const columns: ColumnDef<AlbumRow>[] = [
    { key: 'title', label: 'Album', render: (a) => a.title, sortValue: (a) => a.title, primary: true },
    ...(opts.hasArtist
      ? [{ key: 'artist', label: 'Artist', render: artistOf, sortValue: artistOf }]
      : []),
    { key: 'year', label: 'Year', align: 'right', render: (a) => a.year ?? '—', sortValue: (a) => a.year },
    { key: 'tracks', label: 'Tracks', align: 'right', render: (a) => fmtInt(a.trackCount), sortValue: (a) => a.trackCount },
    ...(opts.hasSize
      ? [{ key: 'size', label: 'Size', align: 'right' as const, render: (a: AlbumRow) => fmtBytes(sizeOf(a)), sortValue: sizeOf, primary: false }]
      : []),
    { key: 'quality', label: 'Quality', render: (a) => (a.lossless ? 'FLAC' : '—'), sortValue: (a) => (a.lossless ? 1 : 0), primary: false },
  ];

  const facets: FacetDef<AlbumRow>[] = [
    { key: 'decade', label: 'Decade', values: (a) => decadeOf(a.year), pinned: true },
    { key: 'flags', label: 'Flags', values: (a) => a.flags },
    { key: 'quality', label: 'Quality', values: (a) => (a.lossless ? 'Lossless' : 'Lossy') },
  ];

  return {
    viewKey: opts.viewKey,
    searchPlaceholder: 'Filter albums…',
    countNoun: 'albums',
    layouts: ['grid', 'list', 'table'],
    sorts,
    facets,
    columns,
    id: (a) => a.id,
    searchText: (a) => `${a.title} ${a.artistName ?? ''}`,
    toDisplay: (a) => ({
      id: a.id,
      title: a.title,
      sub: (
        <>
          {opts.hasArtist ? <>{artistOf(a)} · </> : null}
          {a.year ?? '—'} · {fmtInt(a.trackCount)} tracks
        </>
      ),
      thumb: { albumId: a.id, title: a.title },
      badges: <FlagBadges flags={a.flags} lossless={a.lossless} discCount={a.discCount} />,
      onOpen: () => navigate({ kind: 'album', id: a.id, artistName: artistOf(a) }),
      selectable: true,
      bulk: { albumId: a.id },
    }),
  };
}

export function artistsDescriptor(navigate: Navigate): CollectionDescriptor<ArtistSummary> {
  const sorts: SortDef<ArtistSummary>[] = [
    { key: 'tracks', label: 'Most tracks', sortValue: (a) => a.trackCount, defaultDir: 'desc' },
    { key: 'name', label: 'Name', sortValue: (a) => a.name },
    { key: 'albums', label: 'Most albums', sortValue: (a) => a.albumCount, defaultDir: 'desc' },
    { key: 'size', label: 'Largest', sortValue: (a) => a.sizeBytes ?? 0, defaultDir: 'desc' },
  ];
  const columns: ColumnDef<ArtistSummary>[] = [
    { key: 'name', label: 'Artist', render: (a) => a.name, sortValue: (a) => a.name, primary: true },
    { key: 'genre', label: 'Genre', render: (a) => a.topGenre ?? '—', sortValue: (a) => a.topGenre ?? null, primary: false },
    { key: 'tracks', label: 'Tracks', align: 'right', render: (a) => fmtInt(a.trackCount), sortValue: (a) => a.trackCount },
    { key: 'albums', label: 'Albums', align: 'right', render: (a) => fmtInt(a.albumCount), sortValue: (a) => a.albumCount },
    { key: 'size', label: 'Size', align: 'right', render: (a) => fmtBytes(a.sizeBytes ?? 0), sortValue: (a) => a.sizeBytes ?? 0, primary: false },
  ];
  const facets: FacetDef<ArtistSummary>[] = [
    { key: 'genre', label: 'Genre', values: (a) => a.genres ?? [] },
    { key: 'format', label: 'Format', values: (a) => (a.formats ?? []).map((f) => f.toUpperCase()) },
    { key: 'quality', label: 'Quality', values: (a) => (a.anyLossless ? 'Has lossless' : 'Lossy only') },
    { key: 'decade', label: 'Active in', values: (a) => decadesSpanned(a.minYear, a.maxYear) },
  ];
  return {
    viewKey: 'artists',
    searchPlaceholder: 'Search artists…',
    countNoun: 'artists',
    layouts: ['list', 'table'],
    sorts,
    facets,
    columns,
    id: (a) => a.name,
    searchText: (a) => a.name,
    toDisplay: (a) => ({
      id: a.name,
      title: a.name,
      sub: (
        <>
          {fmtInt(a.trackCount)} tracks
          {a.albumCount > 0 ? ` · ${fmtInt(a.albumCount)} album${a.albumCount === 1 ? '' : 's'}` : ''}
        </>
      ),
      thumb: { initials: initialOf(a.name) },
      onOpen: () => navigate({ kind: 'artist', name: a.name }),
    }),
  };
}
