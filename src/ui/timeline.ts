/**
 * Reanim timeline: animation ranges, sound/particle cue lanes and one row
 * per track with keyframes. Drawn on a canvas for speed.
 */

import { clamp } from '../engine/math';
import { LOOP_MODES, type LoopMode } from '../engine/reanimRuntime';
import { basename } from '../engine/vfs';
import { isAnimTrackName, isMarkerTrack } from '../formats/reanim';
import { EASES, type ReanimDocument } from '../editor/reanimDoc';
import type { Workspace } from '../editor/workspace';
import { h } from './dom';
import { ASSET_MIME } from './viewport';
import { numberField, showMenu, type MenuItem, type NumberField } from './widgets';

const RULER_H = 22;
const ROW_H = 20;
const NAME_W = 210;

type Row =
  | { kind: 'header'; label: string; section: 'anims' | 'cues' | 'parts' }
  | { kind: 'anim'; trackIndex: number; name: string; start: number; end: number; color: string }
  | { kind: 'sound' }
  | { kind: 'particle' }
  | { kind: 'track'; trackIndex: number };

const ANIM_COLORS = ['#4f9dde', '#e08a3c', '#53b86a', '#c95fb8', '#d4c14a', '#5fc4c4', '#e0606a', '#8a7be0'];

const C = {
  bg: '#1d2027',
  rowAlt: '#21252d',
  names: '#262a33',
  header: '#2c313b',
  ruler: '#2a2e37',
  text: '#c9ceda',
  dim: '#7d8494',
  grid: 'rgba(255,255,255,0.05)',
  grid5: 'rgba(255,255,255,0.10)',
  visible: '#2e4a5c',
  visibleSel: '#3b6580',
  key: '#e8edf5',
  keyEase: '#f0a64a',
  keyHold: '#9aa0ad',
  sel: '#ffd34d',
  playhead: '#ff5d5d',
  outside: 'rgba(0,0,0,0.28)',
};

type Drag =
  | { kind: 'scrub' }
  | { kind: 'select'; track: number; from: number }
  | { kind: 'moveKey'; track: number; from: number; to: number }
  | { kind: 'reorder'; track: number; target: number; startY: number; moved: boolean }
  | { kind: 'range'; trackIndex: number; name: string; edge: 'start' | 'end'; start: number; end: number }
  | { kind: 'cue'; cueKind: 'sound' | 'particle'; uid: number; from: number; to: number; moved: boolean };

export interface TimelineHooks {
  trackMenu(doc: ReanimDocument, track: number): MenuItem[];
  editRange(doc: ReanimDocument, name?: string): void;
  addSoundCue(doc: ReanimDocument, frame: number): void;
  addParticleCue(doc: ReanimDocument, frame: number): void;
  renameTrack(doc: ReanimDocument, track: number): void;
  previewSound(path: string): void;
}

export class Timeline {
  readonly el: HTMLElement;
  private toolbar: HTMLElement;
  private canvas: HTMLCanvasElement;
  private wrap: HTMLElement;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private scrollX = 0;
  private scrollY = 0;
  private cellW = 14;
  private rows: Row[] = [];
  private drag: Drag | null = null;
  private playBtn!: HTMLButtonElement;
  private frameField!: NumberField;
  private frameTotal!: HTMLElement;
  private animSelect!: HTMLSelectElement;
  private loopSelect!: HTMLSelectElement;
  private fpsField!: NumberField;
  private countField!: NumberField;
  private onionBtn!: HTMLButtonElement;
  private soundBtn!: HTMLButtonElement;
  private lastFollowFrame = -1;
  /** Per-document horizontal zoom and scroll. */
  private views = new Map<number, { cellW: number; scrollX: number; scrollY: number }>();
  private viewDoc = -1;

  constructor(
    private ws: Workspace,
    private hooks: TimelineHooks,
  ) {
    this.toolbar = h('div', { class: 'tl-toolbar' });
    this.canvas = h('canvas', { class: 'tl-canvas', tabIndex: 0 });
    this.wrap = h('div', { class: 'tl-wrap' }, this.canvas);
    this.el = h('div', { class: 'timeline' }, this.toolbar, this.wrap);
    this.buildToolbar();
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.bindInput();
    const redraw = () => {
      this.syncToolbar();
      this.draw();
    };
    ws.on('change', redraw);
    ws.on('docs', redraw);
    ws.on('frame', () => {
      this.followPlayhead();
      this.syncToolbar(true);
      this.draw();
    });
    ws.on('settings', redraw);
  }

  private get doc(): ReanimDocument | null {
    return this.ws.reanim;
  }

  // ------------------------------------------------------------ toolbar

  private buildToolbar() {
    const ws = this.ws;
    const btn = (label: string, title: string, fn: () => void) => h('button', { class: 'tool-btn', title, onclick: fn }, label);
    const range = () => this.doc?.activeRange() ?? { start: 0, end: 0 };
    this.playBtn = btn('▶', 'Play / pause (Space)', () => ws.togglePlay());
    this.frameField = numberField({
      label: 'Frame',
      value: 0,
      precision: 0,
      onChange: (v, final) => final && ws.setFrame(v),
    });
    this.frameTotal = h('span', { class: 'tl-total' }, '/ 0');
    this.animSelect = h('select', {
      title: 'Animation to preview',
      onchange: () => {
        const doc = this.doc;
        if (!doc) return;
        doc.ui.anim = this.animSelect.value;
        const r = doc.activeRange();
        ws.setFrame(r.start);
        this.scrollToFrame(r.start);
      },
    });
    this.loopSelect = h(
      'select',
      {
        title: 'Loop mode (as used by the game)',
        onchange: () => {
          const doc = this.doc;
          if (doc) doc.ui.loop = this.loopSelect.value as LoopMode;
          ws.emit('change');
        },
      },
      LOOP_MODES.map((m) => h('option', { value: m.id }, m.label)),
    );
    const speed = h(
      'select',
      {
        title: 'Playback speed',
        onchange: () => {
          ws.speed = parseFloat(speed.value);
        },
      },
      [0.1, 0.25, 0.5, 1, 1.5, 2].map((s) => h('option', { value: String(s), selected: s === 1 }, `${s}×`)),
    );
    this.fpsField = numberField({
      label: 'FPS',
      value: 12,
      precision: 2,
      min: 1,
      max: 120,
      title: 'Frames per second stored in the reanim',
      onChange: (v, final) => {
        const doc = this.doc;
        if (doc && final) {
          doc.setFps(v);
          ws.emit('change');
        }
      },
    });
    this.countField = numberField({
      label: 'Frames',
      value: 1,
      precision: 0,
      min: 1,
      max: 5000,
      title: 'Total frame count of the file',
      onChange: (v, final) => {
        const doc = this.doc;
        if (doc && final) {
          doc.setFrameCount(Math.round(v));
          ws.emit('change');
        }
      },
    });
    this.onionBtn = btn('◐', 'Onion skin (O)', () => {
      ws.settings.onion = !ws.settings.onion;
      ws.saveSettings();
    });
    this.soundBtn = btn('🔊', 'Play sound cues', () => {
      ws.soundEnabled = !ws.soundEnabled;
      if (!ws.soundEnabled) ws.audio.stopAll();
      this.syncToolbar();
    });
    this.toolbar.append(
      h(
        'div',
        { class: 'tl-group' },
        btn('⏮', 'First frame of range (Home)', () => ws.setFrame(range().start)),
        btn('◀', 'Previous frame (←)', () => ws.stepFrame(-1)),
        this.playBtn,
        btn('▶|', 'Next frame (→)', () => ws.stepFrame(1)),
        btn('⏭', 'Last frame of range (End)', () => ws.setFrame(range().end)),
      ),
      h('div', { class: 'tl-group' }, this.frameField.el, this.frameTotal),
      h(
        'div',
        { class: 'tl-group' },
        h('span', { class: 'tl-label' }, 'Anim'),
        this.animSelect,
        btn('＋', 'New animation range…', () => this.doc && this.hooks.editRange(this.doc)),
        btn('✎', 'Edit selected animation range…', () => this.doc?.ui.anim && this.hooks.editRange(this.doc, this.doc.ui.anim)),
      ),
      h('div', { class: 'tl-group' }, this.loopSelect, speed),
      h('div', { class: 'tl-group' }, this.fpsField.el, this.countField.el),
      h(
        'div',
        { class: 'tl-group' },
        this.onionBtn,
        this.soundBtn,
        btn('－', 'Zoom timeline out', () => this.zoomCells(1 / 1.25)),
        btn('＋', 'Zoom timeline in', () => this.zoomCells(1.25)),
      ),
    );
  }

  private syncToolbar(light = false) {
    const doc = this.doc;
    const ws = this.ws;
    this.playBtn.textContent = ws.playing ? '❚❚' : '▶';
    this.playBtn.classList.toggle('active', ws.playing);
    if (!doc) return;
    this.frameField.set(ws.frameTime(doc).before);
    this.frameTotal.textContent = `/ ${doc.frameCount - 1}`;
    if (light) return;
    const ranges = doc.animRanges();
    const opts = [{ value: '', label: `All frames (0–${doc.frameCount - 1})` }, ...ranges.map((r) => ({ value: r.name, label: `${r.name} (${r.start}–${r.end})` }))];
    const sig = opts.map((o) => o.value + o.label).join('|');
    if (this.animSelect.dataset.sig !== sig) {
      this.animSelect.replaceChildren(...opts.map((o) => h('option', { value: o.value }, o.label)));
      this.animSelect.dataset.sig = sig;
    }
    this.animSelect.value = doc.ui.anim;
    this.loopSelect.value = doc.ui.loop;
    this.fpsField.set(doc.fps);
    this.countField.set(doc.frameCount);
    this.onionBtn.classList.toggle('active', ws.settings.onion);
    this.soundBtn.textContent = ws.soundEnabled ? '🔊' : '🔇';
  }

  // ------------------------------------------------------------ layout

  private resize() {
    const r = this.wrap.getBoundingClientRect();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.draw();
  }

  private buildRows(doc: ReanimDocument): Row[] {
    const rows: Row[] = [];
    const ranges = doc.animRanges();
    rows.push({ kind: 'header', label: 'ANIMATIONS', section: 'anims' });
    ranges.forEach((r, i) => rows.push({ kind: 'anim', trackIndex: r.trackIndex, name: r.name, start: r.start, end: r.end, color: ANIM_COLORS[i % ANIM_COLORS.length] }));
    // anim_ tracks with no visible frames still deserve a row
    doc.state.tracks.forEach((t, i) => {
      if (isAnimTrackName(t.name) && !ranges.some((r) => r.trackIndex === i)) rows.push({ kind: 'anim', trackIndex: i, name: t.name, start: -1, end: -1, color: '#666' });
    });
    rows.push({ kind: 'header', label: 'CUES', section: 'cues' });
    rows.push({ kind: 'sound' });
    rows.push({ kind: 'particle' });
    rows.push({ kind: 'header', label: 'PARTS  (top = front)', section: 'parts' });
    for (let i = doc.state.tracks.length - 1; i >= 0; i--) {
      if (!isAnimTrackName(doc.state.tracks[i].name)) rows.push({ kind: 'track', trackIndex: i });
    }
    return rows;
  }

  private get maxScrollY(): number {
    return Math.max(0, this.rows.length * ROW_H - (this.cssH - RULER_H) + 8);
  }

  private get maxScrollX(): number {
    const n = this.doc?.frameCount ?? 0;
    return Math.max(0, n * this.cellW - (this.cssW - NAME_W) + 40);
  }

  /** Remember zoom/scroll per document; size cells to fit short animations. */
  private switchView(doc: ReanimDocument) {
    if (this.viewDoc === doc.id) return;
    if (this.viewDoc >= 0) this.views.set(this.viewDoc, { cellW: this.cellW, scrollX: this.scrollX, scrollY: this.scrollY });
    this.viewDoc = doc.id;
    const v = this.views.get(doc.id);
    if (v) {
      ({ cellW: this.cellW, scrollX: this.scrollX, scrollY: this.scrollY } = v);
    } else {
      this.cellW = clamp(Math.floor((this.cssW - NAME_W - 40) / Math.max(1, doc.frameCount)), 10, 28);
      this.scrollX = 0;
      this.scrollY = 0;
    }
  }

  private frameX(f: number): number {
    return NAME_W + f * this.cellW - this.scrollX;
  }

  private xToFrame(x: number): number {
    return Math.floor((x - NAME_W + this.scrollX) / this.cellW);
  }

  private yToRow(y: number): number {
    return Math.floor((y - RULER_H + this.scrollY) / ROW_H);
  }

  private zoomCells(factor: number, anchorX = NAME_W + (this.cssW - NAME_W) / 2) {
    const f = (anchorX - NAME_W + this.scrollX) / this.cellW;
    this.cellW = clamp(this.cellW * factor, 4, 48);
    this.scrollX = clamp(f * this.cellW - (anchorX - NAME_W), 0, this.maxScrollX);
    this.draw();
  }

  /** Frame under a client-space point, or null if it is not over the frame grid. */
  frameAtClient(clientX: number, clientY: number): number | null {
    const doc = this.doc;
    const r = this.canvas.getBoundingClientRect();
    if (!doc || clientX < r.left + NAME_W || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    return clamp(this.xToFrame(clientX - r.left), 0, doc.frameCount - 1);
  }

  scrollToFrame(f: number) {
    const x = f * this.cellW;
    const visW = this.cssW - NAME_W;
    if (x < this.scrollX + this.cellW || x > this.scrollX + visW - this.cellW * 2) {
      this.scrollX = clamp(x - visW / 3, 0, this.maxScrollX);
    }
  }

  private followPlayhead() {
    const doc = this.doc;
    if (!doc) return;
    const f = this.ws.frameTime(doc).before;
    if (f !== this.lastFollowFrame) {
      this.lastFollowFrame = f;
      this.scrollToFrame(f);
    }
  }

  // ------------------------------------------------------------ drawing

  draw(): void {
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const doc = this.doc;
    if (!doc) {
      ctx.fillStyle = C.dim;
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(this.ws.active ? '' : 'Open a reanim to see its timeline.', 16, 30);
      return;
    }
    this.switchView(doc);
    this.rows = this.buildRows(doc);
    this.scrollY = clamp(this.scrollY, 0, this.maxScrollY);
    this.scrollX = clamp(this.scrollX, 0, this.maxScrollX);
    const n = doc.frameCount;
    const first = Math.max(0, this.xToFrame(NAME_W));
    const last = Math.min(n - 1, this.xToFrame(this.cssW) + 1);
    const { start: rs, end: re } = doc.activeRange();
    const ft = this.ws.frameTime(doc);
    const selLo = Math.min(doc.ui.frame, doc.ui.frameEnd);
    const selHi = Math.max(doc.ui.frame, doc.ui.frameEnd);

    // Rows
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, this.cssW, this.cssH - RULER_H);
    ctx.clip();
    const firstRow = Math.max(0, Math.floor(this.scrollY / ROW_H));
    const lastRow = Math.min(this.rows.length - 1, Math.ceil((this.scrollY + this.cssH) / ROW_H));
    for (let ri = firstRow; ri <= lastRow; ri++) {
      const row = this.rows[ri];
      const y = RULER_H + ri * ROW_H - this.scrollY;
      this.drawRowCells(ctx, doc, row, ri, y, first, last, selLo, selHi);
    }
    // dim frames outside the active range
    ctx.fillStyle = C.outside;
    if (rs > 0) ctx.fillRect(NAME_W, RULER_H, Math.max(0, this.frameX(rs) - NAME_W), this.cssH);
    if (re < n - 1) ctx.fillRect(this.frameX(re + 1), RULER_H, this.cssW, this.cssH);
    // name column
    ctx.fillStyle = C.names;
    ctx.fillRect(0, RULER_H, NAME_W, this.cssH);
    for (let ri = firstRow; ri <= lastRow; ri++) {
      const y = RULER_H + ri * ROW_H - this.scrollY;
      this.drawRowName(ctx, doc, this.rows[ri], y);
    }
    const drag = this.drag;
    if (drag?.kind === 'reorder' && drag.moved) {
      const ri = this.rows.findIndex((r) => r.kind === 'track' && r.trackIndex === drag.target);
      if (ri >= 0) {
        ctx.fillStyle = C.sel;
        ctx.fillRect(0, RULER_H + ri * ROW_H - this.scrollY - 1, this.cssW, 2);
      }
    }
    ctx.restore();

    // Ruler
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, this.cssW, RULER_H);
    ctx.fillStyle = 'rgba(79,157,222,0.25)';
    ctx.fillRect(Math.max(NAME_W, this.frameX(rs)), 0, Math.max(0, this.frameX(re + 1) - Math.max(NAME_W, this.frameX(rs))), RULER_H);
    ctx.font = '10px ui-monospace, monospace';
    const labelEvery = this.cellW >= 20 ? 1 : this.cellW >= 10 ? 5 : 10;
    for (let f = first; f <= last; f++) {
      const x = this.frameX(f);
      if (x < NAME_W) continue;
      ctx.fillStyle = f % 5 === 0 ? C.dim : 'rgba(255,255,255,0.15)';
      ctx.fillRect(x, RULER_H - (f % 5 === 0 ? 8 : 4), 1, f % 5 === 0 ? 8 : 4);
      if (f % labelEvery === 0) {
        ctx.fillStyle = C.text;
        ctx.fillText(String(f), x + 2, 11);
      }
    }
    ctx.fillStyle = C.names;
    ctx.fillRect(0, 0, NAME_W, RULER_H);
    ctx.fillStyle = C.dim;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`${doc.name}  ·  ${doc.fps} fps`, 8, 15);

    // Playhead
    const pos = this.ws.playing ? this.ws.playhead : ft.before;
    const px = NAME_W + (pos + 0.5) * this.cellW - this.scrollX;
    if (px >= NAME_W) {
      ctx.fillStyle = C.playhead;
      ctx.fillRect(Math.round(px), 0, 1.5, this.cssH);
      ctx.beginPath();
      ctx.moveTo(px - 6, 0);
      ctx.lineTo(px + 6, 0);
      ctx.lineTo(px, 8);
      ctx.closePath();
      ctx.fill();
    }
    // separators
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(NAME_W - 1, 0, 1, this.cssH);
    ctx.fillRect(0, RULER_H - 1, this.cssW, 1);
  }

  private drawRowCells(ctx: CanvasRenderingContext2D, doc: ReanimDocument, row: Row, ri: number, y: number, first: number, last: number, selLo: number, selHi: number) {
    const cw = this.cellW;
    if (row.kind === 'header') {
      ctx.fillStyle = C.header;
      ctx.fillRect(NAME_W, y, this.cssW, ROW_H);
      return;
    }
    ctx.fillStyle = ri % 2 ? C.rowAlt : C.bg;
    ctx.fillRect(NAME_W, y, this.cssW, ROW_H);
    // grid lines
    for (let f = first; f <= last; f++) {
      ctx.fillStyle = f % 5 === 0 ? C.grid5 : C.grid;
      ctx.fillRect(this.frameX(f), y, 1, ROW_H);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(NAME_W, y + ROW_H - 1, this.cssW, 1);

    if (row.kind === 'anim') {
      if (row.start < 0) return;
      const x0 = this.frameX(row.start);
      const x1 = this.frameX(row.end + 1);
      const active = doc.ui.anim === row.name;
      ctx.fillStyle = row.color + (active ? 'ee' : '88');
      roundRect(ctx, x0 + 1, y + 3, x1 - x0 - 2, ROW_H - 6, 4);
      ctx.fill();
      if (active) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        roundRect(ctx, x0 + 1.5, y + 3.5, x1 - x0 - 3, ROW_H - 7, 4);
        ctx.stroke();
      }
      ctx.fillStyle = '#0d0f12';
      ctx.font = '11px system-ui, sans-serif';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y, x1 - x0, ROW_H);
      ctx.clip();
      ctx.fillText(`${row.name.replace(/^anim_/i, '')}  ${row.start}–${row.end}`, Math.max(x0, NAME_W) + 5, y + 14);
      ctx.restore();
      return;
    }
    if (row.kind === 'sound' || row.kind === 'particle') {
      const cues = row.kind === 'sound' ? doc.state.soundCues : doc.state.particleCues;
      const frameOf = (c: { uid: number; frame: number }) => (this.drag?.kind === 'cue' && this.drag.uid === c.uid ? this.drag.to : c.frame);
      const sorted = [...cues].sort((a, b) => frameOf(a) - frameOf(b));
      ctx.font = '11px system-ui, sans-serif';
      sorted.forEach((cue, idx) => {
        const f = frameOf(cue);
        const x = this.frameX(f);
        const nextX = idx + 1 < sorted.length ? this.frameX(frameOf(sorted[idx + 1])) : this.cssW;
        if (nextX < NAME_W || x > this.cssW) return;
        const selected = doc.ui.cue?.uid === cue.uid;
        const color = row.kind === 'sound' ? '#7fd1a0' : '#f08ad8';
        if (row.kind === 'sound') this.drawWaveform(ctx, (cue as { sound: string }).sound, (cue as { volume: number }).volume, doc.fps, x, y, selected);
        ctx.fillStyle = selected ? C.sel : color;
        roundRect(ctx, x + 1, y + 3, Math.max(cw - 2, 6), ROW_H - 6, 3);
        ctx.fill();
        const label = row.kind === 'sound' ? basename((cue as { sound: string }).sound) : basename((cue as { particle: string }).particle);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, Math.max(0, nextX - x - 2), ROW_H);
        ctx.clip();
        ctx.fillStyle = selected ? C.sel : '#c9ceda';
        ctx.fillText((row.kind === 'sound' ? '♪ ' : '✦ ') + label, x + Math.max(cw, 8) + 2, y + 14);
        ctx.restore();
      });
      return;
    }
    // track row
    const track = doc.state.tracks[row.trackIndex];
    if (!track) return;
    const selected = row.trackIndex === doc.ui.track;
    const tr = track.transforms;
    for (let f = first; f <= last && f < tr.length; f++) {
      if (tr[f].f < 0) continue;
      ctx.fillStyle = selected && f >= selLo && f <= selHi ? C.visibleSel : C.visible;
      ctx.fillRect(this.frameX(f) + 1, y + 3, cw - 1, ROW_H - 6);
    }
    // tween lines and keys
    const mid = y + ROW_H / 2;
    let prevKey = -1;
    for (let f = 0; f < tr.length; f++) {
      if (!track.keys[f]) continue;
      if (prevKey >= 0 && f - prevKey > 1 && tr[prevKey].f >= 0 && f >= first && prevKey <= last) {
        ctx.fillStyle = track.ease[prevKey] === 'hold' ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.4)';
        ctx.fillRect(this.frameX(prevKey) + cw / 2, mid, (f - prevKey) * cw, 1);
      }
      prevKey = f;
    }
    if (prevKey >= 0 && prevKey < tr.length - 1 && tr[prevKey].f >= 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(this.frameX(prevKey) + cw / 2, mid, (tr.length - 1 - prevKey) * cw, 1);
    }
    const r = Math.max(2, Math.min(4, cw / 3.5));
    for (let f = first; f <= last && f < tr.length; f++) {
      if (!track.keys[f]) continue;
      const cx = this.frameX(f) + cw / 2;
      const ease = track.ease[f];
      ctx.fillStyle = ease === 'linear' ? C.key : ease === 'hold' ? C.keyHold : C.keyEase;
      if (tr[f].f < 0) {
        ctx.strokeStyle = ctx.fillStyle as string;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, mid, r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(cx, mid - r - 1);
        ctx.lineTo(cx + r + 1, mid);
        ctx.lineTo(cx, mid + r + 1);
        ctx.lineTo(cx - r - 1, mid);
        ctx.closePath();
        ctx.fill();
      }
    }
    if (this.drag?.kind === 'moveKey' && this.drag.track === row.trackIndex) {
      ctx.strokeStyle = C.sel;
      ctx.strokeRect(this.frameX(this.drag.to) + 0.5, y + 1.5, cw - 1, ROW_H - 3);
    }
    if (selected) {
      ctx.strokeStyle = C.sel;
      ctx.lineWidth = 1;
      ctx.strokeRect(this.frameX(selLo) + 0.5, y + 1.5, (selHi - selLo + 1) * cw - 1, ROW_H - 3);
    }
  }

  /** Draw a sound's amplitude envelope from its cue position, so cues can be synced by eye. */
  private drawWaveform(ctx: CanvasRenderingContext2D, ref: string, volume: number, fps: number, x: number, y: number, selected: boolean) {
    const file = this.ws.assets.resolveSound(ref);
    if (!file) return;
    const buf = this.ws.audio.peek(file);
    if (buf === undefined) {
      void this.ws.audio.load(file).then(() => this.draw());
      return;
    }
    if (!buf) return;
    const env = envelopeOf(buf);
    const width = buf.duration * fps * this.cellW;
    const mid = y + ROW_H / 2;
    const half = ROW_H / 2 - 2;
    ctx.fillStyle = selected ? 'rgba(255, 211, 77, 0.6)' : 'rgba(127, 209, 160, 0.6)';
    const x0 = Math.max(NAME_W, Math.floor(x));
    const x1 = Math.min(this.cssW, Math.ceil(x + width));
    for (let px = x0; px < x1; px++) {
      const a = Math.floor(((px - x) / width) * env.length);
      const b = Math.max(a + 1, Math.floor(((px + 1 - x) / width) * env.length));
      let peak = 0;
      for (let i = a; i < b && i < env.length; i++) peak = Math.max(peak, env[i]);
      const hgt = Math.min(1, peak * Math.max(0.2, volume)) * half;
      ctx.fillRect(px, mid - hgt, 1, Math.max(1, hgt * 2));
    }
  }

  private drawRowName(ctx: CanvasRenderingContext2D, doc: ReanimDocument, row: Row, y: number) {
    ctx.font = '12px system-ui, sans-serif';
    if (row.kind === 'header') {
      ctx.fillStyle = C.header;
      ctx.fillRect(0, y, NAME_W, ROW_H);
      ctx.fillStyle = C.dim;
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillText(row.label, 8, y + 13);
      if (row.section === 'anims' || row.section === 'cues') {
        ctx.fillStyle = C.text;
        ctx.font = '14px system-ui, sans-serif';
        ctx.fillText('+', NAME_W - 18, y + 15);
      }
      return;
    }
    const selected =
      (row.kind === 'track' && row.trackIndex === doc.ui.track) ||
      (row.kind === 'anim' && row.name === doc.ui.anim) ||
      (row.kind === 'sound' && doc.ui.cue?.kind === 'sound') ||
      (row.kind === 'particle' && doc.ui.cue?.kind === 'particle');
    if (selected) {
      ctx.fillStyle = 'rgba(255, 211, 77, 0.14)';
      ctx.fillRect(0, y, NAME_W, ROW_H);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, y + ROW_H - 1, NAME_W, 1);
    if (row.kind === 'anim') {
      ctx.fillStyle = row.color;
      ctx.fillRect(8, y + 6, 8, 8);
      ctx.fillStyle = C.text;
      ctx.fillText(row.name, 22, y + 14);
      return;
    }
    if (row.kind === 'sound' || row.kind === 'particle') {
      ctx.fillStyle = C.text;
      ctx.fillText(row.kind === 'sound' ? '♪  Sound cues' : '✦  Particle cues', 8, y + 14);
      const count = row.kind === 'sound' ? doc.state.soundCues.length : doc.state.particleCues.length;
      ctx.fillStyle = C.dim;
      ctx.fillText(String(count), NAME_W - 24, y + 14);
      return;
    }
    const track = doc.state.tracks[row.trackIndex];
    if (!track) return;
    const hidden = doc.ui.hidden.has(track.uid);
    const locked = doc.ui.locked.has(track.uid);
    ctx.fillStyle = hidden ? '#5a606c' : C.text;
    ctx.fillText(hidden ? '◌' : '●', 8, y + 14);
    ctx.fillStyle = locked ? C.sel : '#5a606c';
    ctx.fillText(locked ? '🔒' : '·', 26, y + 14);
    const marker = isMarkerTrack(track);
    ctx.fillStyle = marker ? C.dim : hidden ? '#7d8494' : C.text;
    ctx.font = marker ? 'italic 12px system-ui, sans-serif' : '12px system-ui, sans-serif';
    let name = track.name;
    const maxW = NAME_W - 50;
    if (ctx.measureText(name).width > maxW) {
      while (name.length > 3 && ctx.measureText(name + '…').width > maxW) name = name.slice(0, -1);
      name += '…';
    }
    ctx.fillText(name, 44, y + 14);
  }

  // ------------------------------------------------------------ input

  private pos(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private bindInput() {
    const cv = this.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x] = this.pos(e);
      if (e.ctrlKey || e.metaKey) {
        this.zoomCells(Math.exp(-e.deltaY * 0.002), Math.max(NAME_W, x));
        return;
      }
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        this.scrollX = clamp(this.scrollX + (e.shiftKey ? e.deltaY : e.deltaX), 0, this.maxScrollX);
      } else {
        this.scrollY = clamp(this.scrollY + e.deltaY, 0, this.maxScrollY);
      }
      this.draw();
    }, { passive: false });
    cv.addEventListener('pointerdown', (e) => this.onDown(e));
    cv.addEventListener('pointermove', (e) => this.onMove(e));
    cv.addEventListener('pointerup', (e) => this.onUp(e));
    cv.addEventListener('dblclick', (e) => this.onDouble(e));
    this.wrap.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes(ASSET_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    this.wrap.addEventListener('drop', (e) => {
      const raw = e.dataTransfer?.getData(ASSET_MIME);
      const doc = this.doc;
      if (!raw || !doc) return;
      e.preventDefault();
      const asset = JSON.parse(raw) as { kind: string; path: string };
      const [x, y] = this.pos(e);
      const frame = clamp(this.xToFrame(x), 0, doc.frameCount - 1);
      const row = this.rows[this.yToRow(y)];
      if (asset.kind === 'sound') {
        const cue = doc.addSoundCue(frame, asset.path);
        doc.ui.cue = { kind: 'sound', uid: cue.uid };
      } else if (asset.kind === 'particle') {
        const track = row?.kind === 'track' ? doc.state.tracks[row.trackIndex].name : '';
        const cue = doc.addParticleCue(frame, asset.path, track);
        doc.ui.cue = { kind: 'particle', uid: cue.uid };
      } else if (asset.kind === 'image' && row?.kind === 'track') {
        doc.setFields(row.trackIndex, frame, { i: this.ws.assets.imageIdForPath(asset.path) }, 'Change image');
        doc.ui.track = row.trackIndex;
      } else return;
      this.ws.emit('change');
    });
  }

  private hitCue(doc: ReanimDocument, kind: 'sound' | 'particle', x: number): number | null {
    const cues = kind === 'sound' ? doc.state.soundCues : doc.state.particleCues;
    for (let i = cues.length - 1; i >= 0; i--) {
      const cx = this.frameX(cues[i].frame);
      if (x >= cx && x <= cx + Math.max(this.cellW, 8)) return cues[i].uid;
    }
    return null;
  }

  private onDown(e: PointerEvent) {
    const doc = this.doc;
    if (!doc) return;
    this.canvas.focus();
    const [x, y] = this.pos(e);
    const frame = clamp(this.xToFrame(x), 0, doc.frameCount - 1);
    if (y < RULER_H) {
      if (x >= NAME_W && e.button === 0) {
        this.canvas.setPointerCapture(e.pointerId);
        this.drag = { kind: 'scrub' };
        this.ws.setFrame(frame);
      }
      return;
    }
    const ri = this.yToRow(y);
    const row = this.rows[ri];
    if (!row) return;
    if (e.button === 2) {
      this.contextMenu(e, doc, row, x, frame);
      return;
    }
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);

    if (row.kind === 'header') {
      if (x > NAME_W - 26 && x < NAME_W) {
        if (row.section === 'anims') this.hooks.editRange(doc);
        else if (row.section === 'cues') this.hooks.addSoundCue(doc, doc.ui.frame);
      }
      return;
    }
    if (row.kind === 'anim') {
      if (x < NAME_W) {
        this.selectAnim(doc, row.name);
        return;
      }
      if (row.start >= 0) {
        const x0 = this.frameX(row.start);
        const x1 = this.frameX(row.end + 1);
        if (Math.abs(x - x0) <= 4) {
          this.drag = { kind: 'range', trackIndex: row.trackIndex, name: row.name, edge: 'start', start: row.start, end: row.end };
          return;
        }
        if (Math.abs(x - x1) <= 4) {
          this.drag = { kind: 'range', trackIndex: row.trackIndex, name: row.name, edge: 'end', start: row.start, end: row.end };
          return;
        }
        if (x > x0 && x < x1) {
          if (doc.ui.anim !== row.name) doc.ui.anim = row.name;
          this.ws.setFrame(frame);
          return;
        }
      }
      this.ws.setFrame(frame);
      return;
    }
    if (row.kind === 'sound' || row.kind === 'particle') {
      if (x < NAME_W) return;
      const uid = this.hitCue(doc, row.kind, x);
      if (uid !== null) {
        doc.ui.cue = { kind: row.kind, uid };
        doc.ui.track = -1;
        const cue = (row.kind === 'sound' ? doc.state.soundCues : doc.state.particleCues).find((c) => c.uid === uid)!;
        this.drag = { kind: 'cue', cueKind: row.kind, uid, from: cue.frame, to: cue.frame, moved: false };
        if (row.kind === 'sound') this.hooks.previewSound(cue && 'sound' in cue ? cue.sound : '');
        this.ws.emit('change');
      } else {
        doc.ui.cue = null;
        this.ws.setFrame(frame);
      }
      return;
    }
    // track row
    const ti = row.trackIndex;
    if (x < NAME_W) {
      const track = doc.state.tracks[ti];
      if (x < 22) {
        toggle(doc.ui.hidden, track.uid);
        this.ws.emit('change');
        return;
      }
      if (x < 40) {
        toggle(doc.ui.locked, track.uid);
        this.ws.emit('change');
        return;
      }
      doc.ui.track = ti;
      doc.ui.cue = null;
      this.drag = { kind: 'reorder', track: ti, target: ti, startY: y, moved: false };
      this.ws.emit('change');
      return;
    }
    const track = doc.state.tracks[ti];
    doc.ui.cue = null;
    if (e.shiftKey && doc.ui.track === ti) {
      this.ws.setFrame(frame, true);
      return;
    }
    const wasSelected = doc.ui.track === ti;
    doc.ui.track = ti;
    if (wasSelected && track.keys[frame] && frame > 0) {
      this.drag = { kind: 'moveKey', track: ti, from: frame, to: frame };
    } else {
      this.drag = { kind: 'select', track: ti, from: frame };
    }
    this.ws.setFrame(frame);
  }

  private onMove(e: PointerEvent) {
    const doc = this.doc;
    const drag = this.drag;
    if (!doc) return;
    const [x, y] = this.pos(e);
    const frame = clamp(this.xToFrame(x), 0, doc.frameCount - 1);
    if (!drag) {
      const row = this.rows[this.yToRow(y)];
      let cursor = 'default';
      if (row?.kind === 'anim' && row.start >= 0 && x > NAME_W) {
        if (Math.abs(x - this.frameX(row.start)) <= 4 || Math.abs(x - this.frameX(row.end + 1)) <= 4) cursor = 'ew-resize';
      }
      this.canvas.style.cursor = cursor;
      return;
    }
    switch (drag.kind) {
      case 'scrub':
        this.ws.setFrame(frame);
        break;
      case 'select':
        doc.ui.frameEnd = drag.from;
        doc.ui.frame = frame;
        this.ws.emit('change');
        break;
      case 'moveKey':
        drag.to = frame;
        this.draw();
        break;
      case 'reorder': {
        if (Math.abs(y - drag.startY) > 4) drag.moved = true;
        const row = this.rows[this.yToRow(y)];
        if (row?.kind === 'track') drag.target = row.trackIndex;
        this.draw();
        break;
      }
      case 'range': {
        // Preview only; the range is committed (one undo step) on release.
        if (drag.edge === 'start') drag.start = Math.min(frame, drag.end);
        else drag.end = Math.max(frame, drag.start);
        this.drawRangePreview(drag.trackIndex, drag.start, drag.end);
        break;
      }
      case 'cue':
        if (frame !== drag.to) drag.moved = true;
        drag.to = frame;
        this.draw();
        break;
    }
  }

  private drawRangePreview(trackIndex: number, start: number, end: number) {
    this.draw();
    const ri = this.rows.findIndex((r) => r.kind === 'anim' && r.trackIndex === trackIndex);
    if (ri < 0) return;
    const ctx = this.canvas.getContext('2d')!;
    const y = RULER_H + ri * ROW_H - this.scrollY;
    ctx.strokeStyle = C.sel;
    ctx.lineWidth = 2;
    ctx.strokeRect(this.frameX(start) + 1, y + 2, this.frameX(end + 1) - this.frameX(start) - 2, ROW_H - 4);
  }

  private onUp(e: PointerEvent) {
    const doc = this.doc;
    const drag = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!doc || !drag) return;
    switch (drag.kind) {
      case 'moveKey':
        if (drag.to !== drag.from && doc.moveKey(drag.track, drag.from, drag.to)) {
          doc.ui.frame = doc.ui.frameEnd = drag.to;
        }
        this.ws.emit('change');
        break;
      case 'reorder':
        if (drag.moved && drag.target !== drag.track) {
          doc.moveTrack(drag.track, drag.target);
          doc.ui.track = drag.target;
        }
        this.ws.emit('change');
        break;
      case 'range':
        doc.setAnimRange(drag.name, drag.start, drag.end, drag.name);
        this.ws.emit('change');
        break;
      case 'cue':
        if (drag.moved && drag.to !== drag.from) {
          if (drag.cueKind === 'sound') doc.updateSoundCue(drag.uid, { frame: drag.to }, 'Move sound cue');
          else doc.updateParticleCue(drag.uid, { frame: drag.to }, 'Move particle cue');
          this.ws.invalidatePreviews();
        }
        this.ws.emit('change');
        break;
    }
  }

  private onDouble(e: MouseEvent) {
    const doc = this.doc;
    if (!doc) return;
    const [x, y] = this.pos(e);
    if (y < RULER_H) return;
    const row = this.rows[this.yToRow(y)];
    const frame = clamp(this.xToFrame(x), 0, doc.frameCount - 1);
    if (!row) return;
    if (row.kind === 'anim') {
      this.hooks.editRange(doc, row.name);
    } else if (row.kind === 'track') {
      if (x < NAME_W) {
        if (x >= 40) this.hooks.renameTrack(doc, row.trackIndex);
      } else if (frame > 0) {
        doc.toggleKey(row.trackIndex, frame);
        this.ws.emit('change');
      }
    } else if ((row.kind === 'sound' || row.kind === 'particle') && x >= NAME_W && this.hitCue(doc, row.kind, x) === null) {
      if (row.kind === 'sound') this.hooks.addSoundCue(doc, frame);
      else this.hooks.addParticleCue(doc, frame);
    }
  }

  private selectAnim(doc: ReanimDocument, name: string) {
    doc.ui.anim = doc.ui.anim === name ? '' : name;
    const r = doc.activeRange();
    this.ws.setFrame(r.start);
    this.scrollToFrame(r.start);
  }

  private contextMenu(e: MouseEvent, doc: ReanimDocument, row: Row, x: number, frame: number) {
    const items: MenuItem[] = [];
    const ws = this.ws;
    if (row.kind === 'track') {
      doc.ui.track = row.trackIndex;
      if (x >= NAME_W && (frame < Math.min(doc.ui.frame, doc.ui.frameEnd) || frame > Math.max(doc.ui.frame, doc.ui.frameEnd))) {
        doc.ui.frame = doc.ui.frameEnd = frame;
      }
      ws.emit('change');
      const track = doc.state.tracks[row.trackIndex];
      const lo = Math.min(doc.ui.frame, doc.ui.frameEnd);
      const hi = Math.max(doc.ui.frame, doc.ui.frameEnd);
      const isKey = track.keys[doc.ui.frame];
      if (x >= NAME_W) {
        items.push(
          { label: isKey ? 'Remove key' : 'Make key', shortcut: 'K', disabled: doc.ui.frame === 0, action: () => (doc.toggleKey(row.trackIndex, doc.ui.frame), ws.emit('change')) },
          { label: `Make keys on frames ${lo}–${hi}`, disabled: lo === hi, action: () => (doc.setKeys(row.trackIndex, lo, hi, true), ws.emit('change')) },
          { label: `Clear keys on frames ${lo}–${hi}`, action: () => (doc.setKeys(row.trackIndex, lo, hi, false), ws.emit('change')) },
          {
            label: 'Easing',
            submenu: EASES.map((ea) => ({
              label: ea.label,
              checked: track.ease[doc.keyAtOrBefore(track, doc.ui.frame)] === ea.id,
              action: () => (doc.setEase(row.trackIndex, doc.ui.frame, ea.id), ws.emit('change')),
            })),
          },
          { label: 'Show part from here', action: () => (doc.setFields(row.trackIndex, doc.ui.frame, { f: 0 }, 'Show part'), ws.emit('change')) },
          { label: 'Hide part from here', action: () => (doc.setFields(row.trackIndex, doc.ui.frame, { f: -1 }, 'Hide part'), ws.emit('change')) },
          { separator: true },
          { label: lo === hi ? 'Insert frame' : `Insert ${hi - lo + 1} frames`, action: () => (doc.insertFrames(lo, hi - lo + 1), ws.emit('change')) },
          { label: lo === hi ? 'Delete frame' : `Delete frames ${lo}–${hi}`, action: () => (doc.deleteFrames(lo, hi - lo + 1), ws.emit('change')) },
          { separator: true },
        );
      }
      items.push(...this.hooks.trackMenu(doc, row.trackIndex));
    } else if (row.kind === 'anim') {
      items.push(
        { label: `Preview ${row.name}`, action: () => this.selectAnim(doc, row.name) },
        { label: 'Edit range…', action: () => this.hooks.editRange(doc, row.name) },
        { label: 'Delete animation range', action: () => (doc.removeAnimRange(row.name), ws.emit('change')) },
        { separator: true },
        { label: 'New animation range…', action: () => this.hooks.editRange(doc) },
      );
    } else if (row.kind === 'sound' || row.kind === 'particle') {
      const uid = x >= NAME_W ? this.hitCue(doc, row.kind, x) : null;
      if (uid !== null) {
        doc.ui.cue = { kind: row.kind, uid };
        ws.emit('change');
        items.push({ label: 'Delete cue', shortcut: 'Del', action: () => (doc.removeCue(row.kind as 'sound' | 'particle', uid), ws.emit('change')) });
      } else {
        const at = x >= NAME_W ? frame : doc.ui.frame;
        items.push(
          row.kind === 'sound'
            ? { label: `Add sound cue at frame ${at}…`, action: () => this.hooks.addSoundCue(doc, at) }
            : { label: `Add particle cue at frame ${at}…`, action: () => this.hooks.addParticleCue(doc, at) },
        );
      }
    } else if (row.kind === 'header') {
      items.push({ label: 'New animation range…', action: () => this.hooks.editRange(doc) }, { label: 'Add sound cue…', action: () => this.hooks.addSoundCue(doc, doc.ui.frame) }, { label: 'Add particle cue…', action: () => this.hooks.addParticleCue(doc, doc.ui.frame) });
    }
    if (items.length) showMenu(items, e.clientX, e.clientY);
  }
}

const envelopes = new WeakMap<AudioBuffer, Float32Array>();

/** Peak amplitude at 200 points per second (cached per buffer). */
function envelopeOf(buf: AudioBuffer): Float32Array {
  let env = envelopes.get(buf);
  if (env) return env;
  const step = Math.max(1, Math.floor(buf.sampleRate / 200));
  env = new Float32Array(Math.ceil(buf.length / step));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      const k = (i / step) | 0;
      if (v > env[k]) env[k] = v;
    }
  }
  envelopes.set(buf, env);
  return env;
}

function toggle(set: Set<number>, v: number) {
  if (set.has(v)) set.delete(v);
  else set.add(v);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
