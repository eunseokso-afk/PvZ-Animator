/**
 * Drawing and baking scenes: layers are prefab instances (reanims), particle
 * emitters or images, positioned by their tweened keyframes.
 */

import { DEFAULT_TRANSFORM, isAnimTrackName, type ReanimDefinition, type ReanimTransform } from '../formats/reanim';
import type { LayerPose, SceneLayer, SceneState } from '../editor/sceneDoc';
import { evalLayer, poseMatrix } from '../editor/sceneDoc';
import type { AssetLibrary } from './assets';
import { apply, invert, mul, type Mat } from './math';
import type { ParticleSystem } from './particleSystem';
import { animRangeOf, decomposeMatrix, drawReanim, interpolateTransform, transformMatrix, type DrawTrackInfo, type FrameTime, type TrackLike } from './reanimRuntime';
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
}

/** Which prefab frame an instance shows at a scene frame. */
export function instanceFrameTime(prefab: Prefab, pose: LayerPose, sceneFps: number, frame: number): FrameTime {
  const key = pose.key;
  const range = animRangeOf({ fps: prefab.fps, tracks: prefab.tracks as ReanimDefinition['tracks'] }, key.anim);
  const last = range.count - 1;
  const offset = Math.max(0, Math.min(last, Math.round(key.startFrame)));
  if (key.loop === 'single' || last <= 0) {
    const f = range.start + offset;
    return { before: f, after: f, fraction: 0 };
  }
  const seconds = Math.max(0, frame - pose.segmentStart) / Math.max(1e-6, sceneFps);
  let pos = offset + seconds * prefab.fps * Math.max(0, key.speed);
  if (key.loop === 'loop') pos %= last;
  else pos = Math.min(pos, last);
  const before = Math.floor(pos);
  const after = Math.min(before + 1, last);
  return { before: range.start + before, after: range.start + after, fraction: before >= last ? 0 : pos - before };
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
  /** Seconds of playback, for attacher sub-animations. */
  clock?: number;
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
        drawReanim(r, assets, prefab.tracks, ft, m, { color, clock: opts.clock, collect: parts });
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
    } else if (layer.kind === 'particle') {
      const sys = res.particles?.(layer, pose, frame);
      if (sys) sys.draw(r, assets, view, color);
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
  const used = new Set<string>();
  const unique = (name: string) => {
    let out = name;
    let i = 2;
    while (used.has(out.toLowerCase())) out = `${name}_${i++}`;
    used.add(out.toLowerCase());
    return out;
  };
  const hidden = (): ReanimTransform => ({ ...DEFAULT_TRANSFORM, f: -1 });
  let tinted = false;

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
    const prefab = res.prefab(layer.source);
    if (!prefab) {
      warnings.push(`Prefab "${layer.source}" for layer "${layer.name}" is not loaded; it was skipped.`);
      continue;
    }
    prefab.tracks.forEach((track) => {
      if (isAnimTrackName(track.name) || track.transforms.length === 0) return;
      const transforms: ReanimTransform[] = [];
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
        if (Math.round(t.f) < 0 || (!t.i && !t.text)) {
          transforms.push({ ...t, f: -1 });
          continue;
        }
        any = true;
        const d = decomposeMatrix(mul(poseMatrix(pose), transformMatrix(t)));
        transforms.push({ ...t, ...d, f: 0, a: t.a * pose.alpha });
      }
      if (any) tracks.push({ name: unique(`${base}_${sanitize(track.name)}`), transforms });
    });
  }
  if (tinted) warnings.push('Tints were dropped: the reanim format has no per-track color.');
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
  return { definition: { fps: scene.fps, tracks }, warnings };
}

function round(v: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}
