/**
 * Reanim playback and drawing, mirroring the game's Reanimation class:
 * frame-time computation, transform interpolation and matrix construction.
 */

import { parseAttacher, type AttacherInfo, type ReanimDefinition, type ReanimTransform } from '../formats/reanim';
import type { AssetLibrary } from './assets';
import { DEG, mul, type Mat } from './math';
import { creditsHidesTongue } from './gameVisibility';
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
  /** How many times a looping animation has wrapped back to its start before this pass. */
  loops?: number;
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
  /** A part of a reanim drawn by attacher track `trackIndex` (not the track's own image). */
  attached?: boolean;
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
  /**
   * The animation being played (first and last frame). Attachers count time from where
   * they appeared but never from before the animation started, and carry on across a
   * loop when the attacher is unchanged at both ends (see FrameTime.loops).
   */
  range?: { start: number; end: number };
  /** Apply the parts the game hides from code (see gameVisibility.ts) inside attachments. */
  gameVisibility?: boolean;
  /** The game screen's coordinate space (top-left at 0,0), for "fullscreen" tracks. Defaults to `base`. */
  screen?: Readonly<Mat>;
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
    } else if (track.name.toLowerCase() === 'fullscreen') {
      // DrawTrack: a "fullscreen" track fills the 800x600 screen with its colour, ignoring its transform.
      r.fillRect(opts.screen ?? base, SCREEN_W, SCREEN_H, c, 'normal');
    }

    // Attachers: a track named attacher__* whose text is "attacher__Reanim__anim_name[tags]".
    if ((opts.depth ?? 0) < 3 && t.text && track.name.toLowerCase().startsWith('attacher__')) {
      drawAttacher(r, assets, ti, track.transforms, ft, m, c, opts, base);
    }
  }
}

/** StartBlend(20): 20 updates of 1/100 s. */
const ATTACHER_BLEND_SECONDS = 0.2;
const SCREEN_W = 800;
const SCREEN_H = 600;

interface AttacherSegment {
  info: AttacherInfo;
  /** First frame of the run: where the attached reanim was created. */
  runStart: number;
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
function attacherSegment(transforms: ReanimTransform[], at: number, floor: number): AttacherSegment | null {
  at = Math.max(0, Math.min(at, transforms.length - 1));
  const info = parseAttacher(transforms[at].text);
  if (!info) return null;
  const reanim = info.reanimName.toLowerCase();
  floor = Math.max(0, Math.min(floor, at));
  let runStart = at;
  for (let k = at - 1; k >= floor; k--) {
    const t = transforms[k];
    if (Math.round(t.f) < 0) break;
    if (t.text !== transforms[k + 1].text) {
      const other = parseAttacher(t.text);
      if (!other || other.reanimName.toLowerCase() !== reanim) break;
    }
    runStart = k;
  }
  let start = runStart;
  let trackName = (parseAttacher(transforms[runStart].text) ?? info).trackName;
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
  return { info, runStart, start, trackName, prev };
}

/**
 * Passes of the attached animation played between parent frames `from` and `until`,
 * plus the loop mode in force at the end. Like UpdateAttacherTrack, a spec that names a
 * track sets the rate and loop mode on every update (so a tempo change takes effect
 * without a restart); a spec without a track keeps those of `initial`.
 */
function attacherPasses(transforms: ReanimTransform[], from: number, until: number, parentFps: number, count: number, initial: AttacherInfo): { passes: number; loop: AttacherInfo['loop'] } {
  let frames = 0;
  let text: string | undefined;
  let rate = initial.fps;
  let loop = initial.loop;
  for (let k = from; k < until; k++) {
    const t = transforms[Math.min(k, transforms.length - 1)].text;
    if (t !== text) {
      text = t;
      const spec = parseAttacher(t);
      if (spec?.trackName) {
        rate = spec.fps;
        loop = spec.loop;
      }
    }
    frames += (Math.min(k + 1, until) - k) * rate;
  }
  // Reanimation::Update: mAnimTime += SECONDS_PER_UPDATE * mAnimRate / mFrameCount.
  return { passes: frames / parentFps / Math.max(1, count), loop };
}

function drawAttacher(r: Renderer, assets: AssetLibrary, ti: number, transforms: ReanimTransform[], ft: FrameTime, m: Mat, color: RGBA, opts: DrawOptions, base: Readonly<Mat>) {
  const floor = opts.range?.start ?? 0;
  const seg = attacherSegment(transforms, ft.before, floor);
  if (!seg) return;
  const path = assets.findReanimPath(seg.info.reanimName);
  if (!path) return;
  const def = assets.reanim(path);
  if (!def) return;
  const parentFps = Math.max(1e-3, opts.fps ?? 12);
  const pos = ft.before + ft.fraction;
  const created = parseAttacher(transforms[seg.runStart].text) ?? seg.info;
  const passesOf = (from: number, trackName: string, until: number) => attacherPasses(transforms, from, until, parentFps, animRangeOf(def, trackName).count, created);

  // A looping parent that wrapped with the same attachment at both ends keeps it running.
  let carried = 0;
  const end = opts.range?.end;
  if ((ft.loops ?? 0) > 0 && end !== undefined && end > floor && seg.start === floor && seg.runStart === floor) {
    const tail = attacherSegment(transforms, end, floor);
    if (tail && tail.info.reanimName.toLowerCase() === seg.info.reanimName.toLowerCase() && tail.trackName.toLowerCase() === seg.trackName.toLowerCase()) {
      const pass = passesOf(tail.start, seg.trackName, end).passes;
      // Unchanged through the whole range: it has run since the first pass.
      carried = tail.start === floor ? pass * (ft.loops ?? 0) : pass;
    }
  }

  const timeAt = (from: number, trackName: string, until: number, extra = 0): FrameTime | null => {
    const range = animRangeOf(def, trackName);
    const { passes, loop } = passesOf(from, trackName, until);
    let animTime = passes + extra;
    let loops = 0;
    if (loop === 'loop') {
      loops = Math.floor(animTime);
      animTime -= loops;
    } else if (animTime >= 1) {
      // [once] is REANIM_PLAY_ONCE: the attachment dies when it ends; [hold] keeps the last frame.
      if (loop === 'once') return null;
      animTime = 1;
    }
    return { ...computeFrameTime(range.start, range.count, animTime, false), loops };
  };
  const cur = timeAt(seg.start, seg.trackName, pos, carried);
  if (!cur) return;
  let blend: DrawOptions['blend'];
  if (seg.prev) {
    const since = (pos - seg.start) / parentFps;
    const from = since < ATTACHER_BLEND_SECONDS ? timeAt(seg.prev.start, seg.prev.trackName, seg.start) : null;
    if (from) blend = { from, weight: 1 - since / ATTACHER_BLEND_SECONDS };
  }
  const range = animRangeOf(def, seg.trackName);
  const nested: DrawTrackInfo[] | undefined = opts.collect ? [] : undefined;
  const hideTongue = opts.gameVisibility && creditsHidesTongue(seg.info.reanimName, ti);
  drawReanim(r, assets, def.tracks, cur, m, {
    color,
    depth: (opts.depth ?? 0) + 1,
    // The attached reanim's frames advance at rate * (count - 1) / count per second.
    fps: (seg.info.fps * Math.max(1, range.count - 1)) / Math.max(1, range.count),
    range: { start: range.start, end: range.start + range.count - 1 },
    screen: opts.screen ?? base,
    gameVisibility: opts.gameVisibility,
    hidden: hideTongue ? (i) => def.tracks[i].name.toLowerCase() === 'anim_tongue' : undefined,
    blend,
    collect: nested,
  });
  // Attached parts count as the attacher track's (clicking a dancer selects its attacher).
  if (nested) for (const n of nested) opts.collect!.push({ ...n, trackIndex: ti, attached: true });
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
