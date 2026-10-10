/**
 * TodParticle simulation. The game updates particles 100 times per second
 * ("ticks"); durations are in ticks (centiseconds) and speeds in px/second.
 */

import { evaluateFloatTrack, tryParseFloatTrack, type FloatTrack } from '../formats/floatTrack';
import {
  ALL_TRACKS,
  TRACK_DEFAULTS,
  type EmitterDefinition,
  type FieldType,
  type ParticleDefinition,
  type ParticleFlag,
  type TrackName,
} from '../formats/particles';
import type { AssetLibrary, LoadedImage } from './assets';
import { DEG, mul, type Mat } from './math';
import type { Renderer, RGBA } from './renderer';

export const TICK_SECONDS = 0.01;

interface CompiledField {
  type: FieldType;
  x: FloatTrack;
  y: FloatTrack;
}

export interface CompiledEmitter {
  def: EmitterDefinition;
  tracks: Record<TrackName, FloatTrack>;
  isSet: Record<TrackName, boolean>;
  fields: CompiledField[];
  systemFields: CompiledField[];
  flag(f: ParticleFlag): boolean;
}

const TRACK_INDEX = new Map(ALL_TRACKS.map((t, i) => [t, i]));

function compileTrack(src: string | undefined, fallback: number): { track: FloatTrack; set: boolean } {
  if (src !== undefined && src.trim() !== '') {
    const { track, error } = tryParseFloatTrack(src);
    if (!error && track.nodes.length) return { track, set: true };
  }
  return {
    track: fallback === 0 ? { nodes: [] } : { nodes: [{ time: 0, low: fallback, high: fallback, curve: 1, distribution: 1 }] },
    set: false,
  };
}

function compileField(f: { type: FieldType; x: string; y: string }): CompiledField {
  return { type: f.type, x: compileTrack(f.x, 0).track, y: compileTrack(f.y, 0).track };
}

export function compileEmitter(def: EmitterDefinition): CompiledEmitter {
  const tracks = {} as Record<TrackName, FloatTrack>;
  const isSet = {} as Record<TrackName, boolean>;
  for (const name of ALL_TRACKS) {
    const c = compileTrack(def.tracks[name], TRACK_DEFAULTS[name]);
    tracks[name] = c.track;
    isSet[name] = c.set;
  }
  return {
    def,
    tracks,
    isSet,
    fields: def.fields.map(compileField),
    systemFields: def.systemFields.map(compileField),
    flag: (f) => !!def.flags[f],
  };
}

interface Particle {
  age: number;
  duration: number;
  time: number;
  lastTime: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  spinVel: number;
  frame: number;
  animTime: number;
  shakeX: number;
  shakeY: number;
  interp: Float32Array;
  fieldInterp: Float32Array;
}

class EmitterInstance {
  cx: number;
  cy: number;
  /** Offset applied by SystemPosition fields. */
  sysOffX = 0;
  sysOffY = 0;
  age = -1;
  duration: number;
  time = 0;
  lastTime = -1;
  spawnAccum = 0;
  spawned = 0;
  dead = false;
  particles: Particle[] = [];
  interp: Float32Array;
  sysFieldInterp: Float32Array;

  constructor(
    readonly c: CompiledEmitter,
    x: number,
    y: number,
    private rand: () => number,
  ) {
    this.cx = x;
    this.cy = y;
    this.interp = new Float32Array(ALL_TRACKS.length).map(() => rand());
    this.sysFieldInterp = new Float32Array(c.systemFields.length * 2).map(() => rand());
    const sd = evaluateFloatTrack(c.tracks.SystemDuration, 0, rand());
    this.duration = Math.max(1, Math.round(sd > 0 ? sd : evaluateFloatTrack(c.tracks.ParticleDuration, 0, 1)));
  }

  private ev(name: TrackName, time: number, interp: number): number {
    return evaluateFloatTrack(this.c.tracks[name], time, interp);
  }

  private sys(name: TrackName): number {
    return this.ev(name, this.time, this.interp[TRACK_INDEX.get(name)!]);
  }

  private pv(p: Particle, name: TrackName): number {
    return this.ev(name, p.time, p.interp[TRACK_INDEX.get(name)!]);
  }

  get centerX() {
    return this.cx + this.sysOffX;
  }

  get centerY() {
    return this.cy + this.sysOffY;
  }

  update(): void {
    if (this.dead) return;
    this.age++;
    let die = false;
    if (this.age >= this.duration) {
      if (this.c.flag('SystemLoops')) {
        this.age = 0;
      } else {
        this.age = this.duration - 1;
        die = true;
      }
    }
    this.time = this.duration > 1 ? this.age / (this.duration - 1) : 1;

    this.c.systemFields.forEach((f, i) => this.updateSystemField(f, i));

    const alive: Particle[] = [];
    for (const p of this.particles) if (this.updateParticle(p)) alive.push(p);
    this.particles = alive;

    this.updateSpawning();
    this.lastTime = this.time;
    if (die) this.dead = true;
  }

  private updateSystemField(f: CompiledField, i: number) {
    const x = evaluateFloatTrack(f.x, this.time, this.sysFieldInterp[i * 2]);
    const y = evaluateFloatTrack(f.y, this.time, this.sysFieldInterp[i * 2 + 1]);
    if (f.type === 'SystemPosition' || f.type === 'Position') {
      const dx = x - this.sysOffX;
      const dy = y - this.sysOffY;
      this.sysOffX = x;
      this.sysOffY = y;
      if (!this.c.flag('ParticlesDontFollow')) {
        for (const p of this.particles) {
          p.x += dx;
          p.y += dy;
        }
      }
    }
  }

  private updateSpawning() {
    const rate = this.sys('SpawnRate');
    this.spawnAccum += rate * TICK_SECONDS;
    let count = Math.floor(this.spawnAccum);
    this.spawnAccum -= count;
    const active = this.particles.length;
    const minActive = this.sys('SpawnMinActive');
    if (minActive >= 0 && active + count < minActive) count = Math.floor(minActive) - active;
    const maxActive = this.sys('SpawnMaxActive');
    if (maxActive >= 0 && active + count > maxActive) count = Math.max(0, Math.floor(maxActive) - active);
    const maxLaunched = this.sys('SpawnMaxLaunched');
    if (maxLaunched >= 0 && this.spawned + count > maxLaunched) count = Math.max(0, Math.floor(maxLaunched) - this.spawned);
    count = Math.min(count, 2000);
    for (let i = 0; i < count; i++) this.spawn(i, count);
  }

  private spawn(index: number, count: number) {
    const rand = this.rand;
    const c = this.c;
    const def = c.def;
    const p: Particle = {
      age: 0,
      duration: 1,
      time: 0,
      lastTime: -1,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      spin: 0,
      spinVel: 0,
      frame: 0,
      animTime: 0,
      shakeX: 0,
      shakeY: 0,
      interp: new Float32Array(ALL_TRACKS.length).map(() => rand()),
      fieldInterp: new Float32Array(c.fields.length * 2).map(() => rand()),
    };
    const t = this.time;
    const ev = (name: TrackName) => this.ev(name, t, rand());
    p.duration = Math.max(1, Math.round(this.ev('ParticleDuration', t, p.interp[TRACK_INDEX.get('ParticleDuration')!])));
    if (c.flag('RandomStartTime')) p.age = Math.floor(rand() * p.duration);

    const speed = ev('LaunchSpeed');
    let angle: number;
    if (def.emitterType === 'CircleEvenSpacing') {
      angle = (2 * Math.PI * index) / Math.max(1, count) + ev('LaunchAngle') * DEG;
    } else if (c.isSet.LaunchAngle) {
      angle = ev('LaunchAngle') * DEG;
    } else {
      angle = rand() * Math.PI * 2;
    }

    let px = 0;
    let py = 0;
    switch (def.emitterType) {
      case 'Circle':
      case 'CircleEvenSpacing': {
        const radius = ev('EmitterRadius');
        px = Math.sin(angle) * radius;
        py = Math.cos(angle) * radius;
        break;
      }
      case 'Box':
        px = ev('EmitterBoxX');
        py = ev('EmitterBoxY');
        break;
      case 'BoxPath': {
        const x0 = this.ev('EmitterBoxX', t, 0);
        const x1 = this.ev('EmitterBoxX', t, 1);
        const y0 = this.ev('EmitterBoxY', t, 0);
        const y1 = this.ev('EmitterBoxY', t, 1);
        const w = Math.abs(x1 - x0);
        const h = Math.abs(y1 - y0);
        let d = rand() * Math.max(1e-6, 2 * (w + h));
        if (d < w) {
          px = x0 + d;
          py = y0;
        } else if ((d -= w) < h) {
          px = x1;
          py = y0 + d;
        } else if ((d -= h) < w) {
          px = x1 - d;
          py = y1;
        } else {
          d -= w;
          px = x0;
          py = y1 - d;
        }
        break;
      }
      case 'CirclePath': {
        const pathPos = ev('EmitterPath');
        const a = pathPos * Math.PI * 2;
        const radius = ev('EmitterRadius');
        px = Math.sin(a) * radius;
        py = Math.cos(a) * radius;
        angle += a;
        break;
      }
    }
    const skewX = ev('EmitterSkewX');
    const skewY = ev('EmitterSkewY');
    const sx = px + py * skewX;
    const sy = py + px * skewY;
    p.x = this.centerX + sx + ev('EmitterOffsetX');
    p.y = this.centerY + sy + ev('EmitterOffsetY');
    p.vx = Math.sin(angle) * speed;
    p.vy = Math.cos(angle) * speed;

    p.spin = this.pv(p, 'ParticleSpinAngle') * DEG;
    if (c.flag('RandomLaunchSpin')) p.spin = rand() * Math.PI * 2;
    if (c.flag('AlignLaunchSpin')) p.spin += Math.PI / 2 - angle;

    const frames = Math.max(1, def.imageFrames);
    if (frames > 1 && !def.animated && !c.isSet.AnimationRate) p.frame = Math.floor(rand() * frames);

    this.particles.push(p);
    this.spawned++;
  }

  private updateParticle(p: Particle): boolean {
    if (p.age >= p.duration) {
      if (this.c.flag('ParticleLoops')) p.age = 0;
      else return false;
    }
    p.time = p.duration > 1 ? p.age / (p.duration - 1) : 1;

    p.shakeX = 0;
    p.shakeY = 0;
    this.c.fields.forEach((f, i) => this.updateField(p, f, i));

    p.x += p.vx * TICK_SECONDS;
    p.y += p.vy * TICK_SECONDS;

    const spinSpeed = this.pv(p, 'ParticleSpinSpeed');
    p.spin += spinSpeed * DEG * TICK_SECONDS + p.spinVel;

    const def = this.c.def;
    const frames = Math.max(1, def.imageFrames);
    if (frames > 1 && (def.animated || this.c.isSet.AnimationRate)) {
      const rate = this.pv(p, 'AnimationRate');
      if (rate > 0) {
        p.animTime += rate * TICK_SECONDS;
        p.frame = Math.floor(p.animTime) % frames;
      } else {
        p.frame = Math.min(frames - 1, Math.floor(p.time * frames));
      }
    }

    p.lastTime = p.time;
    p.age++;
    return true;
  }

  private updateField(p: Particle, f: CompiledField, i: number) {
    const x = evaluateFloatTrack(f.x, p.time, p.fieldInterp[i * 2]);
    const y = evaluateFloatTrack(f.y, p.time, p.fieldInterp[i * 2 + 1]);
    switch (f.type) {
      case 'Friction':
        p.vx *= 1 - x;
        p.vy *= 1 - y;
        break;
      case 'Acceleration':
        p.vx += x * TICK_SECONDS;
        p.vy += y * TICK_SECONDS;
        break;
      case 'Attractor': {
        const dx = this.centerX + x - p.x;
        const dy = this.centerY + y - p.y;
        p.vx += dx * TICK_SECONDS * 10;
        p.vy += dy * TICK_SECONDS * 10;
        break;
      }
      case 'MaxVelocity':
        if (x > 0) p.vx = Math.max(-x, Math.min(x, p.vx));
        if (y > 0) p.vy = Math.max(-y, Math.min(y, p.vy));
        break;
      case 'Velocity':
        p.x += x * TICK_SECONDS;
        p.y += y * TICK_SECONDS;
        break;
      case 'Position':
      case 'SystemPosition': {
        if (p.lastTime < 0) {
          p.x += x;
          p.y += y;
        } else {
          p.x += x - evaluateFloatTrack(f.x, p.lastTime, p.fieldInterp[i * 2]);
          p.y += y - evaluateFloatTrack(f.y, p.lastTime, p.fieldInterp[i * 2 + 1]);
        }
        break;
      }
      case 'GroundConstraint': {
        const ground = this.centerY + y;
        if (p.y > ground) {
          p.y = ground;
          const reflect = this.pv(p, 'CollisionReflect');
          const spin = this.pv(p, 'CollisionSpin');
          p.spinVel = (p.vy * spin * DEG * TICK_SECONDS) / 10;
          p.vx *= reflect;
          p.vy *= -reflect;
        }
        break;
      }
      case 'Shake':
        p.shakeX = (this.rand() * 2 - 1) * x;
        p.shakeY = (this.rand() * 2 - 1) * y;
        break;
      case 'Circle': {
        const rx = p.x - this.centerX;
        const ry = p.y - this.centerY;
        const r = Math.hypot(rx, ry);
        if (r > 1e-6) {
          const a = Math.atan2(ry, rx) + x * DEG * TICK_SECONDS;
          const nr = r + y * TICK_SECONDS;
          p.x = this.centerX + Math.cos(a) * nr;
          p.y = this.centerY + Math.sin(a) * nr;
        }
        break;
      }
      case 'Away': {
        const rx = p.x - this.centerX;
        const ry = p.y - this.centerY;
        const r = Math.hypot(rx, ry);
        if (r > 1e-6) {
          p.x += (rx / r) * x * TICK_SECONDS;
          p.y += (ry / r) * x * TICK_SECONDS;
        }
        break;
      }
    }
  }

  move(dx: number, dy: number) {
    this.cx += dx;
    this.cy += dy;
    if (!this.c.flag('ParticlesDontFollow')) {
      for (const p of this.particles) {
        p.x += dx;
        p.y += dy;
      }
    }
  }

  draw(r: Renderer, assets: AssetLibrary, view: Readonly<Mat>, colorMul: RGBA) {
    if (this.dead || this.particles.length === 0) return;
    const def = this.c.def;
    const blend = this.c.flag('Additive') ? 'additive' : 'normal';
    const sr = this.sys('SystemRed');
    const sg = this.sys('SystemGreen');
    const sb = this.sys('SystemBlue');
    const sa = this.sys('SystemAlpha');
    const sbr = this.sys('SystemBrightness');
    const img = def.image ? assets.image(def.image) : null;
    const fullScreen = this.c.flag('FullScreen');
    if (!img && !fullScreen) return;
    const layout = img ? celLayout(img, def) : null;

    for (const p of this.particles) {
      const bright = this.pv(p, 'ParticleBrightness') * sbr;
      const color: RGBA = [
        this.pv(p, 'ParticleRed') * sr * bright * colorMul[0],
        this.pv(p, 'ParticleGreen') * sg * bright * colorMul[1],
        this.pv(p, 'ParticleBlue') * sb * bright * colorMul[2],
        Math.max(0, Math.min(1, this.pv(p, 'ParticleAlpha') * sa * colorMul[3])),
      ];
      if (color[3] <= 0.002) continue;
      if (fullScreen) {
        r.fillRect([1, 0, 0, 1, -1e5, -1e5], 2e5, 2e5, color, blend);
        continue;
      }
      if (!img || !layout) continue;
      const scale = this.pv(p, 'ParticleScale');
      const stretch = this.pv(p, 'ParticleStretch');
      const cos = Math.cos(p.spin);
      const sin = Math.sin(p.spin);
      const sx = scale;
      const sy = scale * stretch;
      const w = layout.w;
      const h = layout.h;
      // translate(x, y) * rotate(spin) * scale(sx, sy) * translate(-w/2, -h/2)
      const local: Mat = [cos * sx, sin * sx, -sin * sy, cos * sy, 0, 0];
      local[4] = p.x + p.shakeX - (local[0] * w) / 2 - (local[2] * h) / 2;
      local[5] = p.y + p.shakeY - (local[1] * w) / 2 - (local[3] * h) / 2;
      const [srcX, srcY] = layout.src(p.frame);
      r.drawImage(img, srcX, srcY, w, h, mul(view, local), color, blend);
    }
  }
}

/** Work out which part of an image a particle frame uses. */
export function celLayout(img: LoadedImage, def: EmitterDefinition): { w: number; h: number; src: (frame: number) => [number, number] } {
  let rows = img.rows;
  let cols = img.cols;
  const frames = Math.max(1, def.imageFrames);
  if (rows === 1 && cols === 1 && frames > 1) {
    // No resources.xml entry: guess the strip orientation.
    if (img.height >= img.width) rows = frames;
    else cols = frames;
  }
  const w = Math.floor(img.width / cols);
  const h = Math.floor(img.height / rows);
  const vertical = rows > 1;
  return {
    w,
    h,
    src: (frame: number) => {
      if (vertical) return [w * Math.min(cols - 1, def.imageCol), h * Math.min(rows - 1, def.imageRow + frame)];
      return [w * Math.min(cols - 1, def.imageCol + frame), h * Math.min(rows - 1, def.imageRow)];
    },
  };
}

export class ParticleSystem {
  emitters: EmitterInstance[];
  x: number;
  y: number;
  ticks = 0;
  private acc = 0;

  constructor(
    readonly def: ParticleDefinition,
    x = 0,
    y = 0,
    readonly rand: () => number = Math.random,
    compiled?: CompiledEmitter[],
  ) {
    this.x = x;
    this.y = y;
    const ems = compiled ?? def.emitters.map(compileEmitter);
    this.emitters = ems.filter((c) => !c.flag('SoftwareOnly')).map((c) => new EmitterInstance(c, x, y, rand));
  }

  get dead(): boolean {
    return this.emitters.every((e) => e.dead);
  }

  get particleCount(): number {
    return this.emitters.reduce((s, e) => s + (e.dead ? 0 : e.particles.length), 0);
  }

  tick(): void {
    this.ticks++;
    for (const e of this.emitters) e.update();
  }

  /** Advance by real time, stepping in fixed 10 ms ticks. */
  advance(seconds: number, maxTicks = 500): void {
    this.acc += seconds;
    let n = 0;
    while (this.acc >= TICK_SECONDS && n < maxTicks) {
      this.acc -= TICK_SECONDS;
      this.tick();
      n++;
    }
    if (n >= maxTicks) this.acc = 0;
  }

  setPosition(x: number, y: number): void {
    const dx = x - this.x;
    const dy = y - this.y;
    if (dx === 0 && dy === 0) return;
    this.x = x;
    this.y = y;
    for (const e of this.emitters) e.move(dx, dy);
  }

  draw(r: Renderer, assets: AssetLibrary, view: Readonly<Mat>, color: RGBA = [1, 1, 1, 1]): void {
    for (const e of this.emitters) e.draw(r, assets, view, color);
  }

  /** Emitter shapes for the editor overlay (in system space). */
  emitterGuides(): { type: string; cx: number; cy: number; radius: number; box: [number, number, number, number] }[] {
    return this.emitters.map((e) => {
      const t = e.c.tracks;
      const time = Math.max(0, e.time);
      return {
        type: e.c.def.emitterType,
        cx: e.centerX + evaluateFloatTrack(t.EmitterOffsetX, time, 0.5),
        cy: e.centerY + evaluateFloatTrack(t.EmitterOffsetY, time, 0.5),
        radius: evaluateFloatTrack(t.EmitterRadius, time, 1),
        box: [
          evaluateFloatTrack(t.EmitterBoxX, time, 0),
          evaluateFloatTrack(t.EmitterBoxY, time, 0),
          evaluateFloatTrack(t.EmitterBoxX, time, 1),
          evaluateFloatTrack(t.EmitterBoxY, time, 1),
        ],
      };
    });
  }
}
