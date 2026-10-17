import { describe, expect, it } from 'vitest';
import { cameraFrameMatrix, cameraMatrix, evalCamera, SceneDocument } from '../src/editor/sceneDoc';
import { bakeScene, drawScene } from '../src/engine/sceneRuntime';
import { AssetLibrary, type LoadedImage } from '../src/engine/assets';
import { apply, mul, type Mat } from '../src/engine/math';
import type { Renderer } from '../src/engine/renderer';

const img: LoadedImage = { path: 'x.png', source: {} as ImageBitmap, width: 10, height: 10, rows: 1, cols: 1, celWidth: 10, celHeight: 10, serial: 1 };

/** A scene 800x600 with one image layer at (100, 50) and a camera. */
function scene() {
  const doc = SceneDocument.create('S');
  doc.addLayer('image', 'IMAGE_X', 'Pic', { x: 100, y: 50 }, 0);
  const cam = doc.addCamera();
  return { doc, cam };
}

const close = (p: [number, number], q: [number, number]) => {
  expect(p[0]).toBeCloseTo(q[0], 6);
  expect(p[1]).toBeCloseTo(q[1], 6);
};

describe('scene camera', () => {
  it('frames the whole stage when added, as the top layer, one per scene', () => {
    const { doc, cam } = scene();
    expect(cam).toBe(1);
    expect(doc.addCamera()).toBe(1);
    expect(doc.state.layers.filter((l) => l.kind === 'camera')).toHaveLength(1);
    const c = evalCamera(doc.state, 0)!;
    expect(c).toMatchObject({ x: 400, y: 300, rotation: 0, zoom: 1, fade: 0 });
    expect(cameraMatrix(doc.state, c).map((v) => v + 0)).toEqual([1, 0, 0, 1, 0, 0]);
    // No camera (or a blank camera key): the world as it is.
    expect(evalCamera(SceneDocument.create('E').state, 0)).toBeNull();
    doc.setKey(cam, 10, { visible: false }, 'off');
    expect(evalCamera(doc.state, 10)).toBeNull();
  });

  it('zooms about the view centre and turns the world the other way', () => {
    const { doc, cam } = scene();
    doc.setKey(cam, 0, { scaleX: 0.5, scaleY: 0.5 }, 'zoom');
    let m = cameraMatrix(doc.state, evalCamera(doc.state, 0)!);
    close(apply(m, 410, 300), [420, 300]);
    close(apply(m, 400, 300), [400, 300]);
    doc.setKey(cam, 0, { scaleX: 1, scaleY: 1, rotation: 90 }, 'turn');
    m = cameraMatrix(doc.state, evalCamera(doc.state, 0)!);
    // Turning the camera clockwise turns the world anticlockwise: right of centre moves up.
    close(apply(m, 410, 300), [400, 290]);
  });

  it("maps its frame's corners onto the stage corners", () => {
    const { doc, cam } = scene();
    doc.setKey(cam, 0, { x: 250, y: 120, rotation: 30, scaleX: 0.4, scaleY: 0.4 }, 'move');
    const c = evalCamera(doc.state, 0)!;
    const m = mul(cameraMatrix(doc.state, c), cameraFrameMatrix(c));
    close(apply(m, -400, -300), [0, 0]);
    close(apply(m, 400, 300), [800, 600]);
    close(apply(m, 0, 0), [400, 300]);
  });

  it('follows a layer, keeping its place when following starts and when the layer is deleted', () => {
    const { doc, cam } = scene();
    doc.setKey(0, 30, { x: 400, y: 50 }, 'move pic');
    doc.setCameraFollow(cam, 0, doc.state.layers[0].uid);
    // The camera did not jump: its key now holds an offset from the picture.
    expect(doc.state.layers[cam].keys[0]).toMatchObject({ x: 300, y: 250, follow: doc.state.layers[0].uid });
    expect(evalCamera(doc.state, 0)).toMatchObject({ x: 400, y: 300 });
    // …and it moves with the picture.
    expect(evalCamera(doc.state, 30)!.x).toBeCloseTo(700);
    doc.removeLayer(0);
    const k = doc.state.layers[0].keys[0];
    expect(k).toMatchObject({ x: 400, y: 300, follow: 0 });
  });

  it('pans smoothly from a free key to a following one', () => {
    const { doc, cam } = scene();
    doc.setKey(cam, 0, { ease: 'linear' }, 'linear');
    doc.setKey(cam, 10, { x: 0, y: 0, follow: doc.state.layers[0].uid }, 'follow');
    // Halfway between the stage centre and the picture at (100, 50).
    expect(evalCamera(doc.state, 5)).toMatchObject({ x: 250, y: 175 });
    expect(evalCamera(doc.state, 10)).toMatchObject({ x: 100, y: 50 });
    // A key made mid-pan stays on the path (its x/y are a world position, as its key follows nothing).
    doc.setKey(cam, 5, {}, 'key');
    expect(doc.state.layers[cam].keys[1]).toMatchObject({ frame: 5, x: 250, y: 175, follow: 0 });
    expect(evalCamera(doc.state, 5)).toMatchObject({ x: 250, y: 175 });
  });

  it('shakes deterministically within its strength', () => {
    const { doc, cam } = scene();
    doc.setKey(cam, 0, { shake: 10, ease: 'hold' }, 'shake');
    const xs = Array.from({ length: 30 }, (_, f) => evalCamera(doc.state, f)!);
    expect(xs.map((c) => c.x)).toEqual(Array.from({ length: 30 }, (_, f) => evalCamera(doc.state, f)!.x));
    expect(new Set(xs.map((c) => Math.round(c.x))).size).toBeGreaterThan(5);
    for (const c of xs) {
      expect(Math.abs(c.x - 400)).toBeLessThanOrEqual(10);
      expect(Math.abs(c.y - 300)).toBeLessThanOrEqual(10);
    }
  });

  it('makes preset moves from the pose at the playhead', () => {
    const { doc, cam } = scene();
    doc.state.length = 40;
    expect(doc.cameraPreset(cam, 20, 'pushIn')).toBe(true);
    // One second at 30 fps, past the old end: the scene grows.
    expect(doc.state.length).toBe(51);
    const keys = doc.state.layers[cam].keys;
    expect(keys.map((k) => k.frame)).toEqual([0, 20, 50]);
    expect(evalCamera(doc.state, 50)!.zoom).toBeCloseTo(1.5);
    expect(evalCamera(doc.state, 20)!.zoom).toBeCloseTo(1);
    doc.undo();
    expect(doc.state.layers[cam].keys).toHaveLength(1);
    expect(doc.state.length).toBe(40);

    // Static holds the camera until the next key.
    doc.cameraPreset(cam, 0, 'static');
    expect(doc.state.layers[cam].keys[0].ease).toBe('hold');

    // Shake starts at full strength (no ramp up from the previous key) and settles in half a second.
    doc.setKey(cam, 0, { ease: 'easeInOut' }, 'ease');
    doc.cameraPreset(cam, 10, 'shake');
    expect(doc.state.layers[cam].keys.map((k) => [k.frame, k.shake])).toEqual([
      [0, 0],
      [9, 0],
      [10, 12],
      [25, 0],
    ]);

    doc.cameraPreset(cam, 30, 'panRight');
    expect(evalCamera(doc.state, 60)!.x).toBeCloseTo(800);
    doc.cameraPreset(cam, 60, 'reset');
    expect(evalCamera(doc.state, 60)).toMatchObject({ x: 400, y: 300, zoom: 1, rotation: 0 });
  });

  it('bakes through the camera', () => {
    const { doc, cam } = scene();
    doc.setKey(cam, 0, { scaleX: 0.5, scaleY: 0.5, tint: [1, 0.5, 0.5] }, 'zoom');
    doc.state.length = 2;
    const { definition, warnings } = bakeScene(doc.state, { assets: new AssetLibrary(), prefab: () => null });
    // The picture at (100, 50) is twice as far from the centre and twice as big.
    expect(definition.tracks[1].transforms[0]).toMatchObject({ x: -200, y: -200, sx: 2, sy: 2 });
    expect(definition.tracks).toHaveLength(2);
    expect(warnings.some((w) => /color filter/.test(w))).toBe(true);
  });

  it('draws the world through the camera, or the camera frame in world view', () => {
    const { doc, cam } = scene();
    doc.setKey(cam, 0, { x: 500, scaleX: 0.5, scaleY: 0.5, alpha: 0.75, tint: [1, 0, 0] }, 'cam');
    const draws: { m: Mat; color: number[] }[] = [];
    const fills: number[][] = [];
    const r = {
      drawImage: (_i: LoadedImage, _sx: number, _sy: number, _sw: number, _sh: number, m: Mat, color: number[]) => void draws.push({ m, color }),
      fillRect: (_m: Mat, _w: number, _h: number, color: number[]) => void fills.push(color),
    } as unknown as Renderer;
    const res = { assets: { image: () => img } as unknown as AssetLibrary, prefab: () => null };
    const I: Mat = [1, 0, 0, 1, 0, 0];
    drawScene(r, res, doc.state, 0, I);
    expect(draws[0].m).toEqual([2, 0, 0, 2, 400 + 2 * (100 - 500), 300 + 2 * (50 - 300)]);
    expect(draws[0].color).toEqual([1, 0, 0, 1]);
    // Background, then the fade to black on top.
    expect(fills[fills.length - 1]).toEqual([0, 0, 0, 0.25]);

    draws.length = 0;
    fills.length = 0;
    const collect: { layerIndex: number; matrix: Mat }[] = [];
    drawScene(r, res, doc.state, 0, I, { camera: false, cameraFrame: true, collect: collect as never });
    expect(draws[0].m).toEqual([1, 0, 0, 1, 100, 50]);
    expect(fills).toHaveLength(1);
    const frame = collect.find((c) => c.layerIndex === cam)!;
    close(apply(frame.matrix, -400, -300), [300, 150]);
    close(apply(frame.matrix, 400, 300), [700, 450]);
  });
});
