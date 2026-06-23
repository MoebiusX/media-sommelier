// Audio settings popover (anchored above the player bar): EQ presets, night/room mode, output device.
// Everything drives the Web Audio graph owned by PlayerProvider — see player.tsx.
import { useEffect } from 'react';
import { usePlayer, EQ_PRESETS, type EqPreset } from './player';

export default function AudioSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = usePlayer();

  // Re-enumerate output devices whenever the picker opens (labels can appear after a permission grant).
  useEffect(() => {
    if (open) void p.refreshOutputs();
  }, [open, p]);

  if (!open) return null;
  const presets = Object.keys(EQ_PRESETS) as EqPreset[];

  return (
    <div className="audio-pop" role="dialog" aria-label="Audio settings">
      <div className="audio-head">
        <span>Audio</span>
        <button className="queue-x" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="audio-sec">
        <div className="audio-label">Equalizer</div>
        <div className="audio-chips">
          {presets.map((k) => (
            <button
              key={k}
              className={'audio-chip' + (p.eqPreset === k ? ' on' : '')}
              onClick={() => p.setEqPreset(k)}
            >
              {EQ_PRESETS[k].label}
            </button>
          ))}
        </div>
      </div>

      <div className="audio-sec">
        <label className="audio-toggle">
          <input
            type="checkbox"
            checked={p.nightMode}
            onChange={(e) => p.setNightMode(e.currentTarget.checked)}
          />
          <span>Night / room mode</span>
        </label>
        <div className="audio-hint">Lifts quiet passages so vocals carry across a room.</div>
      </div>

      {p.canPickOutput && (
        <div className="audio-sec">
          <div className="audio-label">Output device</div>
          <select
            className="audio-select"
            value={p.outputId}
            onChange={(e) => void p.setOutputId(e.currentTarget.value)}
          >
            <option value="default">System default</option>
            {p.outputs
              .filter((o) => o.id && o.id !== 'default')
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
          </select>
        </div>
      )}
    </div>
  );
}
