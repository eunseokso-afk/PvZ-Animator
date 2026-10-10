/**
 * PopCap TodParticle definitions (particles/*.xml in PvZ).
 *
 * A file is a list of <Emitter> elements (no root). Most emitter properties
 * are FloatParameterTracks written in the text syntax handled by floatTrack.ts.
 * We keep those values as strings so files round-trip exactly.
 */

import { elements, escapeXml, findChild, parseXmlFragment, textContent, type XmlElement } from './xml';

export const EMITTER_TYPES = ['Circle', 'Box', 'BoxPath', 'CirclePath', 'CircleEvenSpacing'] as const;
export type EmitterType = (typeof EMITTER_TYPES)[number];

export const FIELD_TYPES = [
  'Friction',
  'Acceleration',
  'Attractor',
  'MaxVelocity',
  'Velocity',
  'Position',
  'SystemPosition',
  'GroundConstraint',
  'Shake',
  'Circle',
  'Away',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Particle flags; the order matches the game's ParticleFlags bit numbers. */
export const PARTICLE_FLAGS = [
  'RandomLaunchSpin',
  'AlignLaunchSpin',
  'AlignToPixel',
  'SystemLoops',
  'ParticleLoops',
  'ParticlesDontFollow',
  'RandomStartTime',
  'DieIfOverloaded',
  'Additive',
  'FullScreen',
  'SoftwareOnly',
  'HardwareOnly',
] as const;
export type ParticleFlag = (typeof PARTICLE_FLAGS)[number];

/** Float tracks in the order the game's emitter definition lists them. */
export const SYSTEM_TRACKS = [
  'SystemDuration',
  'CrossFadeDuration',
  'SpawnRate',
  'SpawnMinActive',
  'SpawnMaxActive',
  'SpawnMaxLaunched',
  'EmitterRadius',
  'EmitterOffsetX',
  'EmitterOffsetY',
  'EmitterBoxX',
  'EmitterBoxY',
  'EmitterSkewX',
  'EmitterSkewY',
  'EmitterPath',
  'ParticleDuration',
  'LaunchSpeed',
  'LaunchAngle',
  'SystemRed',
  'SystemGreen',
  'SystemBlue',
  'SystemAlpha',
  'SystemBrightness',
] as const;

export const PARTICLE_TRACKS = [
  'ParticleRed',
  'ParticleGreen',
  'ParticleBlue',
  'ParticleAlpha',
  'ParticleBrightness',
  'ParticleSpinAngle',
  'ParticleSpinSpeed',
  'ParticleScale',
  'ParticleStretch',
  'CollisionReflect',
  'CollisionSpin',
  'ClipTop',
  'ClipBottom',
  'ClipLeft',
  'ClipRight',
  'AnimationRate',
] as const;

export const ALL_TRACKS = [...SYSTEM_TRACKS, ...PARTICLE_TRACKS] as const;
export type TrackName = (typeof ALL_TRACKS)[number];

/** Values used when a track is not specified (TodParticle defaults). */
export const TRACK_DEFAULTS: Record<TrackName, number> = {
  SystemDuration: 0,
  CrossFadeDuration: 0,
  SpawnRate: 0,
  SpawnMinActive: -1,
  SpawnMaxActive: -1,
  SpawnMaxLaunched: -1,
  EmitterRadius: 0,
  EmitterOffsetX: 0,
  EmitterOffsetY: 0,
  EmitterBoxX: 0,
  EmitterBoxY: 0,
  EmitterSkewX: 0,
  EmitterSkewY: 0,
  EmitterPath: 0,
  ParticleDuration: 100,
  LaunchSpeed: 0,
  LaunchAngle: 0,
  SystemRed: 1,
  SystemGreen: 1,
  SystemBlue: 1,
  SystemAlpha: 1,
  SystemBrightness: 1,
  ParticleRed: 1,
  ParticleGreen: 1,
  ParticleBlue: 1,
  ParticleAlpha: 1,
  ParticleBrightness: 1,
  ParticleSpinAngle: 0,
  ParticleSpinSpeed: 0,
  ParticleScale: 1,
  ParticleStretch: 1,
  CollisionReflect: 0,
  CollisionSpin: 0,
  ClipTop: 0,
  ClipBottom: 0,
  ClipLeft: 0,
  ClipRight: 0,
  AnimationRate: 0,
};

export interface ParticleField {
  type: FieldType;
  x: string;
  y: string;
}

export interface EmitterDefinition {
  name: string;
  image: string;
  imageCol: number;
  imageRow: number;
  imageFrames: number;
  animated: number;
  emitterType: EmitterType;
  onDuration: string;
  flags: Partial<Record<ParticleFlag, boolean>>;
  tracks: Partial<Record<TrackName, string>>;
  fields: ParticleField[];
  systemFields: ParticleField[];
  /** Unknown elements, preserved for round-tripping. */
  extra: { tag: string; value: string }[];
}

export interface ParticleDefinition {
  emitters: EmitterDefinition[];
}

export function createEmitter(name = 'Emitter'): EmitterDefinition {
  return {
    name,
    image: '',
    imageCol: 0,
    imageRow: 0,
    imageFrames: 1,
    animated: 0,
    emitterType: 'Circle',
    onDuration: '',
    flags: {},
    tracks: {},
    fields: [],
    systemFields: [],
    extra: [],
  };
}

const TRACK_LOOKUP = new Map(ALL_TRACKS.map((t) => [t.toLowerCase(), t]));
const FLAG_LOOKUP = new Map(PARTICLE_FLAGS.map((f) => [f.toLowerCase(), f]));
FLAG_LOOKUP.set('aligntopixels', 'AlignToPixel');
const EMITTER_TYPE_LOOKUP = new Map(EMITTER_TYPES.map((t) => [t.toLowerCase(), t]));
const FIELD_TYPE_LOOKUP = new Map(FIELD_TYPES.map((t) => [t.toLowerCase(), t]));

function parseIntLoose(s: string, fallback = 0): number {
  const v = parseInt(s.trim(), 10);
  return Number.isFinite(v) ? v : fallback;
}

function parseField(el: XmlElement): ParticleField {
  const typeEl = findChild(el, 'FieldType');
  const typeText = typeEl ? textContent(typeEl).trim() : '';
  const type = FIELD_TYPE_LOOKUP.get(typeText.toLowerCase()) ?? 'Acceleration';
  const xEl = findChild(el, 'X');
  const yEl = findChild(el, 'Y');
  return { type, x: xEl ? textContent(xEl).trim() : '', y: yEl ? textContent(yEl).trim() : '' };
}

function parseEmitter(el: XmlElement): EmitterDefinition {
  const em = createEmitter('');
  for (const c of elements(el.children)) {
    const tag = c.tag.toLowerCase();
    const value = textContent(c).trim();
    const track = TRACK_LOOKUP.get(tag);
    if (track) {
      em.tracks[track] = value;
      continue;
    }
    const flag = FLAG_LOOKUP.get(tag);
    if (flag) {
      em.flags[flag] = value === '' ? true : parseIntLoose(value, 1) !== 0;
      continue;
    }
    switch (tag) {
      case 'name':
        em.name = value;
        break;
      case 'image':
        em.image = value;
        break;
      case 'imagecol':
        em.imageCol = parseIntLoose(value);
        break;
      case 'imagerow':
        em.imageRow = parseIntLoose(value);
        break;
      case 'imageframes':
        em.imageFrames = Math.max(1, parseIntLoose(value, 1));
        break;
      case 'animated':
        em.animated = parseIntLoose(value);
        break;
      case 'emittertype':
        em.emitterType = EMITTER_TYPE_LOOKUP.get(value.toLowerCase()) ?? 'Circle';
        break;
      case 'onduration':
        em.onDuration = value;
        break;
      case 'particleflags': {
        const bits = parseIntLoose(value);
        PARTICLE_FLAGS.forEach((f, i) => {
          if (bits & (1 << i)) em.flags[f] = true;
        });
        break;
      }
      case 'field':
        em.fields.push(parseField(c));
        break;
      case 'systemfield':
        em.systemFields.push(parseField(c));
        break;
      default:
        em.extra.push({ tag: c.tag, value });
    }
  }
  return em;
}

export class ParticleParseError extends Error {}

export function parseParticleXml(src: string): ParticleDefinition {
  const top = elements(parseXmlFragment(src));
  let emitterEls = top.filter((e) => e.tag.toLowerCase() === 'emitter');
  if (emitterEls.length === 0 && top.length === 1) {
    emitterEls = elements(top[0].children).filter((e) => e.tag.toLowerCase() === 'emitter');
  }
  if (emitterEls.length === 0) throw new ParticleParseError('No <Emitter> elements found; this does not look like a particle file.');
  return { emitters: emitterEls.map(parseEmitter) };
}

function writeFieldXml(tag: string, f: ParticleField, out: string[]) {
  out.push(`    <${tag}>`);
  out.push(`        <FieldType>${f.type}</FieldType>`);
  if (f.x.trim()) out.push(`        <X>${escapeXml(f.x.trim())}</X>`);
  if (f.y.trim()) out.push(`        <Y>${escapeXml(f.y.trim())}</Y>`);
  out.push(`    </${tag}>`);
}

export function serializeParticleXml(def: ParticleDefinition, newline = '\r\n'): string {
  const out: string[] = [];
  for (const em of def.emitters) {
    out.push('<Emitter>');
    if (em.name) out.push(`    <Name>${escapeXml(em.name)}</Name>`);
    if (em.image) out.push(`    <Image>${escapeXml(em.image)}</Image>`);
    if (em.imageCol) out.push(`    <ImageCol>${em.imageCol}</ImageCol>`);
    if (em.imageRow) out.push(`    <ImageRow>${em.imageRow}</ImageRow>`);
    if (em.imageFrames > 1) out.push(`    <ImageFrames>${em.imageFrames}</ImageFrames>`);
    if (em.animated) out.push(`    <Animated>${em.animated}</Animated>`);
    if (em.emitterType !== 'Circle') out.push(`    <EmitterType>${em.emitterType}</EmitterType>`);
    if (em.onDuration) out.push(`    <OnDuration>${escapeXml(em.onDuration)}</OnDuration>`);
    for (const flag of PARTICLE_FLAGS) {
      if (em.flags[flag]) out.push(`    <${flag}>1</${flag}>`);
    }
    for (const t of SYSTEM_TRACKS) {
      const v = em.tracks[t];
      if (v !== undefined && v.trim() !== '') out.push(`    <${t}>${escapeXml(v.trim())}</${t}>`);
    }
    for (const f of em.fields) writeFieldXml('Field', f, out);
    for (const f of em.systemFields) writeFieldXml('SystemField', f, out);
    for (const t of PARTICLE_TRACKS) {
      const v = em.tracks[t];
      if (v !== undefined && v.trim() !== '') out.push(`    <${t}>${escapeXml(v.trim())}</${t}>`);
    }
    for (const x of em.extra) out.push(`    <${x.tag}>${escapeXml(x.value)}</${x.tag}>`);
    out.push('</Emitter>');
  }
  return out.join(newline) + newline;
}

/** Human-readable help for every editable property (shown as tooltips). */
export const TRACK_HELP: Record<TrackName, string> = {
  SystemDuration: 'Emitter lifetime in centiseconds (100 = 1 s). 0 = use particle duration.',
  CrossFadeDuration: 'Centiseconds to cross-fade into the OnDuration emitter.',
  SpawnRate: 'Particles spawned per second, over the emitter lifetime.',
  SpawnMinActive: 'Keep at least this many particles alive (-1 = off).',
  SpawnMaxActive: 'Never have more than this many particles alive (-1 = unlimited).',
  SpawnMaxLaunched: 'Total particles this emitter may ever spawn (-1 = unlimited).',
  EmitterRadius: 'Spawn radius for Circle emitters (px).',
  EmitterOffsetX: 'Spawn offset X (px).',
  EmitterOffsetY: 'Spawn offset Y (px).',
  EmitterBoxX: 'Box emitters: spawn X range, e.g. [-40 40].',
  EmitterBoxY: 'Box emitters: spawn Y range, e.g. [-10 10].',
  EmitterSkewX: 'Shear spawn positions horizontally.',
  EmitterSkewY: 'Shear spawn positions vertically.',
  EmitterPath: 'Path emitters: position along the path, 0..1.',
  ParticleDuration: 'Particle lifetime in centiseconds (100 = 1 s).',
  LaunchSpeed: 'Initial speed in px/second.',
  LaunchAngle: 'Launch direction in degrees (0 = down, 90 = right, 180 = up). Unset = random.',
  SystemRed: 'Emitter-wide red multiplier 0..1 (over emitter lifetime).',
  SystemGreen: 'Emitter-wide green multiplier 0..1.',
  SystemBlue: 'Emitter-wide blue multiplier 0..1.',
  SystemAlpha: 'Emitter-wide alpha multiplier 0..1.',
  SystemBrightness: 'Emitter-wide brightness multiplier.',
  ParticleRed: 'Particle red 0..1 over particle lifetime.',
  ParticleGreen: 'Particle green 0..1 over particle lifetime.',
  ParticleBlue: 'Particle blue 0..1 over particle lifetime.',
  ParticleAlpha: 'Particle alpha 0..1, e.g. "1,80 0" fades out over the last 20%.',
  ParticleBrightness: 'Brightness multiplier (>1 over-brightens).',
  ParticleSpinAngle: 'Initial rotation in degrees.',
  ParticleSpinSpeed: 'Rotation speed in degrees/second.',
  ParticleScale: 'Scale over particle lifetime.',
  ParticleStretch: 'Vertical stretch relative to scale.',
  CollisionReflect: 'Bounciness for GroundConstraint fields (0..1).',
  CollisionSpin: 'Spin imparted when hitting the ground.',
  ClipTop: 'Clip particles above this offset (px, 0 = off).',
  ClipBottom: 'Clip particles below this offset (px, 0 = off).',
  ClipLeft: 'Clip particles left of this offset (px, 0 = off).',
  ClipRight: 'Clip particles right of this offset (px, 0 = off).',
  AnimationRate: 'Animated images: frames per second (0 = stretch over lifetime).',
};

export const FIELD_HELP: Record<FieldType, string> = {
  Friction: 'Velocity *= (1 - value) every centisecond.',
  Acceleration: 'Adds value px/s² to velocity (gravity: Y = 400).',
  Attractor: 'Pulls particles toward the point (X, Y).',
  MaxVelocity: 'Clamps speed per axis (px/cs).',
  Velocity: 'Adds a constant drift in px/s.',
  Position: 'Offsets the particle by the track value over its lifetime.',
  SystemPosition: 'Moves the whole emitter over its lifetime.',
  GroundConstraint: 'Particles bounce on a floor at Y px below the emitter.',
  Shake: 'Random jitter of up to X/Y px.',
  Circle: 'Orbits around the emitter: X = degrees/s, Y = px/s outward.',
  Away: 'Pushes particles away from the emitter at X px/s.',
};
