/**
 * Custom easing curves, like Animate's custom ease: a chain of cubic Bézier segments
 * from (0, 0) to (1, 1). x is how far through the tween the time is, y how far the
 * values have got; y may leave 0..1 to overshoot or wind up. Every point has handles
 * (offsets from the point). A handle's x stays inside its segment, so the curve has
 * exactly one y for each time.
 */

export interface CurvePoint {
  x: number;
  y: number;
  /** Handle towards the previous point (offset, x <= 0). */
  inX: number;
  inY: number;
  /** Handle towards the next point (offset, x >= 0). */
  outX: number;
  outY: number;
}

export type EaseCurve = CurvePoint[];

/** How far y may go past 0..1 (the editor's range). */
export const CURVE_Y_MIN = -1;
export const CURVE_Y_MAX = 2;

/** Points closer than this in x are merged. */
const MIN_GAP = 0.005;

export function cloneCurve(c: readonly CurvePoint[]): EaseCurve {
  return c.map((p) => ({ ...p }));
}

export function curvesEqual(a: readonly CurvePoint[] | null | undefined, b: readonly CurvePoint[] | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y && p.inX === b[i].inX && p.inY === b[i].inY && p.outX === b[i].outX && p.outY === b[i].outY);
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * A valid curve from anything (a saved project, an edit in progress): points sorted by x,
 * ends at (0, 0) and (1, 1), y within range, and every handle inside its segment.
 */
export function normalizeCurve(input: unknown): EaseCurve {
  const raw = Array.isArray(input) ? (input as Partial<CurvePoint>[]) : [];
  let pts: CurvePoint[] = raw
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({ x: num(p.x, 0), y: num(p.y, 0), inX: num(p.inX, 0), inY: num(p.inY, 0), outX: num(p.outX, 0), outY: num(p.outY, 0) }));
  pts.sort((a, b) => a.x - b.x);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const inner = pts.filter((p) => p !== first && p !== last && p.x > MIN_GAP && p.x < 1 - MIN_GAP);
  pts = [
    { x: 0, y: 0, inX: 0, inY: 0, outX: first?.outX ?? 1 / 3, outY: first?.outY ?? 1 / 3 },
    ...inner,
    { x: 1, y: 1, inX: last?.inX ?? -1 / 3, inY: last?.inY ?? -1 / 3, outX: 0, outY: 0 },
  ];
  // Drop points crowding their neighbour.
  const out: CurvePoint[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (i < pts.length - 1 && (p.x - out[out.length - 1].x < MIN_GAP || pts[pts.length - 1].x - p.x < MIN_GAP)) continue;
    out.push(p);
  }
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    p.x = clamp(p.x, 0, 1);
    p.y = clamp(p.y, CURVE_Y_MIN, CURVE_Y_MAX);
    const prev = out[i - 1];
    const next = out[i + 1];
    if (prev) {
      p.inX = clamp(p.inX, prev.x - p.x, 0);
      p.inY = clamp(p.y + p.inY, CURVE_Y_MIN, CURVE_Y_MAX) - p.y;
    } else p.inX = p.inY = 0;
    if (next) {
      p.outX = clamp(p.outX, 0, next.x - p.x);
      p.outY = clamp(p.y + p.outY, CURVE_Y_MIN, CURVE_Y_MAX) - p.y;
    } else p.outX = p.outY = 0;
  }
  return out;
}

function bez(a: number, b: number, c: number, d: number, u: number): number {
  const v = 1 - u;
  return v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * c + u * u * u * d;
}

function bezSlope(a: number, b: number, c: number, d: number, u: number): number {
  const v = 1 - u;
  return 3 * v * v * (b - a) + 6 * v * u * (c - b) + 3 * u * u * (d - c);
}

/** The segment holding time t, and where along it (the Bézier parameter) t is. */
function locate(c: readonly CurvePoint[], t: number): { i: number; u: number } {
  let i = 0;
  while (i < c.length - 2 && t > c[i + 1].x) i++;
  const p = c[i];
  const q = c[i + 1];
  const x0 = p.x;
  const x1 = p.x + p.outX;
  const x2 = q.x + q.inX;
  const x3 = q.x;
  if (x3 - x0 < 1e-9) return { i, u: 1 };
  // Solve x(u) = t: Newton from a linear guess, bisection when it misbehaves (x(u) is monotonic).
  let u = Math.min(1, Math.max(0, (t - x0) / (x3 - x0)));
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 30; k++) {
    const x = bez(x0, x1, x2, x3, u) - t;
    if (Math.abs(x) < 1e-9) break;
    if (x > 0) hi = u;
    else lo = u;
    const d = bezSlope(x0, x1, x2, x3, u);
    let n = d > 1e-9 ? u - x / d : NaN;
    if (!(n > lo && n < hi)) n = (lo + hi) / 2;
    u = n;
  }
  return { i, u };
}

/** The eased progress (y) at time t (0..1). */
export function evalCurve(c: readonly CurvePoint[], t: number): number {
  if (c.length < 2) return t;
  if (t <= 0) return c[0].y;
  if (t >= 1) return c[c.length - 1].y;
  const { i, u } = locate(c, t);
  const p = c[i];
  const q = c[i + 1];
  return bez(p.y, p.y + p.outY, q.y + q.inY, q.y, u);
}

/** A one-segment curve like CSS cubic-bezier(x1, y1, x2, y2). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseCurve {
  return normalizeCurve([
    { x: 0, y: 0, inX: 0, inY: 0, outX: x1, outY: y1 },
    { x: 1, y: 1, inX: x2 - 1, inY: y2 - 1, outX: 0, outY: 0 },
  ]);
}

/** A smooth point (level handles) at (x, y) between neighbours at xa and xb. */
function smooth(x: number, y: number, xa: number, xb: number, slope = 0): CurvePoint {
  const a = (x - xa) / 3;
  const b = (xb - x) / 3;
  return { x, y, inX: -a, inY: -a * slope, outX: b, outY: b * slope };
}

/** Penner's bounce: a fall, then three hops, each a parabola (exact as Béziers). */
function bounceOut(): EaseCurve {
  const hops: [number, number, number][] = [
    [4 / 11, 8 / 11, 0.25],
    [8 / 11, 10 / 11, 0.0625],
    [10 / 11, 1, 0.015625],
  ];
  const pts: CurvePoint[] = [{ x: 0, y: 0, inX: 0, inY: 0, outX: 4 / 33, outY: 0 }];
  // The fall: y = (t / (4/11))², ending at (4/11, 1) with slope 5.5.
  let prev: CurvePoint = { x: 4 / 11, y: 1, inX: -4 / 33, inY: -2 / 3, outX: 0, outY: 0 };
  pts.push(prev);
  for (const [a, b, h] of hops) {
    // A parabola from (a, 1) to (b, 1) dipping to 1 - h: quadratic control (mid, 1 - 2h).
    const third = (b - a) / 3;
    prev.outX = third;
    prev.outY = -(4 / 3) * h;
    prev = { x: b, y: 1, inX: -third, inY: -(4 / 3) * h, outX: 0, outY: 0 };
    pts.push(prev);
  }
  return normalizeCurve(pts);
}

/** A damped spring settling on 1. */
function elasticOut(): EaseCurve {
  const peaks: [number, number][] = [
    [0, 0],
    [0.16, 1.32],
    [0.36, 0.86],
    [0.56, 1.07],
    [0.76, 0.97],
    [1, 1],
  ];
  return normalizeCurve(
    peaks.map(([x, y], i) => {
      if (i === 0) return { x, y, inX: 0, inY: 0, outX: 0.04, outY: 0.5 };
      return smooth(x, y, peaks[i - 1][0], peaks[i + 1]?.[0] ?? 1);
    }),
  );
}

export interface CurvePreset {
  id: string;
  label: string;
  curve: EaseCurve;
}

export const CURVE_PRESETS: CurvePreset[] = [
  { id: 'linear', label: 'Linear', curve: cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3) },
  // The same curves as the built-in eases (quadratic in/out, smoothstep in-out), exactly.
  { id: 'easeIn', label: 'Ease in', curve: cubicBezier(1 / 3, 0, 2 / 3, 1 / 3) },
  { id: 'easeOut', label: 'Ease out', curve: cubicBezier(1 / 3, 2 / 3, 2 / 3, 1) },
  { id: 'easeInOut', label: 'Ease in-out', curve: cubicBezier(1 / 3, 0, 2 / 3, 1) },
  { id: 'strongIn', label: 'Strong in', curve: cubicBezier(0.55, 0.055, 0.675, 0.19) },
  { id: 'strongOut', label: 'Strong out', curve: cubicBezier(0.215, 0.61, 0.355, 1) },
  { id: 'strongInOut', label: 'Strong in-out', curve: cubicBezier(0.645, 0.045, 0.355, 1) },
  { id: 'snap', label: 'Snap (fast stop)', curve: cubicBezier(0.16, 1, 0.3, 1) },
  { id: 'backIn', label: 'Wind up (back in)', curve: cubicBezier(0.6, -0.28, 0.735, 0.045) },
  { id: 'backOut', label: 'Overshoot (back out)', curve: cubicBezier(0.175, 0.885, 0.32, 1.275) },
  { id: 'backInOut', label: 'Wind up + overshoot', curve: cubicBezier(0.68, -0.55, 0.265, 1.55) },
  { id: 'bounce', label: 'Bounce', curve: bounceOut() },
  { id: 'elastic', label: 'Elastic', curve: elasticOut() },
  {
    id: 'pause',
    label: 'Go, pause, go',
    curve: normalizeCurve([
      { x: 0, y: 0, inX: 0, inY: 0, outX: 0.12, outY: 0.25 },
      smooth(0.5, 0.5, 0, 1),
      { x: 1, y: 1, inX: -0.12, inY: -0.25, outX: 0, outY: 0 },
    ]),
  },
];

/** The curve a built-in ease draws (to start editing from it). Hold has no curve: linear. */
export function curveForEase(ease: string): EaseCurve {
  return cloneCurve((CURVE_PRESETS.find((p) => p.id === ease) ?? CURVE_PRESETS[0]).curve);
}

/** Time runs backwards: an ease-in becomes an ease-out. */
export function reverseCurve(c: readonly CurvePoint[]): EaseCurve {
  return normalizeCurve(
    [...c].reverse().map((p) => ({ x: 1 - p.x, y: 1 - p.y, inX: -p.outX, inY: -p.outY, outX: -p.inX, outY: -p.inY })),
  );
}

/** A point added on the curve at time t, splitting its segment in two without changing the curve's shape. */
export function insertPoint(c: readonly CurvePoint[], t: number): { curve: EaseCurve; index: number } | null {
  if (t <= MIN_GAP || t >= 1 - MIN_GAP) return null;
  const pts = cloneCurve(c);
  const { i, u } = locate(pts, t);
  const a = pts[i];
  const b = pts[i + 1];
  if (t - a.x < MIN_GAP || b.x - t < MIN_GAP) return null;
  // de Casteljau: the two halves of the segment are Béziers whose controls follow from u.
  const lerp = (p: [number, number], q: [number, number]): [number, number] => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
  const p0: [number, number] = [a.x, a.y];
  const p1: [number, number] = [a.x + a.outX, a.y + a.outY];
  const p2: [number, number] = [b.x + b.inX, b.y + b.inY];
  const p3: [number, number] = [b.x, b.y];
  const q0 = lerp(p0, p1);
  const q1 = lerp(p1, p2);
  const q2 = lerp(p2, p3);
  const r0 = lerp(q0, q1);
  const r1 = lerp(q1, q2);
  const m = lerp(r0, r1);
  a.outX = q0[0] - a.x;
  a.outY = q0[1] - a.y;
  b.inX = q2[0] - b.x;
  b.inY = q2[1] - b.y;
  pts.splice(i + 1, 0, { x: m[0], y: m[1], inX: r0[0] - m[0], inY: r0[1] - m[1], outX: r1[0] - m[0], outY: r1[1] - m[1] });
  return { curve: normalizeCurve(pts), index: i + 1 };
}
