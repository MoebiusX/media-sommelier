// "Reconstruct by metadata" simulation. Groups the indexed catalog by embedded album tags (not folders)
// and surfaces the "integrated" albums — releases that folders had scattered, made whole from tags.
import { useState } from 'react';
import { api, fmtInt, type MetadataReconResult } from './api';

export default function MetadataSim() {
  const [data, setData] = useState<MetadataReconResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setErr(null);
    try {
      setData(await api.reconstructMetadata());
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }

  const s = data?.stats;
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-title">
        Reconstruct by metadata <span className="muted">group your indexed library by embedded album tags</span>
      </div>
      <p className="page-lede" style={{ margin: '0 0 14px' }}>
        Folder reconstruction groups by where files <em>live</em>. This groups by what their tags <em>say</em> —
        pulling songs that share an album tag into one album, even when they’re scattered across folders.
      </p>
      <button className="btn primary" onClick={() => void run()} disabled={loading}>
        {loading ? 'Analyzing catalog…' : 'Simulate metadata grouping'}
      </button>

      {err && <div className="err-text" style={{ marginTop: 12 }}>{err}</div>}

      {data && s && (
        <div style={{ marginTop: 18 }}>
          {s.albums === 0 ? (
            <div className="empty">No indexed tracks yet — scan a library first (Library tab), then re-run.</div>
          ) : (
            <>
              <div className="scheme-verdict">
                <b>
                  Metadata grouping finds {fmtInt(s.albums)} albums — {fmtInt(s.integratedAlbums)} of them integrate{' '}
                  {fmtInt(s.integratedTracks)} tracks scattered across multiple folders.
                </b>{' '}
                <span className="muted">Folder reconstruction produced {fmtInt(data.folderAlbums)} albums.</span>
              </div>

              <div className="chips" style={{ marginTop: 12 }}>
                <span className="chip"><span className="fmt">Albums</span><span className="ct">{fmtInt(s.albums)}</span></span>
                <span className="chip"><span className="fmt">Multi-track</span><span className="ct">{fmtInt(s.multiTrackAlbums)}</span></span>
                <span className="chip"><span className="fmt">Integrated</span><span className="ct">{fmtInt(s.integratedAlbums)}</span></span>
                <span className="chip"><span className="fmt">Tracks recovered</span><span className="ct">{fmtInt(s.integratedTracks)}</span></span>
                <span className="chip"><span className="fmt">Untagged</span><span className="ct">{fmtInt(s.untaggedTracks)}</span></span>
              </div>

              {data.integrated.length > 0 ? (
                <>
                  <div className="list-count" style={{ marginTop: 16 }}>
                    {data.integratedTotal > data.integrated.length
                      ? `Top ${fmtInt(data.integrated.length)} of ${fmtInt(data.integratedTotal)} integrated albums`
                      : `${fmtInt(data.integratedTotal)} integrated albums`}{' '}
                    — each pulled from multiple folders
                  </div>
                  <div className="meta-albums">
                    {data.integrated.map((a) => (
                      <div className="meta-album" key={a.key}>
                        <div className="meta-album-head">
                          <div className="meta-album-name" title={a.album}>
                            {a.album}
                          </div>
                          <div className="meta-album-by">
                            {a.artist}
                            {a.year ? ` · ${a.year}` : ''}
                          </div>
                        </div>
                        <div className="meta-album-facts">
                          <span>{fmtInt(a.trackCount)} tracks</span>
                          {a.discCount > 1 && (
                            <>
                              <span className="dotsep">·</span>
                              <span>{a.discCount} discs</span>
                            </>
                          )}
                          <span className="dotsep">·</span>
                          <span className="meta-from">from {a.folderCount} folders</span>
                        </div>
                        <div className="meta-folders">
                          {a.folders.map((f, i) => (
                            <span className="meta-folder" key={i} title={f}>
                              {f || '—'}
                            </span>
                          ))}
                          {a.folderCount > a.folders.length && (
                            <span className="meta-folder more">+{a.folderCount - a.folders.length} more</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="empty" style={{ marginTop: 14 }}>
                  No cross-folder albums found — your tags and folders already agree. (Every album’s tracks live
                  together.)
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
