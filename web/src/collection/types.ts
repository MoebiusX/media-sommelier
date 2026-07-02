// Shared vocabulary for the reusable "collection view" system. A CollectionDescriptor<T> is the seam that
// lets one toolbar + three renderers drive any heterogeneous list (artists, albums, tracks, …): renderers
// only ever see the normalized DisplayItem / ColumnDef the descriptor produces, never the raw T.
import type { ReactNode } from 'react';
import type { PlayerTrack } from '../player';

export type LayoutMode = 'list' | 'grid' | 'table';
export type Density = 'comfortable' | 'compact';
export type SortDir = 'asc' | 'desc';

export interface SortDef<T> {
  key: string;
  label: string;
  sortValue: (item: T) => string | number | null;
  defaultDir?: SortDir;
}

export interface ColumnDef<T> {
  key: string;
  label: string;
  render: (item: T) => ReactNode;
  /** Omit to make the column non-sortable. When present, clicking the header sorts by this. */
  sortValue?: (item: T) => string | number | null;
  align?: 'left' | 'right';
  /** Kept visible in compact density; non-primary columns hide first when space is tight. */
  primary?: boolean;
}

/** A facet is a categorical filter. `values` may bucket a continuous field (year → "2000s", size → tier). */
export interface FacetDef<T> {
  key: string;
  label: string;
  /** Value(s) present on the item; an array marks a multi-valued field (e.g. album flags). null/'' = absent. */
  values: (item: T) => Array<string | null> | string | null;
  /** Optional fixed display order for this facet's values (else sorted by count desc). */
  order?: string[];
  /** Render as an inline single-select chip strip (like the old decade chips) instead of in the popover. */
  pinned?: boolean;
}

export interface CoverRef {
  albumId: string;
  title: string;
}
export interface InitialsRef {
  initials: string;
}
export type Thumb = CoverRef | InitialsRef;

export function isCoverRef(t: Thumb | undefined): t is CoverRef {
  return !!t && 'albumId' in t;
}

/** The renderer-facing shape every collection item is mapped to. */
export interface DisplayItem {
  id: string;
  title: string;
  sub?: ReactNode;
  thumb?: Thumb;
  badges?: ReactNode;
  onOpen: () => void;
  /** When present, a ▶ affordance plays the resolved queue. */
  playable?: { resolve: () => Promise<PlayerTrack[]> | PlayerTrack[] };
  /** When true, the item shows a selection checkbox. */
  selectable?: boolean;
  /** Handles the bulk actions can target (album add-to-playlist/profile, track paths). */
  bulk?: { albumId?: string; artist?: string; trackPaths?: string[] };
}

export interface CollectionDescriptor<T> {
  /** localStorage/hash namespace for this view's preferences, e.g. 'artists' | 'albums' | 'artist:R.E.M.'. */
  viewKey: string;
  searchPlaceholder: string;
  /** Plural noun for the "Showing X of Y <noun>" count line, e.g. 'albums'. */
  countNoun: string;
  layouts: LayoutMode[];
  sorts: SortDef<T>[];
  facets: FacetDef<T>[];
  columns: ColumnDef<T>[];
  searchText: (item: T) => string;
  /** Cheap stable id (react key + selection id) — must equal toDisplay(item).id. */
  id: (item: T) => string;
  /** Maps a raw item to its renderer-facing shape. */
  toDisplay: (item: T) => DisplayItem;
}

export interface ActiveFilters {
  /** facetKey → selected values (OR within a facet, AND across facets). */
  enums: Record<string, string[]>;
}

export interface ViewPrefs {
  sort: string;
  dir: SortDir;
  layout: LayoutMode;
  density: Density;
  /** grid cover min width in px (drives --cover-min). */
  coverSize: number;
  /** search text — kept in memory / the URL hash, never written to localStorage. */
  q: string;
  filters: ActiveFilters;
}

/** Build the default prefs for a descriptor (first sort + first layout). */
export function defaultPrefs<T>(desc: CollectionDescriptor<T>): ViewPrefs {
  const first = desc.sorts[0];
  return {
    sort: first?.key ?? '',
    dir: first?.defaultDir ?? 'asc',
    layout: desc.layouts[0] ?? 'list',
    density: 'comfortable',
    coverSize: 168,
    q: '',
    filters: { enums: {} },
  };
}
