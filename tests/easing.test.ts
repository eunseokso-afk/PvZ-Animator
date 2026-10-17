import { describe, expect, it } from 'vitest';
import { CURVE_PRESETS, cubicBezier, curveForEase, evalCurve, insertPoint, normalizeCurve, reverseCurve } from '../src/editor/easeCurve';
import { easeProgress, evalCamera, evalLayer, keyId, SceneDocument } from '../src/editor/sceneDoc';
import { bakeScene } from '../src/engine/sceneRuntime';
import { AssetLibrary } from '../src/engine/assets';

const preset = (id: string) => CURVE_PRESETS.find((p) => p.id === id)!.curve;
const ts = Array.from({ length: 21 }, (_, i) => i / 20);

describe('easing curves', () => {
  it('reproduces the built-in eases exactly', () => {
    for (const ease of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      for (const t of ts) expect(evalCurve(preset(ease), t)).toBeCloseTo(easeProgress({ ease, curve: null }, t), 6);
    }
    expect(evalCurve(curveForEase('hold'), 0.3)).toBeCloseTo(0.3, 6);
  });

  it('bounces like Penner’s bounce', () => {
    const c = preset('bounce');
    for (const t of [4 / 11, 8 / 11, 10 / 11, 1]) expect(evalCurve(c, t)).toBeCloseTo(1, 6);
    expect(evalCurve(c, 2 / 11)).toBeCloseTo(0.25, 6);
    expect(evalCurve(c, 6 / 11)).toBeCloseTo(0.75, 6);
    expect(evalCurve(c, 9 / 11)).toBeCloseTo(0.9375, 6);
    expect(evalCurve(c, 21 / 22)).toBeCloseTo(0.984375, 6);
  });

  it('overshoots and winds up, and always starts at 0 and ends at 1', () => {
    for (const p of CURVE_PRESETS) {
      expect(evalCurve(p.curve, 0)).toBe(0);
      expect(evalCurve(p.curve, 1)).toBe(1);
    }
    expect(Math.max(...ts.map((t) => evalCurve(preset('backOut'), t)))).toBeGreaterThan(1.05);
    expect(Math.min(...ts.map((t) => evalCurve(preset('backIn'), t)))).toBeLessThan(-0.05);
  });

  it('keeps any curve valid: sorted points, fixed ends, handles inside their segments', () => {
    expect(normalizeCurve('junk')).toHaveLength(2);
    const c = normalizeCurve([
      { x: 0.7, y: 0.2, inX: -5, inY: 0, outX: 9, outY: 0 },
      { x: 0.3, y: 9, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 0, y: 0.5, outX: 0.1, outY: 0 },
      { x: 1, y: 0, inX: -0.1, inY: 0 },
    ]);
    expect(c.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [0.3, 2],
      [0.7, 0.2],
      [1, 1],
    ]);
    expect(c[2].inX).toBeCloseTo(-0.4);
    expect(c[2].outX).toBeCloseTo(0.3);
    // One y per time, even for steep, handle-heavy curves.
    let prev = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const v = evalCurve(cubicBezier(0.9, 0, 0.1, 1), i / 200);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it('reverses and splits curves without changing their shape', () => {
    const r = reverseCurve(preset('easeIn'));
    for (const t of ts) expect(evalCurve(r, t)).toBeCloseTo(evalCurve(preset('easeOut'), t), 6);
    const c = preset('strongOut');
    const split = insertPoint(c, 0.4)!;
    expect(split.curve).toHaveLength(3);
    for (const t of ts) expect(evalCurve(split.curve, t)).toBeCloseTo(evalCurve(c, t), 6);
    expect(split.curve[1].x).toBeCloseTo(0.4, 6);
    expect(insertPoint(c, 0.001)).toBeNull();
  });
});

describe('custom eases in scenes', () => {
  function scene() {
    const doc = SceneDocument.create('S');
    doc.addLayer('image', 'IMAGE_X', 'A', { x: 0 }, 0);
    doc.setKey(0, 10, { x: 100 }, 'k');
    return doc;
  }

  it('tweens along the curve, past the ends for wind-ups and overshoots', () => {
    const doc = scene();
    expect(doc.setEases([{ layer: 0, frame: 3 }], 'custom', preset('backIn'))).toBe(1);
    const k = doc.state.layers[0].keys[0];
    expect(k.ease).toBe('custom');
    expect(evalLayer(doc.state.layers[0], 2)!.x).toBeLessThan(0);
    expect(evalLayer(doc.state.layers[0], 10)!.x).toBe(100);
    doc.setEases([{ layer: 0, frame: 0 }], 'custom', preset('backOut'));
    expect(Math.max(...[6, 7, 8, 9].map((f) => evalLayer(doc.state.layers[0], f)!.x))).toBeGreaterThan(100);
    // Baking samples the curve.
    doc.state.length = 11;
    const { definition } = bakeScene(doc.state, { assets: new AssetLibrary(), prefab: () => null });
    expect(definition.tracks[1].transforms[8].x).toBeCloseTo(evalLayer(doc.state.layers[0], 8)!.x, 1);
  });

  it('keeps a key’s curve when switching to a built-in ease and back', () => {
    const doc = scene();
    doc.setEases([{ layer: 0, frame: 0 }], 'custom', preset('bounce'));
    doc.setEases([{ layer: 0, frame: 0 }], 'linear');
    expect(evalLayer(doc.state.layers[0], 5)!.x).toBeCloseTo(50);
    doc.setEases([{ layer: 0, frame: 0 }], 'custom');
    expect(evalLayer(doc.state.layers[0], 10 * (6 / 11))!.x).toBeCloseTo(75);
    // A key that never had a curve starts from its ease's.
    const fresh = scene();
    fresh.setEases([{ layer: 0, frame: 0 }], 'easeIn');
    fresh.setEases([{ layer: 0, frame: 0 }], 'custom');
    expect(evalLayer(fresh.state.layers[0], 5)!.x).toBeCloseTo(25);
  });

  it('eases several tweens at once, in one undo step; splitting a tween keeps its curve', () => {
    const doc = scene();
    doc.addLayer('image', 'IMAGE_X', 'B', { x: 0 }, 0);
    doc.setKey(1, 20, { x: 50 }, 'k');
    expect(doc.setEases([{ layer: 0, frame: 4 }, { layer: 1, frame: 0 }, { layer: 0, frame: 0 }], 'custom', preset('easeOut'))).toBe(2);
    expect(doc.state.layers.map((l) => l.keys[0].ease)).toEqual(['custom', 'custom']);
    doc.undo();
    expect(doc.state.layers.map((l) => l.keys[0].ease)).toEqual(['linear', 'linear']);
    doc.redo();
    doc.setKey(0, 5, {}, 'split');
    expect(doc.state.layers[0].keys[1].ease).toBe('custom');
    expect(doc.state.layers[0].keys[1].curve).not.toBe(doc.state.layers[0].keys[0].curve);
  });

  it('eases camera moves', () => {
    const doc = SceneDocument.create('S');
    const cam = doc.addCamera();
    doc.setKey(cam, 30, { x: 700 }, 'pan');
    doc.setEases([{ layer: cam, frame: 0 }], 'custom', preset('snap'));
    // Snap gets most of the way early.
    expect(evalCamera(doc.state, 6)!.x).toBeGreaterThan(400 + 300 * 0.5);
  });
});

describe('multi-selection', () => {
  function doc3() {
    const doc = SceneDocument.create('S');
    for (const n of ['A', 'B', 'C']) doc.addLayer('image', 'IMAGE_X', n, { x: 0 }, 0);
    doc.setKey(0, 10, { x: 10 }, 'k');
    doc.setKey(1, 10, { x: 10 }, 'k');
    doc.setKey(1, 20, { x: 20 }, 'k');
    return doc;
  }

  it('selects layers: a main one plus extras', () => {
    const doc = doc3();
    doc.selectOnly(0);
    doc.toggleSelected(2);
    expect(doc.ui.layer).toBe(2);
    expect(doc.selectedLayers()).toEqual([2, 0]);
    doc.toggleSelected(2);
    expect(doc.selectedLayers()).toEqual([0]);
    doc.toggleSelected(1, true);
    doc.selectOnly(1);
    expect(doc.selectedLayers()).toEqual([1]);
    expect(doc.isSelected(0)).toBe(false);
  });

  it('moves selected keys together, refusing collisions and the scene’s ends', () => {
    const doc = doc3();
    const a = doc.state.layers[0].uid;
    const b = doc.state.layers[1].uid;
    doc.ui.keys = new Set([keyId(a, 10), keyId(b, 10), keyId(b, 20)]);
    expect(doc.moveKeys(doc.selectedKeys(), 5)).toBe(true);
    expect(doc.state.layers[0].keys.map((k) => k.frame)).toEqual([0, 15]);
    expect(doc.state.layers[1].keys.map((k) => k.frame)).toEqual([0, 15, 25]);
    expect([...doc.ui.keys].sort()).toEqual([keyId(a, 15), keyId(b, 15), keyId(b, 25)].sort());
    expect(doc.undoLabel).toBe('Move keyframes');
    // Onto an unselected key, or off the end: refused.
    expect(doc.moveKeys([{ layer: 1, frame: 15 }], -15)).toBe(false);
    expect(doc.moveKeys(doc.selectedKeys(), 80)).toBe(false);
    doc.undo();
    expect(doc.state.layers[1].keys.map((k) => k.frame)).toEqual([0, 10, 20]);
  });

  it('removes selected keys but keeps first keys', () => {
    const doc = doc3();
    const r = doc.removeKeys([{ layer: 0, frame: 0 }, { layer: 0, frame: 10 }, { layer: 1, frame: 20 }]);
    expect(r).toEqual({ removed: 2, kept: 1 });
    expect(doc.state.layers[0].keys.map((k) => k.frame)).toEqual([0]);
    expect(doc.state.layers[1].keys.map((k) => k.frame)).toEqual([0, 10]);
    doc.undo();
    expect(doc.state.layers[0].keys).toHaveLength(2);
  });

  it('keys, duplicates and deletes several layers in one step each', () => {
    const doc = doc3();
    doc.setKeys(5, [{ layer: 0, patch: { x: 1 } }, { layer: 2, patch: {} }], 'Insert keyframes');
    expect(doc.state.layers[0].keys.map((k) => [k.frame, k.x])).toEqual([
      [0, 0],
      [5, 1],
      [10, 10],
    ]);
    expect(doc.state.layers[2].keys.map((k) => k.frame)).toEqual([0, 5]);
    const copies = doc.duplicateLayers([0, 2]);
    expect(copies).toEqual([1, 4]);
    expect(doc.state.layers.map((l) => l.name)).toEqual(['A', 'A 2', 'B', 'C', 'C 2']);
    expect(doc.undoLabel).toBe('Duplicate layers');
    expect(doc.removeLayers([1, 4])).toBe(2);
    expect(doc.state.layers.map((l) => l.name)).toEqual(['A', 'B', 'C']);
    doc.undo();
    expect(doc.state.layers).toHaveLength(5);
  });

  it('keeps the selection when deleting another layer', () => {
    const doc = doc3();
    doc.selectOnly(2);
    doc.removeLayer(0);
    expect(doc.selectedLayer?.name).toBe('C');
    doc.removeLayer(1);
    expect(doc.ui.layer).toBe(0);
  });
});
