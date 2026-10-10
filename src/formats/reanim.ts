/**
 * PopCap "reanim" skeletal-less animation format.
 *
 * A .reanim file is a list of <track>s with one <t> (transform) per frame.
 * Each transform only lists fields that changed from the previous frame:
 *   x, y     translation (px)
 *   kx, ky   skew/rotation in degrees (kx == ky is a plain rotation)
 *   sx, sy   scale
 *   f        frame: 0 = visible, -1 = hidden
 *   a        alpha 0..1
 *   i        image id (IMAGE_REANIM_*)
 *   font, text  for text tracks
 * Tracks named "anim_*" that carry no image or text mark the frame range of a
 * named animation (f = 0 inside the range, -1 outside). The game draws every
 * track that has an image whatever its name, so image tracks such as a
 * zombie's "anim_head1" are ordinary parts.
 */

import { decodeEntities, elements, escapeXml, findChild, parseXmlFragment, textContent, type XmlElement } from './xml';
import { formatNumber } from './floatTrack';

export interface ReanimTransform {
  x: number;
  y: number;
  kx: number;
  ky: number;
  sx: number;
  sy: number;
  f: number;
  a: number;
  i: string;
  font: string;
  text: string;
}

export interface ReanimTrack {
  name: string;
  transforms: ReanimTransform[];
}

export interface ReanimDefinition {
  fps: number;
  tracks: ReanimTrack[];
}

export type PartialTransform = Partial<ReanimTransform>;

export const DEFAULT_TRANSFORM: Readonly<ReanimTransform> = Object.freeze({
  x: 0,
  y: 0,
  kx: 0,
  ky: 0,
  sx: 1,
  sy: 1,
  f: 0,
  a: 1,
  i: '',
  font: '',
  text: '',
});

/** Value the game uses for "not specified" in compiled files. */
export const FIELD_PLACEHOLDER = -10000;

export const NUMERIC_FIELDS = ['x', 'y', 'kx', 'ky', 'sx', 'sy', 'f', 'a'] as const;
export const STRING_FIELDS = ['i', 'font', 'text'] as const;
export type NumericField = (typeof NUMERIC_FIELDS)[number];
export type StringField = (typeof STRING_FIELDS)[number];

export function cloneTransform(t: ReanimTransform): ReanimTransform {
  return { ...t };
}

/** Replace unspecified fields with the previous frame's values (ReanimationFillInMissingData). */
export function fillInMissing(raw: PartialTransform[]): ReanimTransform[] {
  let prev: ReanimTransform = { ...DEFAULT_TRANSFORM };
  return raw.map((r) => {
    const t = { ...prev };
    for (const k of NUMERIC_FIELDS) {
      const v = r[k];
      if (v !== undefined && v !== FIELD_PLACEHOLDER && Number.isFinite(v)) t[k] = v;
    }
    for (const k of STRING_FIELDS) {
      const v = r[k];
      if (v) t[k] = v;
    }
    prev = t;
    return t;
  });
}

function parseNum(s: string): number | undefined {
  const v = parseFloat(s.trim());
  return Number.isFinite(v) ? v : undefined;
}

function parseTransform(el: XmlElement): PartialTransform {
  const out: PartialTransform = {};
  for (const c of elements(el.children)) {
    const tag = c.tag.toLowerCase();
    const val = textContent(c);
    if ((NUMERIC_FIELDS as readonly string[]).includes(tag)) {
      const n = parseNum(val);
      if (n !== undefined) out[tag as NumericField] = n;
    } else if ((STRING_FIELDS as readonly string[]).includes(tag)) {
      const s = val.trim();
      if (s) out[tag as StringField] = s;
    }
  }
  return out;
}

export class ReanimParseError extends Error {}

export function parseReanimXml(src: string): ReanimDefinition {
  const top = elements(parseXmlFragment(src));
  // Some tools wrap the file in a root element; unwrap if there is no <track> at top level.
  let nodes = top;
  if (!nodes.some((n) => n.tag.toLowerCase() === 'track') && nodes.length === 1) nodes = elements(nodes[0].children);
  let fps = 12;
  const tracks: ReanimTrack[] = [];
  for (const el of nodes) {
    const tag = el.tag.toLowerCase();
    if (tag === 'fps') {
      fps = parseNum(textContent(el)) ?? 12;
    } else if (tag === 'track') {
      const nameEl = findChild(el, 'name');
      const name = nameEl ? decodeEntities(textContent(nameEl).trim()) : `track${tracks.length}`;
      const raws = elements(el.children)
        .filter((c) => c.tag.toLowerCase() === 't')
        .map(parseTransform);
      tracks.push({ name, transforms: fillInMissing(raws) });
    }
  }
  if (tracks.length === 0 && !nodes.some((n) => n.tag.toLowerCase() === 'fps')) {
    throw new ReanimParseError('No <track> or <fps> elements found; this does not look like a reanim file.');
  }
  return { fps: fps > 0 ? fps : 12, tracks: normalizeTrackLengths(tracks) };
}

/** Pad every track to the same frame count by holding the last frame. */
export function normalizeTrackLengths(tracks: ReanimTrack[]): ReanimTrack[] {
  const count = tracks.reduce((m, t) => Math.max(m, t.transforms.length), 0);
  for (const t of tracks) {
    if (t.transforms.length === 0) t.transforms.push({ ...DEFAULT_TRANSFORM, f: -1 });
    while (t.transforms.length < count) t.transforms.push({ ...t.transforms[t.transforms.length - 1] });
  }
  return tracks;
}

export function frameCountOf(def: { tracks: { transforms: unknown[] }[] }): number {
  return def.tracks.reduce((m, t) => Math.max(m, t.transforms.length), 0);
}

function numEq(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

export interface SerializeOptions {
  /** Line ending, defaults to CRLF like the original game files. */
  newline?: string;
}

/** Serialize with PopCap-style delta encoding. */
export function serializeReanimXml(def: ReanimDefinition, opts: SerializeOptions = {}): string {
  const nl = opts.newline ?? '\r\n';
  const lines: string[] = [];
  lines.push(`<fps>${formatNumber(def.fps)}</fps>`);
  for (const track of def.tracks) {
    lines.push('<track>');
    lines.push(`<name>${escapeXml(track.name)}</name>`);
    let prev: ReanimTransform = { ...DEFAULT_TRANSFORM };
    for (const t of track.transforms) {
      let body = '';
      for (const k of NUMERIC_FIELDS) {
        if (!numEq(t[k], prev[k])) body += `<${k}>${formatNumber(t[k])}</${k}>`;
      }
      for (const k of STRING_FIELDS) {
        // An empty string cannot be expressed (it means "inherit"), so only emit changes to a value.
        if (t[k] && t[k] !== prev[k]) body += `<${k}>${escapeXml(t[k])}</${k}>`;
      }
      lines.push(`<t>${body}</t>`);
      const next = { ...t };
      for (const k of STRING_FIELDS) if (!t[k]) next[k] = prev[k];
      prev = next;
    }
    lines.push('</track>');
  }
  return lines.join(nl) + nl;
}

export interface AnimRange {
  name: string;
  /** First frame index (inclusive). */
  start: number;
  /** Last frame index (inclusive). */
  end: number;
  trackIndex: number;
}

export function isAnimTrackName(name: string): boolean {
  return name.toLowerCase().startsWith('anim_');
}

type TrackShape = { name: string; transforms: { f: number; i?: string; text?: string }[] };

/** Whether any frame of a track shows an image or text. */
export function hasVisuals(track: { transforms: { i?: string; text?: string }[] }): boolean {
  return track.transforms.some((t) => !!(t.i || t.text));
}

/**
 * An "anim_*" track that only marks the frame range of a named animation. Image
 * tracks named anim_* (anim_head1, anim_tongue, anim_cone…) are parts instead.
 */
export function isRangeTrack(track: TrackShape): boolean {
  return isAnimTrackName(track.name) && !hasVisuals(track);
}

/** Frame range of an anim_ track: first..last frame where f >= 0. (Reanimation::GetFramesForLayer) */
export function rangeOfTrack(transforms: { f: number }[]): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < transforms.length; i++) {
    if (transforms[i].f >= 0) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = start;
  for (let j = transforms.length - 1; j >= start; j--) {
    if (transforms[j].f >= 0) {
      end = j;
      break;
    }
  }
  return { start, end };
}

export function getAnimRanges(tracks: TrackShape[]): AnimRange[] {
  const out: AnimRange[] = [];
  tracks.forEach((t, idx) => {
    if (!isRangeTrack(t)) return;
    const r = rangeOfTrack(t.transforms);
    if (r) out.push({ name: t.name, start: r.start, end: r.end, trackIndex: idx });
  });
  return out;
}

/** Tracks that never draw anything themselves: anim_ range markers, _ground, attachers etc. */
export function isMarkerTrack(track: { name: string; transforms: ReanimTransform[] }): boolean {
  if (track.name.toLowerCase() === 'fullscreen') return false;
  return !track.transforms.some((t) => t.i || (t.text && t.font));
}

export interface AttacherInfo {
  reanimName: string;
  trackName: string;
  fps: number;
  loop: 'loop' | 'once' | 'hold';
}

/** Parse "attacher__ReanimName__anim_name[tags]" (ReanimationParseAttacherTrack). */
export function parseAttacher(spec: string): AttacherInfo | null {
  if (!spec.toLowerCase().startsWith('attacher__')) return null;
  const rest = spec.slice('attacher__'.length);
  const tagStart = rest.indexOf('[');
  const body = tagStart >= 0 ? rest.slice(0, tagStart) : rest;
  const tags = tagStart >= 0 ? rest.slice(tagStart) : '';
  const sep = body.indexOf('__');
  const reanimName = sep >= 0 ? body.slice(0, sep) : body;
  const trackName = sep >= 0 ? body.slice(sep + 2) : '';
  const info: AttacherInfo = { reanimName, trackName, fps: 12, loop: 'loop' };
  for (const m of tags.matchAll(/\[([^\]]*)\]/g)) {
    const tag = m[1].trim().toLowerCase();
    if (tag === 'hold') info.loop = 'hold';
    else if (tag === 'once') info.loop = 'once';
    else if (/^[\d.]+$/.test(tag)) info.fps = parseFloat(tag);
  }
  return reanimName ? info : null;
}
