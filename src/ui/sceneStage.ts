/**
 * Scene editing on the viewport: draws the stage and layers, and handles
 * selecting, moving, rotating and scaling instances (auto-keying the current
 * frame, like Animate's auto keyframe mode).
 */

import { imageAlphaAt } from '../engine/assets';
import { apply, DEG, invert, mul, type Mat } from '../engine/math';
import type { Renderer } from '../engine/renderer';
import { animRangeOf, interpolateTransform, transformMatrix } from '../engine/reanimRuntime';
import { drawScene, type DrawnLayer, type SceneResolver } from '../engine/sceneRuntime';
import { fontSizeHint } from '../engine/text';
import { basename, stripExt } from '../engine/vfs';
import { getAnimRanges, type ReanimTransform } from '../formats/reanim';
import { cameraFrameMatrix, cameraMatrix, evalCamera, evalLayer, poseMatrix, type LayerKey, type SceneDocument } from '../editor/sceneDoc';
import type { Workspace } from '../editor/workspace';
import { defaultFont } from './pickers';
import { promptText, type MenuItem } from './widgets';

const HANDLE = 5;
const ROT_DIST = 26;

type Drag =
  /** Moves every selected layer (`items`) by the pointer's world-space movement. */
  | { kind: 'move'; layer: number; frame: number; sx: number; sy: number; items: { layer: number; x0: number; y0: number }[]; inv: Mat | null; began: boolean }
  /** A selection rectangle in screen space; `base` is the selection it adds to (Shift/Ctrl). */
  | { kind: 'marquee'; layer: number; x0: number; y0: number; x1: number; y1: number; base: number[] | null }
  | { kind: 'rotate'; layer: number; frame: number; pivot: [number, number]; startAngle: number; rot0: number; local: [number, number]; sx: number; sy: number; began: boolean }
  | {
      kind: 'scale';
      layer: number;
      frame: number;
      pivot: [number, number];
      local: [number, number];
      corner: [number, number];
      inv: Mat;
      sx0: number;
      sy0: number;
      sx: number;
      sy: number;
      began: boolean;
    };

export interface StageHost {
  view(doc: SceneDocument): Mat;
  toStage(doc: SceneDocument, x: number, y: number): [number, number];
  invalidate(): void;
}

export class SceneStage {
  drawn: DrawnLayer[] = [];
  hover = -1;
  private drag: Drag | null = null;

  constructor(
    private ws: Workspace,
    private host: StageHost,
  ) {}

  resolver(doc: SceneDocument): SceneResolver {
    const ws = this.ws;
    return {
      assets: ws.assets,
      prefab: (path) => ws.prefab(path),
      particles: (layer, pose, frame) => ws.sceneParticles(doc, layer, pose, frame),
      gameVisibility: ws.settings.gameVisibility,
    };
  }

  /** Fit the whole stage into the viewport. */
  fit(doc: SceneDocument, cssW: number, cssH: number): void {
    const pad = 40;
    const s = doc.state;
    const zoom = Math.max(0.05, Math.min((cssW - pad * 2) / s.width, (cssH - pad * 2) / s.height, 4));
    doc.view.zoom = zoom;
    doc.view.panX = -(s.width / 2) * zoom;
    doc.view.panY = -(s.height / 2) * zoom;
    doc.view.fitted = true;
  }

  render(doc: SceneDocument, r: Renderer): void {
    const view = this.host.view(doc);
    const frame = this.ws.sceneFrame(doc);
    const hidden = (l: { uid: number }) => doc.ui.hidden.has(l.uid);
    const res = this.resolver(doc);
    if (this.ws.settings.onion && !this.ws.playing) {
      // Onion skin: neighbouring frames, faded, without the stage background.
      for (const g of [frame - 2, frame + 2]) {
        if (g < 0 || g >= doc.state.length) continue;
        drawScene(r, { ...res, particles: undefined }, doc.state, g, view, { hidden, alpha: 0.25, drawBackground: false, camera: doc.ui.cameraView });
      }
    }
    this.drawn = [];
    drawScene(r, res, doc.state, frame, view, { hidden, collect: this.drawn, camera: doc.ui.cameraView, cameraFrame: !doc.ui.cameraView });
  }

  /** Whether the stage currently shows the world through a camera. */
  throughCamera(doc: SceneDocument, frame = this.ws.sceneFrame(doc)): boolean {
    return doc.ui.cameraView && !!evalCamera(doc.state, frame);
  }

  /** Screen matrix for world coordinates: the stage view, through the camera when looking through it. */
  private worldView(doc: SceneDocument, frame = this.ws.sceneFrame(doc)): Mat {
    const view = this.host.view(doc);
    const cam = doc.ui.cameraView ? evalCamera(doc.state, frame) : null;
    return cam ? mul(view, cameraMatrix(doc.state, cam)) : view;
  }

  /** World coordinates of a screen point. */
  private toWorld(doc: SceneDocument, x: number, y: number, frame?: number): [number, number] {
    const inv = invert(this.worldView(doc, frame));
    return inv ? apply(inv, x, y) : this.host.toStage(doc, x, y);
  }

  /** World coordinates of a stage point (where something at that spot of the picture really is). */
  stageToWorld(doc: SceneDocument, x: number, y: number): [number, number] {
    const cam = doc.ui.cameraView ? evalCamera(doc.state, this.ws.sceneFrame(doc)) : null;
    const inv = cam ? invert(cameraMatrix(doc.state, cam)) : null;
    return inv ? apply(inv, x, y) : [x, y];
  }

  private corners(d: DrawnLayer): [number, number][] | null {
    if (!d.local) return null;
    const [x0, y0, x1, y1] = d.local;
    return [apply(d.matrix, x0, y0), apply(d.matrix, x1, y0), apply(d.matrix, x1, y1), apply(d.matrix, x0, y1)];
  }

  /** The camera frame's label sits just above its top-left corner. */
  private inCameraLabel(pts: [number, number][], x: number, y: number): boolean {
    const [lx, ly] = pts[0];
    return x >= lx && x <= lx + 90 && y >= ly - 20 && y <= ly;
  }

  private rotateHandle(d: DrawnLayer): [number, number] | null {
    if (!d.local) return null;
    const [x0, y0, x1, y1] = d.local;
    const top = apply(d.matrix, (x0 + x1) / 2, y0);
    const c = apply(d.matrix, (x0 + x1) / 2, (y0 + y1) / 2);
    let dx = top[0] - c[0];
    let dy = top[1] - c[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) {
      dx = 0;
      dy = -1;
    } else {
      dx /= len;
      dy /= len;
    }
    return [top[0] + dx * ROT_DIST, top[1] + dy * ROT_DIST];
  }

  overlay(ctx: CanvasRenderingContext2D, doc: SceneDocument, cssW: number, cssH: number): void {
    const view = this.host.view(doc);
    const s = doc.state;
    const [sx0, sy0] = apply(view, 0, 0);
    const [sx1, sy1] = apply(view, s.width, s.height);
    // Dim the pasteboard around the stage (nearly hide it through the camera: exports never show it).
    ctx.fillStyle = this.throughCamera(doc) ? 'rgba(10, 11, 14, 0.82)' : 'rgba(10, 11, 14, 0.45)';
    ctx.fillRect(0, 0, cssW, sy0);
    ctx.fillRect(0, sy1, cssW, cssH - sy1);
    ctx.fillRect(0, sy0, sx0, sy1 - sy0);
    ctx.fillRect(sx1, sy0, cssW - sx1, sy1 - sy0);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(sx0) + 0.5, Math.round(sy0) + 0.5, Math.round(sx1 - sx0), Math.round(sy1 - sy0));

    const outline = (pts: [number, number][], color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    };
    for (const d of this.drawn) {
      const pts = this.corners(d);
      if (!pts) continue;
      if (doc.state.layers[d.layerIndex]?.kind === 'camera') {
        // The camera's frame (world view): what the camera sees, always shown.
        ctx.save();
        ctx.setLineDash([8, 5]);
        outline(pts, d.layerIndex === this.hover || d.layerIndex === doc.ui.layer ? '#d7b8ff' : 'rgba(190, 150, 255, 0.85)', 2);
        ctx.restore();
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(40, 20, 70, 0.75)';
        ctx.fillRect(pts[0][0], pts[0][1] - 19, 88, 18);
        ctx.fillStyle = '#e4d2ff';
        ctx.fillText('🎥 Camera', pts[0][0] + 6, pts[0][1] - 6);
        continue;
      }
      if (d.layerIndex === doc.ui.layer) continue;
      if (doc.isSelected(d.layerIndex)) outline(pts, '#ffd34d', 1);
      else if (d.layerIndex === this.hover) outline(pts, 'rgba(120, 200, 255, 0.9)', 1);
      else if (this.ws.settings.showBounds) outline(pts, 'rgba(120, 200, 255, 0.16)', 1);
    }
    const drag = this.drag;
    if (drag?.kind === 'marquee') {
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(255, 211, 77, 0.9)';
      ctx.fillStyle = 'rgba(255, 211, 77, 0.08)';
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      ctx.fillRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(Math.abs(drag.x1 - drag.x0)), Math.round(Math.abs(drag.y1 - drag.y0)));
      ctx.restore();
    }
    if (this.throughCamera(doc)) {
      // Looking through the camera: say so, so moving things is not confused with moving the world.
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(40, 20, 70, 0.7)';
      ctx.fillRect(sx0 + 6, sy0 + 6, 132, 18);
      ctx.fillStyle = '#e4d2ff';
      ctx.fillText('🎥 Camera view  (C)', sx0 + 12, sy0 + 19);
    }
    const sel = this.drawn.find((d) => d.layerIndex === doc.ui.layer);
    if (!sel || this.ws.playing) return;
    const pts = this.corners(sel);
    if (!pts) return;
    if (doc.selectedLayers().length > 1) {
      // Several layers: they move together; handles are for one layer at a time.
      outline(pts, '#ffd34d', 2);
      return;
    }
    if (doc.isLocked(sel.layerIndex)) {
      // Locked: show what is selected, but offer no handles.
      outline(pts, 'rgba(160, 160, 160, 0.8)', 1);
      return;
    }
    outline(pts, '#ffd34d', 1.5);
    const rot = this.rotateHandle(sel)!;
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
    // Instance origin (the prefab's 0,0).
    const [ox, oy] = apply(sel.matrix, 0, 0);
    ctx.strokeStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.moveTo(ox - 6, oy);
    ctx.lineTo(ox + 6, oy);
    ctx.moveTo(ox, oy - 6);
    ctx.lineTo(ox, oy + 6);
    ctx.stroke();
    const layer = doc.state.layers[sel.layerIndex];
    const pose = layer ? evalLayer(layer, this.ws.sceneFrame(doc), doc.state) : null;
    if (layer && pose) {
      const label =
        layer.kind === 'camera'
          ? `Camera  x ${pose.x.toFixed(0)} y ${pose.y.toFixed(0)}  rot ${pose.rotation.toFixed(1)}°  zoom ${(1 / Math.max(1e-3, Math.abs(pose.scaleX))).toFixed(2)}×`
          : `${layer.name}  x ${pose.x.toFixed(0)} y ${pose.y.toFixed(0)}  rot ${pose.rotation.toFixed(1)}°  ${pose.scaleX.toFixed(2)}×`;
      ctx.font = '11px ui-monospace, monospace';
      const w = ctx.measureText(label).width + 8;
      const lx = Math.min(...pts.map((p) => p[0]));
      const ly = Math.max(...pts.map((p) => p[1])) + 8;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(lx, ly, w, 16);
      ctx.fillStyle = '#ffe9a8';
      ctx.fillText(label, lx + 4, ly + 12);
    }
  }

  // ------------------------------------------------------------ hit testing

  hitLayer(doc: SceneDocument, x: number, y: number): number {
    for (let k = this.drawn.length - 1; k >= 0; k--) {
      const d = this.drawn[k];
      const layer = doc.state.layers[d.layerIndex];
      if (!layer || doc.ui.locked.has(layer.uid)) continue;
      if (layer.kind === 'camera') {
        // The camera frame is picked up by its border or its label, not its inside.
        const pts = this.corners(d);
        if (pts && (nearOutline(pts, x, y, 7) || this.inCameraLabel(pts, x, y))) return d.layerIndex;
        continue;
      }
      if (layer.kind === 'particle') {
        const [ox, oy] = apply(d.matrix, 0, 0);
        if (Math.hypot(ox - x, oy - y) <= 16) return d.layerIndex;
        continue;
      }
      for (let p = d.parts.length - 1; p >= 0; p--) {
        const part = d.parts[p];
        const inv = invert(part.matrix);
        if (!inv) continue;
        const [lx, ly] = apply(inv, x, y);
        if (lx < 0 || ly < 0 || lx > part.width || ly > part.height) continue;
        const id = layer.kind === 'image' ? layer.source : part.transform.i;
        const img = id ? this.ws.assets.image(id) : null;
        if (img && imageAlphaAt(img, lx, ly) < 24) continue;
        return d.layerIndex;
      }
    }
    return -1;
  }

  private hitHandle(doc: SceneDocument, x: number, y: number): { kind: 'rotate' } | { kind: 'scale'; corner: number } | null {
    const sel = this.drawn.find((d) => d.layerIndex === doc.ui.layer);
    if (!sel || this.ws.playing || doc.ui.extra.size) return null;
    const layer = doc.state.layers[sel.layerIndex];
    if (!layer || doc.ui.locked.has(layer.uid)) return null;
    const rot = this.rotateHandle(sel);
    if (rot && Math.hypot(rot[0] - x, rot[1] - y) <= HANDLE + 3) return { kind: 'rotate' };
    const pts = this.corners(sel);
    if (pts) {
      for (let i = 0; i < 4; i++) if (Math.abs(pts[i][0] - x) <= HANDLE + 2 && Math.abs(pts[i][1] - y) <= HANDLE + 2) return { kind: 'scale', corner: i };
    }
    return null;
  }

  cursor(doc: SceneDocument, x: number, y: number): string {
    const h = this.hitHandle(doc, x, y);
    if (h) return h.kind === 'rotate' ? 'grab' : 'nwse-resize';
    const hit = this.hitLayer(doc, x, y);
    if (hit !== this.hover) {
      this.hover = hit;
      this.host.invalidate();
    }
    return hit >= 0 ? 'move' : 'default';
  }

  // ------------------------------------------------------------ dragging

  /**
   * Pointer down on the stage: handles transform the selected layer; a click selects
   * (Shift or Ctrl/⌘ adds or removes) and drags the selection; empty space starts a marquee.
   */
  down(doc: SceneDocument, x: number, y: number, mods: { shift?: boolean; ctrl?: boolean } = {}): boolean {
    if (this.ws.playing) this.ws.pause();
    const frame = doc.ui.frame;
    const additive = !!(mods.shift || mods.ctrl);
    const handle = additive ? null : this.hitHandle(doc, x, y);
    if (handle) {
      const sel = this.drawn.find((d) => d.layerIndex === doc.ui.layer)!;
      const layer = doc.state.layers[sel.layerIndex];
      const pose = evalLayer(layer, frame)!;
      const [x0, y0, x1, y1] = sel.local!;
      const local: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
      // A camera's frame is where it really looks (after following and shaking).
      const cam = layer.kind === 'camera' ? evalCamera(doc.state, frame) : null;
      const m0 = cam ? cameraFrameMatrix(cam) : poseMatrix(pose);
      const pivot = apply(m0, local[0], local[1]);
      // The undo step and the key are made on the first real movement, so a click changes nothing.
      if (handle.kind === 'rotate') {
        const [wx, wy] = this.toWorld(doc, x, y);
        this.drag = { kind: 'rotate', layer: sel.layerIndex, frame, pivot, startAngle: Math.atan2(wy - pivot[1], wx - pivot[0]), rot0: pose.rotation, local, sx: x, sy: y, began: false };
      } else {
        const cornerLocal: [number, number][] = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ];
        this.drag = {
          kind: 'scale',
          layer: sel.layerIndex,
          frame,
          pivot,
          local,
          corner: cornerLocal[handle.corner],
          inv: invert(m0) ?? [1, 0, 0, 1, 0, 0],
          sx0: pose.scaleX,
          sy0: pose.scaleY,
          sx: x,
          sy: y,
          began: false,
        };
      }
      return true;
    }
    const hit = this.hitLayer(doc, x, y);
    if (hit < 0) {
      this.drag = { kind: 'marquee', layer: doc.ui.layer, x0: x, y0: y, x1: x, y1: y, base: additive ? doc.selectedLayers() : null };
      return true;
    }
    if (additive) {
      doc.toggleSelected(hit);
      this.ws.emit('change');
      if (!doc.isSelected(hit)) return true;
    } else if (doc.isSelected(hit)) {
      // Part of the selection: it becomes the main layer and the whole selection moves.
      if (doc.ui.layer !== hit || doc.ui.cue) {
        doc.toggleSelected(hit, true);
        this.ws.emit('change');
      }
    } else {
      doc.selectOnly(hit);
      this.ws.emit('change');
    }
    const items = doc
      .selectedLayers()
      .filter((i) => !doc.isLocked(i))
      .flatMap((i) => {
        const pose = evalLayer(doc.state.layers[i], frame, doc.state);
        return pose ? [{ layer: i, x0: pose.x, y0: pose.y }] : [];
      });
    if (!items.some((it) => it.layer === hit)) return true;
    // Screen -> world as it is now: moving the camera (or what it follows) must not feed back into the drag.
    this.drag = { kind: 'move', layer: hit, frame, sx: x, sy: y, items, inv: invert(this.worldView(doc, frame)), began: false };
    return true;
  }

  /** Layers whose outline touches a screen rectangle (the camera only when it is wholly inside). */
  private inRect(doc: SceneDocument, x0: number, y0: number, x1: number, y1: number): number[] {
    const out: number[] = [];
    for (const d of this.drawn) {
      const layer = doc.state.layers[d.layerIndex];
      const pts = this.corners(d);
      if (!layer || !pts || doc.ui.locked.has(layer.uid)) continue;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const [bx0, by0, bx1, by1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const inside = layer.kind === 'camera' ? bx0 >= x0 && bx1 <= x1 && by0 >= y0 && by1 <= y1 : bx1 >= x0 && bx0 <= x1 && by1 >= y0 && by0 <= y1;
      if (inside && !out.includes(d.layerIndex)) out.push(d.layerIndex);
    }
    return out;
  }

  private marquee(doc: SceneDocument, drag: Extract<Drag, { kind: 'marquee' }>) {
    const hits = this.inRect(doc, Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1));
    const want = new Set([...(drag.base ?? []), ...hits]);
    // Keep the main layer if it is still selected; otherwise the topmost layer caught.
    const main = want.has(drag.layer) ? drag.layer : [...want].sort((a, b) => b - a)[0] ?? -1;
    doc.selectOnly(main, !!drag.base);
    for (const i of want) if (i !== main) doc.ui.extra.add(doc.state.layers[i].uid);
  }

  move(doc: SceneDocument, x: number, y: number, shift: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    if (drag.kind === 'marquee') {
      drag.x1 = x;
      drag.y1 = y;
      if (Math.abs(x - drag.x0) + Math.abs(y - drag.y0) >= 3) this.marquee(doc, drag);
      this.ws.emit('change');
      return;
    }
    const layer = doc.state.layers[drag.layer];
    if (!layer) return;
    if (drag.kind !== 'move' && !drag.began) {
      if (Math.abs(x - drag.sx) + Math.abs(y - drag.sy) < 3) return;
      drag.began = true;
      const what = layer.kind === 'camera' ? 'camera' : 'instance';
      doc.checkpoint(drag.kind === 'rotate' ? `Rotate ${what}` : layer.kind === 'camera' ? 'Zoom camera' : 'Scale instance');
      doc.touch(() => doc.ensureKey(drag.layer, drag.frame));
    }
    if (drag.kind === 'move') {
      // World-space movement (through the camera's zoom and turn when looking through it).
      const [ax, ay] = drag.inv ? apply(drag.inv, drag.sx, drag.sy) : this.toWorld(doc, drag.sx, drag.sy, drag.frame);
      const [bx, by] = drag.inv ? apply(drag.inv, x, y) : this.toWorld(doc, x, y, drag.frame);
      let dx = bx - ax;
      let dy = by - ay;
      if (!drag.began) {
        if (Math.abs(x - drag.sx) + Math.abs(y - drag.sy) < 3) return;
        drag.began = true;
        doc.checkpoint(drag.items.length > 1 ? 'Move layers' : layer.kind === 'camera' ? 'Move camera' : 'Move instance');
      }
      if (shift) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      for (const it of drag.items) doc.setKey(it.layer, drag.frame, { x: Math.round(it.x0 + dx), y: Math.round(it.y0 + dy) });
    } else if (drag.kind === 'rotate') {
      const [wx, wy] = this.toWorld(doc, x, y, drag.frame);
      let rot = drag.rot0 + (Math.atan2(wy - drag.pivot[1], wx - drag.pivot[0]) - drag.startAngle) / DEG;
      if (shift) rot = Math.round(rot / 15) * 15;
      const pose = evalLayer(layer, drag.frame)!;
      // The camera turns about its own centre, so only its rotation changes.
      const patch = layer.kind === 'camera' ? {} : this.keepPivot({ ...pose, rotation: rot }, drag.local, drag.pivot);
      doc.setKey(drag.layer, drag.frame, { ...patch, rotation: Math.round(rot * 100) / 100 });
    } else {
      const [wx, wy] = this.toWorld(doc, x, y, drag.frame);
      const [lx, ly] = apply(drag.inv, wx, wy);
      let fx = (lx - drag.local[0]) / (drag.corner[0] - drag.local[0] || 1);
      let fy = (ly - drag.local[1]) / (drag.corner[1] - drag.local[1] || 1);
      if (layer.kind === 'camera') {
        // Resizing the camera's frame zooms: it keeps the stage's shape and its centre.
        const u = Math.max(0.02, (Math.abs(fx) + Math.abs(fy)) / 2);
        const size = Math.round(drag.sx0 * u * 1000) / 1000;
        doc.setKey(drag.layer, drag.frame, { scaleX: size, scaleY: size });
        this.ws.emit('change');
        return;
      }
      if (shift) {
        const u = (Math.abs(fx) + Math.abs(fy)) / 2;
        fx = Math.sign(fx || 1) * u;
        fy = Math.sign(fy || 1) * u;
      }
      const scaleX = Math.round(drag.sx0 * fx * 1000) / 1000;
      const scaleY = Math.round(drag.sy0 * fy * 1000) / 1000;
      const pose = evalLayer(layer, drag.frame)!;
      const patch = this.keepPivot({ ...pose, scaleX, scaleY }, drag.local, drag.pivot);
      doc.setKey(drag.layer, drag.frame, { ...patch, scaleX, scaleY });
    }
    this.ws.emit('change');
  }

  /** Flip a layer at the current frame around its visible centre, like Animate (not around the prefab origin). */
  flip(doc: SceneDocument, li: number, flipX: boolean): void {
    const layer = doc.state.layers[li];
    const pose = layer && evalLayer(layer, doc.ui.frame);
    if (!pose || pose.flipX === flipX) return;
    const d = this.drawn.find((x) => x.layerIndex === li);
    let patch: Partial<LayerKey> = { flipX };
    if (d?.local) {
      const local: [number, number] = [(d.local[0] + d.local[2]) / 2, (d.local[1] + d.local[3]) / 2];
      const pivot = apply(poseMatrix(pose), local[0], local[1]);
      patch = { ...this.keepPivot({ ...pose, flipX }, local, pivot), flipX };
    }
    doc.setKey(li, doc.ui.frame, patch, 'Flip instance');
  }

  /** x/y that keep the local point `local` at stage position `pivot`. */
  private keepPivot(p: { rotation: number; scaleX: number; scaleY: number; flipX: boolean }, local: [number, number], pivot: [number, number]): Pick<LayerKey, 'x' | 'y'> {
    const m = poseMatrix({ ...p, x: 0, y: 0 });
    const [cx, cy] = apply(m, local[0], local[1]);
    return { x: Math.round((pivot[0] - cx) * 100) / 100, y: Math.round((pivot[1] - cy) * 100) / 100 };
  }

  up(): boolean {
    const drag = this.drag;
    this.drag = null;
    const doc = this.ws.scene;
    if (drag?.kind === 'marquee' && doc && Math.abs(drag.x1 - drag.x0) + Math.abs(drag.y1 - drag.y0) < 3 && !drag.base) {
      // A click on empty space selects nothing.
      doc.selectOnly(-1);
    }
    if (drag) this.ws.emit('change');
    return !!drag;
  }

  /** Double-click: edit the prefab of the instance under the pointer or a text layer's words, or look through the camera. */
  dblclick(doc: SceneDocument, x: number, y: number): void {
    const hit = this.hitLayer(doc, x, y);
    const layer = doc.state.layers[hit];
    if (!layer) return;
    if (layer.kind === 'text') return void this.editText(doc, hit);
    if (layer.kind === 'camera') {
      // Double-clicking the camera's frame looks through it.
      doc.ui.cameraView = true;
      this.ws.emit('change');
      return;
    }
    if (layer.kind !== 'image') void this.ws.editPrefab(layer.source, doc, layer);
  }

  /** Duplicate the selected layers (not the camera); the copies become the selection. */
  duplicateSelection(doc: SceneDocument): void {
    const copies = doc.duplicateLayers(doc.selectedLayers());
    if (!copies.length) return;
    doc.selectOnly(-1);
    for (const i of copies) doc.toggleSelected(i, true);
  }

  nudge(doc: SceneDocument, dx: number, dy: number): void {
    const sel = doc.selectedLayers();
    if (!sel.length) return;
    const free = sel.filter((i) => !doc.isLocked(i));
    if (!free.length) {
      this.ws.status(sel.length > 1 ? 'The selected layers are locked.' : `Layer "${doc.state.layers[sel[0]].name}" is locked.`);
      return;
    }
    const patches = free.flatMap((i) => {
      const pose = evalLayer(doc.state.layers[i], doc.ui.frame, doc.state);
      return pose ? [{ layer: i, patch: { x: pose.x + dx, y: pose.y + dy } }] : [];
    });
    doc.setKeys(doc.ui.frame, patches, patches.length > 1 ? 'Nudge layers' : 'Nudge instance');
    this.ws.emit('change');
  }

  /** Change a text layer's words from the current frame on (making a key there). */
  async editText(doc: SceneDocument, li: number): Promise<void> {
    const layer = doc.state.layers[li];
    const pose = layer && evalLayer(layer, doc.ui.frame);
    if (!layer || !pose) return;
    if (doc.isLocked(li)) return void this.ws.status(`Layer "${layer.name}" is locked.`);
    const text = await promptText('Edit text', `Text from frame ${doc.ui.frame}`, pose.key.text);
    if (text === null || text === pose.key.text) return;
    // (Empty words keep the layer: it shows as a box in the editor, to type into again.)
    doc.setKey(li, doc.ui.frame, { text }, 'Change text');
    this.ws.emit('change');
  }

  /** Add a text layer centred near (x, y) on the stage. */
  addText(doc: SceneDocument, text: string, x: number, y: number): void {
    text = text.trim();
    if (!text) return void this.ws.status('Type some words to add text.');
    const font = defaultFont(this.ws);
    const size = fontSizeHint(font);
    // The text origin is its baseline's left end; centre the words roughly on the point.
    const key = { x: Math.round(x - text.length * size * 0.28), y: Math.round(y + size * 0.35), text };
    doc.selectOnly(doc.addLayer('text', font, text.length > 16 ? text.slice(0, 15) + '…' : text, key, doc.ui.frame));
    doc.ui.cue = null;
    this.ws.emit('change');
    this.ws.status(`Added text at frame ${doc.ui.frame}. Change its words, font and colour in the inspector; new keys can change the words.`);
  }

  // ------------------------------------------------------------ adding instances

  /** Create a layer for an asset dropped at stage position (x, y). */
  async addAsset(doc: SceneDocument, asset: { kind: string; path: string }, x: number, y: number): Promise<void> {
    const ws = this.ws;
    const frame = doc.ui.frame;
    const name = stripExt(stripExt(basename(asset.path)));
    if (asset.kind === 'reanim') {
      const prefab = ws.prefab(asset.path) ?? (await ws.assets.loadReanimFile(asset.path).catch(() => null));
      if (!prefab) {
        ws.status(`Could not load ${asset.path}`, 'error');
        return;
      }
      const ranges = getAnimRanges(prefab.tracks);
      const anim = (ranges.find((r) => /idle/i.test(r.name)) ?? ranges[0])?.name ?? '';
      // Centre the instance's first pose on the drop point.
      const range = animRangeOf({ fps: prefab.fps, tracks: prefab.tracks as never }, anim);
      const box = await this.poseBounds(prefab.tracks, range.start);
      const cx = box ? (box[0] + box[2]) / 2 : 40;
      const cy = box ? (box[1] + box[3]) / 2 : 50;
      doc.selectOnly(doc.addLayer('reanim', asset.path, name, { x: Math.round(x - cx), y: Math.round(y - cy), anim }, frame));
    } else if (asset.kind === 'particle') {
      doc.selectOnly(doc.addLayer('particle', asset.path, name, { x: Math.round(x), y: Math.round(y) }, frame));
    } else if (asset.kind === 'image') {
      const id = ws.assets.imageIdForPath(asset.path);
      const img = await ws.assets.loadImage(id);
      doc.selectOnly(doc.addLayer('image', id, name, { x: Math.round(x - (img?.celWidth ?? 0) / 2), y: Math.round(y - (img?.celHeight ?? 0) / 2) }, frame));
    } else if (asset.kind === 'sound') {
      const cue = doc.addSoundCue(frame, asset.path);
      doc.ui.cue = { kind: 'sound', uid: cue.uid };
    } else {
      return;
    }
    if (asset.kind !== 'sound') doc.ui.cue = null;
    ws.emit('change');
    ws.status(asset.kind === 'sound' ? `Added sound cue at frame ${frame}.` : `Added "${name}" to ${doc.name} at frame ${frame}.`);
  }

  private async poseBounds(tracks: { name: string; transforms: ReanimTransform[] }[], frame: number): Promise<[number, number, number, number] | null> {
    let box: [number, number, number, number] | null = null;
    for (const t of tracks) {
      if (!t.transforms.length) continue;
      const tr = interpolateTransform(t.transforms, { before: frame, after: frame, fraction: 0 });
      if (Math.round(tr.f) < 0 || !tr.i) continue;
      const img = await this.ws.assets.loadImage(tr.i);
      if (!img) continue;
      const m = transformMatrix(tr);
      for (const [px, py] of [
        [0, 0],
        [img.celWidth, 0],
        [0, img.celHeight],
        [img.celWidth, img.celHeight],
      ]) {
        const [sx, sy] = apply(m, px, py);
        box = box ? [Math.min(box[0], sx), Math.min(box[1], sy), Math.max(box[2], sx), Math.max(box[3], sy)] : [sx, sy, sx, sy];
      }
    }
    return box;
  }

  layerMenu(doc: SceneDocument, li: number): MenuItem[] {
    const ws = this.ws;
    const layer = doc.state.layers[li];
    if (!layer) return [];
    const n = doc.state.layers.length;
    const emit = () => ws.emit('change');
    const pose = evalLayer(layer, doc.ui.frame);
    const locked = doc.isLocked(li);
    // A right-click on one of several selected layers acts on all of them.
    const sel = doc.isSelected(li) ? doc.selectedLayers() : [li];
    if (sel.length > 1) {
      const anyLocked = sel.some((i) => doc.isLocked(i));
      return [
        { label: `Duplicate ${sel.length} layers`, shortcut: 'Ctrl+D', action: () => (this.duplicateSelection(doc), emit()) },
        { label: `Delete ${sel.length} layers`, shortcut: 'Del', disabled: anyLocked, action: () => (doc.removeLayers(sel), emit()) },
        { separator: true },
        {
          label: 'Hide in editor',
          checked: sel.every((i) => doc.ui.hidden.has(doc.state.layers[i].uid)),
          action: () => {
            const hide = !sel.every((i) => doc.ui.hidden.has(doc.state.layers[i].uid));
            for (const i of sel) doc.ui.hidden[hide ? 'add' : 'delete'](doc.state.layers[i].uid);
            emit();
          },
        },
        {
          label: 'Lock',
          checked: sel.every((i) => doc.isLocked(i)),
          action: () => {
            const lock = !sel.every((i) => doc.isLocked(i));
            for (const i of sel) doc.ui.locked[lock ? 'add' : 'delete'](doc.state.layers[i].uid);
            emit();
          },
        },
        { label: 'Select only this layer', action: () => (doc.selectOnly(li), emit()) },
      ];
    }
    return [
      ...(layer.kind === 'reanim' ? [{ label: 'Edit prefab', shortcut: 'dbl-click', action: () => void ws.editPrefab(layer.source, doc, layer) }] : []),
      ...(layer.kind === 'particle' ? [{ label: 'Edit effect', shortcut: 'dbl-click', action: () => void ws.editPrefab(layer.source, doc, layer) }] : []),
      ...(layer.kind === 'text' ? [{ label: 'Edit text…', shortcut: 'dbl-click', disabled: locked, action: () => void this.editText(doc, li) }] : []),
      ...(layer.kind === 'camera'
        ? []
        : [
            { label: 'Flip horizontally', disabled: !pose || locked, action: () => (this.flip(doc, li, !pose!.flipX), emit()) },
            { label: 'Duplicate', shortcut: 'Ctrl+D', action: () => (doc.selectOnly(doc.duplicateLayer(li)), emit()) },
          ]),
      { label: 'Delete layer', shortcut: 'Del', disabled: locked, action: () => (doc.removeLayer(li), emit()) },
      { separator: true },
      { label: 'Bring to front', disabled: li >= n - 1, action: () => (doc.moveLayer(li, n - 1), emit()) },
      { label: 'Bring forward', shortcut: ']', disabled: li >= n - 1, action: () => (doc.moveLayer(li, li + 1), emit()) },
      { label: 'Send backward', shortcut: '[', disabled: li <= 0, action: () => (doc.moveLayer(li, li - 1), emit()) },
      { label: 'Send to back', disabled: li <= 0, action: () => (doc.moveLayer(li, 0), emit()) },
      { separator: true },
      {
        label: 'Hide in editor',
        checked: doc.ui.hidden.has(layer.uid),
        action: () => {
          if (!doc.ui.hidden.delete(layer.uid)) doc.ui.hidden.add(layer.uid);
          emit();
        },
      },
      {
        label: 'Lock',
        checked: doc.ui.locked.has(layer.uid),
        action: () => {
          if (!doc.ui.locked.delete(layer.uid)) doc.ui.locked.add(layer.uid);
          emit();
        },
      },
    ];
  }
}

/** Whether (x, y) is within `tol` pixels of the closed outline through `pts`. */
function nearOutline(pts: [number, number][], x: number, y: number, tol: number): boolean {
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2)) : 0;
    if (Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) <= tol) return true;
  }
  return false;
}
