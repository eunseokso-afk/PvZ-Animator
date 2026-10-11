/**
 * Editable reanim document.
 *
 * Reanim data is "baked": every track stores a transform for every frame.
 * The editor layers keyframes on top: frames flagged as keys are authored,
 * all others are tweens recomputed from the surrounding keys. Imported files
 * start with every frame as a key; "simplify" detects tweens.
 *
 * Undo uses copy-on-write snapshots: a checkpoint stores shallow copies, and
 * the first edit of a track after a checkpoint clones that track.
 */

import { Curve, warpTime } from '../formats/floatTrack';
import {
  DEFAULT_TRANSFORM,
  frameCountOf,
  getAnimRanges,
  isAnimTrackName,
  isRangeTrack,
  NUMERIC_FIELDS,
  type AnimRange,
  type ReanimDefinition,
  type ReanimTransform,
} from '../formats/reanim';
import type { LoopMode } from '../engine/reanimRuntime';

export type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold';

export const EASES: { id: Ease; label: string; curve: Curve }[] = [
  { id: 'linear', label: 'Linear', curve: Curve.Linear },
  { id: 'easeIn', label: 'Ease in', curve: Curve.EaseIn },
  { id: 'easeOut', label: 'Ease out', curve: Curve.EaseOut },
  { id: 'easeInOut', label: 'Ease in-out', curve: Curve.EaseInOutWeak },
  { id: 'hold', label: 'Hold (no tween)', curve: Curve.Constant },
];

const EASE_CURVE = new Map(EASES.map((e) => [e.id, e.curve]));

export interface EditorTrack {
  uid: number;
  name: string;
  transforms: ReanimTransform[];
  keys: boolean[];
  ease: Ease[];
}

export interface SoundCue {
  uid: number;
  frame: number;
  /** VFS path or SOUND_ id. */
  sound: string;
  volume: number;
}

export interface ParticleCue {
  uid: number;
  frame: number;
  /** VFS path of a particle definition. */
  particle: string;
  /** Track to follow (empty = fixed position). */
  track: string;
  x: number;
  y: number;
}

export interface ReanimState {
  fps: number;
  tracks: EditorTrack[];
  soundCues: SoundCue[];
  particleCues: ParticleCue[];
}

export interface ViewState {
  panX: number;
  panY: number;
  zoom: number;
  fitted: boolean;
}

let uidCounter = 1;
export const nextUid = () => uidCounter++;
let versionCounter = 1;
let docCounter = 1;

/** Name of the hidden track used to embed editor cues into exported reanims. */
export const CUE_TRACK_NAME = '_pvzanim_cues';

interface Snapshot<S> {
  state: S;
  version: number;
  label: string;
}

export abstract class DocumentBase<S> {
  readonly id = docCounter++;
  abstract readonly kind: 'reanim' | 'particle' | 'scene';
  name: string;
  /** Where the file lives in the game folder (e.g. reanim/Foo.reanim). */
  path: string;
  state: S;
  version = versionCounter++;
  savedVersion: number;
  /** True for documents that do not exist in the pak yet. */
  isNew: boolean;
  view: ViewState = { panX: 0, panY: 0, zoom: 1, fitted: false };
  protected undoStack: Snapshot<S>[] = [];
  protected redoStack: Snapshot<S>[] = [];

  constructor(name: string, path: string, state: S, isNew: boolean) {
    this.name = name;
    this.path = path;
    this.state = state;
    this.isNew = isNew;
    this.savedVersion = isNew ? -1 : this.version;
  }

  get dirty(): boolean {
    return this.version !== this.savedVersion;
  }

  markSaved(): void {
    this.savedVersion = this.version;
  }

  protected abstract snapshot(): S;
  protected abstract afterRestore(): void;

  /** Record an undo step before mutating. */
  checkpoint(label: string): void {
    this.undoStack.push({ state: this.snapshot(), version: this.version, label });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.version = versionCounter++;
    this.afterRestore();
  }

  /** Record a change that is not part of the undo history (e.g. a rename), so the document counts as edited. */
  touchVersion(): void {
    this.version = versionCounter++;
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }

  get redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }

  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push({ state: this.snapshot(), version: this.version, label: s.label });
    this.state = s.state;
    this.version = s.version;
    this.afterRestore();
    return true;
  }

  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push({ state: this.snapshot(), version: this.version, label: s.label });
    this.state = s.state;
    this.version = s.version;
    this.afterRestore();
    return true;
  }
}

function lerpTransform(a: ReanimTransform, b: ReanimTransform, t: number): ReanimTransform {
  const out = { ...a };
  for (const k of NUMERIC_FIELDS) {
    if (k === 'f') continue;
    out[k] = a[k] + (b[k] - a[k]) * t;
  }
  return out;
}

/** Recompute all non-key frames of a track from its keys. */
export function retween(track: EditorTrack): void {
  const n = track.transforms.length;
  if (n === 0) return;
  track.keys[0] = true;
  let k = 0;
  for (let i = 1; i <= n; i++) {
    if (i < n && !track.keys[i]) continue;
    const a = track.transforms[k];
    const b = i < n ? track.transforms[i] : null;
    const ease = track.ease[k] ?? 'linear';
    for (let m = k + 1; m < i; m++) {
      if (!b || ease === 'hold') {
        track.transforms[m] = { ...a };
      } else {
        const t = warpTime((m - k) / (i - k), EASE_CURVE.get(ease) ?? Curve.Linear);
        track.transforms[m] = lerpTransform(a, b, t);
      }
    }
    k = i;
  }
}

export interface Tolerance {
  pos: number;
  angle: number;
  scale: number;
  alpha: number;
}

export const DEFAULT_TOLERANCE: Tolerance = { pos: 0.06, angle: 0.06, scale: 0.0025, alpha: 0.004 };

function segmentMatches(frames: ReanimTransform[], k: number, j: number, ease: Ease, tol: Tolerance): boolean {
  const a = frames[k];
  const b = frames[j];
  const curve = EASE_CURVE.get(ease) ?? Curve.Linear;
  for (let m = k + 1; m < j; m++) {
    const f = frames[m];
    if (f.f !== a.f || f.i !== a.i || f.font !== a.font || f.text !== a.text) return false;
    const t = ease === 'hold' ? 0 : warpTime((m - k) / (j - k), curve);
    const near = (field: 'x' | 'y' | 'kx' | 'ky' | 'sx' | 'sy' | 'a', eps: number) =>
      Math.abs(f[field] - (a[field] + (b[field] - a[field]) * t)) <= eps;
    if (!near('x', tol.pos) || !near('y', tol.pos)) return false;
    if (!near('kx', tol.angle) || !near('ky', tol.angle)) return false;
    if (!near('sx', tol.scale) || !near('sy', tol.scale)) return false;
    if (!near('a', tol.alpha)) return false;
  }
  return true;
}

const DETECT_EASES: Ease[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold'];

/**
 * Turn frames that are reproducible by tweening into non-key frames.
 * `boundaries` are frames that must stay keys (animation range edges), so a
 * tween never spans two animations.
 */
export function simplifyKeys(track: EditorTrack, boundaries: ReadonlySet<number> = new Set(), tol: Tolerance = DEFAULT_TOLERANCE): void {
  const n = track.transforms.length;
  track.keys = new Array(n).fill(false);
  track.ease = new Array(n).fill('linear');
  if (n === 0) return;
  track.keys[0] = true;
  let k = 0;
  while (k < n - 1) {
    let bestJ = k + 1;
    let bestEase: Ease = 'linear';
    for (let j = k + 2; j < n; j++) {
      if (boundaries.has(j - 1)) break;
      const ease = DETECT_EASES.find((e) => segmentMatches(track.transforms, k, j, e, tol));
      if (!ease) break;
      bestJ = j;
      bestEase = ease;
    }
    track.keys[bestJ] = true;
    track.ease[k] = bestEase;
    k = bestJ;
  }
}

/** Frames that start or end an animation range (plus the frame after each end). */
export function rangeBoundaries(tracks: { name: string; transforms: { f: number }[] }[]): Set<number> {
  const out = new Set<number>();
  for (const r of getAnimRanges(tracks)) {
    out.add(r.start);
    out.add(r.end);
    out.add(r.end + 1);
  }
  return out;
}

export function makeTrack(name: string, transforms: ReanimTransform[], allKeys = true): EditorTrack {
  return {
    uid: nextUid(),
    name,
    transforms,
    keys: transforms.map((_, i) => allKeys || i === 0),
    ease: transforms.map(() => 'linear' as Ease),
  };
}

function cloneTrack(t: EditorTrack): EditorTrack {
  return { uid: t.uid, name: t.name, transforms: t.transforms.map((x) => ({ ...x })), keys: [...t.keys], ease: [...t.ease] };
}

// ---------------------------------------------------------------- cue embedding

function encodeCues(sound: SoundCue[], particle: ParticleCue[]): string {
  const e = encodeURIComponent;
  const parts = [
    ...sound.map((c) => ['s', c.frame, e(c.sound), c.volume].join(',')),
    ...particle.map((c) => ['p', c.frame, e(c.particle), e(c.track), c.x, c.y].join(',')),
  ];
  return parts.join('|');
}

export function decodeCues(text: string): { sound: SoundCue[]; particle: ParticleCue[] } {
  const sound: SoundCue[] = [];
  const particle: ParticleCue[] = [];
  for (const part of text.split('|')) {
    const f = part.split(',');
    const d = (s: string | undefined) => {
      try {
        return decodeURIComponent(s ?? '');
      } catch {
        return s ?? '';
      }
    };
    if (f[0] === 's' && f.length >= 3) sound.push({ uid: nextUid(), frame: +f[1] || 0, sound: d(f[2]), volume: f[3] ? +f[3] : 1 });
    if (f[0] === 'p' && f.length >= 3) particle.push({ uid: nextUid(), frame: +f[1] || 0, particle: d(f[2]), track: d(f[3]), x: +(f[4] ?? 0) || 0, y: +(f[5] ?? 0) || 0 });
  }
  return { sound, particle };
}

// ---------------------------------------------------------------- document

export interface ReanimUiState {
  track: number;
  frame: number;
  /** Other end of a shift-click frame selection. */
  frameEnd: number;
  cue: { kind: 'sound' | 'particle'; uid: number } | null;
  anim: string;
  loop: LoopMode;
  hidden: Set<number>;
  locked: Set<number>;
}

export class ReanimDocument extends DocumentBase<ReanimState> {
  readonly kind = 'reanim' as const;
  ui: ReanimUiState = { track: -1, frame: 0, frameEnd: 0, cue: null, anim: '', loop: 'loop', hidden: new Set(), locked: new Set() };
  private fresh = new WeakSet<object>();

  static create(name: string, path: string, fps = 12, frames = 1): ReanimDocument {
    return new ReanimDocument(name, path, { fps, tracks: [], soundCues: [], particleCues: [] }, true, frames);
  }

  static fromDefinition(def: ReanimDefinition, name: string, path: string, simplify = true): ReanimDocument {
    const tracks: EditorTrack[] = [];
    let soundCues: SoundCue[] = [];
    let particleCues: ParticleCue[] = [];
    const boundaries = rangeBoundaries(def.tracks);
    for (const t of def.tracks) {
      if (t.name === CUE_TRACK_NAME) {
        const decoded = decodeCues(t.transforms[0]?.text ?? '');
        soundCues = decoded.sound;
        particleCues = decoded.particle;
        continue;
      }
      const et = makeTrack(t.name, t.transforms.map((x) => ({ ...x })));
      if (simplify && !isRangeTrack(t)) simplifyKeys(et, boundaries);
      tracks.push(et);
    }
    const doc = new ReanimDocument(name, path, { fps: def.fps, tracks, soundCues, particleCues }, false, frameCountOf(def));
    const ranges = doc.animRanges();
    if (ranges.length) {
      const idle = ranges.find((r) => /idle/i.test(r.name)) ?? ranges[0];
      doc.ui.anim = idle.name;
      doc.ui.frame = doc.ui.frameEnd = idle.start;
    }
    return doc;
  }

  private constructor(name: string, path: string, state: ReanimState, isNew: boolean, frames: number) {
    super(name, path, state, isNew);
    this.pendingFrameCount = Math.max(1, frames);
  }

  /** Frame count for documents without tracks. */
  private pendingFrameCount: number;

  get frameCount(): number {
    const n = this.state.tracks.reduce((m, t) => Math.max(m, t.transforms.length), 0);
    return n || this.pendingFrameCount;
  }

  get fps(): number {
    return this.state.fps;
  }

  protected snapshot(): ReanimState {
    return { ...this.state, tracks: [...this.state.tracks] };
  }

  protected afterRestore(): void {
    this.fresh = new WeakSet();
    if (this.ui.track >= this.state.tracks.length) this.ui.track = this.state.tracks.length - 1;
    const n = this.frameCount;
    if (this.ui.frame >= n) this.ui.frame = this.ui.frameEnd = n - 1;
    if (this.ui.cue) {
      const list = this.ui.cue.kind === 'sound' ? this.state.soundCues : this.state.particleCues;
      if (!list.some((c) => c.uid === this.ui.cue!.uid)) this.ui.cue = null;
    }
  }

  /** Get a mutable version of a track (cloned once per checkpoint). */
  editTrack(index: number): EditorTrack {
    const t = this.state.tracks[index];
    if (this.fresh.has(t)) return t;
    const c = cloneTrack(t);
    this.state.tracks[index] = c;
    this.fresh.add(c);
    return c;
  }

  editSoundCues(): SoundCue[] {
    if (!this.fresh.has(this.state.soundCues)) {
      this.state.soundCues = this.state.soundCues.map((c) => ({ ...c }));
      this.fresh.add(this.state.soundCues);
    }
    return this.state.soundCues;
  }

  editParticleCues(): ParticleCue[] {
    if (!this.fresh.has(this.state.particleCues)) {
      this.state.particleCues = this.state.particleCues.map((c) => ({ ...c }));
      this.fresh.add(this.state.particleCues);
    }
    return this.state.particleCues;
  }

  // ------------------------------------------------------------ queries

  get selectedTrack(): EditorTrack | undefined {
    return this.state.tracks[this.ui.track];
  }

  animRanges(): AnimRange[] {
    return getAnimRanges(this.state.tracks);
  }

  /** Frame range [start, end] being previewed. */
  activeRange(): { start: number; end: number } {
    const n = this.frameCount;
    if (this.ui.anim) {
      const r = this.animRanges().find((a) => a.name === this.ui.anim);
      if (r) return { start: r.start, end: Math.min(r.end, n - 1) };
    }
    return { start: 0, end: n - 1 };
  }

  findTrack(name: string): number {
    const lower = name.toLowerCase();
    return this.state.tracks.findIndex((t) => t.name.toLowerCase() === lower);
  }

  uniqueTrackName(base: string): string {
    let name = base;
    let i = 2;
    while (this.findTrack(name) >= 0) name = `${base}_${i++}`;
    return name;
  }

  /** Key frame at or before `frame`. */
  keyAtOrBefore(track: EditorTrack, frame: number): number {
    for (let i = Math.min(frame, track.keys.length - 1); i >= 0; i--) if (track.keys[i]) return i;
    return 0;
  }

  // ------------------------------------------------------------ track editing

  /**
   * Set fields on a track at a frame, turning it into a key, and re-tween.
   * Call checkpoint() first (or rely on `label`).
   */
  setFields(trackIndex: number, frame: number, patch: Partial<ReanimTransform>, label?: string): void {
    if (label) this.checkpoint(label);
    const t = this.editTrack(trackIndex);
    if (frame < 0 || frame >= t.transforms.length) return;
    t.keys[frame] = true;
    Object.assign(t.transforms[frame], patch);
    retween(t);
  }

  toggleKey(trackIndex: number, frame: number): void {
    const t0 = this.state.tracks[trackIndex];
    if (!t0 || frame <= 0 || frame >= t0.transforms.length) return;
    this.checkpoint(t0.keys[frame] ? 'Remove key' : 'Add key');
    const t = this.editTrack(trackIndex);
    t.keys[frame] = !t.keys[frame];
    if (t.keys[frame]) t.ease[frame] = t.ease[this.keyAtOrBefore(t, frame - 1)];
    retween(t);
  }

  setKeys(trackIndex: number, from: number, to: number, isKey: boolean): void {
    this.checkpoint(isKey ? 'Add keys' : 'Clear keys');
    const t = this.editTrack(trackIndex);
    for (let f = Math.max(0, from); f <= Math.min(to, t.transforms.length - 1); f++) if (f > 0) t.keys[f] = isKey;
    retween(t);
  }

  setEase(trackIndex: number, frame: number, ease: Ease): void {
    this.checkpoint('Set easing');
    const t = this.editTrack(trackIndex);
    t.ease[this.keyAtOrBefore(t, frame)] = ease;
    retween(t);
  }

  moveKey(trackIndex: number, from: number, to: number): boolean {
    const t0 = this.state.tracks[trackIndex];
    if (!t0 || from === to || from <= 0 || to <= 0 || to >= t0.transforms.length || !t0.keys[from] || t0.keys[to]) return false;
    this.checkpoint('Move key');
    const t = this.editTrack(trackIndex);
    t.transforms[to] = { ...t.transforms[from] };
    t.ease[to] = t.ease[from];
    t.keys[from] = false;
    t.keys[to] = true;
    retween(t);
    return true;
  }

  simplifyTrack(trackIndex: number): void {
    const t = this.editTrack(trackIndex);
    if (!isRangeTrack(t)) simplifyKeys(t, rangeBoundaries(this.state.tracks));
  }

  addTrack(name: string, image: string, x = 0, y = 0, at = this.state.tracks.length): number {
    this.checkpoint('Add track');
    const n = this.frameCount;
    const base: ReanimTransform = { ...DEFAULT_TRANSFORM, i: image, x, y };
    const t = makeTrack(this.uniqueTrackName(name), Array.from({ length: n }, () => ({ ...base })), false);
    this.fresh.add(t);
    this.state.tracks.splice(at, 0, t);
    return at;
  }

  /** Add a text part (drawn in `font`, a FONT_* id, with its baseline's left end at x, y). */
  addTextTrack(text: string, font: string, x = 0, y = 0, at = this.state.tracks.length): number {
    this.checkpoint('Add text');
    const n = this.frameCount;
    const base: ReanimTransform = { ...DEFAULT_TRANSFORM, text, font, x, y };
    const t = makeTrack(this.uniqueTrackName('text'), Array.from({ length: n }, () => ({ ...base })), false);
    this.fresh.add(t);
    this.state.tracks.splice(at, 0, t);
    return at;
  }

  removeTrack(index: number): void {
    if (!this.state.tracks[index]) return;
    this.checkpoint('Delete track');
    this.state.tracks.splice(index, 1);
    if (this.ui.track >= this.state.tracks.length) this.ui.track = this.state.tracks.length - 1;
  }

  duplicateTrack(index: number): number {
    const src = this.state.tracks[index];
    if (!src) return -1;
    this.checkpoint('Duplicate track');
    const c = cloneTrack(src);
    c.uid = nextUid();
    c.name = this.uniqueTrackName(src.name + '_copy');
    this.fresh.add(c);
    this.state.tracks.splice(index + 1, 0, c);
    return index + 1;
  }

  renameTrack(index: number, name: string): void {
    if (!this.state.tracks[index] || !name.trim()) return;
    this.checkpoint('Rename track');
    const old = this.state.tracks[index].name;
    this.editTrack(index).name = name.trim();
    if (this.ui.anim === old) this.ui.anim = name.trim();
    if (this.state.particleCues.some((c) => c.track === old)) {
      for (const c of this.editParticleCues()) if (c.track === old) c.track = name.trim();
    }
  }

  moveTrack(from: number, to: number): void {
    const tracks = this.state.tracks;
    if (from === to || !tracks[from] || to < 0 || to >= tracks.length) return;
    this.checkpoint('Reorder tracks');
    const [t] = tracks.splice(from, 1);
    tracks.splice(to, 0, t);
    if (this.ui.track === from) this.ui.track = to;
  }

  // ------------------------------------------------------------ frames

  insertFrames(at: number, count: number): void {
    if (count <= 0) return;
    this.checkpoint(count === 1 ? 'Insert frame' : `Insert ${count} frames`);
    at = Math.max(0, Math.min(at, this.frameCount));
    if (this.state.tracks.length === 0) this.pendingFrameCount += count;
    this.state.tracks.forEach((_, i) => {
      const t = this.editTrack(i);
      const src = t.transforms[Math.max(0, at - 1)] ?? { ...DEFAULT_TRANSFORM };
      const isAnim = isRangeTrack(t);
      for (let k = 0; k < count; k++) {
        t.transforms.splice(at, 0, { ...src });
        t.keys.splice(at, 0, isAnim || at === 0);
        t.ease.splice(at, 0, 'linear');
      }
      if (!isAnim) retween(t);
    });
    for (const c of this.editSoundCues()) if (c.frame >= at) c.frame += count;
    for (const c of this.editParticleCues()) if (c.frame >= at) c.frame += count;
  }

  deleteFrames(at: number, count: number): void {
    const n = this.frameCount;
    count = Math.min(count, n - at);
    if (count <= 0 || count >= n) return;
    this.checkpoint(count === 1 ? 'Delete frame' : `Delete ${count} frames`);
    if (this.state.tracks.length === 0) this.pendingFrameCount -= count;
    this.state.tracks.forEach((_, i) => {
      const t = this.editTrack(i);
      t.transforms.splice(at, count);
      t.keys.splice(at, count);
      t.ease.splice(at, count);
      if (!isRangeTrack(t)) retween(t);
    });
    this.state.soundCues = this.editSoundCues().filter((c) => c.frame < at || c.frame >= at + count);
    this.fresh.add(this.state.soundCues);
    for (const c of this.state.soundCues) if (c.frame >= at + count) c.frame -= count;
    this.state.particleCues = this.editParticleCues().filter((c) => c.frame < at || c.frame >= at + count);
    this.fresh.add(this.state.particleCues);
    for (const c of this.state.particleCues) if (c.frame >= at + count) c.frame -= count;
    const last = this.frameCount - 1;
    if (this.ui.frame > last) this.ui.frame = last;
    if (this.ui.frameEnd > last) this.ui.frameEnd = last;
  }

  setFrameCount(count: number): void {
    const n = this.frameCount;
    if (count < 1 || count === n) return;
    if (count > n) this.insertFrames(n, count - n);
    else this.deleteFrames(count, n - count);
  }

  setFps(fps: number): void {
    if (!(fps > 0) || fps === this.state.fps) return;
    this.checkpoint('Change FPS');
    this.state.fps = fps;
  }

  // ------------------------------------------------------------ animation ranges

  setAnimRange(name: string, start: number, end: number, oldName?: string): void {
    const n = this.frameCount;
    start = Math.max(0, Math.min(start, n - 1));
    end = Math.max(start, Math.min(end, n - 1));
    if (!isAnimTrackName(name)) name = 'anim_' + name;
    this.checkpoint('Set animation range');
    let idx = this.findTrack(oldName ?? name);
    // Never turn a part that happens to be called anim_* (e.g. anim_head1) into a range.
    if (idx >= 0 && !isRangeTrack(this.state.tracks[idx])) {
      if (!oldName) name = this.uniqueTrackName(name);
      idx = -1;
    }
    if (idx < 0) {
      const t = makeTrack(name, Array.from({ length: n }, () => ({ ...DEFAULT_TRANSFORM, f: -1 })), true);
      this.fresh.add(t);
      // anim_ tracks conventionally come first.
      const firstNonAnim = this.state.tracks.findIndex((x) => !isRangeTrack(x));
      idx = firstNonAnim < 0 ? this.state.tracks.length : firstNonAnim;
      this.state.tracks.splice(idx, 0, t);
    }
    const t = this.editTrack(idx);
    t.name = name;
    t.transforms.forEach((tr, i) => {
      tr.f = i >= start && i <= end ? 0 : -1;
    });
    t.keys = t.transforms.map(() => true);
    // Key every part at the range edges so tweens never cross into another animation.
    this.state.tracks.forEach((other, i) => {
      if (isRangeTrack(other)) return;
      const edges = [start, end, end + 1].filter((f) => f < n && !other.keys[f]);
      if (!edges.length) return;
      const e = this.editTrack(i);
      for (const f of edges) {
        e.keys[f] = true;
        e.ease[f] = e.ease[this.keyAtOrBefore(e, f - 1)] ?? 'linear';
      }
    });
    if (oldName && this.ui.anim === oldName) this.ui.anim = name;
  }

  removeAnimRange(name: string): void {
    const idx = this.findTrack(name);
    if (idx < 0 || !isRangeTrack(this.state.tracks[idx])) return;
    this.removeTrack(idx);
    if (this.ui.anim === name) this.ui.anim = '';
  }

  // ------------------------------------------------------------ cues

  addSoundCue(frame: number, sound: string, volume = 1): SoundCue {
    this.checkpoint('Add sound cue');
    const cue = { uid: nextUid(), frame, sound, volume };
    this.editSoundCues().push(cue);
    return cue;
  }

  updateSoundCue(uid: number, patch: Partial<SoundCue>, label = 'Edit sound cue'): void {
    if (label) this.checkpoint(label);
    const c = this.editSoundCues().find((x) => x.uid === uid);
    if (c) Object.assign(c, patch);
  }

  addParticleCue(frame: number, particle: string, track = '', x = 0, y = 0): ParticleCue {
    this.checkpoint('Add particle cue');
    const cue = { uid: nextUid(), frame, particle, track, x, y };
    this.editParticleCues().push(cue);
    return cue;
  }

  updateParticleCue(uid: number, patch: Partial<ParticleCue>, label = 'Edit particle cue'): void {
    if (label) this.checkpoint(label);
    const c = this.editParticleCues().find((x) => x.uid === uid);
    if (c) Object.assign(c, patch);
  }

  removeCue(kind: 'sound' | 'particle', uid: number): void {
    this.checkpoint('Delete cue');
    if (kind === 'sound') {
      this.state.soundCues = this.state.soundCues.filter((c) => c.uid !== uid);
    } else {
      this.state.particleCues = this.state.particleCues.filter((c) => c.uid !== uid);
    }
    if (this.ui.cue?.uid === uid) this.ui.cue = null;
  }

  // ------------------------------------------------------------ export

  toDefinition(embedCues = true): ReanimDefinition {
    const tracks = this.state.tracks.map((t) => ({ name: t.name, transforms: t.transforms.map((x) => ({ ...x })) }));
    if (embedCues && (this.state.soundCues.length || this.state.particleCues.length)) {
      const n = this.frameCount;
      const transforms = Array.from({ length: n }, () => ({ ...DEFAULT_TRANSFORM, f: -1 }));
      transforms[0].text = encodeCues(this.state.soundCues, this.state.particleCues);
      tracks.push({ name: CUE_TRACK_NAME, transforms });
    }
    return { fps: this.state.fps, tracks };
  }
}
