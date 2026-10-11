/**
 * Drawing and baking scenes: layers are prefab instances (reanims), particle
 * emitters or images, positioned by their tweened keyframes.
 */

import { gameHiddenTracks } from './gameVisibility';
import { DEFAULT_TRANSFORM, isRangeTrack, type ReanimDefinition, type ReanimTransform } from '../formats/reanim';
import type { LayerPose, SceneLayer, SceneState } from '../editor/sceneDoc';
import { evalLayer, poseMatrix } from '../editor/sceneDoc';
import type { AssetLibrary } from './assets';
import { apply, invert, mul, type Mat } from './math';
import type { ParticleSystem } from './particleSystem';
import { animRangeOf, decomposeMatrix, drawReanim, drawTextAt, interpolateTransform, transformMatrix, type DrawTrackInfo, type FrameTime, type TrackLike } from './reanimRuntime';
import type { Renderer, RGBA } from './renderer';

export interface Prefab {
  fps: number;
  tracks: TrackLike[];
}

export interface SceneResolver {
  assets: AssetLibrary;
  /** Reanim definition for a prefab path; undefined while loading, null if missing. */
  prefab(path: string): Prefab | null | undefined;
  /** Particle system for a particle layer at a frame (positioned and simulated), if available. */
  particles?(layer: SceneLayer, pose: LayerPose, frame: number): ParticleSystem | null;
  /** Hide the parts the game hides from code (e.g. a plain zombie's accessories). */
  gameVisibility?: boolean;
  /** A prefab's own sound cues (baking copies the ones its instances play). */
  soundCues?(path: string): readonly SoundCueLike[];
}

export interface SoundCueLike {
  frame: number;
  sound: string;
  volume: number;
}

/** Prefab frames per second an instance's playhead moves at (Reanimation::Update: a pass lasts count / fps). */
export function instanceFps(prefab: Prefab, count: number, speed: number): number {
  return (prefab.fps * Math.max(0, speed) * Math.max(1, count - 1)) / Math.max(1, count);
}

/** Which prefab frame an instance shows at a scene frame. */
export function instanceFrameTime(prefab: Prefab, pose: LayerPose, sceneFps: number, frame: number): FrameTime {
  const key = pose.key;
  const range = animRangeOf({ fps: prefab.fps, tracks: prefab.tracks as ReanimDefinition['tracks'] }, key.anim);
  const last = range.count - 1;
  const offset = Math.max(0, Math.min(last, Math.round(key.startFrame)));
  const seconds = Math.max(0, frame - pose.segmentStart) / Math.max(1e-6, sceneFps);
  if (key.loop === 'single' || last <= 0) {
    // Held on one frame; attachments still animate for the time that passes.
    const f = range.start + offset;
    return { before: f, after: f, fraction: 0, overrun: seconds * instanceFps(prefab, range.count, key.speed > 0 ? key.speed : 1) };
  }
  // As in the game, one pass of a count-frame animation takes count / fps seconds.
  let pos = offset + seconds * instanceFps(prefab, range.count, key.speed);
  let loops = 0;
  let overrun = 0;
  if (key.loop === 'loop') {
    loops = Math.floor(pos / last);
    pos -= loops * last;
  } else if (pos > last) {
    overrun = pos - last;
    pos = last;
  }
  const before = Math.floor(pos);
  const after = Math.min(before + 1, last);
  return { before: range.start + before, after: range.start + after, fraction: before >= last ? 0 : pos - before, loops, ...(overrun ? { overrun } : {}) };
}

/**
 * The prefab cues an instance passes while the scene plays from frame `from` to `to`:
 * cue frames inside the instance's animation that its (unwrapped, looping) position
 * crosses. A layer that appears or restarts its animation also plays cues on its first frame.
 */
export function instanceCueHits<C extends { frame: number }>(layer: SceneLayer, prefab: Prefab, cues: readonly C[], sceneFps: number, from: number, to: number, inclusive: boolean): C[] {
  const pose = evalLayer(layer, Math.max(0, to));
  if (!pose || !pose.visible || pose.key.loop === 'single' || !cues.length) return [];
  const range = animRangeOf({ fps: prefab.fps, tracks: prefab.tracks as ReanimDefinition['tracks'] }, pose.key.anim);
  const last = range.count - 1;
  // Unwrapped position in the animation (frames from its start, counting loops).
  const raw = (f: number, p: LayerPose) => {
    const ft = instanceFrameTime(prefab, p, sceneFps, f);
    return ft.before - range.start + ft.fraction + (ft.loops ?? 0) * last;
  };
  const prevPose = from >= 0 ? evalLayer(layer, from) : null;
  const fresh = !prevPose || !prevPose.visible || prevPose.segmentStart !== pose.segmentStart;
  const a = fresh ? -1e-9 : raw(from, prevPose) - (inclusive ? 1e-9 : 0);
  const b = raw(to, pose);
  const looping = pose.key.loop === 'loop' && last > 0;
  return cues.filter((cue) => {
    const rel = cue.frame - range.start;
    if (rel < 0 || rel > last) return false;
    // In a loop the last frame is the instant the next pass starts (like the reanim editor's
    // looping playback), so only the first frame's cues play there.
    if (looping && rel === last) return false;
    if (a < rel && rel <= b) return true;
    if (!looping) return false;
    // A later pass: rel + k * last inside (a, b].
    const k = Math.ceil((a - rel) / last + 1e-9);
    return k > 0 && rel + k * last <= b;
  });
}

export interface DrawnLayer {
  layerIndex: number;
  /** Screen matrix of the layer (view * layer). */
  matrix: Mat;
  /** Bounds in layer-local space, or null if nothing visible was drawn. */
  local: [number, number, number, number] | null;
  parts: DrawTrackInfo[];
}

export interface SceneDrawOptions {
  hidden?: (layer: SceneLayer) => boolean;
  collect?: DrawnLayer[];
  /** Multiply every layer's alpha (onion skins). */
  alpha?: number;
  drawBackground?: boolean;
}

function boundsOf(parts: DrawTrackInfo[], inv: Mat | null): [number, number, number, number] | null {
  if (!inv || parts.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of parts) {
    for (const [cx, cy] of [
      [0, 0],
      [p.width, 0],
      [0, p.height],
      [p.width, p.height],
    ]) {
      const [sx, sy] = apply(p.matrix, cx, cy);
      const [lx, ly] = apply(inv, sx, sy);
      x0 = Math.min(x0, lx);
      y0 = Math.min(y0, ly);
      x1 = Math.max(x1, lx);
      y1 = Math.max(y1, ly);
    }
  }
  return [x0, y0, x1, y1];
}

/** Draw a scene at a (possibly fractional) frame. `view` maps stage space to the canvas. */
export function drawScene(r: Renderer, res: SceneResolver, scene: SceneState, frame: number, view: Readonly<Mat>, opts: SceneDrawOptions = {}): void {
  const assets = res.assets;
  if (opts.drawBackground !== false) {
    r.fillRect(view, scene.width, scene.height, hexToRgba(scene.background), 'normal');
    if (scene.backgroundImage) {
      const img = assets.image(scene.backgroundImage);
      if (img) {
        const m = mul(view, [scene.width / img.celWidth, 0, 0, scene.height / img.celHeight, 0, 0]);
        r.drawImage(img, 0, 0, img.celWidth, img.celHeight, m, [1, 1, 1, 1], 'normal');
      }
    }
  }
  const alphaMul = opts.alpha ?? 1;
  scene.layers.forEach((layer, index) => {
    if (opts.hidden?.(layer)) return;
    const pose = evalLayer(layer, frame);
    if (!pose || !pose.visible || pose.alpha <= 0) return;
    const m = mul(view, poseMatrix(pose));
    const color: RGBA = [pose.tint[0], pose.tint[1], pose.tint[2], Math.max(0, Math.min(1, pose.alpha * alphaMul))];
    const parts: DrawTrackInfo[] = [];
    if (layer.kind === 'reanim') {
      const prefab = res.prefab(layer.source);
      if (prefab) {
        const ft = instanceFrameTime(prefab, pose, scene.fps, frame);
        const range = animRangeOf({ fps: prefab.fps, tracks: prefab.tracks as ReanimDefinition['tracks'] }, pose.key.anim);
        const game = res.gameVisibility ? gameHiddenTracks(prefab.tracks) : null;
        drawReanim(r, assets, prefab.tracks, ft, m, {
          color,
          fps: instanceFps(prefab, range.count, pose.key.speed > 0 ? pose.key.speed : 1),
          range: { start: range.start, end: range.start + range.count - 1 },
          screen: view,
          gameVisibility: res.gameVisibility,
          reanimFor: (p) => res.prefab(p),
          hidden: game?.size ? (i) => game.has(i) : undefined,
          collect: parts,
        });
      } else if (prefab === null) {
        r.fillRect(m, 40, 40, [1, 0.3, 0.6, 0.3 * color[3]], 'normal');
        parts.push({ trackIndex: -1, matrix: m, transform: { ...DEFAULT_TRANSFORM }, width: 40, height: 40 });
      }
    } else if (layer.kind === 'image') {
      const img = assets.image(layer.source);
      if (img) {
        r.drawImage(img, 0, 0, img.celWidth, img.celHeight, m, color, 'normal');
        parts.push({ trackIndex: -1, matrix: m, transform: { ...DEFAULT_TRANSFORM }, width: img.celWidth, height: img.celHeight });
      }
    } else if (layer.kind === 'text') {
      // The text origin is the left end of the baseline, as for reanim text tracks.
      const words = pose.key.text ?? '';
      const box = words.trim() ? drawTextAt(r, assets, words, layer.source, m, color) : null;
      if (box) parts.push({ trackIndex: -1, transform: { ...DEFAULT_TRANSFORM }, ...box });
      // Empty words: a box to click (and double-click to type into), shown only in the editor.
      else if (!words.trim() && opts.collect) parts.push({ trackIndex: -1, matrix: mul(m, [1, 0, 0, 1, 0, -24]), transform: { ...DEFAULT_TRANSFORM }, width: 80, height: 28 });
    } else if (layer.kind === 'particle') {
      const sys = res.particles?.(layer, pose, frame);
      // Particles are simulated in stage space around the emitter (pose.x, pose.y); rotate,
      // scale and flip them about the emitter like the rest of the layer.
      if (sys) sys.draw(r, assets, mul(m, [1, 0, 0, 1, -pose.x, -pose.y]), color);
      // A small handle area so emitters can be selected and dragged.
      parts.push({ trackIndex: -1, matrix: m, transform: { ...DEFAULT_TRANSFORM }, width: 0, height: 0 });
    }
    if (opts.collect) {
      let local = boundsOf(
        parts.filter((p) => p.width > 0),
        invert(m),
      );
      if (layer.kind === 'particle') local = [-14, -14, 14, 14];
      opts.collect.push({ layerIndex: index, matrix: m, local, parts });
    }
  });
}

export function hexToRgba(hex: string): RGBA {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.3, 0.54, 0.17, 1];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1];
}

// ---------------------------------------------------------------- baking

export interface BakeResult {
  definition: ReanimDefinition;
  warnings: string[];
  /** Scene frames where the instances' prefab sound cues play. */
  soundCues: SoundCueLike[];
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'layer';
}

/**
 * Flatten a scene into a single reanim: every part of every instance becomes a
 * track whose per-frame transform is the instance transform composed with the
 * part's own. Reanim transforms can express any 2D affine matrix, so this is exact.
 */
export function bakeScene(scene: SceneState, res: SceneResolver, imageIdFor: (layer: SceneLayer) => string = (l) => l.source): BakeResult {
  const warnings: string[] = [];
  const n = scene.length;
  const tracks: ReanimDefinition['tracks'] = [];
  const used = new Set<string>(['fullscreen']);
  const unique = (name: string) => {
    let out = name;
    let i = 2;
    while (used.has(out.toLowerCase())) out = `${name}_${i++}`;
    used.add(out.toLowerCase());
    return out;
  };
  const hidden = (): ReanimTransform => ({ ...DEFAULT_TRANSFORM, f: -1 });
  let tinted = false;
  let textColored = false;

  // One anim track covering the whole scene, so the game can play it by name.
  tracks.push({ name: unique('anim_scene'), transforms: Array.from({ length: n }, () => ({ ...DEFAULT_TRANSFORM, f: 0 })) });

  for (const layer of scene.layers) {
    const base = sanitize(layer.name);
    if (layer.kind === 'particle') {
      warnings.push(`Particle layer "${layer.name}" was skipped: reanims cannot contain particle effects.`);
      continue;
    }
    if (layer.kind === 'image') {
      const transforms: ReanimTransform[] = [];
      for (let f = 0; f < n; f++) {
        const pose = evalLayer(layer, f);
        if (!pose || !pose.visible) {
          transforms.push(hidden());
          continue;
        }
        if (pose.tint.some((c) => Math.abs(c - 1) > 1e-3)) tinted = true;
        const d = decomposeMatrix(poseMatrix(pose));
        transforms.push({ ...DEFAULT_TRANSFORM, ...d, a: pose.alpha, i: imageIdFor(layer) });
      }
      tracks.push({ name: unique(base), transforms });
      continue;
    }
    if (layer.kind === 'text') {
      // A reanim text track: the game draws it in the given font, in white unless code tints it.
      const transforms: ReanimTransform[] = [];
      for (let f = 0; f < n; f++) {
        const pose = evalLayer(layer, f);
        if (!pose || !pose.visible || !pose.key.text) {
          transforms.push({ ...hidden(), font: layer.source, text: pose?.key.text ?? '' });
          continue;
        }
        if (pose.tint.some((c) => Math.abs(c - 1) > 1e-3)) textColored = true;
        const d = decomposeMatrix(poseMatrix(pose));
        transforms.push({ ...DEFAULT_TRANSFORM, ...d, a: pose.alpha, font: layer.source, text: pose.key.text });
      }
      tracks.push({ name: unique(base), transforms });
      continue;
    }
    const prefab = res.prefab(layer.source);
    if (!prefab) {
      warnings.push(`Prefab "${layer.source}" for layer "${layer.name}" is not loaded; it was skipped.`);
      continue;
    }
    const game = res.gameVisibility ? gameHiddenTracks(prefab.tracks) : null;
    prefab.tracks.forEach((track, ti) => {
      if (isRangeTrack(track) || track.transforms.length === 0 || game?.has(ti)) return;
      const transforms: ReanimTransform[] = [];
      const fullscreen = track.name.toLowerCase() === 'fullscreen';
      let any = false;
      for (let f = 0; f < n; f++) {
        const pose = evalLayer(layer, f);
        if (!pose || !pose.visible) {
          transforms.push(hidden());
          continue;
        }
        if (pose.tint.some((c) => Math.abs(c - 1) > 1e-3)) tinted = true;
        const ft = instanceFrameTime(prefab, pose, scene.fps, f);
        const t = interpolateTransform(track.transforms, ft);
        if (Math.round(t.f) < 0 || (!t.i && !t.text && !fullscreen)) {
          transforms.push({ ...t, f: -1 });
          continue;
        }
        any = true;
        // A fullscreen fill ignores its transform in the game; only its alpha (and colour) matter.
        if (fullscreen) transforms.push({ ...t, f: 0, a: t.a * pose.alpha });
        else transforms.push({ ...t, ...decomposeMatrix(mul(poseMatrix(pose), transformMatrix(t))), f: 0, a: t.a * pose.alpha });
      }
      // The game only treats tracks named attacher__* as attachers and "fullscreen" as a
      // screen fill, so keep those names (several tracks may share "fullscreen").
      const attacher = track.name.toLowerCase().startsWith('attacher__');
      const name = fullscreen ? 'fullscreen' : unique(attacher ? `attacher__${base}_${tracks.length}` : `${base}_${sanitize(track.name)}`);
      if (any) tracks.push({ name, transforms });
    });
  }
  if (tinted) warnings.push('Tints were dropped: the reanim format has no per-track color.');
  if (textColored) warnings.push('Text colors were dropped: reanim text is drawn in the font\'s own colors (white for most PvZ fonts).');
  // Round to keep files small.
  for (const t of tracks) {
    for (const tr of t.transforms) {
      tr.x = round(tr.x, 2);
      tr.y = round(tr.y, 2);
      tr.kx = round(tr.kx, 2);
      tr.ky = round(tr.ky, 2);
      tr.sx = round(tr.sx, 4);
      tr.sy = round(tr.sy, 4);
      tr.a = round(tr.a, 3);
    }
  }
  // Prefab sound cues, at the scene frames where each instance plays them.
  const soundCues: SoundCueLike[] = [];
  for (const layer of scene.layers) {
    const cues = layer.kind === 'reanim' ? (res.soundCues?.(layer.source) ?? []) : [];
    const prefab = cues.length ? res.prefab(layer.source) : null;
    if (!prefab) continue;
    for (let f = 0; f < n; f++) {
      for (const cue of instanceCueHits(layer, prefab, cues, scene.fps, f === 0 ? -1 : f - 1, f, f === 0)) soundCues.push({ frame: f, sound: cue.sound, volume: cue.volume });
    }
  }
  return { definition: { fps: scene.fps, tracks }, warnings, soundCues };
}

function round(v: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}
