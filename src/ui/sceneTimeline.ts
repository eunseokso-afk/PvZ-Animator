/**
 * Scene timeline (Adobe Animate style): one row per layer with keyframes
 * (dots), tweens (shaded spans with an arrow) and blank keyframes, plus a
 * sound lane. Drawn on a canvas.
 */

import { clamp } from '../engine/math';
import { basename } from '../engine/vfs';
import { EASES } from '../editor/reanimDoc';
import { keyIndexAt, type SceneDocument, type SceneLayer } from '../editor/sceneDoc';
import type { Workspace } from '../editor/workspace';
import { h, rafThrottle } from './dom';
import { C, envelopeOf, roundRect } from './timeline';
import { ASSET_MIME } from './viewport';
import { numberField, showMenu, type MenuItem, type NumberField } from './widgets';

const RULER_H = 22;
const ROW_H = 22;
const NAME_W = 210;

const KIND_ICON: Record<string, string> = { reanim: '▶', particle: '✦', image: '▣' };
const TWEEN_FILL = 'rgba(122, 104, 214, 0.32)';
const SPAN_FILL = 'rgba(92, 118, 140, 0.28)';

type Row = { kind: 'header'; label: string } | { kind: 'sound' } | { kind: 'layer'; index: number };

type Drag =
  | { kind: 'scrub' }
  | { kind: 'select'; from: number }
  | { kind: 'moveKey'; layer: number; from: number; to: number }
  | { kind: 'reorder'; layer: number; target: number; startY: number; moved: boolean }
  | { kind: 'cue'; uid: number; from: number; to: number; moved: boolean };

export interface SceneTimelineHooks {
  layerMenu(doc: SceneDocument, layer: number): MenuItem[];
  addMenu(doc: SceneDocument): MenuItem[];
  addSoundCue(doc: SceneDocument, frame: number): void;
  renameLayer(doc: SceneDocument, layer: number): void;
  previewSound(path: string): void;
  bake(doc: SceneDocument): void;
}

export class SceneTimeline {
  readonly el: HTMLElement;
  private toolbar: HTMLElement;
  private canvas: HTMLCanvasElement;
  private wrap: HTMLElement;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private scrollX = 0;
  private scrollY = 0;
  private cellW = 10;
  private rows: Row[] = [];
  private drag: Drag | null = null;
  private views = new Map<number, { cellW: number; scrollX: number; scrollY: number }>();
  private viewDoc = -1;
  private playBtn!: HTMLButtonElement;
  private loopBtn!: HTMLButtonElement;
  private soundBtn!: HTMLButtonElement;
  private frameField!: NumberField;
  private frameTotal!: HTMLElement;
  private fpsField!: NumberField;
  private lengthField!: NumberField;
  private lastFollow = -1;

  constructor(
    private ws: Workspace,
    private hooks: SceneTimelineHooks,
  ) {
    this.toolbar = h('div', { class: 'tl-toolbar' });
    this.canvas = h('canvas', { class: 'tl-canvas', tabIndex: 0 });
    this.wrap = h('div', { class: 'tl-wrap' }, this.canvas);
    this.el = h('div', { class: 'timeline' }, this.toolbar, this.wrap);
    this.buildToolbar();
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.bindInput();
    const redraw = rafThrottle(() => {
      this.syncToolbar();
      this.draw();
    });
    ws.on('change', redraw);
    ws.on('docs', redraw);
    ws.on('settings', redraw);
    ws.on(
      'frame',
      rafThrottle(() => {
        this.follow();
        this.syncToolbar(true);
        this.draw();
      }),
    );
  }

  private get doc(): SceneDocument | null {
    return this.ws.scene;
  }

  // ------------------------------------------------------------ toolbar

  private buildToolbar() {
    const ws = this.ws;
    const btn = (label: string, title: string, fn: (e: MouseEvent) => void) => h('button', { class: 'tool-btn', title, onclick: fn }, label);
    this.playBtn = btn('▶', 'Play / pause (Space)', () => ws.togglePlay());
    this.frameField = numberField({ label: 'Frame', value: 0, precision: 0, onChange: (v, final) => final && ws.setFrame(v) });
    this.frameTotal = h('span', { class: 'tl-total' }, '/ 0');
    this.fpsField = numberField({
      label: 'FPS',
      value: 30,
      precision: 2,
      min: 1,
      max: 120,
      title: 'Scene frame rate (prefabs keep playing at their own fps)',
      onChange: (v, final) => {
        const doc = this.doc;
        if (doc && final && v !== doc.state.fps) {
          doc.edit('Change FPS', (s) => (s.fps = v));
          ws.emit('change');
        }
      },
    });
    this.lengthField = numberField({
      label: 'Frames',
      value: 90,
      precision: 0,
      min: 1,
      max: 100000,
      title: 'Scene length in frames',
      onChange: (v, final) => {
        const doc = this.doc;
        if (doc && final) {
          doc.setLength(v);
          ws.emit('change');
        }
      },
    });
    this.loopBtn = btn('⟲', 'Loop playback', () => {
      const doc = this.doc;
      if (doc) doc.ui.loopPlayback = !doc.ui.loopPlayback;
      this.syncToolbar();
    });
    this.soundBtn = btn('🔊', 'Play sound cues', () => {
      ws.soundEnabled = !ws.soundEnabled;
      if (!ws.soundEnabled) ws.audio.stopAll();
      this.syncToolbar();
    });
    const addBtn = btn('＋ Layer ▾', 'Add a prefab instance, particle effect, image or sound', (e) => {
      const doc = this.doc;
      if (!doc) return;
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      showMenu(this.hooks.addMenu(doc), r.left, r.bottom + 2);
    });
    this.toolbar.append(
      h(
        'div',
        { class: 'tl-group' },
        btn('⏮', 'First frame (Home)', () => ws.setFrame(0)),
        btn('◀', 'Previous frame (←)', () => ws.stepFrame(-1)),
        this.playBtn,
        btn('▶|', 'Next frame (→)', () => ws.stepFrame(1)),
        btn('⏭', 'Last frame (End)', () => this.doc && ws.setFrame(this.doc.state.length - 1)),
      ),
      h('div', { class: 'tl-group' }, this.frameField.el, this.frameTotal),
      h('div', { class: 'tl-group' }, this.fpsField.el, this.lengthField.el),
      h('div', { class: 'tl-group' }, addBtn, btn('⇩ Bake', 'Bake the scene into a single .reanim', () => this.doc && this.hooks.bake(this.doc))),
      h(
        'div',
        { class: 'tl-group' },
        this.loopBtn,
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
    this.frameField.set(Math.floor(ws.sceneFrame(doc)));
    this.frameTotal.textContent = `/ ${doc.state.length - 1}`;
    if (light) return;
    this.fpsField.set(doc.state.fps);
    this.lengthField.set(doc.state.length);
    this.loopBtn.classList.toggle('active', doc.ui.loopPlayback);
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

  private switchView(doc: SceneDocument) {
    if (this.viewDoc === doc.id) return;
    if (this.viewDoc >= 0) this.views.set(this.viewDoc, { cellW: this.cellW, scrollX: this.scrollX, scrollY: this.scrollY });
    this.viewDoc = doc.id;
    const v = this.views.get(doc.id);
    if (v) ({ cellW: this.cellW, scrollX: this.scrollX, scrollY: this.scrollY } = v);
    else {
      this.cellW = clamp(Math.floor((this.cssW - NAME_W - 40) / Math.max(1, doc.state.length)), 6, 24);
      this.scrollX = this.scrollY = 0;
    }
  }

  private buildRows(doc: SceneDocument): Row[] {
    const rows: Row[] = [{ kind: 'header', label: 'SOUND' }, { kind: 'sound' }, { kind: 'header', label: 'LAYERS  (top = front)' }];
    for (let i = doc.state.layers.length - 1; i >= 0; i--) rows.push({ kind: 'layer', index: i });
    return rows;
  }

  private get maxScrollY() {
    return Math.max(0, this.rows.length * ROW_H - (this.cssH - RULER_H) + 8);
  }

  private get maxScrollX() {
    return Math.max(0, (this.doc?.state.length ?? 0) * this.cellW - (this.cssW - NAME_W) + 40);
  }

  private frameX(f: number) {
    return NAME_W + f * this.cellW - this.scrollX;
  }

  private xToFrame(x: number) {
    return Math.floor((x - NAME_W + this.scrollX) / this.cellW);
  }

  private yToRow(y: number) {
    return Math.floor((y - RULER_H + this.scrollY) / ROW_H);
  }

  private zoomCells(f: number, anchorX = NAME_W + (this.cssW - NAME_W) / 2) {
    const frame = (anchorX - NAME_W + this.scrollX) / this.cellW;
    this.cellW = clamp(this.cellW * f, 3, 40);
    this.scrollX = clamp(frame * this.cellW - (anchorX - NAME_W), 0, this.maxScrollX);
    this.draw();
  }

  private follow() {
    const doc = this.doc;
    if (!doc) return;
    const f = Math.floor(this.ws.sceneFrame(doc));
    if (f === this.lastFollow) return;
    this.lastFollow = f;
    const x = f * this.cellW;
    const visW = this.cssW - NAME_W;
    if (x < this.scrollX || x > this.scrollX + visW - this.cellW * 2) this.scrollX = clamp(x - visW / 3, 0, this.maxScrollX);
  }

  // ------------------------------------------------------------ drawing

  draw(): void {
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const doc = this.doc;
    if (!doc) return;
    this.switchView(doc);
    this.rows = this.buildRows(doc);
    this.scrollY = clamp(this.scrollY, 0, this.maxScrollY);
    this.scrollX = clamp(this.scrollX, 0, this.maxScrollX);
    const n = doc.state.length;
    const first = Math.max(0, this.xToFrame(NAME_W));
    const last = Math.min(n - 1, this.xToFrame(this.cssW) + 1);
    const lo = Math.min(doc.ui.frame, doc.ui.frameEnd);
    const hi = Math.max(doc.ui.frame, doc.ui.frameEnd);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, this.cssW, this.cssH - RULER_H);
    ctx.clip();
    const r0 = Math.max(0, Math.floor(this.scrollY / ROW_H));
    const r1 = Math.min(this.rows.length - 1, Math.ceil((this.scrollY + this.cssH) / ROW_H));
    for (let ri = r0; ri <= r1; ri++) this.drawRowCells(ctx, doc, this.rows[ri], ri, RULER_H + ri * ROW_H - this.scrollY, first, last, lo, hi);
    ctx.fillStyle = C.names;
    ctx.fillRect(0, RULER_H, NAME_W, this.cssH);
    for (let ri = r0; ri <= r1; ri++) this.drawRowName(ctx, doc, this.rows[ri], RULER_H + ri * ROW_H - this.scrollY);
    const drag = this.drag;
    if (drag?.kind === 'reorder' && drag.moved) {
      const ri = this.rows.findIndex((r) => r.kind === 'layer' && r.index === drag.target);
      if (ri >= 0) {
        ctx.fillStyle = C.sel;
        ctx.fillRect(0, RULER_H + ri * ROW_H - this.scrollY - 1, this.cssW, 2);
      }
    }
    ctx.restore();

    // Ruler
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, this.cssW, RULER_H);
    ctx.font = '10px ui-monospace, monospace';
    const fps = doc.state.fps;
    const every = this.cellW >= 16 ? 5 : this.cellW >= 8 ? 10 : 30;
    for (let f = first; f <= last; f++) {
      const x = this.frameX(f);
      if (x < NAME_W) continue;
      const major = f % 5 === 0;
      ctx.fillStyle = major ? C.dim : 'rgba(255,255,255,0.15)';
      ctx.fillRect(x, RULER_H - (major ? 8 : 4), 1, major ? 8 : 4);
      if (f % every === 0) {
        ctx.fillStyle = C.text;
        ctx.fillText(String(f), x + 2, 11);
      }
      if (f > 0 && Math.abs((f / fps) % 1) < 1e-9) {
        ctx.fillStyle = '#7cc0ff';
        ctx.fillText(`${f / fps}s`, x + 2, 20);
      }
    }
    ctx.fillStyle = C.names;
    ctx.fillRect(0, 0, NAME_W, RULER_H);
    ctx.fillStyle = C.dim;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`🎬 ${doc.name}  ·  ${fps} fps  ·  ${(n / fps).toFixed(1)}s`, 8, 15);

    // Playhead
    const pos = this.ws.playing ? this.ws.sceneFrame(doc) : doc.ui.frame;
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
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(NAME_W - 1, 0, 1, this.cssH);
    ctx.fillRect(0, RULER_H - 1, this.cssW, 1);
  }

  private drawRowCells(ctx: CanvasRenderingContext2D, doc: SceneDocument, row: Row, ri: number, y: number, first: number, last: number, lo: number, hi: number) {
    const cw = this.cellW;
    if (row.kind === 'header') {
      ctx.fillStyle = C.header;
      ctx.fillRect(NAME_W, y, this.cssW, ROW_H);
      return;
    }
    ctx.fillStyle = ri % 2 ? C.rowAlt : C.bg;
    ctx.fillRect(NAME_W, y, this.cssW, ROW_H);
    for (let f = first; f <= last; f++) {
      ctx.fillStyle = f % 5 === 0 ? C.grid5 : C.grid;
      ctx.fillRect(this.frameX(f), y, 1, ROW_H);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(NAME_W, y + ROW_H - 1, this.cssW, 1);
    const end = doc.state.length;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(this.frameX(end), y, this.cssW, ROW_H);

    if (row.kind === 'sound') {
      const cues = [...doc.state.soundCues].sort((a, b) => this.cueFrame(a) - this.cueFrame(b));
      ctx.font = '11px system-ui, sans-serif';
      cues.forEach((cue, idx) => {
        const x = this.frameX(this.cueFrame(cue));
        const nextX = idx + 1 < cues.length ? this.frameX(this.cueFrame(cues[idx + 1])) : this.cssW;
        if (nextX < NAME_W || x > this.cssW) return;
        const selected = doc.ui.cue?.uid === cue.uid;
        this.drawWave(ctx, cue.sound, cue.volume, doc.state.fps, x, y, selected);
        ctx.fillStyle = selected ? C.sel : '#7fd1a0';
        roundRect(ctx, x + 1, y + 4, Math.max(cw - 2, 6), ROW_H - 8, 3);
        ctx.fill();
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, Math.max(0, nextX - x - 2), ROW_H);
        ctx.clip();
        const text = '♪ ' + basename(cue.sound);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(22,24,30,0.9)';
        ctx.strokeText(text, x + Math.max(cw, 8) + 2, y + 15);
        ctx.fillStyle = selected ? C.sel : C.text;
        ctx.fillText(text, x + Math.max(cw, 8) + 2, y + 15);
        ctx.restore();
      });
      return;
    }

    const layer = doc.state.layers[row.index];
    if (!layer) return;
    const selected = row.index === doc.ui.layer;
    const keys = layer.keys;
    // Spans between keys: tween (purple) or static (grey); nothing where the layer is hidden.
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const next = keys[k + 1];
      const spanEnd = next ? next.frame : end;
      if (!key.visible || spanEnd <= key.frame) continue;
      const x0 = this.frameX(key.frame);
      const x1 = this.frameX(spanEnd);
      if (x1 < NAME_W || x0 > this.cssW) continue;
      const tween = !!next && key.ease !== 'hold' && next.visible;
      ctx.fillStyle = tween ? TWEEN_FILL : SPAN_FILL;
      ctx.fillRect(x0 + 1, y + 3, x1 - x0 - 1, ROW_H - 6);
      if (tween && x1 - x0 > cw * 2) {
        const mid = y + ROW_H / 2;
        ctx.strokeStyle = key.ease === 'linear' ? 'rgba(200,190,255,0.75)' : 'rgba(240,166,74,0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0 + cw, mid);
        ctx.lineTo(x1 - cw * 0.6, mid);
        ctx.lineTo(x1 - cw * 0.6 - 4, mid - 3);
        ctx.moveTo(x1 - cw * 0.6, mid);
        ctx.lineTo(x1 - cw * 0.6 - 4, mid + 3);
        ctx.stroke();
      }
    }
    if (selected) {
      ctx.strokeStyle = C.sel;
      ctx.lineWidth = 1;
      ctx.strokeRect(this.frameX(lo) + 0.5, y + 1.5, (hi - lo + 1) * cw - 1, ROW_H - 3);
    }
    // Keyframes: filled dot = key, hollow = blank keyframe (hidden), ring = animation restarts.
    const r = Math.max(2.5, Math.min(4.5, cw / 3));
    keys.forEach((key, k) => {
      const f = this.drag?.kind === 'moveKey' && this.drag.layer === row.index && this.drag.from === key.frame ? this.drag.to : key.frame;
      const cx = this.frameX(f) + cw / 2;
      if (cx < NAME_W - cw || cx > this.cssW + cw) return;
      const mid = y + ROW_H / 2;
      const prev = keys[k - 1];
      const restarts = layer.kind !== 'image' && (k === 0 || key.restart || !prev || prev.anim !== key.anim || prev.loop !== key.loop || prev.startFrame !== key.startFrame || prev.speed !== key.speed || prev.visible !== key.visible);
      ctx.beginPath();
      ctx.arc(cx, mid, r, 0, Math.PI * 2);
      if (key.visible) {
        ctx.fillStyle = selected ? '#ffffff' : '#e8edf5';
        ctx.fill();
      } else {
        ctx.strokeStyle = '#e8edf5';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      if (restarts && key.visible) {
        ctx.strokeStyle = key.restart ? '#f0a64a' : '#7cc0ff';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, mid, r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  }

  private cueFrame(c: { uid: number; frame: number }) {
    return this.drag?.kind === 'cue' && this.drag.uid === c.uid ? this.drag.to : c.frame;
  }

  private drawWave(ctx: CanvasRenderingContext2D, ref: string, volume: number, fps: number, x: number, y: number, selected: boolean) {
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
    for (let px = Math.max(NAME_W, Math.floor(x)); px < Math.min(this.cssW, Math.ceil(x + width)); px++) {
      const a = Math.floor(((px - x) / width) * env.length);
      const b = Math.max(a + 1, Math.floor(((px + 1 - x) / width) * env.length));
      let peak = 0;
      for (let i = a; i < b && i < env.length; i++) peak = Math.max(peak, env[i]);
      const hgt = Math.min(1, peak * Math.max(0.2, volume)) * half;
      ctx.fillRect(px, mid - hgt, 1, Math.max(1, hgt * 2));
    }
  }

  private drawRowName(ctx: CanvasRenderingContext2D, doc: SceneDocument, row: Row, y: number) {
    ctx.font = '12px system-ui, sans-serif';
    if (row.kind === 'header') {
      ctx.fillStyle = C.header;
      ctx.fillRect(0, y, NAME_W, ROW_H);
      ctx.fillStyle = C.dim;
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillText(row.label, 8, y + 14);
      ctx.fillStyle = C.text;
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillText('+', NAME_W - 18, y + 16);
      return;
    }
    const selected = (row.kind === 'layer' && row.index === doc.ui.layer) || (row.kind === 'sound' && !!doc.ui.cue);
    if (selected) {
      ctx.fillStyle = 'rgba(255, 211, 77, 0.14)';
      ctx.fillRect(0, y, NAME_W, ROW_H);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, y + ROW_H - 1, NAME_W, 1);
    if (row.kind === 'sound') {
      ctx.fillStyle = C.text;
      ctx.fillText('♪  Sound cues', 8, y + 15);
      ctx.fillStyle = C.dim;
      ctx.fillText(String(doc.state.soundCues.length), NAME_W - 24, y + 15);
      return;
    }
    const layer = doc.state.layers[row.index];
    if (!layer) return;
    const hidden = doc.ui.hidden.has(layer.uid);
    const locked = doc.ui.locked.has(layer.uid);
    ctx.fillStyle = hidden ? '#5a606c' : C.text;
    ctx.fillText(hidden ? '◌' : '●', 8, y + 15);
    ctx.fillStyle = locked ? C.sel : '#5a606c';
    ctx.fillText(locked ? '🔒' : '·', 26, y + 15);
    ctx.fillStyle = layer.kind === 'reanim' ? '#6fb6ff' : layer.kind === 'particle' ? '#f08ad8' : '#c9ceda';
    ctx.fillText(KIND_ICON[layer.kind], 42, y + 15);
    ctx.fillStyle = hidden ? C.dim : C.text;
    let name = layer.name;
    const maxW = NAME_W - 66;
    if (ctx.measureText(name).width > maxW) {
      while (name.length > 3 && ctx.measureText(name + '…').width > maxW) name = name.slice(0, -1);
      name += '…';
    }
    ctx.fillText(name, 58, y + 15);
  }

  // ------------------------------------------------------------ input

  private pos(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private bindInput() {
    const cv = this.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const [x] = this.pos(e);
        if (e.ctrlKey || e.metaKey) return this.zoomCells(Math.exp(-e.deltaY * 0.002), Math.max(NAME_W, x));
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) this.scrollX = clamp(this.scrollX + (e.shiftKey ? e.deltaY : e.deltaX), 0, this.maxScrollX);
        else this.scrollY = clamp(this.scrollY + e.deltaY, 0, this.maxScrollY);
        this.draw();
      },
      { passive: false },
    );
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
      const [x] = this.pos(e);
      const frame = clamp(this.xToFrame(x), 0, doc.state.length - 1);
      if (asset.kind === 'sound') {
        const cue = doc.addSoundCue(frame, asset.path);
        doc.ui.cue = { kind: 'sound', uid: cue.uid };
        this.ws.emit('change');
      }
    });
  }

  private frameAt(x: number, doc: SceneDocument) {
    return clamp(this.xToFrame(x), 0, doc.state.length - 1);
  }

  private hitCue(doc: SceneDocument, x: number): number | null {
    for (const c of doc.state.soundCues) {
      const cx = this.frameX(c.frame);
      if (x >= cx && x <= cx + Math.max(this.cellW, 8)) return c.uid;
    }
    return null;
  }

  private onDown(e: PointerEvent) {
    const doc = this.doc;
    if (!doc) return;
    this.canvas.focus();
    const [x, y] = this.pos(e);
    const frame = this.frameAt(x, doc);
    if (y < RULER_H) {
      if (x >= NAME_W && e.button === 0) {
        this.canvas.setPointerCapture(e.pointerId);
        this.drag = { kind: 'scrub' };
        this.ws.setFrame(frame);
      }
      return;
    }
    const row = this.rows[this.yToRow(y)];
    if (!row) return;
    if (e.button === 2) return this.contextMenu(e, doc, row, x, frame);
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    if (row.kind === 'header') {
      if (x > NAME_W - 26 && x < NAME_W) {
        const r = this.canvas.getBoundingClientRect();
        if (row.label.startsWith('SOUND')) this.hooks.addSoundCue(doc, doc.ui.frame);
        else showMenu(this.hooks.addMenu(doc), r.left + NAME_W - 20, r.top + y + 10);
      }
      return;
    }
    if (row.kind === 'sound') {
      if (x < NAME_W) return;
      const uid = this.hitCue(doc, x);
      if (uid !== null) {
        const cue = doc.state.soundCues.find((c) => c.uid === uid)!;
        doc.ui.cue = { kind: 'sound', uid };
        this.drag = { kind: 'cue', uid, from: cue.frame, to: cue.frame, moved: false };
        this.hooks.previewSound(cue.sound);
        this.ws.emit('change');
      } else {
        doc.ui.cue = null;
        this.ws.setFrame(frame);
      }
      return;
    }
    const li = row.index;
    const layer = doc.state.layers[li];
    doc.ui.cue = null;
    if (x < NAME_W) {
      if (x < 22) return void (toggle(doc.ui.hidden, layer.uid), this.ws.emit('change'));
      if (x < 40) return void (toggle(doc.ui.locked, layer.uid), this.ws.emit('change'));
      doc.ui.layer = li;
      this.drag = { kind: 'reorder', layer: li, target: li, startY: y, moved: false };
      this.ws.emit('change');
      return;
    }
    if (e.shiftKey && doc.ui.layer === li) return this.ws.setFrame(frame, true);
    const wasSelected = doc.ui.layer === li;
    doc.ui.layer = li;
    if (wasSelected && layer.keys.some((k) => k.frame === frame)) this.drag = { kind: 'moveKey', layer: li, from: frame, to: frame };
    else this.drag = { kind: 'select', from: frame };
    this.ws.setFrame(frame);
  }

  private onMove(e: PointerEvent) {
    const doc = this.doc;
    const drag = this.drag;
    if (!doc || !drag) return;
    const [x, y] = this.pos(e);
    const frame = this.frameAt(x, doc);
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
        if (row?.kind === 'layer') drag.target = row.index;
        this.draw();
        break;
      }
      case 'cue':
        if (frame !== drag.to) drag.moved = true;
        drag.to = frame;
        this.draw();
        break;
    }
  }

  private onUp(e: PointerEvent) {
    const doc = this.doc;
    const drag = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!doc || !drag) return;
    if (drag.kind === 'moveKey' && drag.to !== drag.from && doc.moveKey(drag.layer, drag.from, drag.to)) doc.ui.frame = doc.ui.frameEnd = drag.to;
    if (drag.kind === 'reorder' && drag.moved && drag.target !== drag.layer) doc.moveLayer(drag.layer, drag.target);
    if (drag.kind === 'cue' && drag.moved && drag.to !== drag.from) doc.updateSoundCue(drag.uid, { frame: drag.to }, 'Move sound cue');
    this.ws.emit('change');
  }

  private onDouble(e: MouseEvent) {
    const doc = this.doc;
    if (!doc) return;
    const [x, y] = this.pos(e);
    if (y < RULER_H) return;
    const row = this.rows[this.yToRow(y)];
    const frame = this.frameAt(x, doc);
    if (row?.kind === 'layer') {
      if (x < NAME_W) {
        if (x >= 40) this.hooks.renameLayer(doc, row.index);
      } else {
        doc.toggleKey(row.index, frame);
        this.ws.emit('change');
      }
    } else if (row?.kind === 'sound' && x >= NAME_W && this.hitCue(doc, x) === null) {
      this.hooks.addSoundCue(doc, frame);
    }
  }

  private contextMenu(e: MouseEvent, doc: SceneDocument, row: Row, x: number, frame: number) {
    const ws = this.ws;
    const items: MenuItem[] = [];
    if (row.kind === 'layer') {
      const li = row.index;
      const layer = doc.state.layers[li];
      doc.ui.layer = li;
      if (x >= NAME_W) doc.ui.frame = doc.ui.frameEnd = frame;
      ws.emit('change');
      if (x >= NAME_W) items.push(...this.keyMenu(doc, li, layer, frame), { separator: true });
      items.push({ label: 'Rename layer…', action: () => this.hooks.renameLayer(doc, li) }, ...this.hooks.layerMenu(doc, li));
    } else if (row.kind === 'sound') {
      const uid = x >= NAME_W ? this.hitCue(doc, x) : null;
      if (uid !== null) items.push({ label: 'Delete sound cue', action: () => (doc.removeSoundCue(uid), ws.emit('change')) });
      else items.push({ label: `Add sound cue at frame ${frame}…`, action: () => this.hooks.addSoundCue(doc, frame) });
    } else {
      items.push(...this.hooks.addMenu(doc));
    }
    showMenu(items, e.clientX, e.clientY);
  }

  keyMenu(doc: SceneDocument, li: number, layer: SceneLayer, frame: number): MenuItem[] {
    const ws = this.ws;
    const emit = () => ws.emit('change');
    const isKey = layer.keys.some((k) => k.frame === frame);
    const ki = keyIndexAt(layer, frame);
    const key = layer.keys[ki];
    return [
      { label: 'Insert keyframe', shortcut: 'F6', disabled: isKey, action: () => (doc.toggleKey(li, frame), emit()) },
      { label: 'Insert blank keyframe (hide)', shortcut: 'F7', action: () => (doc.setKey(li, frame, { visible: false }, 'Insert blank keyframe'), emit()) },
      { label: 'Show from here', disabled: !key || key.visible, action: () => (doc.setKey(li, frame, { visible: true }, 'Show layer'), emit()) },
      { label: 'Clear keyframe', shortcut: 'Shift+F6', disabled: !isKey || layer.keys.length <= 1, action: () => (doc.removeKey(li, frame), emit()) },
      {
        label: 'Easing',
        disabled: !key,
        submenu: EASES.map((ea) => ({ label: ea.label, checked: key?.ease === ea.id, action: () => (doc.setEase(li, frame, ea.id), emit()) })),
      },
      ...(layer.kind !== 'image'
        ? [{ label: layer.kind === 'particle' ? 'Restart effect here' : 'Restart animation here', checked: isKey && key?.restart, action: () => (doc.setKey(li, frame, { restart: !(isKey && key?.restart) }, 'Toggle restart'), emit()) }]
        : []),
      { separator: true },
      { label: 'Insert frame', shortcut: 'F5', action: () => (doc.shiftFrames(frame + 1, 1), emit()) },
      { label: 'Remove frame', shortcut: 'Shift+F5', disabled: doc.state.length <= 1, action: () => (doc.shiftFrames(frame, -1), emit()) },
    ];
  }
}

function toggle(set: Set<number>, v: number) {
  if (!set.delete(v)) set.add(v);
}
