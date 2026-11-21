// Gear renders: every piece of gear is modelled in three.js (models.ts), lit once by a warm key
// light and a room reflection, and drawn to an image. The board shows those images with the live
// controls (knobs, switches, labels) on top, so dragging and cabling stay plain DOM.
//
// The camera is oblique: the face of a thing (a pedal's top, an amp's front) lands on screen at
// exactly its size, unskewed, and its body recedes down and right (pedals on the floor) or up and
// right (amps and cabs standing on the stage). That keeps the face aligned with the controls laid
// over it, while the sides, edges and depth show.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { useEffect, useSyncExternalStore } from 'react';

export type View = 'floor' | 'stand' | 'front' | 'behind';
// Screen offset per unit of depth into the object: x right, y down.
// front: nearly head-on (speakers in their baffle); behind: looking past a mic into the cab.
const SHEAR: Record<View, [number, number]> = { floor: [0.18, 0.42], stand: [0.2, -0.34], front: [0.05, -0.08], behind: [0.12, -0.85] };

// A model's face spans x 0..w, y 0..-h (three is y-up) at z = 0; its body goes toward -z.
export type Model = { group: THREE.Object3D; view: View; scale?: number };
// Where the image sits, in model units, relative to the face's top-left corner (y down).
export type Sprite = { url: string; x: number; y: number; w: number; h: number };

let renderer: THREE.WebGLRenderer | null | undefined;
let env: THREE.Texture;
function setup() {
  if (renderer !== undefined) return renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  } catch {
    renderer = null; // no WebGL: gear keeps its flat drawing
  }
  return renderer;
}

function draw({ group, view, scale = 2 }: Model): Sprite | null {
  const r = setup();
  if (!r) return null;
  const [kx, ky] = SHEAR[view];
  const scene = new THREE.Scene();
  scene.environment = env;
  scene.environmentIntensity = 0.55;
  // One warm key light from the top left, a cool fill from the right, a little light from below
  // the camera so fronts don't go black.
  const key = new THREE.DirectionalLight(0xfff0dc, 2.6);
  key.position.set(-0.7, view === 'floor' ? 0.9 : 1.1, view === 'behind' ? 0.4 : 1.2);
  const fill = new THREE.DirectionalLight(0xdbe6ff, 0.5);
  fill.position.set(1, -0.2, 0.8);
  scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.15), group);
  group.updateMatrixWorld(true);
  // Metals ask for more of the room than the scene's dim default (models.ts shiny).
  group.traverse((o) => {
    for (const mat of [(o as THREE.Mesh).material].flat()) {
      const m = mat as THREE.MeshStandardMaterial | undefined;
      if (m?.userData?.env) { m.envMap = env; m.envMapIntensity = m.userData.env; }
    }
  });

  // Screen bounds of the sheared model: x' = x - z kx, y'(down) = -y - z ky.
  const box = new THREE.Box3().setFromObject(group);
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const sx = x - z * kx, sy = -y - z * ky;
    [x0, y0, x1, y1] = [Math.min(x0, sx), Math.min(y0, sy), Math.max(x1, sx), Math.max(y1, sy)];
  }
  const pad = 2;
  [x0, y0, x1, y1] = [Math.floor(x0 - pad), Math.floor(y0 - pad), Math.ceil(x1 + pad), Math.ceil(y1 + pad)];
  const k = Math.min(scale, 2048 / Math.max(x1 - x0, y1 - y0));
  const w = Math.round((x1 - x0) * k), h = Math.round((y1 - y0) * k);
  if (w < 1 || h < 1) return null;

  const D = 2000; // camera distance
  const cam = new THREE.OrthographicCamera(x0, x1, -y0, -y1, 1, 4 * D);
  cam.position.set(0, 0, D);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  // Oblique projection: shear camera-space x and y by depth (camera-space z = z - D).
  const shear = new THREE.Matrix4().set(1, 0, -kx, -kx * D, 0, 1, ky, ky * D, 0, 0, 1, 0, 0, 0, 0, 1);
  cam.projectionMatrix.multiply(shear);
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

  r.setSize(w, h, false);
  r.setClearColor(0x000000, 0);
  r.render(scene, cam);
  const url = r.domElement.toDataURL('image/png');
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    for (const mat of [m.material].flat()) if (mat) (mat as THREE.Material).dispose();
  });
  return { url, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---- Cache and queue: renders run one per frame so the UI never stalls ----
const cache = new Map<string, Sprite | null>();
const queue = new Map<string, () => Model>();
const subs = new Set<() => void>();
let version = 0;
let pumping = false;
function pump() {
  if (pumping) return;
  pumping = true;
  requestAnimationFrame(function step() {
    const start = performance.now();
    while (queue.size && performance.now() - start < 12) {
      const [key, make] = queue.entries().next().value!;
      queue.delete(key);
      let s: Sprite | null = null;
      try { s = draw(make()); } catch (e) { console.warn('render failed', key, e); }
      cache.set(key, s);
      version++;
    }
    subs.forEach((f) => f());
    if (queue.size) requestAnimationFrame(step); else pumping = false;
  });
}
const subscribe = (f: () => void) => { subs.add(f); return () => subs.delete(f); };

// The image of a model, rendered on first use. Undefined until it's ready (or without WebGL).
export function useSprite(key: string | null, make: () => Model): Sprite | undefined {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (key && !cache.has(key) && !queue.has(key)) { queue.set(key, make); pump(); }
  }, [key]);
  return (key && cache.get(key)) || undefined;
}

// CSS that places a sprite over a face of `w` x `h` model units drawn at `w` x `h` pixels, or in
// percent of that face when `relative`.
export const spriteStyle = (s: Sprite, face?: { w: number; h: number }) => face
  ? { left: `${(s.x / face.w) * 100}%`, top: `${(s.y / face.h) * 100}%`, width: `${(s.w / face.w) * 100}%`, height: `${(s.h / face.h) * 100}%` }
  : { left: s.x, top: s.y, width: s.w, height: s.h };
