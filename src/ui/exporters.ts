/**
 * Saving and exporting: individual files, repacked main.pak, project files,
 * WebM video (with sound cues) and PNG frame sequences / sprite sheets.
 */

import { apply, type Mat } from '../engine/math';
import { createRenderer, type Renderer, type RGBA } from '../engine/renderer';
import { drawReanim, isLooping, type DrawTrackInfo } from '../engine/reanimRuntime';
import { bakeScene, drawScene } from '../engine/sceneRuntime';
import { basename, memoryFile, normPath, pathKey, type VFile } from '../engine/vfs';
import { dateToFileTime, PAK_XOR_KEY, writePak, type PakWriteFile } from '../formats/pak';
import { parseParticleXml, serializeParticleXml } from '../formats/particles';
import { parseReanimXml, serializeReanimXml } from '../formats/reanim';
import { writeZip } from '../formats/zip';
import { ParticleDocument } from '../editor/particleDoc';
import { nextUid, ReanimDocument, type Ease } from '../editor/reanimDoc';
import { SceneDocument, type SceneState } from '../editor/sceneDoc';
import type { EditorDocument, Workspace } from '../editor/workspace';
import { downloadBlob, fileBytes, h } from './dom';
import { checkbox, numberField, openDialog, select } from './widgets';

const enc = new TextEncoder();

/** File bytes of a reanim or particle document (scenes are not game files; bake them instead). */
export function serializeDoc(ws: Workspace, doc: ReanimDocument | ParticleDocument): Uint8Array {
  if (doc.kind === 'reanim') return enc.encode(serializeReanimXml(doc.toDefinition(ws.settings.embedCues)));
  return enc.encode(serializeParticleXml(doc.def));
}

export function exportCurrentDoc(ws: Workspace): void {
  const doc = ws.active;
  if (!doc) return;
  if (doc.kind === 'scene') {
    void bakeSceneDialog(ws, doc);
    return;
  }
  const bytes = serializeDoc(ws, doc);
  downloadBlob(new Blob([bytes as BlobPart], { type: 'text/xml' }), basename(doc.path));
  ws.status(`Exported ${basename(doc.path)}`, 'success');
}

/** Write a document into the library so other documents (cues, attachers) see it. */
export function applyToLibrary(ws: Workspace, doc: EditorDocument): void {
  if (doc.kind === 'scene') return; // scenes live in the project, not in the game files
  ws.assets.vfs.set(memoryFile(doc.path, serializeDoc(ws, doc), 'generated'));
  ws.assets.invalidate('definitions');
  doc.markSaved();
  doc.isNew = false;
  ws.emit('docs');
}

// ---------------------------------------------------------------- main.pak

interface PakChange {
  path: string;
  label: string;
  bytes: () => Promise<Uint8Array>;
  checked: boolean;
}

function compiledPathFor(path: string): string {
  return `compiled/${normPath(path)}.compiled`;
}

export async function exportPak(ws: Workspace): Promise<void> {
  const pak = ws.assets.pak;
  const changes = new Map<string, PakChange>();
  for (const f of ws.assets.vfs.list()) {
    if (f.origin === 'pak') continue;
    const label = f.origin === 'generated' ? 'saved document' : f.origin === 'demo' ? 'demo asset' : 'imported file';
    changes.set(pathKey(f.path), { path: f.path, label, bytes: () => f.read(), checked: f.origin !== 'demo' });
  }
  for (const doc of ws.docs) {
    if (doc.kind === 'scene') continue;
    // Unchanged documents are already represented by their library file (if any).
    if (!doc.dirty && !doc.isNew && ws.assets.vfs.has(doc.path)) continue;
    changes.set(pathKey(doc.path), { path: doc.path, label: doc.dirty ? 'edited document' : 'document', bytes: async () => serializeDoc(ws, doc), checked: true });
  }
  if (changes.size === 0) {
    await openDialog({ title: 'Build main.pak', body: h('div', { class: 'dialog-text' }, 'Nothing to pack yet: edit a document or import files first.') });
    return;
  }
  let dropCompiled = true;
  const list = [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
  const body = h(
    'div',
    null,
    pak
      ? h('p', null, `Your changes will be merged into a copy of `, h('b', null, ws.assets.pakName), ` (${pak.entries.length} files). The original file is not modified.`)
      : h('p', { class: 'warn' }, 'No main.pak is open, so the archive will only contain the files below.'),
    h(
      'div',
      { class: 'pak-list' },
      list.map((c) =>
        h(
          'label',
          { class: 'check pak-item' },
          h('input', { type: 'checkbox', checked: c.checked, onchange: (e: Event) => (c.checked = (e.target as HTMLInputElement).checked) }),
          h('span', { class: 'mono' }, c.path),
          h('span', { class: 'dim small' }, ws.assets.vfs.get(c.path)?.origin === 'pak' || pak?.entries.some((e) => pathKey(e.name) === pathKey(c.path)) ? 'replace · ' + c.label : 'add · ' + c.label),
        ),
      ),
    ),
    checkbox('Remove compiled caches of changed reanims/particles (recommended — the game recompiles them from XML)', dropCompiled, (v) => (dropCompiled = v)),
    h('p', { class: 'dim small' }, 'Back up the original main.pak before replacing it in the game folder.'),
  );
  const r = await openDialog({
    title: 'Build main.pak',
    width: 620,
    body,
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Build & download', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return;
  const chosen = list.filter((c) => c.checked);
  ws.status('Building main.pak…');
  const now = dateToFileTime(new Date());
  const replaced = new Map<string, Uint8Array>();
  for (const c of chosen) replaced.set(pathKey(c.path), await c.bytes());
  const remove = new Set<string>();
  if (dropCompiled) {
    for (const c of chosen) {
      const lower = c.path.toLowerCase();
      if (lower.endsWith('.reanim') || lower.endsWith('.xml')) remove.add(pathKey(compiledPathFor(c.path)));
    }
  }
  const files: PakWriteFile[] = [];
  const seen = new Set<string>();
  if (pak) {
    for (const entry of pak.entries) {
      const key = pathKey(entry.name);
      seen.add(key);
      if (remove.has(key)) continue;
      const data = replaced.get(key);
      if (data) {
        files.push({ name: entry.name, data, size: data.length, fileTime: now });
      } else if (pak.key === PAK_XOR_KEY) {
        files.push({ name: entry.name, data: pak.rawSlice(entry), size: entry.size, encrypted: true, fileTime: entry.fileTime });
      } else {
        const plain = await pak.read(entry);
        files.push({ name: entry.name, data: plain, size: plain.length, fileTime: entry.fileTime });
      }
    }
  }
  for (const c of chosen) {
    const key = pathKey(c.path);
    if (seen.has(key)) continue;
    const data = replaced.get(key)!;
    files.push({ name: normPath(c.path).replace(/\//g, '\\'), data, size: data.length, fileTime: now });
  }
  const blob = writePak(files);
  downloadBlob(blob, pak ? basename(ws.assets.pakName) || 'main.pak' : 'main.pak');
  for (const doc of ws.docs) if (chosen.some((c) => pathKey(c.path) === pathKey(doc.path))) doc.markSaved();
  ws.emit('docs');
  ws.status(`Built ${files.length}-file pak (${(blob.size / 1024 / 1024).toFixed(1)} MB) with ${chosen.length} change(s).`, 'success');
}

// ---------------------------------------------------------------- projects

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface ProjectDoc {
  kind: 'reanim' | 'particle';
  name: string;
  path: string;
  isNew: boolean;
  xml: string;
  keys?: number[][];
  ease?: Record<string, Ease>[];
  anim?: string;
  loop?: string;
}

interface ProjectScene {
  name: string;
  open: boolean;
  state: SceneState;
}

interface ProjectFile {
  format: 'pvz-animator-project';
  version: 1;
  savedAt: string;
  pakName?: string;
  docs: ProjectDoc[];
  scenes?: ProjectScene[];
  files: { path: string; origin: string; data: string }[];
}

export async function saveProject(ws: Workspace): Promise<void> {
  const docs: ProjectDoc[] = ws.docs.flatMap((d): ProjectDoc[] => (d.kind === 'scene' ? [] : [projectDoc(d)]));
  const scenes: ProjectScene[] = ws.scenes.map((sc) => ({ name: sc.name, open: ws.docs.includes(sc), state: sc.state }));
  const files: ProjectFile['files'] = [];
  for (const f of ws.assets.vfs.list()) {
    if (f.origin === 'pak') continue;
    files.push({ path: f.path, origin: f.origin, data: toBase64(await f.read()) });
  }
  const project: ProjectFile = { format: 'pvz-animator-project', version: 1, savedAt: new Date().toISOString(), pakName: ws.assets.pakName || undefined, docs, scenes, files };
  const name = (ws.active?.name ?? 'project').replace(/[^\w.-]+/g, '_');
  downloadBlob(new Blob([JSON.stringify(project)], { type: 'application/json' }), `${name}.pvzanim.json`);
  for (const sc of ws.scenes) sc.markSaved();
  ws.emit('docs');
  ws.status(`Saved project (${docs.length} documents, ${scenes.length} scenes, ${files.length} files). Re-open main.pak after loading it.`, 'success');
}

function projectDoc(d: ReanimDocument | ParticleDocument): ProjectDoc {
  if (d.kind === 'particle') return { kind: 'particle', name: d.name, path: d.path, isNew: d.isNew, xml: serializeParticleXml(d.def) };
  const tracks = d.state.tracks;
  return {
    kind: 'reanim',
    name: d.name,
    path: d.path,
    isNew: d.isNew,
    xml: serializeReanimXml(d.toDefinition(true)),
    keys: tracks.map((t) => t.keys.flatMap((k, i) => (k ? [i] : []))),
    ease: tracks.map((t) => Object.fromEntries(t.ease.flatMap((e, i) => (t.keys[i] && e !== 'linear' ? [[String(i), e]] : [])))),
    anim: d.ui.anim,
    loop: d.ui.loop,
  };
}

export async function loadProject(ws: Workspace, file: File): Promise<void> {
  const text = new TextDecoder().decode(await fileBytes(file));
  const p = JSON.parse(text) as ProjectFile;
  if (p.format !== 'pvz-animator-project') throw new Error('Not a PvZ Animator project file.');
  await ws.assets.importFiles(
    p.files.filter((f) => f.origin === 'import').map((f) => ({ path: f.path, data: fromBase64(f.data) })),
  );
  for (const origin of ['generated', 'demo'] as const) {
    const list = p.files.filter((f) => f.origin === origin);
    if (list.length) await ws.assets.importFiles(list.map((f) => ({ path: f.path, data: fromBase64(f.data) })), origin);
  }
  for (const d of p.docs) {
    let doc: EditorDocument;
    if (d.kind === 'reanim') {
      const r = ReanimDocument.fromDefinition(parseReanimXml(d.xml), d.name, d.path, false);
      r.state.tracks.forEach((t, i) => {
        const keys = d.keys?.[i];
        if (keys) {
          t.keys = t.transforms.map(() => false);
          for (const k of keys) if (k < t.keys.length) t.keys[k] = true;
          t.keys[0] = true;
        }
        const ease = d.ease?.[i];
        if (ease) for (const [k, v] of Object.entries(ease)) t.ease[+k] = v;
      });
      if (d.anim !== undefined) r.ui.anim = d.anim;
      if (d.loop) r.ui.loop = d.loop as typeof r.ui.loop;
      doc = r;
    } else {
      doc = ParticleDocument.fromDefinition(parseParticleXml(d.xml), d.name, d.path);
    }
    doc.isNew = d.isNew;
    doc.savedVersion = -1;
    ws.openDoc(doc);
  }
  for (const sc of p.scenes ?? []) {
    const state = sc.state;
    // Fresh ids so they never collide with ids handed out in this session.
    for (const l of state.layers) {
      l.uid = nextUid();
      for (const k of l.keys) k.tint = [...(k.tint ?? [1, 1, 1])] as [number, number, number];
    }
    for (const c of state.soundCues) c.uid = nextUid();
    const doc = SceneDocument.fromState(sc.name, state);
    doc.markSaved();
    ws.addScene(doc);
    if (sc.open) ws.openDoc(doc);
  }
  ws.status(`Loaded project with ${p.docs.length} documents, ${(p.scenes ?? []).length} scenes${p.pakName && !ws.assets.pak ? ` — open ${p.pakName} to see game assets` : ''}.`, 'success');
}

// ---------------------------------------------------------------- rendering exports

class NullRenderer implements Renderer {
  readonly kind = 'canvas2d' as const;
  readonly canvas = document.createElement('canvas');
  resize(): void {}
  begin(): void {}
  drawImage(): void {}
  fillRect(): void {}
  end(): void {}
}

/** What a frame/video export renders: a reanim's active range or a whole scene. */
interface ExportTarget {
  label: string;
  frames: number[];
  /** Content box in document space. */
  box: { x: number; y: number; w: number; h: number };
  isScene: boolean;
  defaultLoops: number;
  /** Draw a (possibly fractional) frame with `base` mapping document space to the output. */
  draw(r: Renderer, base: Mat, frame: number, background: boolean): void;
  /** Current frame while the workspace is playing (for video). */
  playingFrame(): number;
}

async function preloadImages(ws: Workspace, tracks: { transforms: { i: string }[] }[]): Promise<void> {
  const ids = new Set<string>();
  for (const t of tracks) for (const tr of t.transforms) if (tr.i) ids.add(tr.i);
  await Promise.all([...ids].map((id) => ws.assets.loadImage(id)));
}

/** Load every prefab, image and particle definition a scene needs. */
async function preloadScene(ws: Workspace, doc: SceneDocument): Promise<void> {
  const s = doc.state;
  if (s.backgroundImage) await ws.assets.loadImage(s.backgroundImage);
  for (const l of s.layers) {
    if (l.kind === 'reanim') {
      const prefab = ws.prefab(l.source) ?? (await ws.assets.reanimAsync(l.source));
      if (prefab) await preloadImages(ws, prefab.tracks);
    } else if (l.kind === 'image') await ws.assets.loadImage(l.source);
    else if (!ws.particleDef(l.source)) {
      const def = await ws.assets.particleAsync(l.source);
      for (const em of def?.emitters ?? []) if (em.image) await ws.assets.loadImage(em.image);
    }
  }
}

/** Bounding box (reanim space) of all visible parts over the given frames. */
function measure(ws: Workspace, doc: ReanimDocument, frames: number[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const nr = new NullRenderer();
  for (const f of frames) {
    const infos: DrawTrackInfo[] = [];
    drawReanim(nr, ws.assets, doc.state.tracks, { before: f, after: f, fraction: 0 }, [1, 0, 0, 1, 0, 0], { collect: infos, hidden: (i) => doc.ui.hidden.has(doc.state.tracks[i].uid) });
    for (const info of infos) {
      for (const [cx, cy] of [
        [0, 0],
        [info.width, 0],
        [0, info.height],
        [info.width, info.height],
      ]) {
        const [x, y] = apply(info.matrix, cx, cy);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 80, h: 100 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

async function exportTarget(ws: Workspace): Promise<ExportTarget | null> {
  const scene = ws.scene;
  if (scene) {
    await preloadScene(ws, scene);
    const s = scene.state;
    const res = { assets: ws.assets, prefab: (p: string) => ws.prefab(p), particles: ws.sceneParticles.bind(ws, scene) };
    return {
      label: scene.name,
      frames: Array.from({ length: s.length }, (_, i) => i),
      box: { x: 0, y: 0, w: s.width, h: s.height },
      isScene: true,
      defaultLoops: 1,
      draw: (r, base, frame, background) => drawScene(r, res, s, frame, base, { hidden: (l) => scene.ui.hidden.has(l.uid), clock: ws.clock, drawBackground: background }),
      playingFrame: () => ws.sceneFrame(scene),
    };
  }
  const doc = ws.reanim;
  if (!doc) return null;
  await preloadImages(ws, doc.state.tracks);
  const { start, end } = doc.activeRange();
  const frames = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const hidden = (i: number) => doc.ui.hidden.has(doc.state.tracks[i].uid);
  return {
    label: `${doc.name}${doc.ui.anim ? '_' + doc.ui.anim : ''}`,
    frames,
    box: measure(ws, doc, frames),
    isScene: false,
    defaultLoops: isLooping(doc.ui.loop) ? 3 : 1,
    draw: (r, base, frame) => {
      const playing = ws.playing && ws.active === doc;
      const ft = playing ? ws.frameTime(doc) : { before: frame, after: frame, fraction: 0 };
      drawReanim(r, ws.assets, doc.state.tracks, ft, base, { hidden, clock: ws.clock });
      if (playing) {
        for (const l of ws.live) l.sys.draw(r, ws.assets, base);
      } else {
        const saved = doc.ui.frame;
        doc.ui.frame = frame;
        for (const sys of ws.pausedParticleSystems(doc)) sys.draw(r, ws.assets, base);
        doc.ui.frame = saved;
      }
    },
    playingFrame: () => ws.frameTime(doc).before,
  };
}

const BG_COLORS: Record<string, RGBA | null> = {
  stage: null,
  transparent: null,
  dark: [0.137, 0.149, 0.18, 1],
  lawn: [0.3, 0.54, 0.17, 1],
  white: [1, 1, 1, 1],
  black: [0, 0, 0, 1],
};

interface RenderSetup {
  width: number;
  height: number;
  base: Mat;
  bg: RGBA | null;
  /** Draw the scene's own stage background. */
  stageBackground: boolean;
}

async function renderSettingsDialog(target: ExportTarget, title: string, extra: (HTMLElement | null)[], defaults: { scale: number; padding: number }): Promise<RenderSetup | null> {
  const box = target.box;
  let scale = defaults.scale;
  let padding = target.isScene ? 0 : defaults.padding;
  let bg = target.isScene ? 'stage' : 'transparent';
  const sizeText = h('div', { class: 'dim small' });
  const update = () => {
    sizeText.textContent = `Output: ${Math.ceil((box.w + padding * 2) * scale)} × ${Math.ceil((box.h + padding * 2) * scale)} px · ${target.frames.length} frames (${target.label})`;
  };
  update();
  const bgOptions = Object.keys(BG_COLORS).filter((k) => target.isScene || k !== 'stage');
  const r = await openDialog({
    title,
    width: 460,
    body: h(
      'div',
      { class: 'form-col' },
      h(
        'div',
        { class: 'insp-grid2' },
        numberField({ label: 'Scale', value: scale, step: 0.1, precision: 2, min: 0.1, max: 8, onChange: (v) => ((scale = v), update()) }).el,
        target.isScene ? null : numberField({ label: 'Padding', value: padding, precision: 0, min: 0, max: 400, onChange: (v) => ((padding = v), update()) }).el,
      ),
      h(
        'label',
        { class: 'field-col' },
        'Background',
        select(
          bgOptions.map((k) => ({ value: k, label: k === 'stage' ? 'Stage background' : k[0].toUpperCase() + k.slice(1) })),
          bg,
          (v) => (bg = v),
        ),
      ),
      ...extra,
      sizeText,
    ),
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Export', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return null;
  const width = Math.max(2, Math.ceil((box.w + padding * 2) * scale));
  const height = Math.max(2, Math.ceil((box.h + padding * 2) * scale));
  const base: Mat = [scale, 0, 0, scale, (padding - box.x) * scale, (padding - box.y) * scale];
  return { width, height, base, bg: BG_COLORS[bg], stageBackground: bg === 'stage' };
}

function renderFrameTo(target: ExportTarget, r: Renderer, setup: RenderSetup, frame: number) {
  r.begin(setup.bg ?? [0, 0, 0, 0]);
  target.draw(r, setup.base, frame, setup.stageBackground);
  r.end();
}

function canvasToPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? void b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))) : reject(new Error('toBlob failed'))), 'image/png'),
  );
}

export async function exportFrames(ws: Workspace): Promise<void> {
  ws.pause();
  const target = await exportTarget(ws);
  if (!target) return;
  let mode = 'zip' as 'zip' | 'sheet';
  const setup = await renderSettingsDialog(
    target,
    'Export PNG frames',
    [
      h(
        'label',
        { class: 'field-col' },
        'Output',
        select(
          [
            { value: 'zip', label: 'PNG sequence (.zip)' },
            { value: 'sheet', label: 'Sprite sheet (.png)' },
          ],
          mode,
          (v) => (mode = v),
        ),
      ),
    ],
    { scale: 1, padding: 8 },
  );
  if (!setup) return;
  const canvas = document.createElement('canvas');
  const r = createRenderer(canvas);
  r.resize(setup.width, setup.height, 1);
  const pngs: Uint8Array[] = [];
  const cols = Math.ceil(Math.sqrt(target.frames.length));
  const sheet = mode === 'sheet' ? document.createElement('canvas') : null;
  if (sheet) {
    sheet.width = cols * setup.width;
    sheet.height = Math.ceil(target.frames.length / cols) * setup.height;
  }
  ws.invalidatePreviews();
  try {
    for (let k = 0; k < target.frames.length; k++) {
      renderFrameTo(target, r, setup, target.frames[k]);
      if (sheet) sheet.getContext('2d')!.drawImage(canvas, (k % cols) * setup.width, Math.floor(k / cols) * setup.height);
      else pngs.push(await canvasToPng(canvas));
    }
  } finally {
    ws.invalidatePreviews();
  }
  if (sheet) {
    downloadBlob(new Blob([(await canvasToPng(sheet)) as BlobPart], { type: 'image/png' }), `${target.label}_sheet_${cols}x${Math.ceil(target.frames.length / cols)}.png`);
  } else {
    downloadBlob(writeZip(pngs.map((data, i) => ({ name: `${target.label}_${String(target.frames[i]).padStart(4, '0')}.png`, data }))), `${target.label}_frames.zip`);
  }
  ws.status(`Exported ${target.frames.length} frames.`, 'success');
}

export async function exportVideo(ws: Workspace): Promise<void> {
  if (typeof MediaRecorder === 'undefined') {
    ws.status('Video export needs MediaRecorder support (Chrome, Edge or Firefox).', 'error');
    return;
  }
  ws.pause();
  const doc = ws.timed;
  const target = await exportTarget(ws);
  if (!doc || !target) return;
  let loops = target.defaultLoops;
  let withSound = true;
  const setup = await renderSettingsDialog(
    target,
    'Export video (WebM)',
    [
      numberField({ label: 'Loops', value: loops, precision: 0, min: 1, max: 50, onChange: (v) => (loops = Math.round(v)) }).el,
      checkbox('Record sound cues', withSound, (v) => (withSound = v)),
      h('p', { class: 'dim small' }, 'The animation plays in real time while recording.'),
    ],
    { scale: target.isScene ? 1 : 2, padding: 16 },
  );
  if (!setup) return;
  const glCanvas = document.createElement('canvas');
  const r = createRenderer(glCanvas);
  r.resize(setup.width, setup.height, 1);
  const out = document.createElement('canvas');
  out.width = setup.width % 2 ? setup.width + 1 : setup.width;
  out.height = setup.height % 2 ? setup.height + 1 : setup.height;
  const ctx = out.getContext('2d')!;
  const stream = out.captureStream(60);
  if (withSound) for (const t of ws.audio.startRecording().getAudioTracks()) stream.addTrack(t);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  doc.ui.frame = target.frames[0];
  const savedLoop = doc.kind === 'scene' ? doc.ui.loopPlayback : undefined;
  if (doc.kind === 'scene') doc.ui.loopPlayback = loops > 1;
  ws.invalidatePreviews();
  rec.start(250);
  ws.play();
  ws.status('Recording video…');
  let loopCount = 0;
  let last = ws.playhead;
  await new Promise<void>((resolve) => {
    const step = () => {
      if (ws.playhead < last - 0.5) loopCount++;
      last = ws.playhead;
      if (loopCount >= loops || ws.active !== doc) {
        setTimeout(resolve, 100);
        return;
      }
      renderFrameTo(target, r, setup, ws.playing ? ws.playhead : target.playingFrame());
      ctx.clearRect(0, 0, out.width, out.height);
      ctx.drawImage(glCanvas, 0, 0);
      if (!ws.playing) {
        setTimeout(resolve, 200);
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  ws.pause();
  if (doc.kind === 'scene' && savedLoop !== undefined) doc.ui.loopPlayback = savedLoop;
  rec.stop();
  await done;
  ws.audio.stopRecording();
  const blob = new Blob(chunks, { type: 'video/webm' });
  downloadBlob(blob, `${target.label}.webm`);
  ws.status(`Exported video (${(blob.size / 1024).toFixed(0)} KB).`, 'success');
}

// ---------------------------------------------------------------- baking scenes

/** Flatten a scene into one .reanim (optionally opening it and adding it to the library). */
export async function bakeSceneDialog(ws: Workspace, scene: SceneDocument): Promise<void> {
  ws.pause();
  await preloadScene(ws, scene);
  const { definition, warnings } = bakeScene(scene.state, { assets: ws.assets, prefab: (p) => ws.prefab(p) });
  const safe = scene.name.replace(/[^A-Za-z0-9_]+/g, '_') || 'Scene';
  const pathInput = h('input', { type: 'text', class: 'wide mono', value: `reanim/${safe}.reanim` });
  let open = true;
  let library = true;
  let download = false;
  const parts = definition.tracks.length - 1;
  const r = await openDialog({
    title: 'Bake scene to reanim',
    width: 520,
    body: h(
      'div',
      { class: 'form-col' },
      h('p', null, `Flattens every instance into one reanim: ${parts} part track${parts === 1 ? '' : 's'}, ${scene.state.length} frames at ${scene.state.fps} fps, playable in the game as `, h('b', null, 'anim_scene'), '.'),
      warnings.length ? h('ul', { class: 'warn small' }, warnings.map((w) => h('li', null, w))) : null,
      h('label', { class: 'field-col' }, 'Save as', pathInput),
      checkbox('Open it for editing', open, (v) => (open = v)),
      checkbox('Add it to the library (included in Build main.pak)', library, (v) => (library = v)),
      checkbox('Download the .reanim file', download, (v) => (download = v)),
    ),
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Bake', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return;
  const path = normPath(pathInput.value.trim() || `reanim/${safe}.reanim`);
  const name = basename(path).replace(/\.reanim$/i, '');
  const xml = serializeReanimXml(definition);
  if (download) downloadBlob(new Blob([xml], { type: 'text/xml' }), basename(path));
  if (library) {
    ws.assets.vfs.set(memoryFile(path, enc.encode(xml), 'generated'));
    ws.assets.invalidate('definitions');
  }
  const existing = ws.findDoc(path);
  if (existing) ws.closeDoc(existing);
  if (open) {
    const doc = ReanimDocument.fromDefinition(parseReanimXml(xml), name, path, ws.settings.simplifyOnImport);
    if (library) doc.markSaved();
    ws.openDoc(doc);
  }
  ws.status(`Baked ${scene.name} into ${path}${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}.`, 'success');
}

/** Re-export helper used by the asset browser. */
export async function extractFile(file: VFile): Promise<void> {
  const data = await file.read();
  downloadBlob(new Blob([data as BlobPart]), basename(file.path));
}

