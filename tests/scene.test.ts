import { describe, expect, it } from 'vitest';
import { defaultKey, evalLayer, poseMatrix, SceneDocument, type SceneLayer } from '../src/editor/sceneDoc';
import { bakeScene, instanceFrameTime, type Prefab } from '../src/engine/sceneRuntime';
import { apply, mul } from '../src/engine/math';
import { DEFAULT_TRANSFORM, parseReanimXml, serializeReanimXml, type ReanimTransform } from '../src/formats/reanim';
import { transformMatrix } from '../src/engine/reanimRuntime';
import { AssetLibrary } from '../src/engine/assets';

const tr = (p: Partial<ReanimTransform>): ReanimTransform => ({ ...DEFAULT_TRANSFORM, ...p });

function layer(keys: Parameters<typeof defaultKey>[1][], frames: number[]): SceneLayer {
  return { uid: 1, name: 'L', kind: 'reanim', source: 'reanim/P.reanim', keys: frames.map((f, i) => defaultKey(f, keys[i])) };
}

// A 6-frame prefab: anim_a = frames 0-2, anim_b = frames 3-5; "part" moves x = frame index.
const prefab: Prefab = {
  fps: 10,
  tracks: [
    { name: 'anim_a', transforms: [0, 0, 0, -1, -1, -1].map((f) => tr({ f })) },
    { name: 'anim_b', transforms: [-1, -1, -1, 0, 0, 0].map((f) => tr({ f })) },
    { name: 'part', transforms: [0, 1, 2, 3, 4, 5].map((x) => tr({ x, i: 'IMAGE_X' })) },
  ],
};

describe('scene layers', () => {
  it('does not exist before its first key and tweens between keys', () => {
    const l = layer([{ x: 0 }, { x: 100, ease: 'linear' }], [10, 20]);
    expect(evalLayer(l, 5)).toBeNull();
    expect(evalLayer(l, 15)!.x).toBeCloseTo(50);
    expect(evalLayer(l, 25)!.x).toBe(100);
  });

  it('holds values with the hold ease', () => {
    const l = layer([{ x: 0, ease: 'hold' }, { x: 100 }], [0, 10]);
    expect(evalLayer(l, 9.5)!.x).toBe(0);
  });

  it('keeps the animation clock running across keys with the same settings', () => {
    const l = layer([{ anim: 'anim_a' }, { anim: 'anim_a', x: 50 }, { anim: 'anim_b' }], [0, 10, 20]);
    expect(evalLayer(l, 15)!.segmentStart).toBe(0);
    expect(evalLayer(l, 25)!.segmentStart).toBe(20);
    l.keys[1].restart = true;
    expect(evalLayer(l, 15)!.segmentStart).toBe(10);
  });

  it('maps scene frames to prefab frames per loop mode', () => {
    const l = layer([{ anim: 'anim_b', loop: 'loop' }], [0]);
    // scene 30 fps, prefab 10 fps: 3 scene frames per prefab frame; anim_b spans 2 intervals.
    expect(instanceFrameTime(prefab, evalLayer(l, 0)!, 30, 0)).toEqual({ before: 3, after: 4, fraction: 0 });
    expect(instanceFrameTime(prefab, evalLayer(l, 3)!, 30, 3).before).toBe(4);
    expect(instanceFrameTime(prefab, evalLayer(l, 6)!, 30, 6).before).toBe(3); // wrapped
    l.keys[0].loop = 'once';
    expect(instanceFrameTime(prefab, evalLayer(l, 60)!, 30, 60)).toEqual({ before: 5, after: 5, fraction: 0 });
    l.keys[0].loop = 'single';
    l.keys[0].startFrame = 1;
    expect(instanceFrameTime(prefab, evalLayer(l, 60)!, 30, 60).before).toBe(4);
  });

  it('builds rotate/scale/flip matrices', () => {
    const m = poseMatrix({ x: 10, y: 20, rotation: 90, scaleX: 2, scaleY: 1, flipX: false });
    const [x, y] = apply(m, 1, 0);
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(22);
    const f = poseMatrix({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, flipX: true });
    expect(apply(f, 5, 0)[0]).toBeCloseTo(-5);
  });
});

describe('SceneDocument', () => {
  it('auto-keys, undoes and moves keys', () => {
    const doc = SceneDocument.create('S');
    const li = doc.addLayer('reanim', 'reanim/P.reanim', 'Peashooter', { x: 100, y: 200 }, 0);
    doc.setKey(li, 30, { x: 400 }, 'Move');
    expect(doc.state.layers[li].keys.map((k) => k.frame)).toEqual([0, 30]);
    expect(doc.state.layers[li].keys[1].y).toBe(200); // other props copied from the pose
    expect(evalLayer(doc.state.layers[li], 15)!.x).toBeCloseTo(250);
    doc.undo();
    expect(doc.state.layers[li].keys).toHaveLength(1);
    doc.redo();
    expect(doc.moveKey(li, 30, 45)).toBe(true);
    expect(doc.state.layers[li].keys[1].frame).toBe(45);
    doc.toggleKey(li, 45);
    expect(doc.state.layers[li].keys).toHaveLength(1);
  });

  it('inserts and removes frames on all layers', () => {
    const doc = SceneDocument.create('S');
    doc.addLayer('image', 'IMAGE_X', 'A', {}, 0);
    doc.setKey(0, 20, { x: 5 }, 'k');
    doc.addSoundCue(25, 'sounds/x.ogg');
    doc.shiftFrames(10, 5);
    expect(doc.state.layers[0].keys.map((k) => k.frame)).toEqual([0, 25]);
    expect(doc.state.soundCues[0].frame).toBe(30);
    expect(doc.state.length).toBe(95);
    doc.shiftFrames(20, -10);
    expect(doc.state.layers[0].keys.map((k) => k.frame)).toEqual([0]);
    expect(doc.state.soundCues[0].frame).toBe(20);
  });
});

describe('bakeScene', () => {
  it('composes instance and part transforms exactly', () => {
    const doc = SceneDocument.create('S');
    doc.state.length = 4;
    doc.addLayer('reanim', 'reanim/P.reanim', 'Pea Shooter', { x: 100, y: 50, rotation: 30, scaleX: 2, anim: 'anim_a' }, 0);
    const res = { assets: new AssetLibrary(), prefab: () => prefab };
    const { definition, warnings } = bakeScene(doc.state, res);
    expect(warnings).toEqual([]);
    expect(definition.tracks.map((t) => t.name)).toEqual(['anim_scene', 'Pea_Shooter_part']);
    const part = definition.tracks[1].transforms;
    // Scene 30 fps, prefab 10 fps: scene frame 3 shows prefab frame 1 (x = 1).
    const pose = evalLayer(doc.state.layers[0], 3)!;
    const expected = mul(poseMatrix(pose), transformMatrix(tr({ x: 1 })));
    const got = transformMatrix(part[3]);
    for (const [px, py] of [
      [0, 0],
      [10, 5],
    ]) {
      const a = apply(expected, px, py);
      const b = apply(got, px, py);
      expect(b[0]).toBeCloseTo(a[0], 1);
      expect(b[1]).toBeCloseTo(a[1], 1);
    }
    // Round-trips through the reanim XML format.
    expect(parseReanimXml(serializeReanimXml(definition)).tracks).toHaveLength(2);
  });

  it('hides frames before the layer exists and warns about particles', () => {
    const doc = SceneDocument.create('S');
    doc.state.length = 6;
    doc.addLayer('reanim', 'reanim/P.reanim', 'P', {}, 3);
    doc.addLayer('particle', 'particles/Fx.xml', 'Fx', {}, 0);
    const { definition, warnings } = bakeScene(doc.state, { assets: new AssetLibrary(), prefab: () => prefab });
    expect(definition.tracks[1].transforms.map((t) => t.f)).toEqual([-1, -1, -1, 0, 0, 0]);
    expect(warnings.some((w) => w.includes('Particle'))).toBe(true);
  });
});
