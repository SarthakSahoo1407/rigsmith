// The gear as 3D models, for render3d.ts. Units are the board's pixels; a model's face spans
// x 0..w, y 0..-h at z = 0 and its body goes toward -z, unless a builder says it's centred.
// Materials are the real ones: clear-coated paint, chrome, black plastic, tolex, tweed, brushed
// and hammered metal, paper cones. Textures are drawn once on small canvases.

import * as THREE from 'three';
import type { Shape } from './layout';
import type { Model } from './render3d';

const { Mesh, Group } = THREE;
type Mat = THREE.Material;

// ---- Textures ----
const textures = new Map<string, THREE.Texture>();
function canvasTexture(key: string, size: number, paint: (g: CanvasRenderingContext2D, s: number) => void, repeat: number, color = false) {
  let t = textures.get(key);
  if (!t) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    paint(c.getContext('2d')!, size);
    t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / repeat, 1 / repeat);
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    textures.set(key, t);
  }
  return t;
}
const rand = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const noise = (grain: number, seed: number) => (g: CanvasRenderingContext2D, s: number) => {
  const r = rand(seed);
  const img = g.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    const v = 128 + (r() - 0.5) * grain;
    img.data.set([v, v, v, 255], i * 4);
  }
  g.putImageData(img, 0, 0);
};
const TOLEX = () => canvasTexture('tolex', 128, noise(150, 7), 40);
const WRINKLE = () => canvasTexture('wrinkle', 128, (g, s) => {
  noise(60, 3)(g, s);
  const r = rand(11);
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(${r() > 0.5 ? 255 : 0},${r() > 0.5 ? 255 : 0},0,0.25)`;
    g.beginPath(); g.arc(r() * s, r() * s, 2 + r() * 5, 0, 7); g.fill();
  }
}, 60);
const HAMMER = () => canvasTexture('hammer', 256, (g, s) => {
  g.fillStyle = '#808080'; g.fillRect(0, 0, s, s);
  const r = rand(5);
  for (let i = 0; i < 900; i++) {
    const x = r() * s, y = r() * s, rad = 3 + r() * 9;
    const grd = g.createRadialGradient(x - rad / 3, y - rad / 3, 0, x, y, rad);
    grd.addColorStop(0, 'rgba(255,255,255,.35)'); grd.addColorStop(1, 'rgba(0,0,0,.25)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill();
  }
}, 110);
const BRUSHED = () => canvasTexture('brushed', 256, (g, s) => {
  g.fillStyle = '#7a7a7a'; g.fillRect(0, 0, s, s);
  const r = rand(9);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '0,0,0'},${0.05 + r() * 0.12})`;
    g.fillRect(r() * s, r() * s, 20 + r() * 120, 1);
  }
}, 120);
const TWEED = () => canvasTexture('tweed', 64, (g, s) => {
  g.fillStyle = '#c9a46a'; g.fillRect(0, 0, s, s);
  for (let i = -s; i < s * 2; i += 6) {
    g.strokeStyle = '#8f6a3c'; g.lineWidth = 2; g.beginPath(); g.moveTo(i, 0); g.lineTo(i + s, s); g.stroke();
    g.strokeStyle = '#e8cf98'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(i + 3, 0); g.lineTo(i + 3 + s, s); g.stroke();
  }
}, 22, true);
const RINGS = () => canvasTexture('rings', 64, (g, s) => {
  for (let y = 0; y < s; y++) { const v = 128 + Math.sin(y * 0.9) * 70; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, y, s, 1); }
}, 1);
const MESH = () => canvasTexture('mesh', 64, (g, s) => {
  g.fillStyle = '#d9dade'; g.fillRect(0, 0, s, s);
  g.fillStyle = '#202124';
  for (let y = 2; y < s; y += 5) for (let x = (y % 10) / 2 + 2; x < s; x += 5) { g.beginPath(); g.arc(x, y, 1.6, 0, 7); g.fill(); }
}, 18, true);
const cloth = (a: string, b: string) => canvasTexture(`cloth${a}${b}`, 32, (g, s) => {
  g.fillStyle = a; g.fillRect(0, 0, s, s);
  g.fillStyle = b;
  for (let y = 0; y < s; y += 4) for (let x = (y / 4) % 2 ? 0 : 2; x < s; x += 4) g.fillRect(x, y, 2, 2);
}, 10, true);

// ---- Materials ----
const paint = (color: string, flake = 0.15) =>
  new THREE.MeshPhysicalMaterial({ color, roughness: 0.38, metalness: flake, clearcoat: 1, clearcoatRoughness: 0.1 });
const chrome = () => new THREE.MeshStandardMaterial({ color: 0xe9eaec, metalness: 1, roughness: 0.12 });
const nickel = () => new THREE.MeshStandardMaterial({ color: 0xb9bbbf, metalness: 1, roughness: 0.3 });
const plastic = (color = '#121213', roughness = 0.42) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
const rubber = () => new THREE.MeshStandardMaterial({ color: 0x0d0d0e, roughness: 0.85 });
const tolex = (color: string) => color === 'tweed'
  ? new THREE.MeshStandardMaterial({ map: TWEED(), roughness: 0.82, bumpMap: TWEED(), bumpScale: 0.6 })
  : new THREE.MeshStandardMaterial({ color, roughness: 0.86, bumpMap: TOLEX(), bumpScale: 1.4 });
const brushed = (color: string) => new THREE.MeshStandardMaterial({ color, metalness: 1, roughness: 0.42, roughnessMap: BRUSHED(), bumpMap: BRUSHED(), bumpScale: 0.3 });

// ---- Shapes and solids ----
// A rounded rectangle, top-left at (x, y) in board coordinates (y down), as a three shape (y up).
function rrect(x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0.5, Math.min(r, w / 2, h / 2));
  const [l, t, rt, b] = [x, -y, x + w, -y - h];
  const s = new THREE.Shape();
  s.moveTo(l + r, t);
  s.lineTo(rt - r, t); s.quadraticCurveTo(rt, t, rt, t - r);
  s.lineTo(rt, b + r); s.quadraticCurveTo(rt, b, rt - r, b);
  s.lineTo(l + r, b); s.quadraticCurveTo(l, b, l, b + r);
  s.lineTo(l, t - r); s.quadraticCurveTo(l, t, l + r, t);
  return s;
}
function ellipse(x: number, y: number, w: number, h: number) {
  const s = new THREE.Shape();
  s.absellipse(x + w / 2, -y - h / 2, w / 2, h / 2, 0, Math.PI * 2, false, 0);
  return s;
}
// A solid with rounded corners and bevelled edges, face at z = 0, `depth` deep.
function slab(w: number, h: number, r: number, depth: number, bevel: number, mat: Mat, round = false) {
  const b = Math.min(bevel, depth / 2 - 0.5);
  const shape = round ? ellipse(b, b, w - 2 * b, h - 2 * b) : rrect(b, b, w - 2 * b, h - 2 * b, r - b);
  const g = new THREE.ExtrudeGeometry(shape, { depth: depth - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 5, curveSegments: 32 });
  g.translate(0, 0, -(depth - b));
  return new Mesh(g, mat);
}
// A cylinder along z, from z0 to z1, centred on (x, y) in board coordinates.
function cyl(x: number, y: number, r0: number, r1: number, z0: number, z1: number, mat: Mat, segs = 48) {
  const g = new THREE.CylinderGeometry(r1, r0, z1 - z0, segs);
  g.rotateX(Math.PI / 2);
  const m = new Mesh(g, mat);
  m.position.set(x, -y, (z0 + z1) / 2);
  return m;
}
// Knurled sides: alternate the radius around the axis.
function knurl(m: THREE.Mesh, ribs: number, depth: number) {
  const g = m.geometry.toNonIndexed();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), r = Math.hypot(x, y);
    if (r < 0.01) continue;
    const k = 1 + depth * (Math.cos(Math.atan2(y, x) * ribs) > 0 ? 1 : -1);
    p.setXY(i, x * k, y * k);
  }
  g.computeVertexNormals();
  m.geometry = g;
  return m;
}
// A turned part: profile points [radius, z], spun around z at (x, y).
function lathe(x: number, y: number, profile: [number, number][], mat: Mat, segs = 64) {
  const g = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), segs);
  g.rotateX(Math.PI / 2);
  const m = new Mesh(g, mat);
  m.position.set(x, -y, 0);
  return m;
}
const group = (...parts: THREE.Object3D[]) => { const g = new Group(); g.add(...parts); return g; };

// ---- Pedals ----
const PEDAL_DEPTH = 46;
export function pedalShell(shape: Shape, w: number, h: number, color: string, treadle = false): Model {
  const round = shape === 'round';
  const mat = treadle ? new THREE.MeshStandardMaterial({ color: '#1b1b1c', roughness: 0.7, bumpMap: WRINKLE(), bumpScale: 1.5 })
    : shape === 'hammered' ? new THREE.MeshStandardMaterial({ color: '#c3c7cc', metalness: 0.9, roughness: 0.3, bumpMap: HAMMER(), bumpScale: 2 })
    : paint(color);
  const body = slab(w, h, shape === 'compact' ? 12 : 9, treadle ? 58 : PEDAL_DEPTH, round ? 10 : 6, mat, round);
  // Jacks on the right side, where the light catches their nuts.
  const jacks = round ? [] : [0.22, 0.5].map((f) => {
    const g = new THREE.CylinderGeometry(7, 7, 5, 6);
    g.rotateZ(Math.PI / 2);
    const nut = new Mesh(g, nickel());
    nut.position.set(w + 1.5, -h * f, -PEDAL_DEPTH / 2);
    return nut;
  });
  return { group: group(body, ...jacks), view: 'floor' };
}

// A chrome stomp switch, centred on (0, 0).
export function footswitch(): Model {
  const nut = cyl(0, 0, 13, 13, 0, 4, chrome(), 6);
  const collar = cyl(0, 0, 9, 9, 4, 10, nickel());
  const cap = lathe(0, 0, [[0, 17], [6, 16.4], [9.5, 14.5], [10.5, 12], [10.5, 10]], chrome());
  return { group: group(nut, collar, cap), view: 'floor', scale: 3 };
}

// The amber jewel pilot lamp, centred, lit or not.
export function jewel(lit: boolean, view: 'floor' | 'stand' = 'stand'): Model {
  const bezel = cyl(0, 0, 9, 8.5, 0, 3, chrome());
  const g = new THREE.IcosahedronGeometry(6.5, 1);
  g.scale(1, 1, 0.7);
  const glass = new Mesh(g, new THREE.MeshPhysicalMaterial({
    color: lit ? '#ffb64a' : '#5a3a14', emissive: lit ? '#ff9a1f' : '#000000', emissiveIntensity: lit ? 1.6 : 0,
    roughness: 0.15, transmission: 0, flatShading: true, clearcoat: 1,
  }));
  glass.position.z = 3.5;
  return { group: group(bezel, glass), view, scale: 3 };
}

// ---- Knobs: a static body and a top that turns, both centred on (0, 0), skirt radius 14 ----
export type Finish = 'black' | 'chrome' | 'cream' | 'chicken' | 'gold';
const FINISH: Record<Finish, () => { body: Mat; top: Mat; mark: Mat; ribs: boolean }> = {
  black: () => ({ body: plastic('#141415', 0.5), top: plastic('#1b1b1d', 0.28), mark: plastic('#f2f2f2', 0.4), ribs: true }),
  chicken: () => ({ body: plastic('#141415', 0.5), top: plastic('#1b1b1d', 0.28), mark: plastic('#f2f2f2', 0.4), ribs: true }),
  chrome: () => ({ body: chrome(), top: chrome(), mark: plastic('#111'), ribs: false }),
  cream: () => ({ body: plastic('#e8dfc6', 0.45), top: plastic('#efe7d0', 0.3), mark: plastic('#1a1a1a'), ribs: true }),
  gold: () => ({ body: new THREE.MeshStandardMaterial({ color: '#d4b060', metalness: 1, roughness: 0.25 }),
    top: new THREE.MeshStandardMaterial({ color: '#e2c47a', metalness: 1, roughness: 0.18 }), mark: plastic('#111'), ribs: true }),
};
export function knobBody(finish: Finish, view: 'floor' | 'stand'): Model {
  const f = FINISH[finish]();
  const skirt = knurl(cyl(0, 0, 14, 13.6, 0, 3.5, plastic('#0d0d0e', 0.5), 96), 48, 0.018);
  const body = cyl(0, 0, 11, 10.4, 3.5, 12, f.body, 64);
  return { group: group(skirt, f.ribs ? knurl(body, 32, 0.035) : body), view, scale: 4 };
}
export function knobTop(finish: Finish, view: 'floor' | 'stand'): Model {
  const f = FINISH[finish]();
  const top = lathe(0, 0, [[0, 12.8], [9, 12.6], [10.4, 12]], f.top);
  const parts: THREE.Object3D[] = [top];
  if (finish === 'chicken') {
    const s = new THREE.Shape();
    s.moveTo(-4.4, -5); s.lineTo(-1.8, 14); s.quadraticCurveTo(0, 16, 1.8, 14); s.lineTo(4.4, -5); s.quadraticCurveTo(0, -8, -4.4, -5);
    const g = new THREE.ExtrudeGeometry(s, { depth: 3, bevelEnabled: true, bevelThickness: 1, bevelSize: 0.8, bevelSegments: 3 });
    g.translate(0, 0, 12.8);
    parts.push(new Mesh(g, plastic('#efe6cf', 0.35)));
  } else {
    const g = new THREE.BoxGeometry(1.7, 8, 0.6);
    const mark = new Mesh(g, f.mark);
    mark.position.set(0, 6.4, 13);
    parts.push(mark);
  }
  // An invisible ring keeps the image centred on the axis, so turning it turns the knob.
  const ring = new Mesh(new THREE.RingGeometry(16.5, 17, 8), new THREE.MeshBasicMaterial({ visible: false }));
  ring.position.z = 12.8;
  parts.push(ring);
  return { group: group(...parts), view, scale: 4 };
}

// ---- Amps and cabs: tolex boxes with chrome corners ----
const corner = (x: number, y: number, z: number) => {
  const m = new Mesh(new THREE.SphereGeometry(9, 24, 12), chrome());
  m.scale.set(1, 1, 0.8);
  m.position.set(x, y, z);
  return m;
};
function tolexBox(w: number, h: number, depth: number, cover: string, handle: boolean) {
  const parts: THREE.Object3D[] = [slab(w, h, 12, depth, 7, tolex(cover))];
  for (const [x, y] of [[4, -4], [w - 4, -4], [4, -h + 4], [w - 4, -h + 4]]) parts.push(corner(x, y, -3), corner(x, y, -depth + 3));
  if (handle) {
    const strap = slab(120, 26, 8, 12, 3, plastic('#141414', 0.6));
    strap.rotation.x = -Math.PI / 2;
    strap.position.set(w / 2 - 60, 6, -depth / 2 + 13);
    parts.push(strap);
    for (const x of [w / 2 - 66, w / 2 + 66]) {
      const cap = slab(14, 30, 4, 10, 2, chrome());
      cap.rotation.x = -Math.PI / 2;
      cap.position.set(x - 7, 3, -depth / 2 + 15);
      parts.push(cap);
    }
  }
  return parts;
}
const AMP_COVER = ['#18181a', 'tweed', '#18181a', '#18181a', '#18181a', '#18181a', '#151516', '#e2d7bd', '#5d6065'];
export const ampShell = (w: number, h: number, model: number): Model =>
  ({ group: group(...tolexBox(w, h, 150, AMP_COVER[model] ?? '#18181a', true)), view: 'stand' });
const CAB_COVER = ['#18181a', '#141415', 'tweed', '#18181a'];
export function cabShell(w: number, h: number, speaker: number): Model {
  const parts = tolexBox(w, h, 190, CAB_COVER[speaker] ?? '#18181a', false);
  // A recessed side handle on the right.
  const cup = slab(26, 70, 6, 4, 1.5, plastic('#0e0e0f', 0.5));
  cup.rotation.y = Math.PI / 2;
  cup.position.set(w + 1, -h / 2 + 35, -95 + 13);
  parts.push(cup);
  return { group: group(...parts), view: 'stand' };
}

// A speaker seen from the front, face spanning 0..2r: basket rim, surround, ribbed paper cone, dust cap.
const SPEAKER = [
  { cone: '#4a443c', cap: 'felt' }, { cone: '#38383a', cap: 'felt' }, { cone: '#7a6248', cap: 'alloy' }, { cone: '#5a5a5c', cap: 'alloy' },
];
export function speaker(r: number, kind: number): Model {
  const look = SPEAKER[kind] ?? SPEAKER[0];
  const paper = new THREE.MeshStandardMaterial({ color: look.cone, roughness: 0.9, bumpMap: RINGS(), bumpScale: 3 });
  RINGS().repeat.set(1, 7);
  const c = r;
  const rim = lathe(c, c, [[r * 0.93, -r * 0.02], [r * 0.95, 0], [r, 0], [r, -r * 0.05]], new THREE.MeshStandardMaterial({ color: '#3a3b3e', metalness: 0.8, roughness: 0.4 }), 96);
  const surround = new Mesh(new THREE.TorusGeometry(r * 0.9, r * 0.05, 16, 96), rubber());
  surround.position.set(c, -c, -r * 0.06);
  const cone = lathe(c, c, [[r * 0.31, -r * 0.36], [r * 0.5, -r * 0.24], [r * 0.7, -r * 0.13], [r * 0.86, -r * 0.07]], paper, 96);
  const dust = new Mesh(new THREE.SphereGeometry(r * 0.32, 48, 24), look.cap === 'felt'
    ? new THREE.MeshStandardMaterial({ color: '#2a2826', roughness: 0.95 }) : new THREE.MeshStandardMaterial({ color: '#c9cbce', metalness: 1, roughness: 0.3 }));
  dust.scale.set(1, 1, 0.42);
  dust.position.set(c, -c, -r * 0.36);
  const bolts = [0.125, 0.375, 0.625, 0.875].map((t) => cyl(c + Math.cos(t * 2 * Math.PI) * r * 0.955, c - Math.sin(t * 2 * Math.PI) * r * 0.955, r * 0.03, r * 0.03, 0, r * 0.02, chrome(), 12));
  return { group: group(rim, surround, cone, dust, ...bolts), view: 'front', scale: 2 };
}

// ---- Mics. On a cab: seen from behind, head at (0, 0) on the cone, body coming toward you ----
function micParts(model: number) {
  const parts: THREE.Object3D[] = [];
  const meshMat = new THREE.MeshStandardMaterial({ map: MESH(), metalness: 0.7, roughness: 0.35 });
  if (model === 1) { // ribbon: a bronze slotted box
    const bronze = new THREE.MeshStandardMaterial({ color: '#b48a52', metalness: 1, roughness: 0.32 });
    parts.push(slab(34, 40, 12, 26, 5, bronze));
    parts[0].position.set(-17, 20, 0);
    for (const y of [-12, -4, 4, 12]) { const slot = new Mesh(new THREE.BoxGeometry(24, 2, 1), plastic('#1c140b')); slot.position.set(0, y, 0.4); parts.push(slot); }
    parts.push(cyl(0, 0, 6, 7, 26, 92, bronze));
  } else if (model === 2) { // condenser: big mesh capsule, silver body, gold dot
    const head = new Mesh(new THREE.SphereGeometry(16, 48, 24), meshMat);
    head.scale.set(1, 1.2, 0.9);
    parts.push(head, cyl(0, 0, 12, 12.5, 12, 98, new THREE.MeshStandardMaterial({ color: '#d7d9dd', metalness: 1, roughness: 0.22 })));
  } else { // dynamic: slim grille, tapered black body, chrome tail
    parts.push(lathe(0, 0, [[0, -4], [5, -3.4], [7.4, 0], [7.6, 18]], meshMat), cyl(0, 0, 7.6, 8.6, 18, 21, nickel()),
      cyl(0, 0, 8.6, 10.6, 21, 98, plastic('#1d1e21', 0.35)));
  }
  parts.push(cyl(0, 0, 9.4, 9.4, 98, 112, nickel()));
  return parts;
}
export function micBehind(model: number): Model {
  const cable = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[0, 0, 110], [0, -4, 150], [6, -40, 175], [14, -90, 180]].map(([x, y, z]) => new THREE.Vector3(x, y, z))), 32, 3, 10);
  return { group: group(...micParts(model), new Mesh(cable, rubber())), view: 'behind', scale: 3 };
}
// Standing on a short stand, head up, for the gear list and a mic that isn't on a cab.
export function micStanding(model: number): Model {
  const mic = group(...micParts(model));
  mic.rotation.x = Math.PI / 2 + 0.25;
  const pole = cyl(0, 110, 2.5, 2.5, 0, 4, chrome());
  const stem = new Mesh(new THREE.CylinderGeometry(2.2, 2.2, 70, 16), chrome());
  stem.position.set(0, -140, -10);
  const base = new Mesh(new THREE.CylinderGeometry(26, 28, 6, 48), plastic('#18181a', 0.5));
  base.position.set(0, -176, -10);
  return { group: group(mic, pole, stem, base), view: 'stand', scale: 3 };
}

// ---- Desk gear ----
export const steelShell = (w: number, h: number): Model => {
  const screws = [[10, 10], [w - 10, 10], [10, h - 10], [w - 10, h - 10]].map(([x, y]) => lathe(x, y, [[0, 2.2], [3, 1.8], [4, 0]], chrome(), 24));
  return { group: group(slab(w, h, 10, 52, 5, brushed('#c9cacd')), ...screws), view: 'floor' };
};
export const darkBox = (w: number, h: number, depth: number): Model =>
  ({ group: group(slab(w, h, 10, depth, 5, new THREE.MeshStandardMaterial({ color: '#232427', metalness: 0.6, roughness: 0.45, bumpMap: BRUSHED(), bumpScale: 0.2 }))), view: 'floor' });

// ---- Product shots for the gear list and grid: the whole thing, small ----
export function pedalShot(shape: Shape, w: number, h: number, color: string, knobs: number, finish: Finish): Model {
  const m = pedalShell(shape, w, h, color);
  const g = m.group as THREE.Group;
  const k = Math.min(knobs, shape === 'wide' ? 4 : 3);
  for (let i = 0; i < k; i++) {
    const x = w / 2 + (i - (k - 1) / 2) * Math.min(46, (w - 40) / Math.max(1, k - 1 || 1));
    const knob = group(knobBody(finish, 'floor').group, knobTop(finish, 'floor').group);
    knob.position.set(x, -h * (shape === 'round' ? 0.3 : 0.2), 0);
    g.add(knob);
  }
  if (shape === 'compact') {
    const plate = slab(w - 12, 92, 6, 10, 3, paint(color));
    plate.position.set(6, -(h - 140), 10);
    g.add(plate);
  } else {
    const fs = footswitch().group;
    fs.position.set(w / 2, -h * 0.78, 0);
    g.add(fs);
  }
  return { group: g, view: 'floor', scale: 0.7 };
}
const AMP_THUMB = [
  { cloth: ['#bdbdbd', '#6f6f6f'], panel: '#1e1e20', top: true }, { cloth: ['#4a1f18', '#6a3328'], panel: '#c9c2b0', top: true },
  { cloth: ['#4e3420', '#c9a466'], panel: '#c98a55', top: true }, { cloth: ['#2b2925', '#8f877a'], panel: '#e6cd7c', top: false },
  { cloth: ['#141414', '#2e2e2e'], panel: '#e0c472', top: false }, { cloth: ['#121212', '#2a2a2a'], panel: '#c9cbcf', top: false },
  { cloth: ['#101010', '#262626'], panel: '#232325', top: false }, { cloth: ['#3a2a20', '#5a4535'], panel: '#efe6d2', top: false },
  { cloth: ['#161616', '#242424'], panel: '#d4d6d8', top: true },
];
export function ampShot(model: number, w = 540, h = 228): Model {
  const look = AMP_THUMB[model] ?? AMP_THUMB[6];
  const m = ampShell(w, h, model);
  const g = m.group as THREE.Group;
  const ph = 64, gh = h - 28 - ph;
  const grille = slab(w - 28, gh, 6, 3, 1, new THREE.MeshStandardMaterial({ map: cloth(look.cloth[0], look.cloth[1]), roughness: 0.95 }));
  const panel = slab(w - 28, ph, 4, 3, 1, look.panel === '#232325' ? brushed('#2a2a2d') : paint(look.panel, 0.5));
  grille.position.set(14, -(look.top ? 14 + ph : 14), 1.5);
  panel.position.set(14, -(look.top ? 14 : 14 + gh), 1.5);
  g.add(grille, panel);
  for (let i = 0; i < 6; i++) {
    const knob = group(knobBody('black', 'stand').group, knobTop('black', 'stand').group);
    knob.scale.setScalar(1.3);
    knob.position.set(130 + i * 56, -(look.top ? 14 + ph / 2 : 14 + gh + ph / 2), 1.5);
    g.add(knob);
  }
  return { group: g, view: 'stand', scale: 0.5 };
}
export function cabShot(speakerKind: number, w = 460, h = 340): Model {
  const m = cabShell(w, h, speakerKind);
  const g = m.group as THREE.Group;
  const look = [['#2b2925', '#8f877a'], ['#121212', '#2c2c2c'], ['#4a1f18', '#6a3328'], ['#bdbdbd', '#6f6f6f']][speakerKind] ?? ['#121212', '#2c2c2c'];
  const grille = slab(w - 44, h - 44, 6, 3, 1, new THREE.MeshStandardMaterial({ map: cloth(look[0], look[1]), roughness: 0.95 }));
  grille.position.set(22, -22, 1.5);
  g.add(grille);
  return { group: g, view: 'stand', scale: 0.5 };
}

// ---- The pedalboard: aluminium rails with velcro, end caps, on the floor ----
const VELCRO = () => canvasTexture('velcro', 64, noise(220, 13), 12);
export function pedalboard(w: number, h: number): Model {
  const parts: THREE.Object3D[] = [];
  const metal = new THREE.MeshStandardMaterial({ color: '#2a2b2e', metalness: 0.85, roughness: 0.42, bumpMap: BRUSHED(), bumpScale: 0.2 });
  for (const x of [0, w - 22]) parts.push(slab(22, h, 8, 70, 4, metal));
  const rail = 60, gap = 12;
  for (let y = 10; y + rail <= h - 6; y += rail + gap) {
    const r = slab(w - 40, rail, 4, 36, 3, metal);
    r.position.set(20, -y, -14);
    const strip = slab(w - 60, rail - 16, 2, 3, 1, new THREE.MeshStandardMaterial({ color: '#141415', roughness: 1, bumpMap: VELCRO(), bumpScale: 2 }));
    strip.position.set(30, -y - 8, -13);
    parts.push(r, strip);
  }
  return { group: group(...parts), view: 'floor', scale: 1 };
}
