/**
 * Saving and exporting: individual files, repacked main.pak, project files,
 * WebM video (with sound cues) and PNG frame sequences / sprite sheets.
 */

import { apply, type Mat } from '../engine/math';
import { createRenderer, type Renderer, type RGBA } from '../engine/renderer';
import { drawReanim, isLooping, type DrawTrackInfo } from '../engine/reanimRuntime';
import { basename, memoryFile, normPath, pathKey, type VFile } from '../engine/vfs';
import { dateToFileTime, PAK_XOR_KEY, writePak, type PakWriteFile } from '../formats/pak';
import { parseParticleXml, serializeParticleXml } from '../formats/particles';
import { parseReanimXml, serializeReanimXml } from '../formats/reanim';
import { writeZip } from '../formats/zip';
import { ParticleDocument } from '../editor/particleDoc';
import { ReanimDocument, type Ease } from '../editor/reanimDoc';
import type { EditorDocument, Workspace } from '../editor/workspace';
import { downloadBlob, fileBytes, h } from './dom';
import { checkbox, numberField, openDialog, select } from './widgets';

const enc = new TextEncoder();

export function serializeDoc(ws: Workspace, doc: EditorDocument): Uint8Array {
  if (doc.kind === 'reanim') return enc.encode(serializeReanimXml(doc.toDefinition(ws.settings.embedCues)));
  return enc.encode(serializeParticleXml(doc.def));
}

export function exportCurrentDoc(ws: Workspace): void {
  const doc = ws.active;
  if (!doc) return;
  const bytes = serializeDoc(ws, doc);
  downloadBlob(new Blob([bytes as BlobPart], { type: 'text/xml' }), basename(doc.path));
  ws.status(`Exported ${basename(doc.path)}`, 'success');
}

/** Write a document into the library so other documents (cues, attachers) see it. */
export function applyToLibrary(ws: Workspace, doc: EditorDocument): void {
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

interface ProjectFile {
  format: 'pvz-animator-project';
  version: 1;
  savedAt: string;
  pakName?: string;
  docs: ProjectDoc[];
  files: { path: string; origin: string; data: string }[];
}

export async function saveProject(ws: Workspace): Promise<void> {
  const docs: ProjectDoc[] = ws.docs.map((d) => {
    if (d.kind === 'reanim') {
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
    return { kind: 'particle', name: d.name, path: d.path, isNew: d.isNew, xml: serializeParticleXml(d.def) };
  });
  const files: ProjectFile['files'] = [];
  for (const f of ws.assets.vfs.list()) {
    if (f.origin === 'pak') continue;
    files.push({ path: f.path, origin: f.origin, data: toBase64(await f.read()) });
  }
  const project: ProjectFile = { format: 'pvz-animator-project', version: 1, savedAt: new Date().toISOString(), pakName: ws.assets.pakName || undefined, docs, files };
  const name = (ws.active?.name ?? 'project').replace(/[^\w.-]+/g, '_');
  downloadBlob(new Blob([JSON.stringify(project)], { type: 'application/json' }), `${name}.pvzanim.json`);
  ws.status(`Saved project (${docs.length} documents, ${files.length} files). Re-open main.pak after loading it.`, 'success');
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
  ws.status(`Loaded project with ${p.docs.length} documents${p.pakName && !ws.assets.pak ? ` — open ${p.pakName} to see game assets` : ''}.`, 'success');
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

async function preloadImages(ws: Workspace, doc: ReanimDocument): Promise<void> {
  const ids = new Set<string>();
  for (const t of doc.state.tracks) for (const tr of t.transforms) if (tr.i) ids.add(tr.i);
  await Promise.all([...ids].map((id) => ws.assets.loadImage(id)));
}

function rangeFrames(doc: ReanimDocument): number[] {
  const { start, end } = doc.activeRange();
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
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

const BG_COLORS: Record<string, RGBA | null> = {
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
}

async function renderSettingsDialog(ws: Workspace, doc: ReanimDocument, title: string, extra: (HTMLElement | null)[], defaults: { scale: number; padding: number }): Promise<(RenderSetup & { frames: number[] }) | null> {
  await preloadImages(ws, doc);
  const frames = rangeFrames(doc);
  const box = measure(ws, doc, frames);
  let scale = defaults.scale;
  let padding = defaults.padding;
  let bg = 'transparent';
  const sizeText = h('div', { class: 'dim small' });
  const update = () => {
    sizeText.textContent = `Output: ${Math.ceil((box.w + padding * 2) * scale)} × ${Math.ceil((box.h + padding * 2) * scale)} px · ${frames.length} frames (${doc.ui.anim || 'all frames'})`;
  };
  update();
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
        numberField({ label: 'Padding', value: padding, precision: 0, min: 0, max: 400, onChange: (v) => ((padding = v), update()) }).el,
      ),
      h(
        'label',
        { class: 'field-col' },
        'Background',
        select(
          Object.keys(BG_COLORS).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })),
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
  return { width, height, base, bg: BG_COLORS[bg], frames };
}

function renderFrameTo(ws: Workspace, doc: ReanimDocument, r: Renderer, setup: RenderSetup, frame: { before: number; after: number; fraction: number }, systems: { draw: (r: Renderer, a: typeof ws.assets, m: Mat) => void }[]) {
  r.begin(setup.bg ?? [0, 0, 0, 0]);
  drawReanim(r, ws.assets, doc.state.tracks, frame, setup.base, { hidden: (i) => doc.ui.hidden.has(doc.state.tracks[i].uid), clock: ws.clock });
  for (const s of systems) s.draw(r, ws.assets, setup.base);
  r.end();
}

function canvasToPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? void b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))) : reject(new Error('toBlob failed'))), 'image/png'),
  );
}

export async function exportFrames(ws: Workspace): Promise<void> {
  const doc = ws.reanim;
  if (!doc) return;
  let mode = 'zip' as 'zip' | 'sheet';
  const setup = await renderSettingsDialog(
    ws,
    doc,
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
  ws.pause();
  const canvas = document.createElement('canvas');
  const r = createRenderer(canvas);
  r.resize(setup.width, setup.height, 1);
  const savedFrame = doc.ui.frame;
  const pngs: Uint8Array[] = [];
  const cols = Math.ceil(Math.sqrt(setup.frames.length));
  const sheet = mode === 'sheet' ? document.createElement('canvas') : null;
  if (sheet) {
    sheet.width = cols * setup.width;
    sheet.height = Math.ceil(setup.frames.length / cols) * setup.height;
  }
  try {
    for (let k = 0; k < setup.frames.length; k++) {
      const f = setup.frames[k];
      doc.ui.frame = f;
      const systems = ws.pausedParticleSystems(doc);
      renderFrameTo(ws, doc, r, setup, { before: f, after: f, fraction: 0 }, systems);
      if (sheet) sheet.getContext('2d')!.drawImage(canvas, (k % cols) * setup.width, Math.floor(k / cols) * setup.height);
      else pngs.push(await canvasToPng(canvas));
    }
  } finally {
    doc.ui.frame = savedFrame;
    ws.invalidatePreviews();
  }
  const base = `${doc.name}${doc.ui.anim ? '_' + doc.ui.anim : ''}`;
  if (sheet) {
    downloadBlob(new Blob([(await canvasToPng(sheet)) as BlobPart], { type: 'image/png' }), `${base}_sheet_${cols}x${Math.ceil(setup.frames.length / cols)}.png`);
  } else {
    downloadBlob(writeZip(pngs.map((data, i) => ({ name: `${base}_${String(setup.frames[i]).padStart(4, '0')}.png`, data }))), `${base}_frames.zip`);
  }
  ws.status(`Exported ${setup.frames.length} frames.`, 'success');
}

export async function exportVideo(ws: Workspace): Promise<void> {
  const doc = ws.reanim;
  if (!doc) return;
  if (typeof MediaRecorder === 'undefined') {
    ws.status('Video export needs MediaRecorder support (Chrome, Edge or Firefox).', 'error');
    return;
  }
  let loops = isLooping(doc.ui.loop) ? 3 : 1;
  let withSound = true;
  const setup = await renderSettingsDialog(
    ws,
    doc,
    'Export video (WebM)',
    [
      numberField({ label: 'Loops', value: loops, precision: 0, min: 1, max: 50, onChange: (v) => (loops = Math.round(v)) }).el,
      checkbox('Record sound cues', withSound, (v) => (withSound = v)),
      h('p', { class: 'dim small' }, 'The animation plays in real time while recording.'),
    ],
    { scale: 2, padding: 16 },
  );
  if (!setup) return;
  ws.pause();
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
  const { start } = doc.activeRange();
  doc.ui.frame = start;
  rec.start(250);
  ws.play();
  ws.status('Recording video…');
  let loopCount = 0;
  let last = ws.playhead;
  await new Promise<void>((resolve) => {
    const step = () => {
      if (ws.playhead < last - 0.5) loopCount++;
      last = ws.playhead;
      const ft = ws.frameTime(doc);
      renderFrameTo(ws, doc, r, setup, ft, ws.live.map((l) => l.sys));
      ctx.clearRect(0, 0, out.width, out.height);
      ctx.drawImage(glCanvas, 0, 0);
      if (!ws.playing || loopCount >= loops || ws.active !== doc) {
        setTimeout(resolve, 200);
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  ws.pause();
  rec.stop();
  await done;
  ws.audio.stopRecording();
  const blob = new Blob(chunks, { type: 'video/webm' });
  downloadBlob(blob, `${doc.name}${doc.ui.anim ? '_' + doc.ui.anim : ''}.webm`);
  ws.status(`Exported video (${(blob.size / 1024).toFixed(0)} KB).`, 'success');
}

/** Re-export helper used by the asset browser. */
export async function extractFile(file: VFile): Promise<void> {
  const data = await file.read();
  downloadBlob(new Blob([data as BlobPart]), basename(file.path));
}

