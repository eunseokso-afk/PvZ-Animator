/**
 * Application state: open documents, the asset library, playback and live
 * previews. UI panels subscribe to its events.
 */

import { AssetLibrary } from '../engine/assets';
import { AudioEngine } from '../engine/audio';
import { clamp, seededRandom } from '../engine/math';
import { ParticleSystem } from '../engine/particleSystem';
import { gameHiddenTracks } from '../engine/gameVisibility';
import { interpolateTransform, isFullLastFrame, isLooping, transformMatrix, type FrameTime } from '../engine/reanimRuntime';
import { basename, stripExt } from '../engine/vfs';
import type { ParticleDefinition } from '../formats/particles';
import type { ReanimTransform } from '../formats/reanim';
import type { Prefab } from '../engine/sceneRuntime';
import { ParticleDocument } from './particleDoc';
import { ReanimDocument, type ParticleCue, type SoundCue } from './reanimDoc';
import { SceneDocument, type LayerPose, type SceneLayer } from './sceneDoc';

export type EditorDocument = ReanimDocument | ParticleDocument | SceneDocument;
/** Documents with a frame timeline. */
export type TimedDocument = ReanimDocument | SceneDocument;

export type WsEvent = 'docs' | 'change' | 'frame' | 'assets' | 'status' | 'settings';

export interface Settings {
  simplifyOnImport: boolean;
  embedCues: boolean;
  background: 'dark' | 'light' | 'checker' | 'lawn' | 'night';
  grid: boolean;
  lawnGuide: boolean;
  onion: boolean;
  showBounds: boolean;
  /** Hide parts the game hides from code (zombie accessories, most credits tongues). */
  gameVisibility: boolean;
}

const SETTINGS_KEY = 'pvz-animator-settings';

function loadSettings(): Settings {
  const defaults: Settings = {
    simplifyOnImport: true,
    embedCues: true,
    background: 'dark',
    grid: true,
    lawnGuide: false,
    onion: false,
    showBounds: true,
    gameVisibility: true,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

interface LiveSystem {
  cue: ParticleCue;
  sys: ParticleSystem;
}

interface SceneParticle {
  sys: ParticleSystem;
  ticks: number;
  trigger: number;
  def: ParticleDefinition;
  rev: number;
}

interface PreviewSystem {
  sys: ParticleSystem;
  ticks: number;
  def: ParticleDefinition;
  /** Revision of the open particle document it was built from (-1 if none). */
  rev: number;
  frame: number;
}

export class Workspace extends EventTarget {
  readonly assets = new AssetLibrary();
  readonly audio = new AudioEngine();
  docs: EditorDocument[] = [];
  active: EditorDocument | null = null;
  settings: Settings = loadSettings();

  playing = false;
  speed = 1;
  /** Fractional frame position while playing. */
  playhead = 0;
  /** Times the playing reanim wrapped back to the start of its range (attachments run on across it). */
  loops = 0;
  soundEnabled = true;
  private firstTick = false;

  /** Last asset the user clicked in the browser (used when adding cues). */
  selectedAsset: { kind: string; path: string } | null = null;
  clipboard: ReanimTransform | null = null;

  live: LiveSystem[] = [];
  private previews = new Map<number, PreviewSystem>();
  private sceneParticleCache = new Map<number, SceneParticle>();

  /** All scenes of the project (they stay here when their tab is closed). */
  scenes: SceneDocument[] = [];
  /** Prefab documents opened from a scene ("edit in place"), for the breadcrumb back. */
  readonly returnTo = new WeakMap<EditorDocument, SceneDocument>();

  constructor() {
    super();
    this.assets.addEventListener('change', (e) => {
      const scope = (e as CustomEvent<{ scope: string }>).detail?.scope ?? 'all';
      if (scope === 'all') this.audio.clearCache();
      this.emit('assets', { scope });
    });
    this.assets.addEventListener('image', () => this.emit('frame'));
  }

  emit(type: WsEvent, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type: WsEvent, fn: (e: CustomEvent) => void): void {
    this.addEventListener(type, fn as EventListener);
  }

  status(message: string, level: 'info' | 'error' | 'success' = 'info'): void {
    this.emit('status', { message, level });
  }

  saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* private mode */
    }
    this.emit('settings');
  }

  // ------------------------------------------------------------ documents

  get reanim(): ReanimDocument | null {
    return this.active?.kind === 'reanim' ? this.active : null;
  }

  get particle(): ParticleDocument | null {
    return this.active?.kind === 'particle' ? this.active : null;
  }

  get scene(): SceneDocument | null {
    return this.active?.kind === 'scene' ? this.active : null;
  }

  /** The active document if it has a timeline. */
  get timed(): TimedDocument | null {
    return this.reanim ?? this.scene;
  }

  newScene(): SceneDocument {
    let n = this.scenes.length + 1;
    while (this.scenes.some((s) => s.name.toLowerCase() === `scene ${n}`)) n++;
    const doc = SceneDocument.create(`Scene ${n}`);
    this.addScene(doc);
    this.openDoc(doc);
    return doc;
  }

  addScene(doc: SceneDocument): void {
    if (!this.scenes.includes(doc)) this.scenes.push(doc);
    this.emit('docs');
  }

  deleteScene(doc: SceneDocument): void {
    this.scenes = this.scenes.filter((s) => s !== doc);
    this.closeDoc(doc);
    this.emit('docs');
  }

  /** The document path a library file is edited under: compiled reanims open as reanim/<name>.reanim. */
  editPathFor(path: string): string {
    if (!path.toLowerCase().endsWith('.compiled')) return path;
    return `reanim/${stripExt(stripExt(basename(path)))}.reanim`;
  }

  /** The open document editing a library file, if any (compiled files map to their XML path). */
  findDocFor(path: string): EditorDocument | undefined {
    return this.findDoc(path) ?? this.findDoc(this.editPathFor(path));
  }

  /** Prefab data for a reanim path, preferring an open (possibly edited) document. */
  prefab(path: string): Prefab | null | undefined {
    const doc = this.findDocFor(path);
    if (doc?.kind === 'reanim') return { fps: doc.fps, tracks: doc.state.tracks };
    const def = this.assets.reanim(path);
    return def ? { fps: def.fps, tracks: def.tracks } : def;
  }

  /** Open a prefab's reanim for editing, remembering the scene to return to. */
  async editPrefab(path: string, from: SceneDocument): Promise<void> {
    const doc = await this.openAsset(path);
    if (doc) {
      this.returnTo.set(doc, from);
      this.emit('docs');
    }
  }

  openDoc(doc: EditorDocument): void {
    if (!this.docs.includes(doc)) this.docs.push(doc);
    this.setActive(doc);
  }

  setActive(doc: EditorDocument | null): void {
    if (this.active === doc) return;
    this.pause();
    this.active = doc;
    this.previews.clear();
    this.sceneParticleCache.clear();
    this.emit('docs');
    this.emit('change');
  }

  /** Close a tab. Scenes stay in the project's scene list. */
  closeDoc(doc: EditorDocument): void {
    const i = this.docs.indexOf(doc);
    if (i < 0) return;
    this.docs.splice(i, 1);
    if (this.active === doc) {
      this.active = null;
      this.setActive(this.docs[Math.min(i, this.docs.length - 1)] ?? null);
    }
    this.emit('docs');
  }

  findDoc(path: string): EditorDocument | undefined {
    const key = path.toUpperCase();
    return this.docs.find((d) => d.path.toUpperCase() === key);
  }

  /** Open a reanim or particle file from the library in a new tab. */
  async openAsset(path: string): Promise<EditorDocument | null> {
    const existing = this.findDocFor(path);
    if (existing) {
      this.setActive(existing);
      return existing;
    }
    const kind = this.assets.kindOf(this.assets.vfs.get(path) ?? { path, size: 0, origin: 'import', read: async () => new Uint8Array() });
    const name = stripExt(stripExt(basename(path)));
    try {
      if (kind === 'reanim') {
        const def = await this.assets.loadReanimFile(path);
        // Compiled files are saved back as XML next to the original location.
        const target = this.editPathFor(path);
        const doc = ReanimDocument.fromDefinition(def, name, target, this.settings.simplifyOnImport);
        this.openDoc(doc);
        this.status(`Opened ${path} (${def.tracks.length} tracks, ${doc.frameCount} frames @ ${def.fps} fps)`, 'success');
        return doc;
      }
      if (kind === 'particle') {
        const def = await this.assets.loadParticleFile(path);
        const doc = ParticleDocument.fromDefinition(def, name, path);
        this.openDoc(doc);
        this.status(`Opened ${path} (${def.emitters.length} emitters)`, 'success');
        return doc;
      }
      this.status(`Don't know how to open ${path}`, 'error');
    } catch (e) {
      this.status(`Failed to open ${path}: ${(e as Error).message}`, 'error');
    }
    return null;
  }

  uniqueDocPath(dir: string, base: string, ext: string): string {
    let n = 1;
    let path = `${dir}/${base}.${ext}`;
    while (this.findDoc(path) || this.assets.vfs.has(path)) path = `${dir}/${base}${++n}.${ext}`;
    return path;
  }

  newReanim(): ReanimDocument {
    const path = this.uniqueDocPath('reanim', 'NewAnimation', 'reanim');
    const doc = ReanimDocument.create(stripExt(basename(path)), path, 12, 24);
    doc.setAnimRange('anim_idle', 0, 23);
    doc.clearHistory();
    doc.ui.anim = 'anim_idle';
    this.openDoc(doc);
    return doc;
  }

  newParticle(): ParticleDocument {
    const path = this.uniqueDocPath('particles', 'NewEffect', 'xml');
    const doc = ParticleDocument.create(stripExt(basename(path)), path);
    this.openDoc(doc);
    return doc;
  }

  /** Particle definition by path, preferring an open (possibly edited) document. */
  particleDef(path: string): ParticleDefinition | null | undefined {
    const doc = this.findDoc(path);
    if (doc?.kind === 'particle') return doc.def;
    return this.assets.particle(path);
  }

  // ------------------------------------------------------------ playback

  frameTime(doc: ReanimDocument): FrameTime {
    if (this.playing && doc === this.active) {
      const { end } = doc.activeRange();
      const before = Math.min(Math.floor(this.playhead), end);
      const after = Math.min(before + 1, end);
      return { before, after, fraction: before >= end ? 0 : this.playhead - Math.floor(this.playhead), loops: this.loops };
    }
    const f = clamp(doc.ui.frame, 0, doc.frameCount - 1);
    return { before: f, after: f, fraction: 0 };
  }

  /** Which tracks of a reanim document are not drawn: hidden in the editor, or by the game's code. */
  hiddenTracks(doc: ReanimDocument): (trackIndex: number) => boolean {
    const game = this.settings.gameVisibility ? gameHiddenTracks(doc.state.tracks) : null;
    return (i) => doc.ui.hidden.has(doc.state.tracks[i]?.uid) || !!game?.has(i);
  }

  /**
   * Frames per second the playhead moves at for a reanim's active range. Like
   * Reanimation::Update, one pass takes count / fps seconds, so without "full last
   * frame" the playhead covers count - 1 frames in that time.
   */
  playbackFps(doc: ReanimDocument): number {
    const { start, end } = doc.activeRange();
    const count = end - start + 1;
    const span = isFullLastFrame(doc.ui.loop) ? count : count - 1;
    return span > 0 ? (doc.fps * span) / count : doc.fps;
  }

  /** Current (fractional while playing) frame of a scene. */
  sceneFrame(doc: SceneDocument): number {
    if (this.playing && doc === this.active) return Math.min(this.playhead, doc.state.length - 1);
    return clamp(doc.ui.frame, 0, doc.state.length - 1);
  }

  play(): void {
    const scene = this.scene;
    if (scene && !this.playing) {
      let f = scene.ui.frame;
      if (f >= scene.state.length - 1) f = 0;
      this.playhead = f;
      this.playing = true;
      this.firstTick = true;
      this.audio.context;
      this.resumeCueSounds(scene.state.soundCues, scene.fps, f, 0);
      this.emit('change');
      return;
    }
    const doc = this.reanim;
    if (!doc || this.playing) return;
    const { start, end } = doc.activeRange();
    let f = doc.ui.frame;
    this.loops = 0;
    if (f < start || f > end) f = start;
    if (f >= end && !isLooping(doc.ui.loop)) f = start;
    this.playhead = f;
    this.playing = true;
    this.firstTick = true;
    this.live = [];
    this.audio.context; // unlock audio on the user gesture
    this.resumeSounds(doc, f);
    this.emit('change');
  }

  /** When playback starts mid-animation, pick up sounds that would already be playing. */
  private resumeSounds(doc: ReanimDocument, frame: number): void {
    this.resumeCueSounds(doc.state.soundCues, doc.fps, frame, doc.activeRange().start);
  }

  private resumeCueSounds(cues: SoundCue[], fps: number, frame: number, start: number): void {
    if (!this.soundEnabled) return;
    for (const cue of cues) {
      if (cue.frame >= frame || cue.frame < start) continue;
      const file = this.assets.resolveSound(cue.sound);
      const buf = file ? this.audio.peek(file) : null;
      const offset = (frame - cue.frame) / fps;
      if (buf && offset < buf.duration) this.audio.play(buf, cue.volume, offset);
    }
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.live = [];
    this.previews.clear();
    const doc = this.timed;
    if (doc) doc.ui.frame = doc.ui.frameEnd = clamp(Math.floor(this.playhead), 0, doc.frameCount - 1);
    this.emit('change');
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setFrame(frame: number, extend = false): void {
    const doc = this.timed;
    if (!doc) return;
    if (this.playing) this.pause();
    const f = clamp(Math.round(frame), 0, doc.frameCount - 1);
    doc.ui.frame = f;
    if (!extend) doc.ui.frameEnd = f;
    this.emit('change');
  }

  stepFrame(delta: number): void {
    const doc = this.timed;
    if (!doc) return;
    const { start, end } = doc.kind === 'reanim' ? doc.activeRange() : { start: 0, end: doc.state.length - 1 };
    let f = doc.ui.frame + delta;
    if (f > end) f = start;
    if (f < start) f = end;
    this.setFrame(f);
  }

  /** Advance playback and particle previews by dt seconds. */
  update(dt: number): boolean {
    let changed = false;
    const scene = this.scene;
    if (scene && this.playing) {
      this.updateScene(scene, dt);
      changed = true;
    }
    const doc = this.reanim;
    if (doc && this.playing) {
      const { start, end } = doc.activeRange();
      const full = isFullLastFrame(doc.ui.loop);
      const span = full ? end - start + 1 : end - start;
      const endPos = start + span;
      const prev = this.playhead;
      let next = prev + dt * this.playbackFps(doc) * this.speed;
      const fire: [number, number][] = [];
      const inclusiveStart = this.firstTick;
      this.firstTick = false;
      if (span <= 0) {
        next = start;
        if (inclusiveStart) fire.push([start, start]);
      } else if (next >= endPos) {
        fire.push([prev, endPos - 1e-9]);
        if (isLooping(doc.ui.loop)) {
          this.loops += Math.floor((next - start) / span);
          next = start + ((next - start) % span);
          fire.push([start - 1e-9, next]);
        } else {
          next = full ? endPos - 1e-6 : end;
          this.playhead = next;
          this.playing = false;
          doc.ui.frame = doc.ui.frameEnd = end;
        }
      } else {
        fire.push([prev, next]);
      }
      for (const [a, b] of fire) this.fireCues(doc, a, b, inclusiveStart && a === prev);
      if (this.playing) {
        this.playhead = next;
        doc.ui.frame = doc.ui.frameEnd = clamp(Math.floor(next), start, end);
      } else {
        this.emit('change');
      }
      changed = true;
    }
    if (this.live.length) {
      const d = this.reanim;
      for (const l of this.live) {
        if (d) {
          const [x, y] = this.cuePosition(d, l.cue, d === this.active ? this.frameTime(d) : null);
          l.sys.setPosition(x, y);
        }
        l.sys.advance(dt * this.speed);
      }
      this.live = this.live.filter((l) => !l.sys.dead);
      changed = true;
    }
    return changed;
  }

  private updateScene(scene: SceneDocument, dt: number): void {
    const end = scene.state.length;
    const prev = this.playhead;
    let next = prev + dt * scene.fps * this.speed;
    const inclusive = this.firstTick;
    this.firstTick = false;
    if (next >= end) {
      this.playSoundCues(scene.state.soundCues, prev, end, inclusive);
      if (scene.ui.loopPlayback && end > 1) {
        next %= end;
        this.playSoundCues(scene.state.soundCues, -1e-9, next, false);
        this.sceneParticleCache.clear();
      } else {
        this.playhead = end - 1;
        this.playing = false;
        scene.ui.frame = scene.ui.frameEnd = end - 1;
        this.emit('change');
        return;
      }
    } else {
      this.playSoundCues(scene.state.soundCues, prev, next, inclusive);
    }
    this.playhead = next;
    scene.ui.frame = scene.ui.frameEnd = clamp(Math.floor(next), 0, end - 1);
  }

  private playSoundCues(cues: SoundCue[], from: number, to: number, inclusive: boolean): void {
    if (!this.soundEnabled) return;
    for (const cue of cues) {
      if (!((inclusive ? cue.frame >= from : cue.frame > from) && cue.frame <= to)) continue;
      const file = this.assets.resolveSound(cue.sound);
      if (!file) continue;
      const buf = this.audio.peek(file);
      if (buf) this.audio.play(buf, cue.volume);
      else
        void this.audio.load(file).then((b) => {
          if (b && this.playing) this.audio.play(b, cue.volume);
        });
    }
  }

  /**
   * The particle system of a scene's particle layer at a frame, simulated
   * deterministically from the start of the layer's current run.
   */
  sceneParticles(scene: SceneDocument, layer: SceneLayer, pose: LayerPose, frame: number): ParticleSystem | null {
    const def = this.particleDef(layer.source);
    if (!def) return null;
    const source = this.findDoc(layer.source);
    const rev = source?.kind === 'particle' ? source.revision : -1;
    const trigger = pose.segmentStart;
    const target = Math.round(((frame - trigger) / scene.fps) * 100);
    if (this.sceneParticleCache.size > scene.state.layers.length) {
      // Drop systems of deleted layers.
      const live = new Set(scene.state.layers.map((l) => l.uid));
      for (const uid of this.sceneParticleCache.keys()) if (!live.has(uid)) this.sceneParticleCache.delete(uid);
    }
    let p = this.sceneParticleCache.get(layer.uid);
    if (!p || p.def !== def || p.rev !== rev || p.trigger !== trigger || p.ticks > target) {
      p = { sys: new ParticleSystem(def, pose.x, pose.y, seededRandom(layer.uid * 7919 + trigger)), ticks: 0, trigger, def, rev };
      this.sceneParticleCache.set(layer.uid, p);
    }
    p.sys.setPosition(pose.x, pose.y);
    let budget = 3000;
    while (p.ticks < target && budget-- > 0) {
      p.sys.tick();
      p.ticks++;
    }
    return p.sys.dead ? null : p.sys;
  }

  private fireCues(doc: ReanimDocument, from: number, to: number, inclusive: boolean): void {
    const hit = (f: number) => (inclusive ? f >= from : f > from) && f <= to;
    this.playSoundCues(doc.state.soundCues, from, to, inclusive);
    for (const cue of doc.state.particleCues) {
      if (!hit(cue.frame)) continue;
      const def = this.particleDef(cue.particle);
      if (!def) continue;
      const [x, y] = this.cuePosition(doc, cue, this.frameTime(doc));
      this.live.push({ cue, sys: new ParticleSystem(def, x, y) });
    }
  }

  /** Where a particle cue sits in reanim space at the given frame time. */
  cuePosition(doc: ReanimDocument, cue: ParticleCue, ft: FrameTime | null): [number, number] {
    if (cue.track && ft) {
      const ti = doc.findTrack(cue.track);
      const track = doc.state.tracks[ti];
      if (track) {
        const t = interpolateTransform(track.transforms, ft);
        const m = transformMatrix(t);
        return [m[0] * cue.x + m[2] * cue.y + m[4], m[1] * cue.x + m[3] * cue.y + m[5]];
      }
    }
    return [cue.x, cue.y];
  }

  /**
   * Particle systems to draw for a paused reanim: each cue that started at or
   * before the current frame is simulated deterministically up to now.
   */
  pausedParticleSystems(doc: ReanimDocument): ParticleSystem[] {
    const out: ParticleSystem[] = [];
    const { start } = doc.activeRange();
    const frame = doc.ui.frame;
    const ft = this.frameTime(doc);
    const seen = new Set<number>();
    for (const cue of doc.state.particleCues) {
      seen.add(cue.uid);
      if (cue.frame > frame || cue.frame < start) continue;
      const def = this.particleDef(cue.particle);
      if (!def) continue;
      const source = this.findDoc(cue.particle);
      const rev = source?.kind === 'particle' ? source.revision : -1;
      const targetTicks = Math.round(((frame - cue.frame) / doc.fps) * 100);
      let p = this.previews.get(cue.uid);
      if (!p || p.def !== def || p.rev !== rev || p.ticks > targetTicks || p.frame !== cue.frame) {
        const [x, y] = this.cuePosition(doc, cue, { before: cue.frame, after: cue.frame, fraction: 0 });
        p = { sys: new ParticleSystem(def, x, y, seededRandom(cue.uid * 7919)), ticks: 0, def, rev, frame: cue.frame };
        this.previews.set(cue.uid, p);
      }
      const [x, y] = this.cuePosition(doc, cue, ft);
      p.sys.setPosition(x, y);
      while (p.ticks < targetTicks && p.ticks < 3000) {
        p.sys.tick();
        p.ticks++;
      }
      if (!p.sys.dead) out.push(p.sys);
    }
    for (const uid of [...this.previews.keys()]) if (!seen.has(uid)) this.previews.delete(uid);
    return out;
  }

  invalidatePreviews(): void {
    this.previews.clear();
    this.sceneParticleCache.clear();
  }
}
