/**
 * An easing-curve editor (like Animate's custom ease): drag points and their Bézier
 * handles; double-click the curve to add a point and a point to remove it. Handles of
 * a point move together (a smooth curve) unless Alt is held.
 */

import { CURVE_Y_MAX, CURVE_Y_MIN, cloneCurve, evalCurve, insertPoint, normalizeCurve, type EaseCurve } from '../editor/easeCurve';
import { h } from './dom';

export interface CurveEditorOptions {
  height?: number;
  /** Before a change (an undo step). */
  onBegin?(): void;
  /** Each change; `final` is false while dragging. */
  onChange(curve: EaseCurve, final: boolean): void;
}

type Hit = { kind: 'point' | 'in' | 'out'; index: number };

const PAD_X = 14;
const PAD_Y = 12;
const HANDLE_R = 4.5;

export class CurveEditor {
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private curve: EaseCurve;
  /** A step curve (hold): drawn instead of the curve until it is edited. */
  private step = false;
  private disabled = false;
  private selected = -1;
  private hover: Hit | null = null;
  private drag: (Hit & { began: boolean; sx: number; sy: number; y0: number; y1: number }) | null = null;
  private marker: number | null = null;
  /** Visible y range; frozen while dragging so the graph does not rescale under the pointer. */
  private yr: [number, number] = [-0.2, 1.2];

  constructor(curve: EaseCurve, private opts: CurveEditorOptions) {
    this.curve = normalizeCurve(curve);
    this.canvas = h('canvas', { class: 'curve-canvas', tabIndex: 0, style: { height: `${opts.height ?? 180}px` } });
    this.el = h('div', { class: 'curve-editor' }, this.canvas);
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => {
      if (this.hover) {
        this.hover = null;
        this.draw();
      }
    });
    this.canvas.addEventListener('dblclick', (e) => this.onDouble(e));
    this.canvas.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected > 0 && this.selected < this.curve.length - 1) {
        e.preventDefault();
        e.stopPropagation();
        this.removePoint(this.selected);
      } else if (e.key !== 'Escape') e.stopPropagation();
    });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  /** Show a curve (not while it is being dragged). `step` draws a hold. */
  set(curve: EaseCurve, step = false): void {
    if (this.drag) return;
    this.curve = normalizeCurve(curve);
    this.step = step;
    if (this.selected >= this.curve.length) this.selected = -1;
    this.draw();
  }

  get value(): EaseCurve {
    return cloneCurve(this.curve);
  }

  setDisabled(v: boolean): void {
    this.disabled = v;
    this.canvas.classList.toggle('disabled', v);
    this.draw();
  }

  /** Show the progress marker at time t (0..1), or hide it. */
  setMarker(t: number | null): void {
    this.marker = t;
    this.draw();
  }

  // ------------------------------------------------------------ geometry

  private size(): [number, number] {
    return [Math.max(40, this.canvas.clientWidth), Math.max(40, this.canvas.clientHeight)];
  }

  private fitRange() {
    let lo = -0.15;
    let hi = 1.15;
    for (const p of this.curve) {
      lo = Math.min(lo, p.y - 0.08, p.y + p.inY - 0.08, p.y + p.outY - 0.08);
      hi = Math.max(hi, p.y + 0.08, p.y + p.inY + 0.08, p.y + p.outY + 0.08);
    }
    this.yr = [Math.max(CURVE_Y_MIN - 0.05, lo), Math.min(CURVE_Y_MAX + 0.05, hi)];
  }

  private toPx(x: number, y: number): [number, number] {
    const [w, hh] = this.size();
    const [lo, hi] = this.yr;
    return [PAD_X + x * (w - PAD_X * 2), PAD_Y + ((hi - y) / (hi - lo)) * (hh - PAD_Y * 2)];
  }

  private fromPx(px: number, py: number): [number, number] {
    const [w, hh] = this.size();
    const [lo, hi] = this.yr;
    return [(px - PAD_X) / (w - PAD_X * 2), hi - ((py - PAD_Y) / (hh - PAD_Y * 2)) * (hi - lo)];
  }

  private pos(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private hit(px: number, py: number): Hit | null {
    const c = this.curve;
    // Handles first (they sit on top), then points.
    for (let i = 0; i < c.length; i++) {
      const p = c[i];
      if (i > 0) {
        const [hx, hy] = this.toPx(p.x + p.inX, p.y + p.inY);
        if (Math.hypot(hx - px, hy - py) <= HANDLE_R + 3) return { kind: 'in', index: i };
      }
      if (i < c.length - 1) {
        const [hx, hy] = this.toPx(p.x + p.outX, p.y + p.outY);
        if (Math.hypot(hx - px, hy - py) <= HANDLE_R + 3) return { kind: 'out', index: i };
      }
    }
    for (let i = 1; i < c.length - 1; i++) {
      const [x, y] = this.toPx(c[i].x, c[i].y);
      if (Math.abs(x - px) <= HANDLE_R + 3 && Math.abs(y - py) <= HANDLE_R + 3) return { kind: 'point', index: i };
    }
    return null;
  }

  // ------------------------------------------------------------ editing

  private onDown(e: PointerEvent) {
    if (this.disabled || e.button !== 0) return;
    this.canvas.focus();
    const [px, py] = this.pos(e);
    const hit = this.hit(px, py);
    if (!hit) {
      if (this.selected !== -1) {
        this.selected = -1;
        this.draw();
      }
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.selected = hit.index;
    this.drag = { ...hit, began: false, sx: px, sy: py, y0: this.yr[0], y1: this.yr[1] };
    this.draw();
  }

  private onMove(e: PointerEvent) {
    const [px, py] = this.pos(e);
    const drag = this.drag;
    if (!drag) {
      if (this.disabled) return;
      const hit = this.hit(px, py);
      if (hit?.kind !== this.hover?.kind || hit?.index !== this.hover?.index) {
        this.hover = hit;
        this.canvas.style.cursor = hit ? (hit.kind === 'point' ? 'move' : 'grab') : 'default';
        this.draw();
      }
      return;
    }
    if (!drag.began) {
      if (Math.abs(px - drag.sx) + Math.abs(py - drag.sy) < 2) return;
      drag.began = true;
      this.opts.onBegin?.();
      // Editing a hold starts from a straight line.
      this.step = false;
    }
    const [x, y] = this.fromPx(px, py);
    const c = this.curve;
    const p = c[drag.index];
    const prev = c[drag.index - 1];
    const next = c[drag.index + 1];
    if (drag.kind === 'point') {
      p.x = Math.min(next.x - 0.01, Math.max(prev.x + 0.01, x));
      p.y = Math.min(CURVE_Y_MAX, Math.max(CURVE_Y_MIN, y));
      // Handles stay inside the neighbouring segments.
      p.inX = Math.max(p.inX, prev.x - p.x);
      p.outX = Math.min(p.outX, next.x - p.x);
      prev.outX = Math.min(prev.outX, p.x - prev.x);
      next.inX = Math.max(next.inX, p.x - next.x);
    } else {
      const out = drag.kind === 'out';
      let dx = x - p.x;
      const dy = Math.min(CURVE_Y_MAX, Math.max(CURVE_Y_MIN, y)) - p.y;
      dx = out ? Math.min(next.x - p.x, Math.max(0, dx)) : Math.max(prev.x - p.x, Math.min(0, dx));
      if (out) [p.outX, p.outY] = [dx, dy];
      else [p.inX, p.inY] = [dx, dy];
      // Keep the curve smooth through an inner point: the other handle turns to stay in line.
      if (!e.altKey && drag.index > 0 && drag.index < c.length - 1) {
        const len = out ? Math.hypot(p.inX, p.inY) : Math.hypot(p.outX, p.outY);
        const d = Math.hypot(dx, dy);
        if (d > 1e-6 && len > 1e-6) {
          let ox = (-dx / d) * len;
          let oy = (-dy / d) * len;
          const room = out ? prev.x - p.x : next.x - p.x;
          // Shorten along the line if the handle would leave its segment.
          const k = Math.abs(ox) > Math.abs(room) && ox !== 0 ? Math.abs(room / ox) : 1;
          ox *= k;
          oy *= k;
          if (out) [p.inX, p.inY] = [ox, oy];
          else [p.outX, p.outY] = [ox, oy];
        }
      }
    }
    this.curve = normalizeCurve(c);
    this.opts.onChange(this.value, false);
    this.draw();
  }

  private onUp(e: PointerEvent) {
    const drag = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (drag?.began) {
      this.opts.onChange(this.value, true);
      this.draw();
    }
  }

  private onDouble(e: MouseEvent) {
    if (this.disabled) return;
    const [px, py] = this.pos(e);
    const hit = this.hit(px, py);
    if (hit?.kind === 'point') return this.removePoint(hit.index);
    if (hit) return;
    const [t] = this.fromPx(px, py);
    const added = insertPoint(this.step ? normalizeCurve([]) : this.curve, t);
    if (!added) return;
    this.opts.onBegin?.();
    this.step = false;
    this.curve = added.curve;
    this.selected = added.index;
    this.opts.onChange(this.value, true);
    this.draw();
  }

  private removePoint(i: number) {
    if (i <= 0 || i >= this.curve.length - 1) return;
    this.opts.onBegin?.();
    const c = cloneCurve(this.curve);
    c.splice(i, 1);
    this.curve = normalizeCurve(c);
    this.selected = -1;
    this.opts.onChange(this.value, true);
    this.draw();
  }

  // ------------------------------------------------------------ drawing

  draw(): void {
    const cv = this.canvas;
    const [w, hh] = this.size();
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(hh * dpr);
    }
    if (!this.drag) this.fitRange();
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#181a20';
    ctx.fillRect(0, 0, w, hh);
    // Grid: quarters of the tween; the start (0) and end (1) values.
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const [x] = this.toPx(i / 4, 0);
      ctx.fillStyle = i % 4 === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
      ctx.fillRect(Math.round(x), 0, 1, hh);
    }
    for (const v of [0, 0.5, 1]) {
      const [, y] = this.toPx(0, v);
      ctx.fillStyle = v === 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.18)';
      ctx.fillRect(0, Math.round(y), w, 1);
    }
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText('end', 3, this.toPx(0, 1)[1] - 3);
    ctx.fillText('start', 3, this.toPx(0, 0)[1] + 11);
    ctx.fillText('time →', w - 44, hh - 3);
    // Linear, for reference.
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(...this.toPx(0, 0));
    ctx.lineTo(...this.toPx(1, 1));
    ctx.stroke();
    ctx.setLineDash([]);

    const c = this.curve;
    const accent = this.disabled ? '#6b7180' : '#f0a64a';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (this.step) {
      ctx.moveTo(...this.toPx(0, 0));
      ctx.lineTo(...this.toPx(1, 0));
      ctx.lineTo(...this.toPx(1, 1));
    } else {
      const n = Math.max(60, Math.round(w / 2));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const [x, y] = this.toPx(t, evalCurve(c, t));
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
    }
    ctx.stroke();
    if (this.marker !== null && !this.step) {
      const t = Math.max(0, Math.min(1, this.marker));
      const [x, y] = this.toPx(t, evalCurve(c, t));
      ctx.fillStyle = 'rgba(124,192,255,0.35)';
      ctx.fillRect(Math.round(x), 0, 1, hh);
      ctx.fillStyle = '#7cc0ff';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.disabled || this.step) return;
    // Handles, then points.
    for (let i = 0; i < c.length; i++) {
      const p = c[i];
      const [x, y] = this.toPx(p.x, p.y);
      for (const kind of ['in', 'out'] as const) {
        if ((kind === 'in' && i === 0) || (kind === 'out' && i === c.length - 1)) continue;
        const [hx, hy] = this.toPx(p.x + (kind === 'in' ? p.inX : p.outX), p.y + (kind === 'in' ? p.inY : p.outY));
        const hot = (this.hover?.kind === kind && this.hover.index === i) || (this.drag?.kind === kind && this.drag.index === i);
        ctx.strokeStyle = 'rgba(124,192,255,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.fillStyle = hot ? '#ffffff' : '#7cc0ff';
        ctx.beginPath();
        ctx.arc(hx, hy, HANDLE_R, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (let i = 0; i < c.length; i++) {
      const [x, y] = this.toPx(c[i].x, c[i].y);
      const end = i === 0 || i === c.length - 1;
      const sel = i === this.selected;
      const hot = this.hover?.kind === 'point' && this.hover.index === i;
      ctx.fillStyle = sel ? '#ffd34d' : end ? '#8a90a0' : hot ? '#ffffff' : '#e8edf5';
      ctx.fillRect(x - 4, y - 4, 8, 8);
      ctx.strokeStyle = '#181a20';
      ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
    }
  }
}

/** A small, non-interactive picture of a curve (for preset menus and buttons). */
export function curveThumb(curve: EaseCurve, w = 34, hh = 22): HTMLCanvasElement {
  const dpr = window.devicePixelRatio || 1;
  const cv = h('canvas', { class: 'curve-thumb', width: Math.round(w * dpr), height: Math.round(hh * dpr), style: { width: `${w}px`, height: `${hh}px` } });
  const ctx = cv.getContext('2d');
  if (!ctx) return cv;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i <= 40; i++) {
    const y = evalCurve(curve, i / 40);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  const map = (t: number, y: number): [number, number] => [2 + t * (w - 4), 2 + ((hi - y) / (hi - lo || 1)) * (hh - 4)];
  ctx.strokeStyle = '#f0a64a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) {
    const [x, y] = map(i / 40, evalCurve(curve, i / 40));
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.stroke();
  return cv;
}
