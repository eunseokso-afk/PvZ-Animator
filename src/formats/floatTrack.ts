/**
 * PopCap "FloatParameterTrack" values used throughout particle definitions.
 *
 * Text syntax (as found in PvZ's particles/*.xml):
 *   5                 constant 5
 *   [5 10]            random value between 5 and 10 (picked once per particle)
 *   [EaseIn 5 10]     random value, biased with the given distribution curve
 *   0 1               0 at the start of the lifetime, 1 at the end (linear)
 *   1,80 0            1 until 80% of the lifetime, then down to 0 at 100%
 *   EaseOut 0 1       curve keyword sets the interpolation into the next node
 *
 * Times are percentages of the lifetime of the particle (or emitter for
 * System* tracks). Nodes without an explicit time are spread evenly.
 */

export enum Curve {
  Constant = 0,
  Linear,
  EaseIn,
  EaseOut,
  EaseInOut,
  EaseInOutWeak,
  FastInOut,
  FastInOutWeak,
  WeakFastInOut,
  Bounce,
  BounceFastMiddle,
  BounceSlowMiddle,
  SinWave,
  EaseSinWave,
}

export const CURVE_NAMES: string[] = [
  'Constant',
  'Linear',
  'EaseIn',
  'EaseOut',
  'EaseInOut',
  'EaseInOutWeak',
  'FastInOut',
  'FastInOutWeak',
  'WeakFastInOut',
  'Bounce',
  'BounceFastMiddle',
  'BounceSlowMiddle',
  'SinWave',
  'EaseSinWave',
];

const CURVE_LOOKUP = new Map(CURVE_NAMES.map((n, i) => [n.toLowerCase(), i as Curve]));

export function curveFromName(name: string): Curve | undefined {
  return CURVE_LOOKUP.get(name.toLowerCase());
}

export interface FloatTrackNode {
  /** 0..1 */
  time: number;
  low: number;
  high: number;
  /** Interpolation from this node to the next one. */
  curve: Curve;
  /** Distribution used to pick a value between low and high. */
  distribution: Curve;
}

export interface FloatTrack {
  nodes: FloatTrackNode[];
}

export class FloatTrackParseError extends Error {}

const quad = (t: number) => t * t;
const invQuad = (t: number) => 2 * t - t * t;
const sCurve = (t: number) => 3 * t * t - 2 * t * t * t;
const invQuadS = (t: number) => (t <= 0.5 ? invQuad(t * 2) * 0.5 : quad((t - 0.5) * 2) * 0.5 + 0.5);
const bounce = (t: number) => 1 - Math.abs(1 - 2 * t);

export function warpTime(t: number, curve: Curve): number {
  switch (curve) {
    case Curve.Constant:
      return 0;
    case Curve.Linear:
      return t;
    case Curve.EaseIn:
      return quad(t);
    case Curve.EaseOut:
      return invQuad(t);
    case Curve.EaseInOut:
      return sCurve(sCurve(t));
    case Curve.EaseInOutWeak:
      return sCurve(t);
    case Curve.FastInOut:
      return invQuadS(invQuadS(t));
    case Curve.FastInOutWeak:
      return invQuadS(t);
    case Curve.WeakFastInOut:
      return invQuadS(sCurve(t));
    case Curve.Bounce:
      return bounce(t);
    case Curve.BounceFastMiddle:
      return quad(bounce(t));
    case Curve.BounceSlowMiddle:
      return invQuad(bounce(t));
    case Curve.SinWave:
      return Math.sin(t * Math.PI * 2);
    case Curve.EaseSinWave:
      return Math.sin(sCurve(t) * Math.PI * 2);
    default:
      return t;
  }
}

export function curveEvaluate(t: number, start: number, end: number, curve: Curve): number {
  return start + (end - start) * warpTime(t, curve);
}

export function isTrackSet(track: FloatTrack | undefined): boolean {
  return !!track && track.nodes.length > 0;
}

export function constantTrack(value: number): FloatTrack {
  return { nodes: [{ time: 0, low: value, high: value, curve: Curve.Linear, distribution: Curve.Linear }] };
}

/** FloatTrackEvaluate from TodLib. `interp` is the per-instance random 0..1. */
export function evaluateFloatTrack(track: FloatTrack, time: number, interp: number): number {
  const nodes = track.nodes;
  if (nodes.length === 0) return 0;
  const first = nodes[0];
  if (time < first.time) return curveEvaluate(interp, first.low, first.high, first.distribution);
  for (let i = 1; i < nodes.length; i++) {
    const next = nodes[i];
    if (time <= next.time) {
      const cur = nodes[i - 1];
      const span = next.time - cur.time;
      const frac = span > 0 ? (time - cur.time) / span : 1;
      const left = curveEvaluate(interp, cur.low, cur.high, cur.distribution);
      const right = curveEvaluate(interp, next.low, next.high, next.distribution);
      return curveEvaluate(frac, left, right, cur.curve);
    }
  }
  const last = nodes[nodes.length - 1];
  return curveEvaluate(interp, last.low, last.high, last.distribution);
}

/** Smallest/largest values the track can produce (used for UI graphs). */
export function trackBounds(track: FloatTrack): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let s = 0; s <= 32; s++) {
    for (const interp of [0, 1]) {
      const v = evaluateFloatTrack(track, s / 32, interp);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo)) return [0, 0];
  return [lo, hi];
}

const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;

export function parseFloatTrack(src: string): FloatTrack {
  const s = src.trim();
  const nodes: (FloatTrackNode & { explicitTime: boolean })[] = [];
  let i = 0;
  let pendingCurve: Curve | null = null;

  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const readNumber = (): number => {
    skipWs();
    const m = NUMBER_RE.exec(s.slice(i));
    if (!m) throw new FloatTrackParseError(`Expected a number at position ${i + 1} in "${src}"`);
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const readWord = (): string => {
    const m = /^[A-Za-z]+/.exec(s.slice(i));
    if (!m) return '';
    i += m[0].length;
    return m[0];
  };

  while (true) {
    skipWs();
    if (i >= s.length) break;
    const c = s[i];
    if (/[A-Za-z]/.test(c)) {
      const word = readWord();
      const curve = curveFromName(word);
      if (curve === undefined) throw new FloatTrackParseError(`Unknown curve "${word}" in "${src}"`);
      pendingCurve = curve;
      continue;
    }
    let low: number;
    let high: number;
    let distribution = Curve.Linear;
    if (c === '[') {
      i++;
      skipWs();
      if (/[A-Za-z]/.test(s[i] ?? '')) {
        const word = readWord();
        const curve = curveFromName(word);
        if (curve === undefined) throw new FloatTrackParseError(`Unknown curve "${word}" in "${src}"`);
        distribution = curve;
      }
      low = readNumber();
      skipWs();
      if (s[i] === ']') {
        high = low;
      } else {
        high = readNumber();
        skipWs();
      }
      if (s[i] !== ']') throw new FloatTrackParseError(`Missing "]" in "${src}"`);
      i++;
    } else {
      low = high = readNumber();
    }
    skipWs();
    let time = -1;
    let explicitTime = false;
    if (s[i] === ',') {
      i++;
      time = readNumber() / 100;
      explicitTime = true;
    }
    nodes.push({ time, low, high, curve: pendingCurve ?? Curve.Linear, distribution, explicitTime });
    pendingCurve = null;
  }
  // (A trailing curve keyword has no node to apply to and is ignored.)

  // Fill in unspecified times: first = 0, last = 1, others spread evenly.
  if (nodes.length > 0) {
    if (!nodes[0].explicitTime) nodes[0].time = 0;
    const last = nodes[nodes.length - 1];
    if (!last.explicitTime && nodes.length > 1) last.time = 1;
    let prevKnown = 0;
    for (let k = 1; k < nodes.length; k++) {
      if (nodes[k].explicitTime || k === nodes.length - 1) {
        const from = nodes[prevKnown].time;
        const to = nodes[k].time;
        const gap = k - prevKnown;
        for (let m = prevKnown + 1; m < k; m++) nodes[m].time = from + ((to - from) * (m - prevKnown)) / gap;
        prevKnown = k;
      }
    }
  }
  return { nodes: nodes.map(({ explicitTime: _e, ...n }) => n) };
}

export function tryParseFloatTrack(src: string): { track: FloatTrack; error?: string } {
  try {
    return { track: parseFloatTrack(src) };
  } catch (e) {
    return { track: { nodes: [] }, error: (e as Error).message };
  }
}

export function formatNumber(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return '0';
  let s = n.toFixed(digits);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

/** Serialize a track back into PopCap's text syntax. */
export function formatFloatTrack(track: FloatTrack): string {
  const n = track.nodes.length;
  const parts: string[] = [];
  track.nodes.forEach((node, idx) => {
    let piece = '';
    if (node.curve !== Curve.Linear && idx < n - 1) piece += CURVE_NAMES[node.curve] + ' ';
    if (node.low === node.high && node.distribution === Curve.Linear) {
      piece += formatNumber(node.low);
    } else {
      const dist = node.distribution !== Curve.Linear ? CURVE_NAMES[node.distribution] + ' ' : '';
      piece += `[${dist}${formatNumber(node.low)} ${formatNumber(node.high)}]`;
    }
    const implicit = (idx === 0 && node.time === 0) || (idx === n - 1 && n > 1 && node.time === 1);
    if (!implicit && n > 1) piece += ',' + formatNumber(node.time * 100, 2);
    else if (n === 1 && node.time !== 0) piece += ',' + formatNumber(node.time * 100, 2);
    parts.push(piece);
  });
  return parts.join(' ');
}
