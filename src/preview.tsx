// Dev only (preview.html): the gear of a preset laid out on the board at 1:1, to look at it in a browser.
// ?preset=Name picks the preset; ?zoom=1 scales it.
import './previewStub';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './app.css';
import { GearDefs, Gear } from './gear';
import { gearSize, isPedal, layoutBoard } from './layout';
import { PRESETS } from './presets';

const q = new URLSearchParams(location.search);
const rig = PRESETS[q.get('preset') ?? 'Shred lead'].build();
const lay = layoutBoard(rig);
const zoom = Number(q.get('zoom') ?? 1);
const kind = q.get('kind'); // pedals | amps
const shown = Object.values(rig.devices).filter((d) => lay.pos[d.id] && (kind === 'pedals' ? isPedal(d) : kind === 'amps' ? ['amp', 'namAmp', 'namRig', 'cab'].includes(d.type) : true));
const x0 = Math.min(...shown.map((d) => lay.pos[d.id].x)), y0 = Math.min(...shown.map((d) => lay.pos[d.id].y));
createRoot(document.getElementById('root')!).render(
  <div style={{ position: 'relative', transform: `scale(${zoom})`, transformOrigin: '0 0', padding: 40 }}>
    <GearDefs />
    {shown.map((d) => {
      const s = gearSize(d), p = lay.pos[d.id];
      return (
        <div key={d.id} className="device board" style={{ position: 'absolute', left: p.x - x0, top: p.y - y0, width: s.w, height: s.h, zIndex: ['amp', 'namAmp', 'namRig'].includes(d.type) ? 1 : 0 }}>
          <Gear d={d} rig={rig} edit={() => {}} inputs={[]} live={{}} />
        </div>
      );
    })}
  </div>,
);
