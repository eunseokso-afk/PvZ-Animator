import { describe, expect, it } from 'vitest';
import { DEFAULT_TRANSFORM, parseReanimXml, serializeReanimXml, type ReanimTransform } from '../src/formats/reanim';
import { makeTrack, ReanimDocument, retween, simplifyKeys, CUE_TRACK_NAME } from '../src/editor/reanimDoc';
import { ParticleDocument } from '../src/editor/particleDoc';
import { computeFrameTime, interpolateTransform, transformMatrix, decomposeMatrix } from '../src/engine/reanimRuntime';
import { ParticleSystem } from '../src/engine/particleSystem';
import { parseParticleXml } from '../src/formats/particles';
import { seededRandom } from '../src/engine/math';

const tr = (p: Partial<ReanimTransform>): ReanimTransform => ({ ...DEFAULT_TRANSFORM, ...p });

describe('tweening', () => {
  it('retweens linear segments between keys', () => {
    const t = makeTrack('a', [tr({ x: 0 }), tr({ x: 99 }), tr({ x: 99 }), tr({ x: 30 })], false);
    t.keys[3] = true;
    retween(t);
    expect(t.transforms.map((f) => f.x)).toEqual([0, 10, 20, 30]);
  });

  it('holds after the last key and steps discrete fields', () => {
    const t = makeTrack('a', [tr({ x: 0, f: 0 }), tr({}), tr({ x: 10, f: -1 }), tr({})], false);
    t.keys[2] = true;
    retween(t);
    expect(t.transforms[1]).toMatchObject({ x: 5, f: 0 });
    expect(t.transforms[3]).toMatchObject({ x: 10, f: -1 });
  });

  it('detects linear and eased tweens when simplifying', () => {
    const linear = makeTrack('a', [0, 1, 2, 3, 4, 10, 10, 10].map((x) => tr({ x })));
    simplifyKeys(linear);
    expect(linear.keys).toEqual([true, false, false, false, true, true, false, true]);
    const eased = makeTrack('b', [0, 0.25, 0.5, 0.75, 1].map((t) => tr({ y: 100 * t * t })));
    simplifyKeys(eased);
    expect(eased.keys).toEqual([true, false, false, false, true]);
    expect(eased.ease[0]).toBe('easeIn');
  });

  it('simplification keeps baked values identical', () => {
    const frames = [0, 3, 7, 7, 7, 2, -5, 0].map((x, i) => tr({ x, kx: i * 5, ky: i * 5 }));
    const t = makeTrack('a', frames.map((f) => ({ ...f })));
    simplifyKeys(t);
    retween(t);
    t.transforms.forEach((f, i) => expect(f.x).toBeCloseTo(frames[i].x, 1));
  });
});

const XML = `<fps>12</fps>
<track><name>anim_idle</name><t><f>0</f></t><t></t><t></t><t><f>-1</f></t></track>
<track><name>body</name><t><x>0</x><i>IMAGE_REANIM_BODY</i></t><t><x>1</x></t><t><x>2</x></t><t><x>3</x></t></track>`;

describe('ReanimDocument', () => {
  it('loads definitions, picks the idle range and round-trips', () => {
    const doc = ReanimDocument.fromDefinition(parseReanimXml(XML), 'Test', 'reanim/Test.reanim');
    expect(doc.frameCount).toBe(4);
    expect(doc.ui.anim).toBe('anim_idle');
    expect(doc.activeRange()).toEqual({ start: 0, end: 2 });
    // Frame 2 ends anim_idle and frame 3 follows it, so both stay keys.
    expect(doc.state.tracks[1].keys).toEqual([true, false, true, true]);
    expect(parseReanimXml(serializeReanimXml(doc.toDefinition()))).toEqual(parseReanimXml(XML));
  });

  it('undoes and redoes edits without touching snapshots', () => {
    const doc = ReanimDocument.fromDefinition(parseReanimXml(XML), 'Test', 'reanim/Test.reanim');
    const before = doc.state.tracks[1];
    doc.setFields(1, 1, { x: 30 }, 'Move');
    expect(doc.state.tracks[1]).not.toBe(before);
    expect(doc.state.tracks[1].transforms.map((f) => f.x)).toEqual([0, 30, 2, 3]);
    expect(before.transforms[1].x).toBe(1);
    expect(doc.dirty).toBe(true);
    doc.undo();
    expect(doc.state.tracks[1].transforms[1].x).toBe(1);
    expect(doc.dirty).toBe(false);
    doc.redo();
    expect(doc.state.tracks[1].transforms[1].x).toBe(30);
  });

  it('inserts and deletes frames, shifting cues', () => {
    const doc = ReanimDocument.fromDefinition(parseReanimXml(XML), 'Test', 'reanim/Test.reanim');
    doc.addSoundCue(2, 'sounds/plant.ogg');
    doc.insertFrames(1, 2);
    expect(doc.frameCount).toBe(6);
    expect(doc.state.soundCues[0].frame).toBe(4);
    expect(doc.animRanges()[0]).toMatchObject({ start: 0, end: 4 });
    doc.deleteFrames(0, 2);
    expect(doc.frameCount).toBe(4);
    expect(doc.state.soundCues[0].frame).toBe(2);
  });

  it('creates animation ranges and tracks', () => {
    const doc = ReanimDocument.create('New', 'reanim/New.reanim', 12, 10);
    const idx = doc.addTrack('head', 'IMAGE_REANIM_HEAD', 5, 6);
    expect(doc.state.tracks[idx].transforms).toHaveLength(10);
    doc.setAnimRange('shoot', 2, 5);
    expect(doc.animRanges()).toEqual([{ name: 'anim_shoot', start: 2, end: 5, trackIndex: 0 }]);
  });

  it('embeds cues in a hidden track and restores them', () => {
    const doc = ReanimDocument.fromDefinition(parseReanimXml(XML), 'Test', 'reanim/Test.reanim');
    doc.addSoundCue(1, 'sounds/a b,c.ogg', 0.5);
    doc.addParticleCue(2, 'particles/Pea.xml', 'body', 3, 4);
    const def = doc.toDefinition(true);
    const cueTrack = def.tracks.find((t) => t.name === CUE_TRACK_NAME)!;
    expect(cueTrack.transforms.every((t) => t.f === -1)).toBe(true);
    const back = ReanimDocument.fromDefinition(parseReanimXml(serializeReanimXml(def)), 'Test', 'reanim/Test.reanim');
    expect(back.state.tracks.some((t) => t.name === CUE_TRACK_NAME)).toBe(false);
    expect(back.state.soundCues[0]).toMatchObject({ frame: 1, sound: 'sounds/a b,c.ogg', volume: 0.5 });
    expect(back.state.particleCues[0]).toMatchObject({ frame: 2, particle: 'particles/Pea.xml', track: 'body', x: 3, y: 4 });
  });
});

describe('runtime', () => {
  it('computes frame times like the game', () => {
    expect(computeFrameTime(10, 5, 0, false)).toEqual({ before: 10, after: 11, fraction: 0 });
    expect(computeFrameTime(10, 5, 1, false)).toEqual({ before: 14, after: 14, fraction: 0 });
    const mid = computeFrameTime(10, 5, 0.5, true);
    expect(mid.before).toBe(12);
    expect(mid.fraction).toBeCloseTo(0.5);
  });

  it('hides disappearing frames mid-interpolation', () => {
    const frames = [tr({ x: 0, f: 0 }), tr({ x: 10, f: -1 })];
    expect(interpolateTransform(frames, { before: 0, after: 1, fraction: 0.5 }).f).toBe(-1);
    expect(interpolateTransform(frames, { before: 0, after: 1, fraction: 0 }).f).toBe(0);
  });

  it('builds and decomposes matrices', () => {
    const t = tr({ x: 5, y: 6, kx: 30, ky: 30, sx: 2, sy: 0.5 });
    const d = decomposeMatrix(transformMatrix(t));
    expect(d.kx).toBeCloseTo(30);
    expect(d.ky).toBeCloseTo(30);
    expect(d.sx).toBeCloseTo(2);
    expect(d.sy).toBeCloseTo(0.5);
    const m = transformMatrix(tr({ kx: 90, ky: 90 }));
    // A 90 degree rotation maps +x to +y (clockwise on screen).
    expect(m[0]).toBeCloseTo(0);
    expect(m[1]).toBeCloseTo(1);
  });
});

describe('particles', () => {
  const def = parseParticleXml(`<Emitter>
    <SpawnMinActive>10</SpawnMinActive>
    <SpawnMaxLaunched>10</SpawnMaxLaunched>
    <SystemDuration>100</SystemDuration>
    <ParticleDuration>50</ParticleDuration>
    <LaunchSpeed>100</LaunchSpeed>
    <LaunchAngle>180</LaunchAngle>
    <Field><FieldType>Acceleration</FieldType><Y>400</Y></Field>
  </Emitter>`);

  it('spawns, moves and expires particles deterministically', () => {
    const sys = new ParticleSystem(def, 0, 0, seededRandom(1));
    sys.tick();
    expect(sys.particleCount).toBe(10);
    for (let i = 0; i < 20; i++) sys.tick();
    const p = (sys.emitters[0] as unknown as { particles: { y: number }[] }).particles[0];
    expect(p.y).toBeLessThan(0); // launched upwards (angle 180)
    for (let i = 0; i < 40; i++) sys.tick();
    expect(sys.particleCount).toBe(0); // MaxLaunched stops respawns
    for (let i = 0; i < 50; i++) sys.tick();
    expect(sys.dead).toBe(true);
  });

  it('particle documents undo', () => {
    const doc = ParticleDocument.create('Fx', 'particles/Fx.xml');
    doc.editEmitter('rename', (e) => (e.name = 'Changed'));
    expect(doc.def.emitters[0].name).toBe('Changed');
    doc.undo();
    expect(doc.def.emitters[0].name).toBe('Fx');
  });
});

describe('animation boundaries', () => {
  it('never tweens across animation ranges', () => {
    // x is perfectly linear over all frames, but frames 0-3 and 4-7 are different animations.
    const xml = `<fps>12</fps>
<track><name>anim_a</name>${[0, 0, 0, 0, -1, -1, -1, -1].map((f) => `<t><f>${f}</f></t>`).join('')}</track>
<track><name>anim_b</name>${[-1, -1, -1, -1, 0, 0, 0, 0].map((f) => `<t><f>${f}</f></t>`).join('')}</track>
<track><name>part</name>${[0, 1, 2, 3, 4, 5, 6, 7].map((x) => `<t><x>${x}</x></t>`).join('')}</track>`;
    const doc = ReanimDocument.fromDefinition(parseReanimXml(xml), 'T', 'reanim/T.reanim');
    const part = doc.state.tracks[2];
    expect(part.keys[3]).toBe(true);
    expect(part.keys[4]).toBe(true);
    doc.setFields(2, 7, { x: 70 }, 'edit b');
    // anim_a is untouched by an edit inside anim_b
    expect(doc.state.tracks[2].transforms.slice(0, 4).map((t) => t.x)).toEqual([0, 1, 2, 3]);
  });
});
