import { describe, expect, it } from 'vitest';
import { DEFAULT_TRANSFORM, getAnimRanges, isRangeTrack, type ReanimDefinition, type ReanimTransform } from '../src/formats/reanim';
import { drawReanim, type DrawTrackInfo } from '../src/engine/reanimRuntime';
import type { AssetLibrary, LoadedImage } from '../src/engine/assets';
import type { Renderer } from '../src/engine/renderer';
import type { Mat } from '../src/engine/math';

const tr = (p: Partial<ReanimTransform>): ReanimTransform => ({ ...DEFAULT_TRANSFORM, ...p });

const img: LoadedImage = { path: 'x.png', source: {} as ImageBitmap, width: 1, height: 1, rows: 1, cols: 1, celWidth: 1, celHeight: 1, serial: 1 };

/** Records the translation of every drawn image. */
function recorder(): Renderer & { xs: number[] } {
  const xs: number[] = [];
  return {
    xs,
    canvas: {} as HTMLCanvasElement,
    kind: 'canvas2d',
    resize() {},
    begin() {},
    drawImage(_i: LoadedImage, _sx: number, _sy: number, _sw: number, _sh: number, m: Readonly<Mat>) {
      xs.push(Math.round(m[4] * 1000) / 1000);
    },
    fillRect() {},
    end() {},
    dispose() {},
    readPixels: () => ({}) as ImageData,
  };
}

function assets(child?: ReanimDefinition): AssetLibrary {
  return {
    image: () => img,
    findReanimPath: (name: string) => (child && name.toLowerCase() === 'child' ? 'reanim/Child.reanim' : undefined),
    reanim: () => child,
  } as unknown as AssetLibrary;
}

const at = (f: number) => ({ before: f, after: f, fraction: 0 });

describe('anim_ tracks', () => {
  const tracks = [
    { name: 'anim_idle', transforms: [tr({ f: 0 }), tr({ f: 0 })] },
    { name: 'anim_head1', transforms: [tr({ i: 'IMAGE_REANIM_ZOMBIE_HEAD' }), tr({ i: 'IMAGE_REANIM_ZOMBIE_HEAD' })] },
  ];

  it('only treats image-less anim_ tracks as ranges', () => {
    expect(isRangeTrack(tracks[0])).toBe(true);
    expect(isRangeTrack(tracks[1])).toBe(false);
    expect(getAnimRanges(tracks).map((r) => r.name)).toEqual(['anim_idle']);
  });

  it('draws anim_ tracks that have images, like the game (zombie heads)', () => {
    const collect: DrawTrackInfo[] = [];
    drawReanim(recorder(), assets(), tracks, at(0), [1, 0, 0, 1, 0, 0], { collect });
    expect(collect.map((c) => c.trackIndex)).toEqual([1]);
  });

  it('does not draw text without a font (attacher specs live in the text)', () => {
    const collect: DrawTrackInfo[] = [];
    drawReanim(recorder(), assets(), [{ name: 'attacher__Child', transforms: [tr({ text: 'attacher__Nope__anim_x' })] }], at(0), [1, 0, 0, 1, 0, 0], { collect });
    expect(collect).toEqual([]);
  });
});

describe('attachers', () => {
  // Child reanim: anim_a = frames 0-3, anim_b = frames 4-7, "part" sits at x = frame index.
  const child: ReanimDefinition = {
    fps: 12,
    tracks: [
      { name: 'anim_a', transforms: [0, 0, 0, 0, -1, -1, -1, -1].map((f) => tr({ f })) },
      { name: 'anim_b', transforms: [-1, -1, -1, -1, 0, 0, 0, 0].map((f) => tr({ f })) },
      { name: 'part', transforms: [0, 1, 2, 3, 4, 5, 6, 7].map((x) => tr({ x, i: 'IMAGE_X' })) },
    ],
  };
  const specs = ['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b', '', 'a'];
  const parent = [
    {
      name: 'attacher__Child',
      transforms: specs.map((s) => (s ? tr({ text: `attacher__Child__anim_${s}[10]` }) : tr({ f: -1, text: '' }))),
    },
  ];
  const xAt = (frame: number) => {
    const r = recorder();
    drawReanim(r, assets(child), parent, at(frame), [1, 0, 0, 1, 0, 0], { fps: 10 });
    return r.xs[0];
  };

  it('times the attached animation from where the attacher appeared', () => {
    // Parent at 10 fps, child at 10 fps over 4 frames: animTime = 0.2 s * 10 / 4 = 0.5 -> frame 1.5.
    expect(xAt(0)).toBe(0);
    expect(xAt(2)).toBe(1.5);
  });

  it('restarts and blends when the attacher switches animation', () => {
    // At the switch the old pose (anim_a wrapped back to frame 0) is fully blended in.
    expect(xAt(4)).toBe(0);
    // 0.1 s later: anim_b at 4.75, half-way blended towards 0.
    expect(xAt(5)).toBe(2.375);
    // After the 0.2 s blend only anim_b remains.
    expect(xAt(6)).toBe(5.5);
  });

  it('starts over when the attacher reappears after being hidden', () => {
    expect(xAt(8)).toBeUndefined();
    expect(xAt(9)).toBe(0);
  });

  const run = (texts: string[], frame: number, opts: { rangeStart?: number } = {}) => {
    const r = recorder();
    const tracks = [{ name: 'attacher__Child', transforms: texts.map((text) => tr({ text })) }];
    drawReanim(r, assets(child), tracks, at(frame), [1, 0, 0, 1, 0, 0], { fps: 10, ...opts });
    return r.xs[0];
  };

  it('applies a tempo change without restarting', () => {
    // 0.1 s at 10 fps then 0.1 s at 20 fps over 4 frames: (1 + 2) / 4 = 0.75 -> frame 2.25.
    expect(run(['attacher__Child__anim_a[10]', 'attacher__Child__anim_a[20]', 'attacher__Child__anim_a[20]'], 2)).toBe(2.25);
  });

  it('drops [once] attachments when they finish but holds [hold] ones', () => {
    const once = Array(6).fill('attacher__Child__anim_a[10][once]');
    expect(run(once, 3)).toBe(2.25);
    expect(run(once, 4)).toBeUndefined();
    expect(run(Array(6).fill('attacher__Child__anim_a[10][hold]'), 5)).toBe(3);
  });

  it('times attachers from the start of the animation being played', () => {
    const texts = Array(8).fill('attacher__Child__anim_a[10]');
    expect(run(texts, 6)).toBe(1.5);
    expect(run(texts, 6, { rangeStart: 4 })).toBe(1.5);
    expect(run(texts, 6, { rangeStart: 6 })).toBe(0);
  });

  it('collects attached parts under the attacher track', () => {
    const collect: DrawTrackInfo[] = [];
    drawReanim(recorder(), assets(child), parent, at(0), [1, 0, 0, 1, 0, 0], { fps: 10, collect });
    expect(collect.map((c) => [c.trackIndex, c.attached])).toEqual([[0, true]]);
  });
});

describe('fullscreen tracks', () => {
  it('fill the 800x600 screen with the track colour, ignoring the track transform', () => {
    const fills: [number, number, number][] = [];
    const r = { ...recorder(), fillRect: (m: Readonly<Mat>, w: number, hgt: number) => void fills.push([m[4], w, hgt]) };
    drawReanim(r, assets(), [{ name: 'fullscreen', transforms: [tr({ x: 50, a: 0.5 })] }], at(0), [1, 0, 0, 1, 7, 0]);
    expect(fills).toEqual([[7, 800, 600]]);
  });
});
