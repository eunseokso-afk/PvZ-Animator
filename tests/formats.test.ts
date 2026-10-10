import { describe, expect, it } from 'vitest';
import { PakArchive, writePak, detectPakKey, PAK_XOR_KEY, dateToFileTime, fileTimeToDate } from '../src/formats/pak';
import { parseXmlFragment, textContent, elements } from '../src/formats/xml';
import { parseReanimXml, serializeReanimXml, getAnimRanges, parseAttacher, fillInMissing } from '../src/formats/reanim';
import { buildCompiledReanim, buildCompiledReanimBody, parseCompiledReanim, COMPILED_COOKIE, parseCompiledReanimBody } from '../src/formats/reanimCompiled';
import { Curve, evaluateFloatTrack, formatFloatTrack, parseFloatTrack } from '../src/formats/floatTrack';
import { parseParticleXml, serializeParticleXml } from '../src/formats/particles';
import { parseResourcesXml } from '../src/formats/resources';
import { decodeAu, encodeWav } from '../src/formats/au';
import { crc32 } from '../src/formats/zip';

const enc = new TextEncoder();

describe('pak', () => {
  it('round-trips files through an encrypted archive', async () => {
    const files = [
      { name: 'reanim\\PeaShooter.reanim', data: enc.encode('<fps>12</fps>'), size: 13 },
      { name: 'images/foo.png', data: new Uint8Array([1, 2, 3, 250]), size: 4 },
    ];
    const blob = writePak(files);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(detectPakKey(bytes)).toBe(PAK_XOR_KEY);
    // The raw header is encrypted.
    expect(bytes[0]).toBe(0xc0 ^ 0xf7);

    const pak = await PakArchive.open(blob);
    expect(pak.entries.map((e) => e.name)).toEqual(['reanim\\PeaShooter.reanim', 'images\\foo.png']);
    expect(new TextDecoder().decode(await pak.read(pak.entries[0]))).toBe('<fps>12</fps>');
    expect(Array.from(await pak.read(pak.entries[1]))).toEqual([1, 2, 3, 250]);

    // Raw slices can be copied into a new archive without decrypting.
    const again = writePak([{ name: 'x.bin', data: pak.rawSlice(pak.entries[1]), size: 4, encrypted: true }]);
    const pak2 = await PakArchive.open(again);
    expect(Array.from(await pak2.read(pak2.entries[0]))).toEqual([1, 2, 3, 250]);
  });

  it('reads unencrypted archives too', async () => {
    const blob = writePak([{ name: 'a.txt', data: enc.encode('hi'), size: 2 }], 0);
    const pak = await PakArchive.open(blob);
    expect(pak.key).toBe(0);
    expect(new TextDecoder().decode(await pak.read(pak.entries[0]))).toBe('hi');
  });

  it('rejects non-pak data', async () => {
    await expect(PakArchive.open(new Blob([enc.encode('hello world, not a pak')]))).rejects.toThrow();
  });

  it('converts FILETIME', () => {
    const d = new Date('2009-05-05T12:00:00Z');
    expect(fileTimeToDate(dateToFileTime(d)).getTime()).toBe(d.getTime());
  });
});

describe('xml', () => {
  it('parses root-less fragments with entities, comments and bare attributes', () => {
    const nodes = parseXmlFragment('<?xml version="1.0"?><!-- c --><a x=1 y="2" flag/><b>&lt;hi&amp;</b><c><![CDATA[<raw>]]></c>');
    const els = elements(nodes);
    expect(els.map((e) => e.tag)).toEqual(['a', 'b', 'c']);
    expect(els[0].attrs).toEqual({ x: '1', y: '2', flag: '' });
    expect(textContent(els[1])).toBe('<hi&');
    expect(textContent(els[2])).toBe('<raw>');
  });
});

const SAMPLE_REANIM = `<fps>12</fps>
<track>
<name>anim_idle</name>
<t><f>-1</f></t>
<t><f>0</f></t>
<t></t>
<t><f>-1</f></t>
</track>
<track>
<name>head</name>
<t><x>10</x><y>-5.5</y><i>IMAGE_REANIM_PEASHOOTER_HEAD</i></t>
<t><x>11</x><kx>5</kx><ky>5</ky></t>
<t><sx>0.9</sx><a>0.5</a></t>
<t><f>-1</f></t>
</track>`;

describe('reanim', () => {
  it('fills in missing values from the previous frame', () => {
    const def = parseReanimXml(SAMPLE_REANIM);
    expect(def.fps).toBe(12);
    expect(def.tracks).toHaveLength(2);
    const head = def.tracks[1].transforms;
    expect(head[0]).toMatchObject({ x: 10, y: -5.5, kx: 0, sx: 1, f: 0, a: 1, i: 'IMAGE_REANIM_PEASHOOTER_HEAD' });
    expect(head[1]).toMatchObject({ x: 11, y: -5.5, kx: 5, ky: 5, i: 'IMAGE_REANIM_PEASHOOTER_HEAD' });
    expect(head[2]).toMatchObject({ x: 11, sx: 0.9, a: 0.5 });
    expect(head[3].f).toBe(-1);
  });

  it('finds animation ranges', () => {
    const def = parseReanimXml(SAMPLE_REANIM);
    expect(getAnimRanges(def.tracks)).toEqual([{ name: 'anim_idle', start: 1, end: 2, trackIndex: 0 }]);
  });

  it('round-trips through the delta-encoded serializer', () => {
    const def = parseReanimXml(SAMPLE_REANIM);
    const xml = serializeReanimXml(def);
    expect(xml).toContain('<t><x>11</x><kx>5</kx><ky>5</ky></t>');
    expect(parseReanimXml(xml)).toEqual(def);
  });

  it('pads tracks to equal length', () => {
    const def = parseReanimXml('<fps>10</fps><track><name>a</name><t><x>1</x></t><t><x>2</x></t></track><track><name>b</name><t><x>3</x></t></track>');
    expect(def.tracks[1].transforms).toHaveLength(2);
    expect(def.tracks[1].transforms[1].x).toBe(3);
  });

  it('parses attacher specs', () => {
    expect(parseAttacher('attacher__Zombie_head__anim_idle[once][24]')).toEqual({
      reanimName: 'Zombie_head',
      trackName: 'anim_idle',
      fps: 24,
      loop: 'once',
    });
    expect(parseAttacher('head')).toBeNull();
  });

  it('treats -10000 as unset', () => {
    const t = fillInMissing([{ x: 5 }, { x: -10000, y: 2 }]);
    expect(t[1]).toMatchObject({ x: 5, y: 2 });
  });
});

describe('compiled reanim', () => {
  it('parses compiled files with and without element-size markers', async () => {
    const def = parseReanimXml(SAMPLE_REANIM);
    for (const sizes of [true, false]) {
      const body = buildCompiledReanimBody(def, 0xb393b4c0, sizes);
      const parsed = parseCompiledReanimBody(body);
      expect(parsed.tracks.map((t) => t.name)).toEqual(['anim_idle', 'head']);
      expect(parsed.tracks[1].transforms[2].sx).toBeCloseTo(0.9);
      expect(parsed.tracks[1].transforms[1].i).toBe('IMAGE_REANIM_PEASHOOTER_HEAD');
    }
  });

  it('decompresses the 0xDEADFED4 container', async () => {
    const def = parseReanimXml(SAMPLE_REANIM);
    const file = await buildCompiledReanim(def, 1);
    expect(new DataView(file.buffer).getUint32(0, true)).toBe(COMPILED_COOKIE);
    const parsed = await parseCompiledReanim(file);
    expect(parsed.fps).toBe(12);
    expect(parsed.tracks[1].transforms[0].y).toBeCloseTo(-5.5);
  });
});

describe('float tracks', () => {
  it('parses constants and ranges', () => {
    const t = parseFloatTrack('[5 10]');
    expect(evaluateFloatTrack(t, 0, 0)).toBe(5);
    expect(evaluateFloatTrack(t, 0.5, 1)).toBe(10);
    expect(evaluateFloatTrack(parseFloatTrack('7'), 0.3, 0.5)).toBe(7);
  });

  it('handles explicit node times', () => {
    const t = parseFloatTrack('1,80 0');
    expect(t.nodes.map((n) => n.time)).toEqual([0.8, 1]);
    expect(evaluateFloatTrack(t, 0.5, 0)).toBe(1);
    expect(evaluateFloatTrack(t, 0.9, 0)).toBeCloseTo(0.5);
    expect(evaluateFloatTrack(t, 1, 0)).toBe(0);
  });

  it('spreads unspecified times evenly', () => {
    const t = parseFloatTrack('0 1 0 1');
    expect(t.nodes.map((n) => n.time)).toEqual([0, 1 / 3, 2 / 3, 1]);
  });

  it('applies curve keywords to the following node', () => {
    const t = parseFloatTrack('EaseIn 0 10');
    expect(t.nodes[0].curve).toBe(Curve.EaseIn);
    expect(evaluateFloatTrack(t, 0.5, 0)).toBeCloseTo(2.5);
    const d = parseFloatTrack('[EaseOut 0 10]');
    expect(d.nodes[0].distribution).toBe(Curve.EaseOut);
    expect(evaluateFloatTrack(d, 0, 0.5)).toBeCloseTo(7.5);
  });

  it('formats back to text', () => {
    for (const s of ['5', '[5 10]', '1,80 0', 'EaseIn 0 10', '[EaseOut 0 10]', '0 1,25 1,75 0']) {
      const track = parseFloatTrack(s);
      expect(parseFloatTrack(formatFloatTrack(track))).toEqual(track);
    }
  });

  it('rejects garbage', () => {
    expect(() => parseFloatTrack('[1 2')).toThrow();
    expect(() => parseFloatTrack('Wobble 1')).toThrow();
  });
});

const SAMPLE_PARTICLE = `<Emitter>
    <Name>Dirt</Name>
    <Image>IMAGE_DIRTSMALL</Image>
    <ImageFrames>4</ImageFrames>
    <SpawnMinActive>0</SpawnMinActive>
    <SystemDuration>50</SystemDuration>
    <ParticleDuration>[40 60]</ParticleDuration>
    <SpawnMaxLaunched>8</SpawnMaxLaunched>
    <EmitterType>CircleEvenSpacing</EmitterType>
    <Additive>1</Additive>
    <LaunchSpeed>[50 100]</LaunchSpeed>
    <Field>
        <FieldType>Acceleration</FieldType>
        <Y>400</Y>
    </Field>
    <ParticleAlpha>1,60 0</ParticleAlpha>
    <SomethingNew>42</SomethingNew>
</Emitter>
<Emitter>
    <Name>Second</Name>
</Emitter>`;

describe('particles', () => {
  it('parses emitters, flags, fields and unknown tags', () => {
    const def = parseParticleXml(SAMPLE_PARTICLE);
    expect(def.emitters).toHaveLength(2);
    const e = def.emitters[0];
    expect(e.name).toBe('Dirt');
    expect(e.image).toBe('IMAGE_DIRTSMALL');
    expect(e.imageFrames).toBe(4);
    expect(e.emitterType).toBe('CircleEvenSpacing');
    expect(e.flags.Additive).toBe(true);
    expect(e.tracks.ParticleDuration).toBe('[40 60]');
    expect(e.fields).toEqual([{ type: 'Acceleration', x: '', y: '400' }]);
    expect(e.extra).toEqual([{ tag: 'SomethingNew', value: '42' }]);
  });

  it('round-trips through the serializer', () => {
    const def = parseParticleXml(SAMPLE_PARTICLE);
    expect(parseParticleXml(serializeParticleXml(def))).toEqual(def);
  });
});

describe('resources.xml', () => {
  it('applies SetDefaults prefixes and paths', () => {
    const m = parseResourcesXml(`<?xml version="1.0"?>
<ResourceManifest>
  <Resources id="Init">
    <SetDefaults path="images" idprefix="IMAGE_"/>
    <Image id="SEEDS" path="seeds" cols="9"/>
    <SetDefaults path="particles" idprefix="IMAGE_"/>
    <Image id="DIRTSMALL" path="dirt_small" rows="2" cols="2" nopal/>
    <SetDefaults path="sounds" idprefix="SOUND_"/>
    <Sound id="PLANT" path="plant"/>
  </Resources>
</ResourceManifest>`);
    expect(m.images.get('IMAGE_SEEDS')).toMatchObject({ path: 'images/seeds', cols: 9, rows: 1 });
    expect(m.images.get('IMAGE_DIRTSMALL')).toMatchObject({ path: 'particles/dirt_small', cols: 2, rows: 2 });
    expect(m.sounds.get('SOUND_PLANT')?.path).toBe('sounds/plant');
  });
});

describe('au', () => {
  it('decodes 16-bit PCM and mu-law', () => {
    const mk = (encoding: number, data: number[]) => {
      const out = new Uint8Array(24 + data.length);
      const dv = new DataView(out.buffer);
      out.set([0x2e, 0x73, 0x6e, 0x64]);
      dv.setUint32(4, 24, false);
      dv.setUint32(8, data.length, false);
      dv.setUint32(12, encoding, false);
      dv.setUint32(16, 8000, false);
      dv.setUint32(20, 1, false);
      out.set(data, 24);
      return out;
    };
    const pcm16 = decodeAu(mk(3, [0x40, 0x00, 0xc0, 0x00]));
    expect(pcm16.sampleRate).toBe(8000);
    expect(Array.from(pcm16.channels[0])).toEqual([0.5, -0.5]);
    const ulaw = decodeAu(mk(1, [0xff, 0x7f, 0x00]));
    expect(ulaw.channels[0][0]).toBeCloseTo(0, 3);
    expect(ulaw.channels[0][2]).toBeLessThan(-0.9);
  });

  it('encodes wav headers', () => {
    const wav = encodeWav({ sampleRate: 22050, channels: [new Float32Array([0, 1, -1])] });
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(wav.length).toBe(44 + 6);
  });
});

describe('zip', () => {
  it('computes CRC32', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  });
});
