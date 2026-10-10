/**
 * Procedurally generated demo assets (original art), so the editor can be
 * tried without the game's main.pak.
 */

import { encodeWav } from './formats/au';
import { DEFAULT_TRANSFORM, serializeReanimXml, type ReanimTransform } from './formats/reanim';
import { ReanimDocument } from './editor/reanimDoc';
import type { Workspace } from './editor/workspace';

async function png(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  draw(ctx);
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

function outlineFill(ctx: CanvasRenderingContext2D, fill: string | CanvasGradient, stroke = '#1f4d12', width = 2.5) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

async function makeImages(): Promise<{ path: string; data: Uint8Array }[]> {
  const head = await png(76, 64, (ctx) => {
    const g = ctx.createRadialGradient(30, 24, 4, 34, 32, 34);
    g.addColorStop(0, '#b9f27a');
    g.addColorStop(1, '#4fae2c');
    ctx.beginPath();
    ctx.ellipse(34, 33, 29, 27, 0, 0, Math.PI * 2);
    outlineFill(ctx, g);
    // leaf tuft
    ctx.beginPath();
    ctx.moveTo(14, 18);
    ctx.quadraticCurveTo(2, 4, 10, 2);
    ctx.quadraticCurveTo(18, 8, 20, 14);
    outlineFill(ctx, '#62c23a');
    // eye
    ctx.beginPath();
    ctx.ellipse(40, 26, 7, 9, 0, 0, Math.PI * 2);
    outlineFill(ctx, '#ffffff', '#1d2a14', 2);
    ctx.beginPath();
    ctx.ellipse(42, 27, 3.5, 5, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#111';
    ctx.fill();
  });
  const snout = await png(34, 30, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 30);
    g.addColorStop(0, '#9be35c');
    g.addColorStop(1, '#3f9a22');
    ctx.beginPath();
    ctx.moveTo(2, 6);
    ctx.lineTo(24, 4);
    ctx.quadraticCurveTo(32, 2, 32, 15);
    ctx.quadraticCurveTo(32, 28, 24, 26);
    ctx.lineTo(2, 24);
    ctx.closePath();
    outlineFill(ctx, g);
    ctx.beginPath();
    ctx.ellipse(27, 15, 3, 8, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#1d3d10';
    ctx.fill();
  });
  const stem = await png(16, 58, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(6, 2);
    ctx.quadraticCurveTo(1, 30, 6, 56);
    ctx.lineTo(11, 56);
    ctx.quadraticCurveTo(7, 30, 12, 2);
    ctx.closePath();
    outlineFill(ctx, '#4fae2c', '#1f4d12', 2);
  });
  const leaf = await png(54, 26, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 54, 0);
    g.addColorStop(0, '#3f9a22');
    g.addColorStop(1, '#8fdc55');
    ctx.beginPath();
    ctx.moveTo(2, 13);
    ctx.quadraticCurveTo(26, -6, 52, 12);
    ctx.quadraticCurveTo(26, 30, 2, 13);
    outlineFill(ctx, g);
    ctx.beginPath();
    ctx.moveTo(4, 13);
    ctx.lineTo(46, 12);
    ctx.strokeStyle = 'rgba(31,77,18,0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
  const pea = await png(22, 22, (ctx) => {
    const g = ctx.createRadialGradient(8, 8, 1, 11, 11, 10);
    g.addColorStop(0, '#d8ff9a');
    g.addColorStop(1, '#5cc02e');
    ctx.beginPath();
    ctx.arc(11, 11, 9, 0, Math.PI * 2);
    outlineFill(ctx, g, '#245a12', 2);
  });
  const spark = await png(32, 32, (ctx) => {
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.65)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
  });
  const dirt = await png(16, 64, (ctx) => {
    const shapes = [
      [8, 8, 6, 5],
      [8, 24, 5, 6],
      [8, 40, 6, 4],
      [8, 56, 4, 4],
    ];
    for (const [x, y, rx, ry] of shapes) {
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0.4, 0, Math.PI * 2);
      outlineFill(ctx, '#7a5530', '#3d2a14', 1.5);
    }
  });
  return [
    { path: 'reanim/Demo_Head.png', data: head },
    { path: 'reanim/Demo_Snout.png', data: snout },
    { path: 'reanim/Demo_Stem.png', data: stem },
    { path: 'reanim/Demo_Leaf.png', data: leaf },
    { path: 'reanim/Demo_Pea.png', data: pea },
    { path: 'particles/Demo_Spark.png', data: spark },
    { path: 'particles/Demo_Dirt.png', data: dirt },
  ];
}

function makeSounds(): { path: string; data: Uint8Array }[] {
  const rate = 22050;
  const pop = new Float32Array(Math.floor(rate * 0.18));
  let phase = 0;
  for (let i = 0; i < pop.length; i++) {
    const t = i / rate;
    const freq = 900 * Math.exp(-t * 18) + 180;
    phase += (2 * Math.PI * freq) / rate;
    pop[i] = Math.sin(phase) * Math.exp(-t * 22) * 0.8;
  }
  const whoosh = new Float32Array(Math.floor(rate * 0.35));
  let lp = 0;
  let seed = 12345;
  for (let i = 0; i < whoosh.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = seed / 0x3fffffff - 1;
    const t = i / whoosh.length;
    lp += (noise - lp) * (0.05 + 0.25 * t);
    whoosh[i] = lp * Math.sin(Math.PI * t) * 1.6;
  }
  return [
    { path: 'sounds/demo_pop.wav', data: encodeWav({ sampleRate: rate, channels: [pop] }) },
    { path: 'sounds/demo_whoosh.wav', data: encodeWav({ sampleRate: rate, channels: [whoosh] }) },
  ];
}

const PARTICLE_XML = `<Emitter>
    <Name>Sparkle</Name>
    <Image>IMAGE_DEMO_SPARK</Image>
    <EmitterType>CircleEvenSpacing</EmitterType>
    <Additive>1</Additive>
    <SystemDuration>70</SystemDuration>
    <SpawnRate>2000</SpawnRate>
    <SpawnMaxLaunched>12</SpawnMaxLaunched>
    <EmitterRadius>4</EmitterRadius>
    <ParticleDuration>[40 70]</ParticleDuration>
    <LaunchSpeed>[90 170]</LaunchSpeed>
    <Field>
        <FieldType>Friction</FieldType>
        <X>.05</X>
        <Y>.05</Y>
    </Field>
    <ParticleRed>.75</ParticleRed>
    <ParticleGreen>1</ParticleGreen>
    <ParticleBlue>.45</ParticleBlue>
    <ParticleAlpha>1,60 0</ParticleAlpha>
    <ParticleScale>[.5 .9] .15</ParticleScale>
</Emitter>
<Emitter>
    <Name>Dirt</Name>
    <Image>IMAGE_DEMO_DIRT</Image>
    <ImageFrames>4</ImageFrames>
    <SystemDuration>90</SystemDuration>
    <SpawnRate>2000</SpawnRate>
    <SpawnMaxLaunched>8</SpawnMaxLaunched>
    <ParticleDuration>[70 90]</ParticleDuration>
    <LaunchSpeed>[120 220]</LaunchSpeed>
    <LaunchAngle>[140 220]</LaunchAngle>
    <Field>
        <FieldType>Acceleration</FieldType>
        <Y>700</Y>
    </Field>
    <Field>
        <FieldType>GroundConstraint</FieldType>
        <Y>12</Y>
    </Field>
    <ParticleAlpha>1,75 0</ParticleAlpha>
    <ParticleSpinSpeed>[-400 400]</ParticleSpinSpeed>
    <CollisionReflect>.35</CollisionReflect>
</Emitter>
`;

function buildReanim(): ReanimDocument {
  const IDLE = 24;
  const SHOOT = 12;
  const n = IDLE + SHOOT;
  const doc = ReanimDocument.create('DemoPlant', 'reanim/DemoPlant.reanim', 12, n);
  const track = (name: string, image: string, fn: (f: number) => Partial<ReanimTransform>) => {
    const idx = doc.addTrack(name, image);
    const t = doc.editTrack(idx);
    t.transforms = Array.from({ length: n }, (_, f) => ({ ...DEFAULT_TRANSFORM, i: image, ...fn(f) }));
    t.keys = t.transforms.map(() => true);
    doc.simplifyTrack(idx);
  };
  const idle = (f: number) => (f < IDLE ? Math.sin((f / IDLE) * Math.PI * 2) : 0);
  const shoot = (f: number) => (f >= IDLE ? (f - IDLE) / (SHOOT - 1) : -1);
  const recoil = (f: number) => {
    const s = shoot(f);
    if (s < 0) return 0;
    return s < 0.45 ? -8 * Math.sin((s / 0.45) * (Math.PI / 2)) : -8 + 12 * Math.sin(((s - 0.45) / 0.55) * Math.PI);
  };
  track('backleaf', 'IMAGE_REANIM_DEMO_LEAF', (f) => ({ x: 26, y: 68 + idle(f), kx: 12 + 4 * idle(f), ky: 12 + 4 * idle(f), sx: -1 }));
  track('stem', 'IMAGE_REANIM_DEMO_STEM', (f) => ({ x: 22, y: 30, kx: 2 * idle(f), ky: 2 * idle(f) }));
  track('frontleaf', 'IMAGE_REANIM_DEMO_LEAF', (f) => ({ x: 30, y: 72 - idle(f), kx: -10 - 4 * idle(f), ky: -10 - 4 * idle(f) }));
  track('snout', 'IMAGE_REANIM_DEMO_SNOUT', (f) => ({ x: 52 + 2 * idle(f) + recoil(f), y: 6 + 2.5 * idle(f), sx: 1 + (shoot(f) > 0.4 && shoot(f) < 0.7 ? 0.15 : 0), sy: 1 + (shoot(f) > 0.4 && shoot(f) < 0.7 ? 0.15 : 0) }));
  track('head', 'IMAGE_REANIM_DEMO_HEAD', (f) => ({ x: -2 + 2 * idle(f) + recoil(f), y: -10 + 2.5 * idle(f), kx: -3 * idle(f), ky: -3 * idle(f) }));
  track('pea', 'IMAGE_REANIM_DEMO_PEA', (f) => {
    const s = shoot(f);
    if (s < 0.5) return { f: -1, x: 80, y: 10 };
    return { f: 0, x: 80 + (s - 0.5) * 2 * 120, y: 10 };
  });
  doc.setAnimRange('anim_idle', 0, IDLE - 1);
  doc.setAnimRange('anim_shoot', IDLE, n - 1);
  doc.addSoundCue(IDLE + 6, 'sounds/demo_pop.wav', 0.9);
  doc.addSoundCue(IDLE, 'sounds/demo_whoosh.wav', 0.5);
  doc.addParticleCue(IDLE + 6, 'particles/DemoSparkle.xml', 'snout', 30, 15);
  return doc;
}

export async function loadDemoAssets(ws: Workspace): Promise<void> {
  const files = [...(await makeImages()), ...makeSounds()];
  files.push({ path: 'particles/DemoSparkle.xml', data: new TextEncoder().encode(PARTICLE_XML) });
  const reanim = buildReanim();
  files.push({ path: 'reanim/DemoPlant.reanim', data: new TextEncoder().encode(serializeReanimXml(reanim.toDefinition(true))) });
  await ws.assets.importFiles(files, 'demo');
  await ws.openAsset('reanim/DemoPlant.reanim');
  ws.status('Loaded demo assets: a reanim with idle/shoot animations, a particle effect and two sounds.', 'success');
}
