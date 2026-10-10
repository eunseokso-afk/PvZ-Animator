/**
 * The stage: renders the active document with WebGL and handles direct
 * manipulation (select, move, rotate, scale parts; move particle emitters).
 */

import { imageAlphaAt } from '../engine/assets';
import { apply, clamp, DEG, invert, type Mat } from '../engine/math';
import { ParticleSystem } from '../engine/particleSystem';
import { gameHiddenTracks } from '../engine/gameVisibility';
import { createRenderer, type Renderer, type RGBA } from '../engine/renderer';
import { drawReanim, interpolateTransform, transformMatrix, type DrawTrackInfo } from '../engine/reanimRuntime';
import type { ReanimTransform } from '../formats/reanim';
import type { ParticleDocument } from '../editor/particleDoc';
import type { ReanimDocument } from '../editor/reanimDoc';
import type { EditorDocument, Workspace } from '../editor/workspace';
import { h } from './dom';
import { SceneStage } from './sceneStage';
import { showMenu, type MenuItem } from './widgets';

export const ASSET_MIME = 'application/x-pvz-asset';

type Drag =
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number; moved: boolean; button: number; hit: number }
  | { kind: 'move'; sx: number; sy: number; start: ReanimTransform; track: number; frame: number; began: boolean; selectOnly: boolean }
  | { kind: 'rotate'; track: number; frame: number; start: ReanimTransform; w: number; h: number; startAngle: number; pivot: [number, number] }
  | { kind: 'scale'; track: number; frame: number; start: ReanimTransform; w: number; h: number; corner: [number, number]; inv: Mat; pivot: [number, number] }
  | { kind: 'emitter'; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'cue'; uid: number; sx: number; sy: number; began: boolean }
  | { kind: 'scene' };

const BACKGROUNDS: Record<string, string> = {
  dark: '#23262e',
  light: '#d9dce3',
  lawn: '#4d8a2b',
  night: '#0f1a33',
};

const HANDLE = 5;
const ROT_HANDLE_DIST = 26;

export class Viewport {
  readonly el: HTMLElement;
  private tabs: HTMLElement;
  private stage: HTMLElement;
  private bgCanvas: HTMLCanvasElement;
  private glCanvas: HTMLCanvasElement;
  private ovCanvas: HTMLCanvasElement;
  private empty: HTMLElement;
  private info: HTMLElement;
  readonly renderer: Renderer;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private drawn: DrawTrackInfo[] = [];
  private drag: Drag | null = null;
  private hoverTrack = -1;
  private spaceDown = false;
  private needsRender = true;
  private lastT = 0;
  private preview: { doc: ParticleDocument; revision: number; sys: ParticleSystem; deadFor: number } | null = null;
  private cueScreen: { uid: number; x: number; y: number }[] = [];
  private crumbs: HTMLElement;
  readonly sceneStage: SceneStage;

  constructor(
    private ws: Workspace,
    actions: { welcome: HTMLElement },
  ) {
    this.tabs = h('div', { class: 'doc-tabs' });
    this.bgCanvas = h('canvas', { class: 'layer' });
    this.glCanvas = h('canvas', { class: 'layer' });
    this.ovCanvas = h('canvas', { class: 'layer overlay-layer', tabIndex: 0 });
    this.info = h('div', { class: 'stage-info' });
    this.empty = h('div', { class: 'stage-empty' }, actions.welcome);
    this.stage = h('div', { class: 'stage' }, this.bgCanvas, this.glCanvas, this.ovCanvas, this.info, this.empty);
    this.crumbs = h('div', { class: 'crumbs' });
    this.el = h('div', { class: 'viewport' }, this.tabs, this.crumbs, this.stage);
    this.renderer = createRenderer(this.glCanvas, () => this.invalidate());
    this.glCanvas = this.renderer.canvas; // the 2D fallback may swap in a new canvas
    this.sceneStage = new SceneStage(ws, {
      view: (d) => this.viewMatrix(d),
      toStage: (d, x, y) => this.toWorld(d, x, y),
      invalidate: () => this.invalidate(),
    });

    new ResizeObserver(() => this.resize()).observe(this.stage);
    this.bindInput();
    ws.on('docs', () => {
      this.renderTabs();
      this.invalidate();
    });
    ws.on('change', () => {
      this.renderTabs();
      this.invalidate();
    });
    ws.on('frame', () => this.invalidate());
    ws.on('settings', () => this.invalidate());
    ws.on('assets', () => this.invalidate());
    this.renderTabs();
    requestAnimationFrame((t) => this.loop(t));
  }

  invalidate(): void {
    this.needsRender = true;
  }

  get rendererKind(): string {
    return this.renderer.kind;
  }

  private resize() {
    const r = this.stage.getBoundingClientRect();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.dpr = window.devicePixelRatio || 1;
    this.renderer.resize(this.cssW, this.cssH, this.dpr);
    for (const c of [this.bgCanvas, this.ovCanvas]) {
      c.width = Math.round(this.cssW * this.dpr);
      c.height = Math.round(this.cssH * this.dpr);
    }
    this.invalidate();
  }

  // ------------------------------------------------------------ tabs

  private renderTabs() {
    const ws = this.ws;
    this.tabs.replaceChildren(
      ...ws.docs.map((d) =>
        h(
          'div',
          {
            class: `doc-tab${d === ws.active ? ' active' : ''}`,
            title: d.path,
            onmousedown: (e: MouseEvent) => {
              if (e.button === 1) {
                e.preventDefault();
                void this.requestClose(d);
              } else if (e.button === 0) ws.setActive(d);
            },
          },
          h('span', { class: `doc-kind ${d.kind}` }, d.kind === 'reanim' ? '▶' : d.kind === 'scene' ? '🎬' : '✦'),
          h('span', { class: 'doc-name' }, d.name + (d.dirty ? ' •' : '')),
          h(
            'button',
            {
              class: 'icon-btn tab-close',
              title: 'Close',
              onmousedown: (e: MouseEvent) => e.stopPropagation(),
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                void this.requestClose(d);
              },
            },
            '✕',
          ),
        ),
      ),
    );
    this.empty.style.display = ws.active ? 'none' : '';
    this.renderCrumbs();
  }

  /** "Scene › Prefab" breadcrumb while editing a prefab opened from a scene. */
  private renderCrumbs() {
    const ws = this.ws;
    const doc = ws.active;
    const scene = doc ? ws.returnTo.get(doc) : undefined;
    if (!doc || !scene || !ws.scenes.includes(scene)) {
      this.crumbs.style.display = 'none';
      return;
    }
    this.crumbs.style.display = '';
    this.crumbs.replaceChildren(
      h('button', { class: 'btn small', title: `Back to ${scene.name}`, onclick: () => ws.openDoc(scene) }, `⬅ ${scene.name}`),
      h('span', { class: 'crumb' }, '🎬 ', scene.name),
      h('span', { class: 'crumb-sep' }, '›'),
      doc.kind === 'particle'
        ? h('span', { class: 'crumb current' }, '✦ ', doc.name, h('span', { class: 'dim' }, '  (effect — changes show up in the scene)'))
        : h('span', { class: 'crumb current' }, '▶ ', doc.name, h('span', { class: 'dim' }, '  (prefab — changes show up in the scene)')),
    );
  }

  /** Overridden by the app to confirm closing unsaved documents. */
  requestClose: (doc: EditorDocument) => Promise<void> = async (doc) => this.ws.closeDoc(doc);

  // ------------------------------------------------------------ view math

  viewMatrix(doc: EditorDocument): Mat {
    const v = doc.view;
    return [v.zoom, 0, 0, v.zoom, this.cssW / 2 + v.panX, this.cssH / 2 + v.panY];
  }

  private toWorld(doc: EditorDocument, x: number, y: number): [number, number] {
    const v = doc.view;
    return [(x - this.cssW / 2 - v.panX) / v.zoom, (y - this.cssH / 2 - v.panY) / v.zoom];
  }

  setZoom(zoom: number, anchor?: [number, number]): void {
    const doc = this.ws.active;
    if (!doc) return;
    const v = doc.view;
    const [ax, ay] = anchor ?? [this.cssW / 2, this.cssH / 2];
    const [wx, wy] = this.toWorld(doc, ax, ay);
    v.zoom = clamp(zoom, 0.05, 40);
    v.panX = ax - this.cssW / 2 - wx * v.zoom;
    v.panY = ay - this.cssH / 2 - wy * v.zoom;
    v.fitted = true;
    this.invalidate();
    this.ws.emit('settings');
  }

  /** Fit the current pose (or a default framing). Returns false if images are still loading. */
  fit(force = true): boolean {
    const doc = this.ws.active;
    if (!doc) return true;
    const v = doc.view;
    if (doc.kind === 'scene') {
      this.sceneStage.fit(doc, this.cssW, this.cssH);
      this.invalidate();
      this.ws.emit('settings');
      return true;
    }
    if (doc.kind === 'particle') {
      v.zoom = 1;
      v.panX = 0;
      v.panY = Math.min(120, this.cssH * 0.2);
      v.fitted = true;
      this.invalidate();
      return true;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const ft = this.ws.frameTime(doc);
    for (const t of doc.state.tracks) {
      const tr = interpolateTransform(t.transforms, ft);
      if (Math.round(tr.f) < 0 || !tr.i) continue;
      const img = this.ws.assets.image(tr.i);
      if (img === undefined) {
        if (!force) return false;
        continue;
      }
      const w = img?.celWidth ?? 24;
      const hh = img?.celHeight ?? 24;
      const m = transformMatrix(tr);
      for (const [cx, cy] of [
        [0, 0],
        [w, 0],
        [0, hh],
        [w, hh],
      ]) {
        const [x, y] = apply(m, cx, cy);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (!Number.isFinite(minX)) {
      minX = -40;
      minY = -60;
      maxX = 120;
      maxY = 140;
    }
    const pad = 60;
    const zoom = clamp(Math.min((this.cssW - pad * 2) / Math.max(1, maxX - minX), (this.cssH - pad * 2) / Math.max(1, maxY - minY)), 0.1, 2.5);
    v.zoom = zoom;
    v.panX = -((minX + maxX) / 2) * zoom;
    v.panY = -((minY + maxY) / 2) * zoom;
    v.fitted = true;
    this.invalidate();
    this.ws.emit('settings');
    return true;
  }

  // ------------------------------------------------------------ loop

  private loop(t: number) {
    const dt = this.lastT ? Math.min(0.1, (t - this.lastT) / 1000) : 0;
    this.lastT = t;
    if (this.ws.update(dt)) {
      this.needsRender = true;
      if (this.ws.playing) this.ws.emit('frame');
    }
    const pdoc = this.ws.particle;
    if (pdoc && this.updateParticlePreview(pdoc, dt)) this.needsRender = true;
    if (this.needsRender) {
      this.needsRender = false;
      try {
        this.render();
      } catch (e) {
        console.error(e);
      }
    }
    requestAnimationFrame((tt) => this.loop(tt));
  }

  private updateParticlePreview(doc: ParticleDocument, dt: number): boolean {
    if (!this.preview || this.preview.doc !== doc || this.preview.revision !== doc.revision) {
      this.preview = { doc, revision: doc.revision, sys: new ParticleSystem(doc.def, doc.ui.x, doc.ui.y), deadFor: 0 };
    }
    const p = this.preview;
    p.sys.setPosition(doc.ui.x, doc.ui.y);
    if (!doc.ui.playing) return false;
    p.sys.advance(dt * doc.ui.speed);
    if (p.sys.dead) {
      p.deadFor += dt;
      if (doc.ui.autoRestart && p.deadFor > 0.5) this.restartParticles();
    }
    return true;
  }

  restartParticles(): void {
    const doc = this.ws.particle;
    if (!doc) return;
    this.preview = { doc, revision: doc.revision, sys: new ParticleSystem(doc.def, doc.ui.x, doc.ui.y), deadFor: 0 };
    this.invalidate();
  }

  get particleCount(): number {
    return this.preview?.sys.particleCount ?? 0;
  }

  // ------------------------------------------------------------ rendering

  private render() {
    const doc = this.ws.active;
    if (doc && !doc.view.fitted) this.fit(false);
    this.renderBackground(doc);
    const r = this.renderer;
    r.begin([0, 0, 0, 0], r.kind === 'canvas2d' ? this.bgCanvas : undefined);
    this.drawn = [];
    if (doc?.kind === 'reanim') this.renderReanim(doc);
    else if (doc?.kind === 'particle') this.preview?.sys.draw(r, this.ws.assets, this.viewMatrix(doc));
    else if (doc?.kind === 'scene') this.sceneStage.render(doc, r);
    r.end();
    this.renderOverlay(doc);
  }

  private renderBackground(doc: EditorDocument | null) {
    const ctx = this.bgCanvas.getContext('2d')!;
    const d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const bg = this.ws.settings.background;
    if (bg === 'checker') {
      const s = 12;
      ctx.fillStyle = '#9a9ea8';
      ctx.fillRect(0, 0, this.cssW, this.cssH);
      ctx.fillStyle = '#b8bcc5';
      for (let y = 0; y < this.cssH; y += s) for (let x = (y / s) % 2 ? s : 0; x < this.cssW; x += s * 2) ctx.fillRect(x, y, s, s);
    } else {
      ctx.fillStyle = BACKGROUNDS[bg] ?? BACKGROUNDS.dark;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    }
    if (!doc) return;
    const m = this.viewMatrix(doc);
    const light = bg === 'light' || bg === 'checker';
    if (this.ws.settings.grid) {
      const zoom = m[0];
      let step = 10;
      while (step * zoom < 14) step *= 5;
      const [x0, y0] = this.toWorld(doc, 0, 0);
      const [x1, y1] = this.toWorld(doc, this.cssW, this.cssH);
      ctx.lineWidth = 1;
      for (const [s, alpha] of [
        [step, 0.06],
        [step * 5, 0.12],
      ] as const) {
        ctx.strokeStyle = light ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha})`;
        ctx.beginPath();
        for (let x = Math.floor(x0 / s) * s; x <= x1; x += s) {
          const sx = Math.round(m[4] + x * zoom) + 0.5;
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, this.cssH);
        }
        for (let y = Math.floor(y0 / s) * s; y <= y1; y += s) {
          const sy = Math.round(m[5] + y * zoom) + 0.5;
          ctx.moveTo(0, sy);
          ctx.lineTo(this.cssW, sy);
        }
        ctx.stroke();
      }
      ctx.strokeStyle = light ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.28)';
      ctx.beginPath();
      ctx.moveTo(Math.round(m[4]) + 0.5, 0);
      ctx.lineTo(Math.round(m[4]) + 0.5, this.cssH);
      ctx.moveTo(0, Math.round(m[5]) + 0.5);
      ctx.lineTo(this.cssW, Math.round(m[5]) + 0.5);
      ctx.stroke();
    }
    if (this.ws.settings.lawnGuide && doc.kind === 'reanim') {
      // A lawn cell is 80x100 px; most plant reanims are drawn with their origin near the cell's top-left.
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(255, 230, 120, 0.75)';
      ctx.lineWidth = 1;
      ctx.strokeRect(m[4] + 0.5, m[5] + 0.5, 80 * m[0], 100 * m[3]);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255, 230, 120, 0.8)';
      ctx.font = '11px sans-serif';
      ctx.fillText('lawn cell 80×100', m[4] + 4, m[5] + 100 * m[3] + 13);
      ctx.restore();
    }
  }

  private renderReanim(doc: ReanimDocument) {
    const ws = this.ws;
    const r = this.renderer;
    const view = this.viewMatrix(doc);
    const tracks = doc.state.tracks;
    // Parts the game hides from code stay hidden, except the selected one, shown as a ghost.
    const game = ws.settings.gameVisibility ? gameHiddenTracks(tracks) : null;
    const sel = doc.ui.track;
    const hidden = (i: number) => doc.ui.hidden.has(tracks[i].uid) || (!!game?.has(i) && i !== sel);
    const tintSel: RGBA = [1, 1, 1, 0.35];
    const tint = game?.has(sel) ? (i: number) => (i === sel ? tintSel : null) : undefined;
    const common = { fps: ws.playbackFps(doc), range: doc.activeRange(), gameVisibility: ws.settings.gameVisibility, tint };
    if (ws.settings.onion && !ws.playing) {
      const { start, end } = doc.activeRange();
      const f = doc.ui.frame;
      const ghosts: [number, RGBA][] = [];
      if (f - 1 >= start) ghosts.push([f - 1, [1, 0.45, 0.45, 1]]);
      if (f + 1 <= end) ghosts.push([f + 1, [0.45, 1, 0.55, 1]]);
      for (const [g, onion] of ghosts) {
        drawReanim(r, ws.assets, tracks, { before: g, after: g, fraction: 0 }, view, { ...common, hidden, alpha: 0.28, color: onion });
      }
    }
    drawReanim(r, ws.assets, tracks, ws.frameTime(doc), view, { ...common, hidden, collect: this.drawn });
    const systems = ws.playing ? ws.live.map((l) => l.sys) : ws.pausedParticleSystems(doc);
    for (const s of systems) s.draw(r, ws.assets, view);
  }

  private renderOverlay(doc: EditorDocument | null) {
    const ctx = this.ovCanvas.getContext('2d')!;
    const d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this.cueScreen = [];
    if (!doc) {
      this.info.textContent = '';
      return;
    }
    if (doc.kind === 'reanim') this.overlayReanim(ctx, doc);
    else if (doc.kind === 'scene') this.sceneStage.overlay(ctx, doc, this.cssW, this.cssH);
    else this.overlayParticle(ctx, doc);
    const zoom = Math.round(doc.view.zoom * 100);
    if (doc.kind === 'scene') {
      this.info.textContent = `frame ${Math.floor(this.ws.sceneFrame(doc))} · ${doc.state.width}×${doc.state.height} · ${zoom}%`;
    } else if (doc.kind === 'reanim') {
      const ft = this.ws.frameTime(doc);
      this.info.textContent = `frame ${ft.before}${doc.ui.anim ? ` · ${doc.ui.anim}` : ''} · ${zoom}%`;
    } else {
      this.info.textContent = `${this.particleCount} particles · ${zoom}%`;
    }
  }

  private polygon(info: DrawTrackInfo): [number, number][] {
    const m = info.matrix;
    return [apply(m, 0, 0), apply(m, info.width, 0), apply(m, info.width, info.height), apply(m, 0, info.height)];
  }

  private overlayReanim(ctx: CanvasRenderingContext2D, doc: ReanimDocument) {
    const showAll = this.ws.settings.showBounds;
    ctx.lineWidth = 1;
    for (const info of this.drawn) {
      const isSel = info.trackIndex === doc.ui.track;
      const isHover = info.trackIndex === this.hoverTrack;
      if (!isSel && !isHover && !showAll) continue;
      if (isSel) continue;
      const pts = this.polygon(info);
      ctx.strokeStyle = isHover ? 'rgba(120, 200, 255, 0.9)' : 'rgba(120, 200, 255, 0.18)';
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    }
    const sel = this.drawn.find((i) => i.trackIndex === doc.ui.track && !i.attached);
    if (sel && !this.ws.playing) {
      const pts = this.polygon(sel);
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      // Rotation handle above the top edge.
      const rot = this.rotateHandle(sel);
      const topMid: [number, number] = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
      ctx.beginPath();
      ctx.moveTo(topMid[0], topMid[1]);
      ctx.lineTo(rot[0], rot[1]);
      ctx.stroke();
      ctx.fillStyle = '#ffd34d';
      ctx.beginPath();
      ctx.arc(rot[0], rot[1], HANDLE, 0, Math.PI * 2);
      ctx.fill();
      for (const [x, y] of pts) {
        ctx.fillStyle = '#1b1d22';
        ctx.fillRect(x - HANDLE, y - HANDLE, HANDLE * 2, HANDLE * 2);
        ctx.strokeRect(x - HANDLE + 0.5, y - HANDLE + 0.5, HANDLE * 2 - 1, HANDLE * 2 - 1);
      }
      // Origin (the transform's x/y = image top-left corner).
      const [ox, oy] = pts[0];
      ctx.strokeStyle = '#ff6b6b';
      ctx.beginPath();
      ctx.moveTo(ox - 6, oy);
      ctx.lineTo(ox + 6, oy);
      ctx.moveTo(ox, oy - 6);
      ctx.lineTo(ox, oy + 6);
      ctx.stroke();
      // Center pivot used by the rotate/scale tools.
      const [cx, cy] = apply(sel.matrix, sel.width / 2, sel.height / 2);
      ctx.strokeStyle = '#ffd34d';
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.stroke();
      const t = sel.transform;
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const label = `${doc.state.tracks[sel.trackIndex].name}  x ${t.x.toFixed(1)} y ${t.y.toFixed(1)}  rot ${t.kx.toFixed(1)}°`;
      const w = ctx.measureText(label).width + 8;
      const lx = Math.min(...pts.map((p) => p[0]));
      const ly = Math.max(...pts.map((p) => p[1])) + 8;
      ctx.fillRect(lx, ly, w, 16);
      ctx.fillStyle = '#ffe9a8';
      ctx.fillText(label, lx + 4, ly + 12);
    }
    // Particle cue markers.
    if (!this.ws.playing) {
      const view = this.viewMatrix(doc);
      const ft = this.ws.frameTime(doc);
      for (const cue of doc.state.particleCues) {
        const [wx, wy] = this.ws.cuePosition(doc, cue, ft);
        const [x, y] = apply(view, wx, wy);
        this.cueScreen.push({ uid: cue.uid, x, y });
        const selected = doc.ui.cue?.kind === 'particle' && doc.ui.cue.uid === cue.uid;
        ctx.strokeStyle = selected ? '#ffd34d' : 'rgba(255, 140, 220, 0.85)';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4;
          const rr = i % 2 ? 4 : 9;
          const px = x + Math.cos(a) * rr;
          const py = y + Math.sin(a) * rr;
          if (i) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }
  }

  private overlayParticle(ctx: CanvasRenderingContext2D, doc: ParticleDocument) {
    const view = this.viewMatrix(doc);
    const [ox, oy] = apply(view, doc.ui.x, doc.ui.y);
    if (doc.ui.showGuides && this.preview) {
      const guides = this.preview.sys.emitterGuides();
      guides.forEach((g, i) => {
        const selected = i === doc.ui.emitter;
        ctx.strokeStyle = selected ? 'rgba(255, 211, 77, 0.9)' : 'rgba(255,255,255,0.25)';
        ctx.setLineDash(selected ? [] : [4, 4]);
        ctx.lineWidth = 1;
        const [cx, cy] = apply(view, g.cx, g.cy);
        const z = view[0];
        if (g.type.startsWith('Circle')) {
          if (g.radius > 0) {
            ctx.beginPath();
            ctx.arc(cx, cy, g.radius * z, 0, Math.PI * 2);
            ctx.stroke();
          }
        } else {
          const [x0, y0, x1, y1] = g.box;
          ctx.strokeRect(cx + x0 * z, cy + y0 * z, (x1 - x0) * z, (y1 - y0) * z);
        }
      });
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = '#ffd34d';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(ox, oy, 7, 0, Math.PI * 2);
    ctx.moveTo(ox - 12, oy);
    ctx.lineTo(ox + 12, oy);
    ctx.moveTo(ox, oy - 12);
    ctx.lineTo(ox, oy + 12);
    ctx.stroke();
  }

  private rotateHandle(info: DrawTrackInfo): [number, number] {
    const m = info.matrix;
    const top = apply(m, info.width / 2, 0);
    const center = apply(m, info.width / 2, info.height / 2);
    let dx = top[0] - center[0];
    let dy = top[1] - center[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) {
      dx = 0;
      dy = -1;
    } else {
      dx /= len;
      dy /= len;
    }
    return [top[0] + dx * ROT_HANDLE_DIST, top[1] + dy * ROT_HANDLE_DIST];
  }

  // ------------------------------------------------------------ hit testing

  private hitTrack(doc: ReanimDocument, x: number, y: number): number {
    for (let k = this.drawn.length - 1; k >= 0; k--) {
      const info = this.drawn[k];
      const track = doc.state.tracks[info.trackIndex];
      if (!track || doc.ui.locked.has(track.uid)) continue;
      const inv = invert(info.matrix);
      if (!inv) continue;
      const [lx, ly] = apply(inv, x, y);
      if (lx < 0 || ly < 0 || lx > info.width || ly > info.height) continue;
      const img = info.transform.i ? this.ws.assets.image(info.transform.i) : null;
      if (img && imageAlphaAt(img, lx, ly) < 24) continue;
      return info.trackIndex;
    }
    return -1;
  }

  private hitHandle(doc: ReanimDocument, x: number, y: number): { kind: 'rotate' } | { kind: 'scale'; corner: number } | null {
    const sel = this.drawn.find((i) => i.trackIndex === doc.ui.track && !i.attached);
    if (!sel || this.ws.playing) return null;
    const [rx, ry] = this.rotateHandle(sel);
    if (Math.hypot(rx - x, ry - y) <= HANDLE + 3) return { kind: 'rotate' };
    const corners: [number, number][] = [
      [0, 0],
      [sel.width, 0],
      [sel.width, sel.height],
      [0, sel.height],
    ];
    for (let i = 0; i < 4; i++) {
      const [cx, cy] = apply(sel.matrix, corners[i][0], corners[i][1]);
      if (Math.abs(cx - x) <= HANDLE + 2 && Math.abs(cy - y) <= HANDLE + 2) return { kind: 'scale', corner: i };
    }
    return null;
  }

  private hitCue(x: number, y: number): number | null {
    for (const c of this.cueScreen) if (Math.hypot(c.x - x, c.y - y) <= 10) return c.uid;
    return null;
  }

  // ------------------------------------------------------------ input

  private localPos(e: MouseEvent): [number, number] {
    const r = this.ovCanvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private bindInput() {
    const ov = this.ovCanvas;
    ov.addEventListener('contextmenu', (e) => e.preventDefault());
    ov.addEventListener('pointerdown', (e) => this.onDown(e));
    ov.addEventListener('pointermove', (e) => this.onMove(e));
    ov.addEventListener('pointerup', (e) => this.onUp(e));
    ov.addEventListener('pointercancel', (e) => this.onUp(e));
    ov.addEventListener('pointerleave', () => {
      if (this.hoverTrack !== -1 || this.sceneStage.hover !== -1) {
        this.hoverTrack = -1;
        this.sceneStage.hover = -1;
        this.invalidate();
      }
    });
    ov.addEventListener('dblclick', (e) => {
      const doc = this.ws.active;
      if (doc?.kind === 'scene') {
        const [x, y] = this.localPos(e);
        this.sceneStage.dblclick(doc, x, y);
      }
    });
    ov.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const doc = this.ws.active;
        if (!doc) return;
        if (e.ctrlKey || !e.shiftKey) {
          const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
          this.setZoom(doc.view.zoom * factor, this.localPos(e));
        } else {
          doc.view.panX -= e.deltaY;
          this.invalidate();
        }
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && document.activeElement === ov) {
        this.spaceDown = true;
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
    this.stage.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes(ASSET_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    this.stage.addEventListener('drop', (e) => {
      const data = e.dataTransfer?.getData(ASSET_MIME);
      if (!data) return;
      e.preventDefault();
      e.stopPropagation();
      this.onAssetDrop(JSON.parse(data), this.localPos(e));
    });
  }

  private onDown(e: PointerEvent) {
    const doc = this.ws.active;
    this.ovCanvas.focus();
    if (!doc) return;
    const [x, y] = this.localPos(e);
    this.ovCanvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || this.spaceDown) {
      this.drag = { kind: 'pan', sx: x, sy: y, px: doc.view.panX, py: doc.view.panY, moved: false, button: e.button, hit: -1 };
      return;
    }
    if (e.button !== 0) return;
    if (doc.kind === 'scene') {
      if (this.sceneStage.down(doc, x, y)) this.drag = { kind: 'scene' };
      else this.drag = { kind: 'pan', sx: x, sy: y, px: doc.view.panX, py: doc.view.panY, moved: false, button: 0, hit: -1 };
      return;
    }
    if (doc.kind === 'particle') {
      const [ox, oy] = apply(this.viewMatrix(doc), doc.ui.x, doc.ui.y);
      if (Math.hypot(ox - x, oy - y) < 14) {
        this.drag = { kind: 'emitter', sx: x, sy: y, ox: doc.ui.x, oy: doc.ui.y };
      } else {
        this.drag = { kind: 'pan', sx: x, sy: y, px: doc.view.panX, py: doc.view.panY, moved: false, button: 0, hit: -1 };
      }
      return;
    }
    if (this.ws.playing) this.ws.pause();
    const cueUid = this.hitCue(x, y);
    if (cueUid !== null) {
      doc.ui.cue = { kind: 'particle', uid: cueUid };
      this.drag = { kind: 'cue', uid: cueUid, sx: x, sy: y, began: false };
      this.ws.emit('change');
      return;
    }
    const handle = this.hitHandle(doc, x, y);
    const frame = doc.ui.frame;
    if (handle) {
      const sel = this.drawn.find((i) => i.trackIndex === doc.ui.track && !i.attached)!;
      const track = doc.state.tracks[doc.ui.track];
      const start = { ...track.transforms[frame] };
      const pivot = apply(transformMatrix(start), sel.width / 2, sel.height / 2);
      doc.checkpoint(handle.kind === 'rotate' ? 'Rotate part' : 'Scale part');
      if (handle.kind === 'rotate') {
        const [wx, wy] = this.toWorld(doc, x, y);
        this.drag = { kind: 'rotate', track: doc.ui.track, frame, start, w: sel.width, h: sel.height, startAngle: Math.atan2(wy - pivot[1], wx - pivot[0]), pivot };
      } else {
        const corners: [number, number][] = [
          [0, 0],
          [sel.width, 0],
          [sel.width, sel.height],
          [0, sel.height],
        ];
        this.drag = {
          kind: 'scale',
          track: doc.ui.track,
          frame,
          start,
          w: sel.width,
          h: sel.height,
          corner: corners[handle.corner],
          inv: invert(transformMatrix(start)) ?? [1, 0, 0, 1, 0, 0],
          pivot,
        };
      }
      return;
    }
    const hit = this.hitTrack(doc, x, y);
    if (hit >= 0) {
      const changed = doc.ui.track !== hit || doc.ui.cue !== null;
      doc.ui.track = hit;
      doc.ui.cue = null;
      const track = doc.state.tracks[hit];
      this.drag = { kind: 'move', sx: x, sy: y, start: { ...track.transforms[frame] }, track: hit, frame, began: false, selectOnly: e.altKey };
      if (changed) this.ws.emit('change');
    } else {
      this.drag = { kind: 'pan', sx: x, sy: y, px: doc.view.panX, py: doc.view.panY, moved: false, button: 0, hit: -1 };
    }
  }

  private onMove(e: PointerEvent) {
    const doc = this.ws.active;
    if (!doc) return;
    const [x, y] = this.localPos(e);
    const drag = this.drag;
    if (!drag) {
      if (doc.kind === 'reanim' && !this.ws.playing) {
        const handle = this.hitHandle(doc, x, y);
        const cue = this.hitCue(x, y);
        const hit = handle || cue !== null ? -1 : this.hitTrack(doc, x, y);
        this.ovCanvas.style.cursor = handle ? (handle.kind === 'rotate' ? 'grab' : 'nwse-resize') : cue !== null || hit >= 0 ? 'move' : 'default';
        if (hit !== this.hoverTrack) {
          this.hoverTrack = hit;
          this.invalidate();
        }
      } else if (doc.kind === 'particle') {
        const [ox, oy] = apply(this.viewMatrix(doc), doc.ui.x, doc.ui.y);
        this.ovCanvas.style.cursor = Math.hypot(ox - x, oy - y) < 14 ? 'move' : 'default';
      } else if (doc.kind === 'scene' && !this.ws.playing) {
        this.ovCanvas.style.cursor = this.sceneStage.cursor(doc, x, y);
      }
      return;
    }
    switch (drag.kind) {
      case 'scene':
        if (doc.kind === 'scene') this.sceneStage.move(doc, x, y, e.shiftKey);
        break;
      case 'pan': {
        const dx = x - drag.sx;
        const dy = y - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) {
          doc.view.panX = drag.px + dx;
          doc.view.panY = drag.py + dy;
          doc.view.fitted = true;
          this.ovCanvas.style.cursor = 'grabbing';
          this.invalidate();
        }
        break;
      }
      case 'emitter': {
        if (doc.kind !== 'particle') break;
        doc.ui.x = drag.ox + (x - drag.sx) / doc.view.zoom;
        doc.ui.y = drag.oy + (y - drag.sy) / doc.view.zoom;
        this.invalidate();
        break;
      }
      case 'move': {
        if (doc.kind !== 'reanim' || drag.selectOnly) break;
        let dx = (x - drag.sx) / doc.view.zoom;
        let dy = (y - drag.sy) / doc.view.zoom;
        if (!drag.began) {
          if (Math.abs(x - drag.sx) + Math.abs(y - drag.sy) < 3) break;
          drag.began = true;
          doc.checkpoint('Move part');
        }
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        doc.setFields(drag.track, drag.frame, { x: round2(drag.start.x + dx), y: round2(drag.start.y + dy) });
        this.ws.emit('change');
        break;
      }
      case 'rotate': {
        if (doc.kind !== 'reanim') break;
        const [wx, wy] = this.toWorld(doc, x, y);
        const angle = Math.atan2(wy - drag.pivot[1], wx - drag.pivot[0]);
        let delta = (angle - drag.startAngle) / DEG;
        let kx = drag.start.kx + delta;
        if (e.shiftKey) {
          kx = Math.round(kx / 15) * 15;
          delta = kx - drag.start.kx;
        }
        const t = { ...drag.start, kx: round2(drag.start.kx + delta), ky: round2(drag.start.ky + delta) };
        keepPivot(t, drag.w, drag.h, drag.pivot);
        doc.setFields(drag.track, drag.frame, { x: t.x, y: t.y, kx: t.kx, ky: t.ky });
        this.ws.emit('change');
        break;
      }
      case 'scale': {
        if (doc.kind !== 'reanim') break;
        const [wx, wy] = this.toWorld(doc, x, y);
        const [lx, ly] = apply(drag.inv, wx, wy);
        const cx = drag.w / 2;
        const cy = drag.h / 2;
        let fx = (lx - cx) / (drag.corner[0] - cx || 1);
        let fy = (ly - cy) / (drag.corner[1] - cy || 1);
        if (e.shiftKey) {
          const u = (Math.abs(fx) + Math.abs(fy)) / 2;
          fx = Math.sign(fx || 1) * u;
          fy = Math.sign(fy || 1) * u;
        }
        const t = { ...drag.start, sx: round3(drag.start.sx * fx), sy: round3(drag.start.sy * fy) };
        keepPivot(t, drag.w, drag.h, drag.pivot);
        doc.setFields(drag.track, drag.frame, { x: t.x, y: t.y, sx: t.sx, sy: t.sy });
        this.ws.emit('change');
        break;
      }
      case 'cue': {
        if (doc.kind !== 'reanim') break;
        if (!drag.began) {
          if (Math.abs(x - drag.sx) + Math.abs(y - drag.sy) < 3) break;
          drag.began = true;
          doc.checkpoint('Move particle cue');
        }
        const cue = doc.state.particleCues.find((c) => c.uid === drag.uid);
        if (!cue) break;
        const [wx, wy] = this.toWorld(doc, x, y);
        let lx = wx;
        let ly = wy;
        const ti = cue.track ? doc.findTrack(cue.track) : -1;
        if (ti >= 0) {
          const m = transformMatrix(interpolateTransform(doc.state.tracks[ti].transforms, this.ws.frameTime(doc)));
          const inv = invert(m);
          if (inv) [lx, ly] = apply(inv, wx, wy);
        }
        doc.updateParticleCue(drag.uid, { x: round2(lx), y: round2(ly) }, '');
        this.ws.invalidatePreviews();
        this.ws.emit('change');
        break;
      }
    }
  }

  private onUp(e: PointerEvent) {
    const drag = this.drag;
    this.drag = null;
    if (this.ovCanvas.hasPointerCapture(e.pointerId)) this.ovCanvas.releasePointerCapture(e.pointerId);
    this.ovCanvas.style.cursor = 'default';
    const doc = this.ws.active;
    if (!drag || !doc) return;
    const [x, y] = this.localPos(e);
    if (drag.kind === 'scene') this.sceneStage.up();
    if (drag.kind === 'pan' && !drag.moved) {
      if (drag.button === 2) this.contextMenu(e, x, y);
      else if (drag.button === 0 && doc.kind === 'reanim' && (doc.ui.track !== -1 || doc.ui.cue)) {
        doc.ui.track = -1;
        doc.ui.cue = null;
        this.ws.emit('change');
      } else if (drag.button === 0 && doc.kind === 'scene' && (doc.ui.layer !== -1 || doc.ui.cue)) {
        doc.ui.layer = -1;
        doc.ui.cue = null;
        this.ws.emit('change');
      }
    }
    if (drag.kind === 'emitter') this.ws.emit('change');
  }

  private contextMenu(e: MouseEvent, x: number, y: number) {
    const doc = this.ws.active;
    const items: MenuItem[] = [];
    if (doc?.kind === 'reanim') {
      const hit = this.hitTrack(doc, x, y);
      if (hit >= 0) {
        doc.ui.track = hit;
        this.ws.emit('change');
        items.push(...this.trackMenu(doc, hit), { separator: true });
      }
    } else if (doc?.kind === 'scene') {
      const hit = this.sceneStage.hitLayer(doc, x, y);
      if (hit >= 0) {
        doc.ui.layer = hit;
        doc.ui.cue = null;
        this.ws.emit('change');
        items.push(...this.sceneStage.layerMenu(doc, hit), { separator: true });
      }
    }
    items.push(
      { label: 'Fit to view', shortcut: 'F', action: () => this.fit() },
      { label: 'Zoom 100%', shortcut: '0', action: () => this.setZoom(1) },
      { separator: true },
      {
        label: 'Background',
        submenu: (['dark', 'light', 'checker', 'lawn', 'night'] as const).map((b) => ({
          label: b[0].toUpperCase() + b.slice(1),
          checked: this.ws.settings.background === b,
          action: () => {
            this.ws.settings.background = b;
            this.ws.saveSettings();
          },
        })),
      },
    );
    showMenu(items, e.clientX, e.clientY);
  }

  /** Context-menu items for a track (shared with the timeline). */
  trackMenu: (doc: ReanimDocument, track: number) => MenuItem[] = () => [];

  /** Overridden by the app: handle assets dropped from the browser. */
  onAssetDrop(asset: { kind: string; path: string }, pos: [number, number]): void {
    const scene = this.ws.scene;
    if (scene) {
      const [sx, sy] = this.toWorld(scene, pos[0], pos[1]);
      void this.sceneStage.addAsset(scene, asset, sx, sy);
      return;
    }
    const doc = this.ws.reanim;
    if (!doc) return;
    const [wx, wy] = this.toWorld(doc, pos[0], pos[1]);
    this.dropHandler(doc, asset, wx, wy, this.hitTrack(doc, pos[0], pos[1]));
  }

  dropHandler: (doc: ReanimDocument, asset: { kind: string; path: string }, x: number, y: number, trackUnder: number) => void = () => {};

  /** Stage-local point for a client-space point, or null if outside the stage. */
  stagePoint(clientX: number, clientY: number): [number, number] | null {
    const r = this.stage.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    return [clientX - r.left, clientY - r.top];
  }

  worldToScreen(doc: EditorDocument, x: number, y: number): [number, number] {
    return apply(this.viewMatrix(doc), x, y);
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Adjust x/y so the image center stays at `pivot` after changing rotation/scale. */
function keepPivot(t: ReanimTransform, w: number, h: number, pivot: [number, number]) {
  const m = transformMatrix({ ...t, x: 0, y: 0 });
  const [cx, cy] = apply(m, w / 2, h / 2);
  t.x = round2(pivot[0] - cx);
  t.y = round2(pivot[1] - cy);
}

