/**
 * Scenes, Adobe Animate style: reanims (and particle effects / images) are
 * prefabs placed on a stage as layers. Each layer has keyframes with a
 * transform, tint and visibility that are tweened, plus which of the prefab's
 * animations to play from that key (like Animate's graphic-symbol looping
 * options).
 */

import { Curve, warpTime } from '../formats/floatTrack';
import { DEG, type Mat } from '../engine/math';
import { DocumentBase, EASES, nextUid, type Ease, type SoundCue } from './reanimDoc';

/**
 * Text layers keep their font id (FONT_*) in `source` and their words in each key.
 * A scene has at most one camera layer: its keys place the camera's frame in the world.
 */
export type LayerKind = 'reanim' | 'particle' | 'image' | 'text' | 'camera';

/** How an instance plays its prefab animation (Animate: Loop / Play once / Single frame). */
export type InstanceLoop = 'loop' | 'once' | 'single';

export const INSTANCE_LOOPS: { id: InstanceLoop; label: string }[] = [
  { id: 'loop', label: 'Loop' },
  { id: 'once', label: 'Play once (hold last frame)' },
  { id: 'single', label: 'Single frame' },
];

/** One-click camera moves, made from the camera's pose at the playhead. */
export type CameraPreset = 'static' | 'pushIn' | 'pullOut' | 'panLeft' | 'panRight' | 'tilt' | 'shake' | 'reset';

export const CAMERA_PRESETS: { id: CameraPreset; label: string; title: string }[] = [
  { id: 'static', label: 'Static', title: 'Hold the camera still from this key until the next one' },
  { id: 'pushIn', label: 'Push in', title: 'Zoom in 1.5× over one second' },
  { id: 'pullOut', label: 'Pull out', title: 'Zoom out 1.5× over one second' },
  { id: 'panLeft', label: '← Pan', title: 'Pan left by half the view over one second' },
  { id: 'panRight', label: 'Pan →', title: 'Pan right by half the view over one second' },
  { id: 'tilt', label: 'Tilt 10°', title: 'Turn the camera 10° over one second' },
  { id: 'shake', label: 'Shake', title: 'Shake hard, settling over half a second' },
  { id: 'reset', label: 'Reset', title: 'Frame the whole stage again: no zoom, turn, shake, follow, filter or fade' },
];

export interface LayerKey {
  frame: number;
  x: number;
  y: number;
  /** Degrees, clockwise. */
  rotation: number;
  scaleX: number;
  scaleY: number;
  alpha: number;
  flipX: boolean;
  visible: boolean;
  /** Color multiply, 0..1 per channel. */
  tint: [number, number, number];
  /** Tween from this key to the next. */
  ease: Ease;
  /** Reanim layers: anim_ track to play ('' = every frame). */
  anim: string;
  loop: InstanceLoop;
  speed: number;
  /** Frame offset into the animation (the shown frame for 'single'). */
  startFrame: number;
  /** Restart the animation / effect at this key even if nothing else changed. */
  restart: boolean;
  /** Text layers: the words shown from this key on (they change at keys, never tween). */
  text: string;
  /** Camera: shake amplitude in stage pixels (tweened). */
  shake: number;
  /** Camera: uid of the layer it follows (x/y are then an offset from it); 0 = none. */
  follow: number;
}

export interface SceneLayer {
  uid: number;
  name: string;
  kind: LayerKind;
  /** Reanim path, particle effect path, or image id. */
  source: string;
  /** Sorted by frame; never empty. */
  keys: LayerKey[];
  /** Random seed for a particle layer's simulation, saved so effects look the same after reloading. */
  seed?: number;
}

export interface SceneState {
  width: number;
  height: number;
  /** CSS hex color. */
  background: string;
  /** Image id or path stretched over the stage ('' = none). */
  backgroundImage: string;
  fps: number;
  length: number;
  /** Bottom to top. */
  layers: SceneLayer[];
  soundCues: SoundCue[];
}

export interface LayerPose {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  alpha: number;
  flipX: boolean;
  visible: boolean;
  tint: [number, number, number];
  shake: number;
  /** The key governing discrete settings (anim, loop…). */
  key: LayerKey;
  keyIndex: number;
  /** Frame at which the current animation / effect run started. */
  segmentStart: number;
}

export const TWEENED_PROPS = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'alpha', 'shake'] as const;

const EASE_CURVE = new Map(EASES.map((e) => [e.id, e.curve]));

export function defaultKey(frame: number, patch: Partial<LayerKey> = {}): LayerKey {
  return {
    frame,
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    alpha: 1,
    flipX: false,
    visible: true,
    tint: [1, 1, 1],
    ease: 'linear',
    anim: '',
    loop: 'loop',
    speed: 1,
    startFrame: 0,
    restart: false,
    text: '',
    shake: 0,
    follow: 0,
    ...patch,
  };
}

export function cloneKey(k: LayerKey): LayerKey {
  return { ...k, tint: [...k.tint] as [number, number, number] };
}

export function cloneLayer(l: SceneLayer): SceneLayer {
  return { ...l, keys: l.keys.map(cloneKey) };
}

export function cloneSceneState(s: SceneState): SceneState {
  return { ...s, layers: s.layers.map(cloneLayer), soundCues: s.soundCues.map((c) => ({ ...c })) };
}

/** Index of the last key at or before `frame`, or -1. */
export function keyIndexAt(layer: SceneLayer, frame: number): number {
  let idx = -1;
  for (let i = 0; i < layer.keys.length; i++) {
    if (layer.keys[i].frame <= frame) idx = i;
    else break;
  }
  return idx;
}

/** Settings that, when changed at a key, restart the instance's animation or effect. */
function sameRun(a: LayerKey, b: LayerKey): boolean {
  return a.anim === b.anim && a.loop === b.loop && a.speed === b.speed && a.startFrame === b.startFrame && a.visible === b.visible;
}

/** How far (eased, 0..1) a frame is from key `k` towards `next`; 0 when they do not tween. */
function tweenFraction(k: LayerKey, next: LayerKey | undefined, frame: number): number {
  // Like Animate, a blank (hidden) keyframe ends the tween instead of being tweened towards.
  if (!next || !next.visible || k.ease === 'hold' || next.frame <= k.frame || frame <= k.frame) return 0;
  return warpTime((frame - k.frame) / (next.frame - k.frame), EASE_CURVE.get(k.ease) ?? Curve.Linear);
}

/**
 * Evaluate a layer at a (possibly fractional) frame. Returns null before the
 * layer's first key, where the layer does not exist yet. Pass the scene for a camera
 * layer whose keys follow another layer (x/y then tween through the world).
 */
export function evalLayer(layer: SceneLayer, frame: number, scene?: SceneState): LayerPose | null {
  const i = keyIndexAt(layer, frame);
  if (i < 0) return null;
  const k = layer.keys[i];
  const next = layer.keys[i + 1];
  const pose: LayerPose = {
    x: k.x,
    y: k.y,
    rotation: k.rotation,
    scaleX: k.scaleX,
    scaleY: k.scaleY,
    alpha: k.alpha,
    flipX: k.flipX,
    visible: k.visible,
    tint: [...k.tint] as [number, number, number],
    shake: k.shake ?? 0,
    key: k,
    keyIndex: i,
    segmentStart: k.frame,
  };
  const t = tweenFraction(k, next, frame);
  if (t > 0 && next) {
    for (const p of TWEENED_PROPS) pose[p] = k[p] + (next[p] - k[p]) * t;
    for (let c = 0; c < 3; c++) pose.tint[c] = k.tint[c] + (next.tint[c] - k.tint[c]) * t;
  }
  if (scene && layer.kind === 'camera' && (k.follow || next?.follow)) {
    // A following camera key's x/y are an offset from the target. Tween between where each
    // key puts the camera in the world (so starting or stopping to follow pans smoothly),
    // and give x/y as an offset from what this frame's key follows.
    const at = (key: LayerKey): [number, number] => {
      const tp = followTarget(scene, key, frame);
      return tp ? [key.x + tp.x, key.y + tp.y] : [key.x, key.y];
    };
    let [x, y] = at(k);
    if (t > 0 && next) {
      const b = at(next);
      x += (b[0] - x) * t;
      y += (b[1] - y) * t;
    }
    const own = followTarget(scene, k, frame);
    pose.x = x - (own?.x ?? 0);
    pose.y = y - (own?.y ?? 0);
  }
  let j = i;
  while (j > 0 && !layer.keys[j].restart && sameRun(layer.keys[j - 1], layer.keys[j])) j--;
  pose.segmentStart = layer.keys[j].frame;
  return pose;
}

/** Stage-space matrix of a layer: translate, rotate, then scale (flip mirrors around the origin). */
export function poseMatrix(p: { x: number; y: number; rotation: number; scaleX: number; scaleY: number; flipX: boolean }): Mat {
  const r = p.rotation * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const sx = p.scaleX * (p.flipX ? -1 : 1);
  const sy = p.scaleY;
  return [c * sx, s * sx, -s * sy, c * sy, p.x, p.y];
}

/**
 * Shift a layer's keys at or after `at` by `count` frames. Removing frames works like
 * Animate's Remove Frames: spans get shorter. The key in force at the end of the removed
 * span carries on from where the span began, unless the next key starts right there.
 */
function shiftKeys(l: SceneLayer, at: number, count: number, length: number): void {
  if (count < 0) {
    const end = at - count;
    const inSpan = l.keys.filter((k) => k.frame >= at && k.frame < end);
    const kept = l.keys.filter((k) => k.frame < at || k.frame >= end);
    const carry = inSpan[inSpan.length - 1];
    if (carry && !kept.some((k) => k.frame === end)) {
      carry.frame = end;
      kept.push(carry);
      kept.sort((a, b) => a.frame - b.frame);
    }
    l.keys = kept;
  }
  for (const k of l.keys) if (k.frame >= at) k.frame = Math.max(0, k.frame + count);
  // Keys pushed past a shorter end: keep the last of them on the last frame.
  const past = l.keys.filter((k) => k.frame > length - 1);
  if (past.length) {
    const inside = l.keys.filter((k) => k.frame <= length - 1);
    const last = past[past.length - 1];
    if (!inside.some((k) => k.frame === length - 1)) {
      last.frame = length - 1;
      inside.push(last);
    }
    l.keys = inside.length ? inside : [last];
  }
}

// ---------------------------------------------------------------- camera

/** Where the camera looks at a frame, after following and shaking. */
export interface CameraState {
  /** Centre of the view, in stage (world) coordinates. */
  x: number;
  y: number;
  /** Degrees the view is turned (the world appears turned the other way). */
  rotation: number;
  /** 2 = everything twice as big. */
  zoom: number;
  /** Colour filter multiplied into everything. */
  tint: [number, number, number];
  /** 0 = clear, 1 = faded to black. */
  fade: number;
}

export function cameraLayer(scene: SceneState): SceneLayer | undefined {
  return scene.layers.find((l) => l.kind === 'camera');
}

/**
 * The camera at a (possibly fractional) frame, or null when the scene has no camera or
 * it is switched off (a blank keyframe): then the stage shows the world as it is.
 * The camera layer's pose is its frame in the world: x/y the centre, rotation the turn,
 * scale the frame size (so zoom = 1 / scale).
 */
export function evalCamera(scene: SceneState, frame: number): CameraState | null {
  const layer = cameraLayer(scene);
  const pose = layer && evalLayer(layer, frame, scene);
  if (!pose || !pose.visible) return null;
  let { x, y } = pose;
  const tp = followTarget(scene, pose.key, frame);
  if (tp) {
    x += tp.x;
    y += tp.y;
  }
  if (pose.shake > 0) {
    // Smooth, deterministic wobble: a few sines at unrelated rates.
    const t = frame / Math.max(1, scene.fps);
    const w = (a: number, b: number, p: number, q: number) => 0.6 * Math.sin(2 * Math.PI * a * t + p) + 0.4 * Math.sin(2 * Math.PI * b * t + q);
    x += pose.shake * w(7.3, 12.9, 0, 1.7);
    y += pose.shake * w(8.1, 13.7, 0.5, 2.9);
  }
  return { x, y, rotation: pose.rotation, zoom: 1 / Math.max(1e-3, Math.abs(pose.scaleX)), tint: [...pose.tint] as [number, number, number], fade: 1 - Math.max(0, Math.min(1, pose.alpha)) };
}

/** Pose of the layer a camera key follows, or null when it follows nothing (or the layer is not there). */
function followTarget(scene: SceneState, key: LayerKey, frame: number): LayerPose | null {
  if (!key.follow) return null;
  const target = scene.layers.find((l) => l.uid === key.follow && l.kind !== 'camera');
  return (target && evalLayer(target, frame)) ?? null;
}

/** World -> stage matrix for a camera: its centre lands mid-stage, turned and zoomed. */
export function cameraMatrix(scene: { width: number; height: number }, cam: CameraState): Mat {
  const r = -cam.rotation * DEG;
  const c = Math.cos(r) * cam.zoom;
  const s = Math.sin(r) * cam.zoom;
  // T(w/2, h/2) * R(-rotation) * S(zoom) * T(-x, -y)
  return [c, s, -s, c, scene.width / 2 - (c * cam.x - s * cam.y), scene.height / 2 - (s * cam.x + c * cam.y)];
}

/** The camera's frame in the world, in coordinates centred on the frame (for drawing and dragging it). */
export function cameraFrameMatrix(cam: CameraState): Mat {
  return poseMatrix({ x: cam.x, y: cam.y, rotation: cam.rotation, scaleX: 1 / cam.zoom, scaleY: 1 / cam.zoom, flipX: false });
}

export interface SceneUiState {
  layer: number;
  frame: number;
  frameEnd: number;
  cue: { kind: 'sound'; uid: number } | null;
  hidden: Set<number>;
  locked: Set<number>;
  loopPlayback: boolean;
  /** Look at the stage through the camera (on) or see the whole world with the camera's frame (off). */
  cameraView: boolean;
}

export class SceneDocument extends DocumentBase<SceneState> {
  readonly kind = 'scene' as const;
  ui: SceneUiState = { layer: -1, frame: 0, frameEnd: 0, cue: null, hidden: new Set(), locked: new Set(), loopPlayback: true, cameraView: true };
  /** Bumped on every change (particle previews and caches key on it). */
  revision = 0;

  static create(name: string, width = 800, height = 600): SceneDocument {
    const doc = new SceneDocument(
      name,
      `scenes/${name}`,
      { width, height, background: '#4d8a2b', backgroundImage: '', fps: 30, length: 90, layers: [], soundCues: [] },
      true,
    );
    return doc;
  }

  static fromState(name: string, state: SceneState): SceneDocument {
    return new SceneDocument(name, `scenes/${name}`, state, true);
  }

  /** Which layer was selected when each undo snapshot was taken, so undo/redo can reselect it. */
  private selectionOf = new WeakMap<SceneState, number>();

  protected snapshot(): SceneState {
    const copy = cloneSceneState(this.state);
    const uid = this.selectedLayer?.uid;
    if (uid !== undefined) this.selectionOf.set(copy, uid);
    return copy;
  }

  protected afterRestore(): void {
    this.revision++;
    const uid = this.selectionOf.get(this.state);
    if (uid !== undefined) {
      // The restored snapshot becomes the live state; forget its selection so later edits don't reapply it.
      this.selectionOf.delete(this.state);
      const i = this.state.layers.findIndex((l) => l.uid === uid);
      if (i >= 0) this.ui.layer = i;
    }
    if (this.ui.layer >= this.state.layers.length) this.ui.layer = this.state.layers.length - 1;
    if (this.ui.frame >= this.state.length) this.ui.frame = this.ui.frameEnd = this.state.length - 1;
    if (this.ui.cue && !this.state.soundCues.some((c) => c.uid === this.ui.cue!.uid)) this.ui.cue = null;
  }

  get frameCount(): number {
    return this.state.length;
  }

  get fps(): number {
    return this.state.fps;
  }

  get selectedLayer(): SceneLayer | undefined {
    return this.state.layers[this.ui.layer];
  }

  /** Whether a layer is locked against edits in the editor. */
  isLocked(layerIndex: number): boolean {
    const layer = this.state.layers[layerIndex];
    return !!layer && this.ui.locked.has(layer.uid);
  }

  /** Record an undo step and mark the scene changed. */
  edit(label: string, fn: (s: SceneState) => void): void {
    this.checkpoint(label);
    fn(this.state);
    this.revision++;
  }

  /** Mutate without a new undo step (continuation of a drag that already checkpointed). */
  touch(fn: (s: SceneState) => void): void {
    fn(this.state);
    this.revision++;
  }

  uniqueLayerName(base: string): string {
    const names = new Set(this.state.layers.map((l) => l.name.toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    // "Shooter 2" duplicates to "Shooter 3", not "Shooter 2 2".
    base = base.replace(/ \d+$/, '');
    let i = 2;
    while (names.has(`${base} ${i}`.toLowerCase())) i++;
    return `${base} ${i}`;
  }

  /**
   * Add the scene's camera (one per scene), framing the whole stage, as the top layer.
   * Returns its layer index (the existing one if there is already a camera).
   */
  addCamera(frame = 0): number {
    const existing = this.state.layers.findIndex((l) => l.kind === 'camera');
    if (existing >= 0) return existing;
    const uid = nextUid();
    const key = defaultKey(Math.max(0, frame), { x: this.state.width / 2, y: this.state.height / 2, ease: 'easeInOut' });
    this.edit('Add camera', (s) => s.layers.push({ uid, name: 'Camera', kind: 'camera', source: '', keys: [key] }));
    return this.state.layers.length - 1;
  }

  addLayer(kind: LayerKind, source: string, name: string, key: Partial<LayerKey>, frame = this.ui.frame): number {
    const uid = nextUid();
    const layer: SceneLayer = { uid, name: this.uniqueLayerName(name), kind, source, keys: [defaultKey(frame, key)], seed: uid };
    this.edit('Add layer', (s) => s.layers.push(layer));
    return this.state.layers.length - 1;
  }

  removeLayer(index: number): void {
    if (!this.state.layers[index]) return;
    this.edit('Delete layer', (s) => {
      const uid = s.layers[index].uid;
      // A camera that followed the layer stays where it was looking.
      for (const k of cameraLayer(s)?.keys ?? []) {
        if (k.follow !== uid) continue;
        const tp = followTarget(s, k, k.frame);
        k.x += tp?.x ?? 0;
        k.y += tp?.y ?? 0;
        k.follow = 0;
      }
      s.layers.splice(index, 1);
    });
    if (this.ui.layer >= this.state.layers.length) this.ui.layer = this.state.layers.length - 1;
  }

  duplicateLayer(index: number): number {
    const src = this.state.layers[index];
    if (!src || src.kind === 'camera') return index;
    const copy = cloneLayer(src);
    copy.uid = nextUid();
    copy.seed = copy.uid;
    copy.name = this.uniqueLayerName(src.name);
    for (const k of copy.keys) {
      k.x += 20;
      k.y += 20;
    }
    this.edit('Duplicate layer', (s) => s.layers.splice(index + 1, 0, copy));
    return index + 1;
  }

  moveLayer(from: number, to: number): void {
    const layers = this.state.layers;
    if (from === to || !layers[from] || to < 0 || to >= layers.length) return;
    this.edit('Reorder layers', (s) => {
      const [l] = s.layers.splice(from, 1);
      s.layers.splice(to, 0, l);
    });
    if (this.ui.layer === from) this.ui.layer = to;
  }

  /** Pose-derived key for a frame (used when creating a key between existing ones). */
  keyFromPose(layer: SceneLayer, frame: number): LayerKey {
    const pose = evalLayer(layer, frame, this.state);
    const base = pose ? cloneKey(pose.key) : cloneKey(layer.keys[0]);
    if (pose) {
      for (const p of TWEENED_PROPS) base[p] = pose[p];
      base.tint = [...pose.tint] as [number, number, number];
    }
    base.frame = frame;
    base.restart = false;
    return base;
  }

  /** Make sure a key exists at `frame` and return its index (no undo step). */
  ensureKey(layerIndex: number, frame: number): number {
    const layer = this.state.layers[layerIndex];
    let i = layer.keys.findIndex((k) => k.frame === frame);
    if (i >= 0) return i;
    const key = this.keyFromPose(layer, frame);
    i = layer.keys.findIndex((k) => k.frame > frame);
    if (i < 0) i = layer.keys.length;
    layer.keys.splice(i, 0, key);
    return i;
  }

  /** Set key properties at a frame (creating the key, Animate "auto keyframe" style). */
  setKey(layerIndex: number, frame: number, patch: Partial<LayerKey>, label?: string): void {
    if (!this.state.layers[layerIndex]) return;
    const apply = () => {
      const i = this.ensureKey(layerIndex, frame);
      Object.assign(this.state.layers[layerIndex].keys[i], patch, { frame });
    };
    if (label) this.edit(label, apply);
    else this.touch(apply);
  }

  /**
   * Remove the key at `frame`. The first key is where the layer starts and holds its
   * animation settings, so it is never removed (move it instead); returns false then.
   */
  removeKey(layerIndex: number, frame: number): boolean {
    const layer = this.state.layers[layerIndex];
    if (!layer) return false;
    const i = layer.keys.findIndex((k) => k.frame === frame);
    if (i <= 0) return false;
    this.edit('Remove keyframe', (s) => s.layers[layerIndex].keys.splice(i, 1));
    return true;
  }

  toggleKey(layerIndex: number, frame: number): boolean {
    const layer = this.state.layers[layerIndex];
    if (!layer) return false;
    if (layer.keys.some((k) => k.frame === frame)) return this.removeKey(layerIndex, frame);
    this.edit('Add keyframe', () => this.ensureKey(layerIndex, frame));
    return true;
  }

  moveKey(layerIndex: number, from: number, to: number): boolean {
    const layer = this.state.layers[layerIndex];
    if (!layer || from === to || to < 0 || to >= this.state.length) return false;
    const i = layer.keys.findIndex((k) => k.frame === from);
    if (i < 0 || layer.keys.some((k) => k.frame === to)) return false;
    this.edit('Move keyframe', (s) => {
      const keys = s.layers[layerIndex].keys;
      keys[i].frame = to;
      keys.sort((a, b) => a.frame - b.frame);
    });
    return true;
  }

  setEase(layerIndex: number, frame: number, ease: Ease): void {
    const layer = this.state.layers[layerIndex];
    if (!layer) return;
    const i = keyIndexAt(layer, frame);
    if (i < 0) return;
    this.edit('Set easing', (s) => (s.layers[layerIndex].keys[i].ease = ease));
  }

  /**
   * Make the camera follow a layer (uid) or stop following (0) from `frame` on: this key
   * and the later ones keep their place in the world, re-expressed as offsets.
   */
  setCameraFollow(layerIndex: number, frame: number, follow: number): void {
    const layer = this.state.layers[layerIndex];
    if (!layer || layer.kind !== 'camera') return;
    if (follow && !this.state.layers.some((l) => l.uid === follow && l.kind !== 'camera')) return;
    this.edit(follow ? 'Follow layer' : 'Stop following', (s) => {
      const keys = s.layers[layerIndex].keys;
      const from = this.ensureKey(layerIndex, frame);
      // Where each key puts the camera in the world, before changing any of them.
      const world = keys.map((k) => {
        const tp = followTarget(s, k, k.frame);
        return [k.x + (tp?.x ?? 0), k.y + (tp?.y ?? 0)];
      });
      for (let i = from; i < keys.length; i++) {
        const k = keys[i];
        k.follow = follow;
        const tp = followTarget(s, k, k.frame);
        k.x = Math.round((world[i][0] - (tp?.x ?? 0)) * 100) / 100;
        k.y = Math.round((world[i][1] - (tp?.y ?? 0)) * 100) / 100;
      }
    });
  }

  /** Apply a camera preset at `frame` (one undo step). The scene grows if the move runs past its end. */
  cameraPreset(layerIndex: number, frame: number, preset: CameraPreset): boolean {
    const layer = this.state.layers[layerIndex];
    const pose = layer?.kind === 'camera' ? evalLayer(layer, frame, this.state) : null;
    if (!pose) return false;
    const sec = Math.max(1, Math.round(this.state.fps));
    const label = CAMERA_PRESETS.find((p) => p.id === preset)?.label ?? preset;
    this.edit(`Camera: ${label}`, (s) => {
      const at = (f: number, patch: Partial<LayerKey>) => {
        if (f >= s.length) s.length = f + 1;
        const i = this.ensureKey(layerIndex, f);
        Object.assign(s.layers[layerIndex].keys[i], patch, { frame: f });
      };
      const move = (patch: Partial<LayerKey>) => {
        at(frame, { ease: pose.key.ease === 'hold' || pose.key.ease === 'linear' ? 'easeInOut' : pose.key.ease });
        at(frame + sec, patch);
      };
      const r = pose.rotation * DEG;
      const pan = (s.width / 2) * pose.scaleX;
      switch (preset) {
        case 'static':
          at(frame, { ease: 'hold' });
          break;
        case 'pushIn':
          move({ scaleX: pose.scaleX / 1.5, scaleY: pose.scaleY / 1.5 });
          break;
        case 'pullOut':
          move({ scaleX: pose.scaleX * 1.5, scaleY: pose.scaleY * 1.5 });
          break;
        case 'panLeft':
        case 'panRight': {
          const d = preset === 'panLeft' ? -pan : pan;
          move({ x: Math.round(pose.x + Math.cos(r) * d), y: Math.round(pose.y + Math.sin(r) * d) });
          break;
        }
        case 'tilt':
          move({ rotation: pose.rotation + 10 });
          break;
        case 'shake': {
          // Start at full strength: stop the previous key tweening the shake up to it.
          const keys = s.layers[layerIndex].keys;
          const prev = keyIndexAt(s.layers[layerIndex], frame - 1);
          if (frame > 0 && prev >= 0 && keys[prev].frame < frame - 1 && keys[prev].ease !== 'hold') at(frame - 1, {});
          at(frame, { shake: 12, ease: 'easeOut' });
          at(frame + Math.max(1, Math.round(sec / 2)), { shake: 0 });
          break;
        }
        case 'reset':
          at(frame, { x: s.width / 2, y: s.height / 2, rotation: 0, scaleX: 1, scaleY: 1, shake: 0, follow: 0, tint: [1, 1, 1], alpha: 1, visible: true });
          break;
      }
    });
    return true;
  }

  /** Change the scene length. Keys and sound cues past a new, shorter end are trimmed (undoable); returns how many. */
  setLength(length: number): { keys: number; cues: number } {
    length = Math.max(1, Math.round(length));
    const dropped = { keys: 0, cues: 0 };
    if (length === this.state.length) return dropped;
    this.edit('Change scene length', (s) => {
      s.length = length;
      for (const l of s.layers) {
        const kept = l.keys.filter((k) => k.frame < length);
        if (!kept.length) {
          // The layer starts after the new end: keep it, starting on the last frame.
          const first = l.keys[0];
          first.frame = length - 1;
          kept.push(first);
        }
        dropped.keys += l.keys.length - kept.length;
        l.keys = kept;
      }
      const cues = s.soundCues.filter((c) => c.frame < length);
      dropped.cues = s.soundCues.length - cues.length;
      s.soundCues = cues;
    });
    if (this.ui.frame >= length) this.ui.frame = this.ui.frameEnd = length - 1;
    return dropped;
  }

  /** Insert or remove frames at `at` on every layer and the sound cues, changing the scene length. */
  shiftFrames(at: number, count: number): void {
    if (count === 0) return;
    this.edit(count > 0 ? 'Insert frames (all layers)' : 'Remove frames (all layers)', (s) => {
      s.length = Math.max(1, s.length + count);
      for (const l of s.layers) shiftKeys(l, at, count, s.length);
      if (count < 0) s.soundCues = s.soundCues.filter((c) => c.frame < at || c.frame >= at - count);
      for (const c of s.soundCues) if (c.frame >= at) c.frame = Math.max(0, c.frame + count);
    });
    if (this.ui.frame >= this.state.length) this.ui.frame = this.ui.frameEnd = this.state.length - 1;
  }

  /**
   * Animate F5 / Shift+F5 on one layer: insert or remove frames at `at` in that layer
   * only. Inserting lengthens the scene so the layer's later keys keep their place.
   */
  shiftLayerFrames(layerIndex: number, at: number, count: number): void {
    if (count === 0 || !this.state.layers[layerIndex]) return;
    this.edit(count > 0 ? 'Insert frames' : 'Remove frames', (s) => {
      if (count > 0) s.length += count;
      shiftKeys(s.layers[layerIndex], at, count, s.length);
    });
  }

  addSoundCue(frame: number, sound: string, volume = 1): SoundCue {
    const cue = { uid: nextUid(), frame, sound, volume };
    this.edit('Add sound cue', (s) => s.soundCues.push(cue));
    return cue;
  }

  updateSoundCue(uid: number, patch: Partial<SoundCue>, label = 'Edit sound cue'): void {
    this.edit(label, (s) => {
      const c = s.soundCues.find((x) => x.uid === uid);
      if (c) Object.assign(c, patch);
    });
  }

  removeSoundCue(uid: number): void {
    this.edit('Delete sound cue', (s) => (s.soundCues = s.soundCues.filter((c) => c.uid !== uid)));
    if (this.ui.cue?.uid === uid) this.ui.cue = null;
  }
}
