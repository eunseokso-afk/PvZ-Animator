/** Modal pickers for images, sounds and particle effects, plus thumbnails. */

import type { AssetKind } from '../engine/assets';
import { basename, dirname, type VFile } from '../engine/vfs';
import type { Workspace } from '../editor/workspace';
import { h } from './dom';
import { openDialog } from './widgets';

const thumbCache = new Map<string, HTMLCanvasElement>();
let observer: IntersectionObserver | null = null;

/** A canvas that lazily draws a thumbnail of an image file when scrolled into view. */
export function thumbnail(ws: Workspace, path: string, size = 64): HTMLElement {
  const key = `${path.toUpperCase()}@${size}`;
  const holder = h('div', { class: 'thumb', style: { width: `${size}px`, height: `${size}px` } });
  const cached = thumbCache.get(key);
  if (cached) {
    holder.appendChild(cached.cloneNode(true) as HTMLCanvasElement);
    const c = holder.firstChild as HTMLCanvasElement;
    c.getContext('2d')!.drawImage(cached, 0, 0);
    return holder;
  }
  (holder as HTMLElement & { _load?: () => void })._load = () => {
    void ws.assets.loadImage(path).then((img) => {
      const c = h('canvas', { width: size * 2, height: size * 2 });
      c.style.width = `${size}px`;
      c.style.height = `${size}px`;
      if (img) {
        const s = Math.min((size * 2) / img.celWidth, (size * 2) / img.celHeight, 4);
        const w = img.celWidth * s;
        const hh = img.celHeight * s;
        // A 1:1 canvas copy first, so scaling does not bleed colour hidden in transparent pixels.
        const src = h('canvas', { width: img.celWidth, height: img.celHeight });
        src.getContext('2d')!.drawImage(img.source, 0, 0, img.celWidth, img.celHeight, 0, 0, img.celWidth, img.celHeight);
        c.getContext('2d')!.drawImage(src, 0, 0, img.celWidth, img.celHeight, (size * 2 - w) / 2, (size * 2 - hh) / 2, w, hh);
        holder.title = `${img.width}×${img.height}${img.rows * img.cols > 1 ? ` (${img.cols}×${img.rows} cels)` : ''}`;
      } else {
        holder.classList.add('broken');
      }
      thumbCache.set(key, c);
      holder.replaceChildren(c);
    });
  };
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const el = en.target as HTMLElement & { _load?: () => void };
        observer!.unobserve(el);
        el._load?.();
        el._load = undefined;
      }
    }, { rootMargin: '200px' });
  }
  observer.observe(holder);
  return holder;
}

export function clearThumbnails(): void {
  thumbCache.clear();
}

export async function pickImage(ws: Workspace, title: string, preferDir: 'reanim' | 'particles' = 'reanim', current?: string): Promise<{ path: string; id: string } | null> {
  let chosen: VFile | null = null;
  const all = ws.assets.list('image');
  const search = h('input', { type: 'search', placeholder: 'Search images…', class: 'wide' });
  const dirSel = h(
    'select',
    null,
    h('option', { value: '' }, 'All folders'),
    [...new Set(all.map((f) => dirname(f.path).toLowerCase()))].sort().map((d) => h('option', { value: d, selected: d === preferDir }, d || '(root)')),
  );
  if (!all.some((f) => dirname(f.path).toLowerCase() === preferDir)) dirSel.value = '';
  const grid = h('div', { class: 'picker-grid' });
  const info = h('div', { class: 'picker-info' }, current ? `Current: ${current}` : '');
  let dialogRoot: HTMLElement | null = null;

  const render = () => {
    const q = search.value.trim().toLowerCase();
    const dir = dirSel.value;
    const items = all.filter((f) => (!dir || dirname(f.path).toLowerCase() === dir) && (!q || f.path.toLowerCase().includes(q)));
    grid.replaceChildren(
      ...items.slice(0, 600).map((f) => {
        const cell = h(
          'div',
          {
            class: 'picker-cell',
            title: f.path,
            onclick: () => {
              chosen = f;
              grid.querySelectorAll('.picker-cell.sel').forEach((c) => c.classList.remove('sel'));
              cell.classList.add('sel');
              info.textContent = `${f.path}  →  ${ws.assets.imageIdForPath(f.path)}`;
            },
            ondblclick: () => {
              chosen = f;
              dialogRoot?.querySelector<HTMLButtonElement>('.btn.primary')?.click();
            },
          },
          thumbnail(ws, f.path, 56),
          h('div', { class: 'picker-name' }, basename(f.path)),
        );
        return cell;
      }),
      ...(items.length > 600 ? [h('div', { class: 'picker-more' }, `…and ${items.length - 600} more — refine the search`)] : []),
      ...(items.length === 0 ? [h('div', { class: 'picker-more' }, 'No images. Open main.pak or import PNG files first.')] : []),
    );
  };
  search.addEventListener('input', render);
  dirSel.addEventListener('change', render);
  render();
  const r = await openDialog({
    title,
    width: 720,
    body: h('div', { class: 'picker' }, h('div', { class: 'picker-bar' }, search, dirSel), grid, info),
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Use image', value: 'ok', primary: true },
    ],
    onOpen: (root) => (dialogRoot = root),
  });
  if (r !== 'ok' || !chosen) return null;
  const file = chosen as VFile;
  return { path: file.path, id: ws.assets.imageIdForPath(file.path) };
}

export async function pickAsset(ws: Workspace, kind: AssetKind, title: string): Promise<string | null> {
  const all = ws.assets.list(kind);
  let chosen: string | null = null;
  const search = h('input', { type: 'search', placeholder: 'Search…', class: 'wide' });
  const list = h('div', { class: 'picker-list' });
  let dialogRoot: HTMLElement | null = null;
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const items = all.filter((f) => !q || f.path.toLowerCase().includes(q));
    list.replaceChildren(
      ...items.slice(0, 1000).map((f) => {
        const id = kind === 'sound' ? ws.assets.soundIdForPath(f.path) : undefined;
        const row = h(
          'div',
          {
            class: 'picker-row',
            onclick: () => {
              chosen = f.path;
              list.querySelectorAll('.picker-row.sel').forEach((c) => c.classList.remove('sel'));
              row.classList.add('sel');
              if (kind === 'sound') void previewSound(ws, f.path);
            },
            ondblclick: () => {
              chosen = f.path;
              dialogRoot?.querySelector<HTMLButtonElement>('.btn.primary')?.click();
            },
          },
          h('span', { class: 'picker-row-name' }, basename(f.path)),
          h('span', { class: 'picker-row-path' }, id ?? dirname(f.path)),
        );
        return row;
      }),
      ...(items.length === 0 ? [h('div', { class: 'picker-more' }, `Nothing found. Open main.pak or import ${kind} files first.`)] : []),
    );
  };
  search.addEventListener('input', render);
  render();
  const r = await openDialog({
    title,
    width: 560,
    body: h('div', { class: 'picker' }, search, list),
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Choose', value: 'ok', primary: true },
    ],
    onOpen: (root) => (dialogRoot = root),
  });
  return r === 'ok' ? chosen : null;
}

export async function previewSound(ws: Workspace, ref: string, volume = 1): Promise<void> {
  const file = ws.assets.resolveSound(ref);
  if (!file) {
    ws.status(`Sound not found: ${ref}`, 'error');
    return;
  }
  const buf = await ws.audio.load(file);
  if (buf) ws.audio.play(buf, volume);
  else ws.status(`Could not decode ${file.path}`, 'error');
}

let fontListSerial = 0;

/**
 * A font id field (FONT_*) that suggests the fonts in the loaded files. Any id can be
 * typed; ids the game knows are drawn with its bitmap font once main.pak is open.
 */
export function fontInput(ws: Workspace, value: string, onChange: (font: string) => void): HTMLElement {
  const id = `font-list-${fontListSerial++}`;
  const list = h('datalist', { id }, ws.assets.fontIds().map((f) => h('option', { value: f })));
  const input = h('input', {
    type: 'text',
    value,
    class: 'wide mono',
    list: id,
    spellcheck: false,
    placeholder: 'FONT_HOUSEOFTERROR28',
    onchange: () => onChange(input.value.trim().toUpperCase()),
  });
  input.setAttribute('list', id);
  const describe = (f: { path: string } | null | undefined) => (!value ? '' : f ? `Bitmap font from ${f.path}` : f === null ? 'Not in the loaded files: shown with a similar system font' : 'Loading…');
  const loaded = value ? ws.assets.font(value) : null;
  const note = h('div', { class: 'dim small' }, describe(loaded));
  if (value && loaded === undefined) void ws.assets.loadFont(value).then((f) => (note.textContent = describe(f)));
  return h('div', { class: 'font-input' }, input, list, note);
}

/**
 * The font new text uses: PvZ's House of Terror if its bitmap font is loaded, else the
 * first bitmap font that is, else House of Terror (drawn with a system font until a pak is open).
 */
export function defaultFont(ws: Workspace): string {
  const ids = ws.assets.fontIds();
  const loadable = ids.filter((f) => ws.assets.resolveFont(f));
  return loadable.find((f) => f === 'FONT_HOUSEOFTERROR28') ?? loadable[0] ?? 'FONT_HOUSEOFTERROR28';
}

