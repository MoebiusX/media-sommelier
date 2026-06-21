import { useState } from 'react';
import { api } from './api';

/** Inline stroke icons (no dependency). */
export function Icon({ name, className }: { name: 'overview' | 'library' | 'chevron'; className?: string }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
  };
  if (name === 'overview') {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </svg>
    );
  }
  if (name === 'library') {
    return (
      <svg {...common}>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** Album cover with embedded-art fetch + graceful initials fallback. */
export function Cover({ albumId, title }: { albumId: string; title: string }) {
  const [failed, setFailed] = useState(false);
  const initials = title
    .replace(/[\[\(].*$/, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <div className="cover">
      {failed ? (
        <div className="cover-fallback">{initials || '♪'}</div>
      ) : (
        <img src={api.coverUrl(albumId)} alt="" loading="lazy" onError={() => setFailed(true)} />
      )}
    </div>
  );
}

const FLAG_META: Record<string, { label: string; cls: string }> = {
  'needs-review': { label: 'needs review', cls: 'review' },
  needsReview: { label: 'needs review', cls: 'review' },
  'no-track-numbers': { label: 'no track #s', cls: 'review' },
  'possible-compilation': { label: 'compilation', cls: '' },
  'multi-folder-merge': { label: 'multi-folder', cls: 'multi' },
  multiDisc: { label: 'multi-disc', cls: 'multi' },
  orphan: { label: 'orphan', cls: 'review' },
};

/** Render the engine's album flags as friendly badges. */
export function FlagBadges({
  flags,
  lossless,
  discCount,
}: {
  flags: string[];
  lossless?: boolean;
  discCount?: number;
}) {
  const badges: Array<{ label: string; cls: string }> = [];
  if (lossless) badges.push({ label: 'FLAC', cls: 'flac' });
  if (discCount && discCount > 1) badges.push({ label: `${discCount} discs`, cls: 'multi' });
  for (const f of flags) {
    const m = FLAG_META[f];
    if (m) badges.push(m);
  }
  if (badges.length === 0) return null;
  return (
    <div className="flags">
      {badges.map((b, i) => (
        <span key={i} className={'badge ' + b.cls}>
          {b.label}
        </span>
      ))}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="center">
      <div>
        <div className="spinner" />
        <div className="muted">{label}</div>
      </div>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="center">
      <div>
        <div style={{ fontSize: 22, marginBottom: 8 }}>Couldn’t load this view</div>
        <div className="muted">{message}</div>
      </div>
    </div>
  );
}
