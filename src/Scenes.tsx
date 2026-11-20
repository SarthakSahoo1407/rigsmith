// The scene strip: one button per scene (A to H), the active one lit by its pilot lamp. Click to
// switch, double-click to rename, + to add one copied from what's playing now.

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { addScene, MAX_SCENES, removeScene, renameScene, selectScene, type Rig } from './rig';
import type { Edit } from './gear';

export function SceneStrip({ rig, edit }: { rig: Rig; edit: Edit }) {
  const [naming, setNaming] = useState<number>();
  const sc = rig.scenes;
  return (
    <div className="scene-strip" role="toolbar" aria-label="Scenes">
      <span className="strip-label">Scenes</span>
      {!sc && <span className="strip-hint">Snapshots of which pedals are on and chosen knobs, switched without a gap</span>}
      {sc?.list.map((s, i) => naming === i ? (
        <form key={i} onSubmit={(e) => { e.preventDefault(); setNaming(undefined); }}>
          <input className="scene-name" autoFocus defaultValue={s.name} aria-label="Scene name" maxLength={24}
            onBlur={(e) => { edit((r) => renameScene(r, i, e.target.value.trim() || s.name)); setNaming(undefined); }}
            onKeyDown={(e) => e.key === 'Escape' && setNaming(undefined)} />
        </form>
      ) : (
        <button key={i} className={`scene${sc.active === i ? ' on' : ''}`} aria-pressed={sc.active === i}
          title={`${s.name} (⇧${i + 1}). Double-click to rename`}
          onClick={() => edit((r) => selectScene(r, i))} onDoubleClick={() => setNaming(i)}>
          <i className="lamp" /><kbd>{String.fromCharCode(65 + i)}</kbd>{s.name}
          {sc.active === i && (
            <span className="scene-remove" role="button" tabIndex={-1} aria-label={`Remove ${s.name}`}
              onClick={(e) => { e.stopPropagation(); edit((r) => removeScene(r, i)); }}><X size={12} strokeWidth={1.5} /></span>
          )}
        </button>
      ))}
      {(sc?.list.length ?? 0) < MAX_SCENES && (
        <button className="text-button" onClick={() => edit((r) => addScene(r))} title="Add a scene from what's playing now">
          <Plus size={16} strokeWidth={1.5} />{sc ? 'Scene' : 'Add scenes'}
        </button>
      )}
    </div>
  );
}
