/**
 * Reanim playback and drawing, mirroring the game's Reanimation class:
 * frame-time computation, transform interpolation and matrix construction.
 */

import { isAnimTrackName, parseAttacher, type ReanimDefinition, type ReanimTransform } from '../formats/reanim';
import type { AssetLibrary } from './assets';
import { DEG, mul, type Mat } from './math';
import { textImage, type Renderer, type RGBA } from './renderer';

export type LoopMode = 'loop' | 'loopFullLastFrame' | 'once' | 'onceAndHold' | 'onceFullLastFrame' | 'onceAndHoldFullLastFrame';

export const LOOP_MODES: { id: LoopMode; label: string }[] = [
  { id: 'loop', label: 'Loop' },
  { id: 'loopFullLastFrame', label: 'Loop (full last frame)' },
  { id: 'once', label: 'Play once' },
  { id: 'onceAndHold', label: 'Play once & hold' },
  { id: 'onceFullLastFrame', label: 'Play once (full last frame)' },
  { id: 'onceAndHoldFullLastFrame', label: 'Play once & hold (full last frame)' },
];

export function isFullLastFrame(mode: LoopMode): boolean {
  return mode.endsWith('FullLastFrame');
}

export function isLooping(mode: LoopMode): boolean {
  return mode === 'loop' || mode === 'loopFullLastFrame';
}

export interface FrameTime {
  before: number;
  after: number;
  fraction: number;
}

/** Reanimation::GetFrameTime. animTime is 0..1 over the range. */
export function computeFrameTime(frameStart: number, frameCount: number, animTime: number, fullLastFrame: boolean): FrameTime {
  const span = fullLastFrame ? frameCount : frameCount - 1;
  const pos = frameStart + span * animTime;
  const beforeF = Math.floor(pos);
  const fraction = pos - beforeF;
  let before = beforeF;
  let after: number;
  const last = frameStart + frameCount - 1;
  if (before >= last) {
    before = last;
    after = last;
  } else {
    after = before + 1;
  }
  return { before, after, fraction };
}

/** Duration in seconds of one pass through a range. */
export function rangeDuration(frameCount: number, fps: number, fullLastFrame: boolean): number {
  const span = fullLastFrame ? frameCount : frameCount - 1;
  return Math.max(span, 1) / Math.max(fps, 0.001);
}

/** Reanimation::GetTransformAtTime. */
export function interpolateTransform(transforms: ReanimTransform[], ft: FrameTime, truncateDisappearing = true): ReanimTransform {
  const a = transforms[Math.min(ft.before, transforms.length - 1)];
  const b = transforms[Math.min(ft.after, transforms.length - 1)];
  const f = ft.fraction;
  const out: ReanimTransform = {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    kx: a.kx + (b.kx - a.kx) * f,
    ky: a.ky + (b.ky - a.ky) * f,
    sx: a.sx + (b.sx - a.sx) * f,
    sy: a.sy + (b.sy - a.sy) * f,
    a: a.a + (b.a - a.a) * f,
    f: a.f,
    i: a.i,
    font: a.font,
    text: a.text,
  };
  if (truncateDisappearing && a.f !== -1 && b.f === -1 && f > 0) out.f = -1;
  return out;
}

/** Reanimation::MatrixFromTransform. */
export function transformMatrix(t: ReanimTransform): Mat {
  const skx = -t.kx * DEG;
  const sky = -t.ky * DEG;
  return [Math.cos(skx) * t.sx, -Math.sin(skx) * t.sx, Math.sin(sky) * t.sy, Math.cos(sky) * t.sy, t.x, t.y];
}

/** Extract reanim fields (x, y, kx, ky, sx, sy) from a matrix built by transformMatrix. */
export function decomposeMatrix(m: Readonly<Mat>): { x: number; y: number; kx: number; ky: number; sx: number; sy: number } {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  const kx = Math.atan2(m[1], m[0]) / DEG;
  const ky = Math.atan2(-m[2], m[3]) / DEG;
  return { x: m[4], y: m[5], kx, ky, sx, sy };
}

export interface DrawTrackInfo {
  trackIndex: number;
  matrix: Mat;
  transform: ReanimTransform;
  width: number;
  height: number;
}

export interface DrawOptions {
  /** Tracks hidden in the editor. */
  hidden?: (trackIndex: number) => boolean;
  color?: RGBA;
  /** Per-track alpha multiplier (onion skins). */
  alpha?: number;
  /** Seconds since playback start, used for attacher sub-animations. */
  clock?: number;
  /** Collect the drawn tracks (for hit testing / gizmos). */
  collect?: DrawTrackInfo[];
  tint?: (trackIndex: number) => RGBA | null;
  /** Recursion guard for attachers. */
  depth?: number;
  truncateDisappearing?: boolean;
}

export interface TrackLike {
  name: string;
  transforms: ReanimTransform[];
}

/** Draw all tracks of a reanim at a given frame time. */
export function drawReanim(
  r: Renderer,
  assets: AssetLibrary,
  tracks: TrackLike[],
  ft: FrameTime,
  base: Readonly<Mat>,
  opts: DrawOptions = {},
): void {
  const color = opts.color ?? [1, 1, 1, 1];
  const alphaMul = opts.alpha ?? 1;
  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti];
    if (opts.hidden?.(ti)) continue;
    if (track.transforms.length === 0 || isAnimTrackName(track.name)) continue;
    const t = interpolateTransform(track.transforms, ft, opts.truncateDisappearing ?? true);
    if (Math.round(t.f) < 0) continue;
    const alpha = Math.max(0, Math.min(1, t.a * color[3] * alphaMul));
    if (alpha <= 0) continue;
    const m = mul(base, transformMatrix(t));
    const tint = opts.tint?.(ti) ?? null;
    const c: RGBA = tint ? [color[0] * tint[0], color[1] * tint[1], color[2] * tint[2], alpha * tint[3]] : [color[0], color[1], color[2], alpha];

    if (t.i) {
      const img = assets.image(t.i);
      if (img) {
        r.drawImage(img, 0, 0, img.celWidth, img.celHeight, m, c, 'normal');
        opts.collect?.push({ trackIndex: ti, matrix: m, transform: t, width: img.celWidth, height: img.celHeight });
      } else if (img === null) {
        // Missing image: draw a placeholder so the part can still be selected.
        r.fillRect(m, 24, 24, [1, 0.2, 0.6, 0.35 * alpha], 'normal');
        opts.collect?.push({ trackIndex: ti, matrix: m, transform: t, width: 24, height: 24 });
      }
    } else if (t.text) {
      const img = textImage(t.text, t.font);
      r.drawImage(img, 0, 0, img.width, img.height, m, c, 'normal');
      opts.collect?.push({ trackIndex: ti, matrix: m, transform: t, width: img.width, height: img.height });
    }

    // Attachers: "attacher__ReanimName__anim_name[tags]" in the track name or text.
    if ((opts.depth ?? 0) < 3 && track.name.toLowerCase().startsWith('attacher__')) {
      const info = parseAttacher(t.text || track.name);
      if (info) drawAttacher(r, assets, info.reanimName, info.trackName, info.fps, info.loop, m, opts, alpha);
    }
  }
}

function drawAttacher(
  r: Renderer,
  assets: AssetLibrary,
  reanimName: string,
  animName: string,
  fps: number,
  loop: 'loop' | 'once' | 'hold',
  m: Mat,
  opts: DrawOptions,
  alpha: number,
) {
  const path = assets.findReanimPath(reanimName);
  if (!path) return;
  const def = assets.reanim(path);
  if (!def) return;
  const range = animRangeOf(def, animName);
  const dur = rangeDuration(range.count, fps, false);
  const clock = opts.clock ?? 0;
  let animTime = dur > 0 ? clock / dur : 0;
  if (loop === 'loop') animTime -= Math.floor(animTime);
  else animTime = Math.min(1, animTime);
  const ft = computeFrameTime(range.start, range.count, animTime, false);
  drawReanim(r, assets, def.tracks, ft, m, { clock, depth: (opts.depth ?? 0) + 1, alpha: alpha * (opts.alpha ?? 1) });
}

export function animRangeOf(def: ReanimDefinition, animName: string): { start: number; count: number } {
  const total = def.tracks.reduce((mx, t) => Math.max(mx, t.transforms.length), 0);
  if (!animName) return { start: 0, count: Math.max(1, total) };
  const track = def.tracks.find((t) => t.name.toLowerCase() === animName.toLowerCase());
  if (!track) return { start: 0, count: Math.max(1, total) };
  let start = -1;
  let end = -1;
  track.transforms.forEach((t, i) => {
    if (t.f >= 0) {
      if (start < 0) start = i;
      end = i;
    }
  });
  if (start < 0) return { start: 0, count: Math.max(1, total) };
  return { start, count: end - start + 1 };
}
