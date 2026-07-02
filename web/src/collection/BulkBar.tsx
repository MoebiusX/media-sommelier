// Actions on a multi-selection: add selected albums to a playlist/profile, or play/enqueue selected tracks.
// Reuses the existing endpoints (api.addToPlaylist/addToProfile accept albumId or trackPaths[]) so nothing
// new touches the read-only source. Shown by CollectionView only while a selection exists.
import { useState } from 'react';
import { api, fmtInt } from '../api';
import { usePlayer } from '../player';
import PickerMenu from './PickerMenu';
import type { DisplayItem } from './types';

export interface SelectedInfo {
  id: string;
  title: string;
  bulk?: DisplayItem['bulk'];
  playable?: DisplayItem['playable'];
}

export default function BulkBar({ items, onClear }: { items: SelectedInfo[]; onClear: () => void }) {
  const player = usePlayer();
  const [msg, setMsg] = useState<string | null>(null);
  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2500);
  };

  const albumIds = items.map((i) => i.bulk?.albumId).filter((x): x is string => !!x);
  const trackPaths = items.flatMap((i) => i.bulk?.trackPaths ?? []);

  const addAlbumsToPlaylist = async (id: number, name: string) => {
    for (const albumId of albumIds) await api.addToPlaylist({ id, albumId });
    flash(`Added ${fmtInt(albumIds.length)} to ${name}`);
    onClear();
  };
  const addAlbumsToProfile = async (id: number, name: string) => {
    for (const albumId of albumIds) await api.addToProfile({ id, albumId });
    flash(`Added ${fmtInt(albumIds.length)} to ${name}`);
    onClear();
  };
  const addTracksToPlaylist = async (id: number, name: string) => {
    await api.addToPlaylist({ id, trackPaths });
    flash(`Added ${fmtInt(trackPaths.length)} to ${name}`);
    onClear();
  };
  const playSelected = async () => {
    const queues = await Promise.all(items.filter((i) => i.playable).map((i) => i.playable!.resolve()));
    const q = queues.flat();
    if (q.length) player.playQueue(q, 0);
    onClear();
  };

  const loadPlaylists = () =>
    api.playlists().then((ps) => ps.map((p) => ({ id: p.id, name: p.name, sub: `${fmtInt(p.trackCount)}` })));
  const loadProfiles = () =>
    api.profiles().then((ps) => ps.map((p) => ({ id: p.id, name: p.name, sub: `${fmtInt(p.albumCount)} albums` })));

  return (
    <div className="bulk-bar">
      <span className="bulk-count">{fmtInt(items.length)} selected</span>

      {albumIds.length > 0 && (
        <>
          <PickerMenu label="Add to playlist" load={loadPlaylists} onPick={addAlbumsToPlaylist} onCreate={(n) => api.createPlaylist(n)} emptyText="No playlists yet" />
          <PickerMenu label="Add to profile" load={loadProfiles} onPick={addAlbumsToProfile} onCreate={(n) => api.createProfile({ name: n })} emptyText="No profiles yet" />
        </>
      )}

      {trackPaths.length > 0 && (
        <>
          <button className="btn ghost" onClick={() => void playSelected()}>
            ▶ Play
          </button>
          <PickerMenu label="Add to playlist" load={loadPlaylists} onPick={addTracksToPlaylist} onCreate={(n) => api.createPlaylist(n)} emptyText="No playlists yet" />
        </>
      )}

      {msg && <span className="ok-text bulk-msg">{msg}</span>}
      <button className="btn ghost bulk-clear" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
