/**
 * Reanim playback and drawing, mirroring the game's Reanimation class:
 * frame-time computation, transform interpolation and matrix construction.
 */

import { parseAttacher, type AttacherInfo, type ReanimDefinition, type ReanimTransform } from '../formats/reanim';
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
  /**
   * How many frames per second `ft` advances at (the reanim's playback rate). Attachers
   * use it to time their animations from the frame where they appeared. Default 12.
   */
  fps?: number;
  /** Cross-fade from another pose of the same tracks (Reanimation::StartBlend); weight 1 = all `from`. */
  blend?: { from: FrameTime; weight: number };
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

/** BlendTransform: mix position/scale/skew/alpha towards `from` by `weight`, taking skew the short way round. */
export function blendTransform(t: ReanimTransform, from: ReanimTransform, weight: number): ReanimTransform {
  const lerp = (a: number, b: number) => a + (b - a) * weight;
  const near = (a: number, b: number) => {
    while (b > a + 180) b -= 360;
    while (b < a - 180) b += 360;
    return b;
  };
  return {
    ...t,
    x: lerp(t.x, from.x),
    y: lerp(t.y, from.y),
    sx: lerp(t.sx, from.sx),
    sy: lerp(t.sy, from.sy),
    kx: lerp(t.kx, near(t.kx, from.kx)),
    ky: lerp(t.ky, near(t.ky, from.ky)),
    a: lerp(t.a, from.a),
  };
}

/**
 * Draw all tracks of a reanim at a given frame time, like Reanimation::Draw: every
 * visible track with an image is drawn, whatever its name (a zombie's head is
 * "anim_head1"); text only when it has a font; attacher__ tracks draw the reanim
 * their text names.
 */
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
  const truncate = opts.truncateDisappearing ?? true;
  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti];
    if (opts.hidden?.(ti)) continue;
    if (track.transforms.length === 0) continue;
    let t = interpolateTransform(track.transforms, ft, truncate);
    if (Math.round(t.f) < 0) continue;
    if (opts.blend && opts.blend.weight > 0) {
      const from = interpolateTransform(track.transforms, opts.blend.from, truncate);
      if (Math.round(from.f) >= 0) t = blendTransform(t, from, opts.blend.weight);
    }
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
        r.fillRect(m, 24, 24, [1, 0.3, 0.6, 0.25 * alpha], 'normal');
        opts.collect?.push({ trackIndex: ti, matrix: m, transform: t, width: 24, height: 24 });
      }
    } else if (t.text && t.font) {
      // The game draws text only with a font; attacher tracks keep their spec in the text.
      const img = textImage(t.text, t.font);
      r.drawImage(img, 0, 0, img.width, img.height, m, c, 'normal');
      opts.collect?.push({ trackIndex: ti, matrix: m, transform: t, width: img.width, height: img.height });
    }

    // Attachers: a track named attacher__* whose text is "attacher__Reanim__anim_name[tags]".
    if ((opts.depth ?? 0) < 3 && t.text && track.name.toLowerCase().startsWith('attacher__')) {
      drawAttacher(r, assets, track.transforms, ft, m, c, opts);
    }
  }
}

/** StartBlend(20): 20 updates of 1/100 s. */
const ATTACHER_BLEND_SECONDS = 0.2;

interface AttacherSegment {
  info: AttacherInfo;
  /** Rate and loop mode are fixed when the attachment is created. */
  rate: number;
  loop: AttacherInfo['loop'];
  /** Frame where the current animation (re)started. */
  start: number;
  trackName: string;
  /** The animation shown before, if the attachment switched animations (for the blend). */
  prev?: { start: number; trackName: string };
}

/**
 * Where the attachment shown at frame `at` came from (Reanimation::UpdateAttacherTrack):
 * a new attached reanim is created when the attacher appears or names another reanim,
 * and its animation restarts (SetFramesForLayer) when the attacher names another track.
 */
function attacherSegment(transforms: ReanimTransform[], at: number): AttacherSegment | null {
  at = Math.max(0, Math.min(at, transforms.length - 1));
  const info = parseAttacher(transforms[at].text);
  if (!info) return null;
  const reanim = info.reanimName.toLowerCase();
  let runStart = at;
  for (let k = at - 1; k >= 0; k--) {
    const t = transforms[k];
    if (Math.round(t.f) < 0) break;
    if (t.text !== transforms[k + 1].text) {
      const other = parseAttacher(t.text);
      if (!other || other.reanimName.toLowerCase() !== reanim) break;
    }
    runStart = k;
  }
  const first = parseAttacher(transforms[runStart].text) ?? info;
  let start = runStart;
  let trackName = first.trackName;
  let prev: AttacherSegment['prev'];
  for (let k = runStart + 1; k <= at; k++) {
    if (transforms[k].text === transforms[k - 1].text) continue;
    const next = parseAttacher(transforms[k].text);
    if (next && next.trackName.toLowerCase() !== trackName.toLowerCase()) {
      prev = { start, trackName };
      start = k;
      trackName = next.trackName;
    }
  }
  return { info, rate: first.fps, loop: first.loop, start, trackName, prev };
}

function drawAttacher(r: Renderer, assets: AssetLibrary, transforms: ReanimTransform[], ft: FrameTime, m: Mat, color: RGBA, opts: DrawOptions) {
  const seg = attacherSegment(transforms, ft.before);
  if (!seg) return;
  const path = assets.findReanimPath(seg.info.reanimName);
  if (!path) return;
  const def = assets.reanim(path);
  if (!def) return;
  const parentFps = Math.max(1e-3, opts.fps ?? 12);
  const pos = ft.before + ft.fraction;
  // Reanimation::Update: mAnimTime += SECONDS_PER_UPDATE * mAnimRate / mFrameCount.
  const timeAt = (from: number, trackName: string, until: number): FrameTime => {
    const range = animRangeOf(def, trackName);
    let animTime = ((Math.max(0, until - from) / parentFps) * seg.rate) / Math.max(1, range.count);
    if (seg.loop === 'loop') animTime -= Math.floor(animTime);
    else animTime = Math.min(1, animTime);
    return computeFrameTime(range.start, range.count, animTime, false);
  };
  const cur = timeAt(seg.start, seg.trackName, pos);
  let blend: DrawOptions['blend'];
  if (seg.prev) {
    const since = (pos - seg.start) / parentFps;
    if (since < ATTACHER_BLEND_SECONDS) blend = { from: timeAt(seg.prev.start, seg.prev.trackName, seg.start), weight: 1 - since / ATTACHER_BLEND_SECONDS };
  }
  const range = animRangeOf(def, seg.trackName);
  drawReanim(r, assets, def.tracks, cur, m, {
    color,
    depth: (opts.depth ?? 0) + 1,
    // The attached reanim's frames advance at rate * (count - 1) / count per second.
    fps: (seg.rate * Math.max(1, range.count - 1)) / Math.max(1, range.count),
    blend,
  });
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
