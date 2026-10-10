/** Left panel: browse the files of main.pak and imported assets. */

import type { AssetKind } from '../engine/assets';
import { basename, dirname, type VFile } from '../engine/vfs';
import type { Workspace } from '../editor/workspace';
import { formatBytes, h, rafThrottle } from './dom';
import { previewSound, thumbnail } from './pickers';
import { ASSET_MIME } from './viewport';

type Tab = AssetKind | 'all';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'reanim', label: 'Reanims', icon: '▶' },
  { id: 'particle', label: 'Particles', icon: '✦' },
  { id: 'image', label: 'Images', icon: '▣' },
  { id: 'sound', label: 'Sounds', icon: '♪' },
  { id: 'all', label: 'All', icon: '≡' },
];

const ROW_H = 26;
const CELL_W = 84;
const CELL_H = 96;

export interface AssetBrowserHooks {
  openPak(): void;
  openFolder(): void;
  importFiles(accept?: string): void;
  loadDemo(): void;
  assetMenu(file: VFile, kind: AssetKind, e: MouseEvent): void;
  activate(file: VFile, kind: AssetKind): void;
}

export class AssetBrowser {
  readonly el: HTMLElement;
  private tab: Tab = 'reanim';
  private query = '';
  private tabsEl: HTMLElement;
  private scroller: HTMLElement;
  private inner: HTMLElement;
  private summary: HTMLElement;
  private welcome: HTMLElement;
  private items: VFile[] = [];
  private selected = '';
  private lastVersion = -1;

  constructor(
    private ws: Workspace,
    private hooks: AssetBrowserHooks,
  ) {
    const search = h('input', {
      type: 'search',
      placeholder: 'Filter files…',
      class: 'asset-search',
      oninput: () => {
        this.query = search.value.trim().toLowerCase();
        this.refresh(true);
      },
      onkeydown: (e: KeyboardEvent) => e.stopPropagation(),
    });
    this.tabsEl = h('div', { class: 'asset-tabs' });
    this.inner = h('div', { class: 'asset-inner' });
    this.scroller = h('div', { class: 'asset-scroll' }, this.inner);
    this.summary = h('div', { class: 'asset-summary' });
    this.welcome = h(
      'div',
      { class: 'asset-welcome' },
      h('div', { class: 'welcome-title' }, 'No game files loaded'),
      h('p', null, 'Open your Plants vs. Zombies ', h('b', null, 'main.pak'), ' (found in the game folder) or an extracted game folder.'),
      h('button', { class: 'btn primary', onclick: () => hooks.openPak() }, 'Open main.pak…'),
      h('button', { class: 'btn', onclick: () => hooks.openFolder() }, 'Open extracted folder…'),
      h('button', { class: 'btn', onclick: () => hooks.loadDemo() }, 'Try demo assets'),
      h('p', { class: 'dim small' }, 'Files are read locally in your browser — nothing is uploaded.'),
    );
    this.el = h(
      'div',
      { class: 'asset-browser' },
      h(
        'div',
        { class: 'panel-head' },
        h('span', { class: 'panel-title' }, 'Assets'),
        h(
          'div',
          { class: 'panel-actions' },
          h('button', { class: 'tool-btn', title: 'Open main.pak', onclick: () => hooks.openPak() }, '📦'),
          h('button', { class: 'tool-btn', title: 'Open extracted game folder', onclick: () => hooks.openFolder() }, '📁'),
          h('button', { class: 'tool-btn', title: 'Import images, sounds, reanims or particle files', onclick: () => hooks.importFiles() }, '＋'),
        ),
      ),
      this.tabsEl,
      search,
      this.welcome,
      this.scroller,
      this.summary,
    );
    this.scroller.addEventListener('scroll', () => this.renderWindow());
    new ResizeObserver(() => this.renderWindow()).observe(this.scroller);
    const refresh = rafThrottle(() => this.refresh());
    ws.on('assets', refresh);
    this.refresh(true);
  }

  setTab(tab: Tab): void {
    this.tab = tab;
    this.scroller.scrollTop = 0;
    this.refresh(true);
  }

  refresh(force = false): void {
    const vfs = this.ws.assets.vfs;
    if (!force && vfs.version === this.lastVersion) return;
    this.lastVersion = vfs.version;
    const all = this.ws.assets.list();
    const counts = new Map<Tab, number>();
    for (const f of all) {
      const k = this.ws.assets.kindOf(f);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    counts.set('all', all.length);
    this.tabsEl.replaceChildren(
      ...TABS.map((t) =>
        h(
          'button',
          { class: `asset-tab${t.id === this.tab ? ' active' : ''}`, title: t.label, onclick: () => this.setTab(t.id) },
          h('span', { class: 'tab-icon' }, t.icon),
          h('span', { class: 'tab-label' }, t.label),
          h('span', { class: 'tab-count' }, String(counts.get(t.id) ?? 0)),
        ),
      ),
    );
    const q = this.query;
    this.items = all.filter((f) => (this.tab === 'all' || this.ws.assets.kindOf(f) === this.tab) && (!q || f.path.toLowerCase().includes(q)));
    const empty = all.length === 0;
    this.welcome.style.display = empty ? '' : 'none';
    this.scroller.style.display = empty ? 'none' : '';
    const pak = this.ws.assets.pak ? `${this.ws.assets.pakName}: ${this.ws.assets.pak.entries.length} files` : 'no pak';
    const imported = all.filter((f) => f.origin !== 'pak').length;
    this.summary.textContent = `${this.items.length} shown · ${pak}${imported ? ` · ${imported} imported` : ''}`;
    this.renderWindow();
  }

  private get gridMode(): boolean {
    return this.tab === 'image';
  }

  private renderWindow() {
    const width = this.scroller.clientWidth || 240;
    const cols = this.gridMode ? Math.max(1, Math.floor(width / CELL_W)) : 1;
    const rowH = this.gridMode ? CELL_H : ROW_H;
    const rows = Math.ceil(this.items.length / cols);
    this.inner.style.height = `${rows * rowH}px`;
    const top = this.scroller.scrollTop;
    const first = Math.max(0, Math.floor(top / rowH) - 2);
    const last = Math.min(rows - 1, Math.ceil((top + this.scroller.clientHeight) / rowH) + 2);
    const nodes: HTMLElement[] = [];
    for (let r = first; r <= last; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const f = this.items[idx];
        if (!f) break;
        const el = this.gridMode ? this.cell(f) : this.row(f);
        el.style.top = `${r * rowH}px`;
        if (this.gridMode) {
          el.style.left = `${c * CELL_W}px`;
          el.style.width = `${CELL_W - 4}px`;
        }
        nodes.push(el);
      }
    }
    this.inner.replaceChildren(...nodes);
  }

  private common(el: HTMLElement, f: VFile) {
    const kind = this.ws.assets.kindOf(f);
    el.draggable = true;
    el.title = `${f.path}\n${formatBytes(f.size)} · ${f.origin === 'pak' ? 'from main.pak' : 'imported'}`;
    if (f.path === this.selected) el.classList.add('sel');
    el.addEventListener('click', () => {
      this.selected = f.path;
      this.ws.selectedAsset = { kind, path: f.path };
      this.inner.querySelectorAll('.sel').forEach((n) => n.classList.remove('sel'));
      el.classList.add('sel');
    });
    el.addEventListener('dblclick', () => this.hooks.activate(f, kind));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.selected = f.path;
      this.ws.selectedAsset = { kind, path: f.path };
      this.hooks.assetMenu(f, kind, e);
    });
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(ASSET_MIME, JSON.stringify({ kind, path: f.path }));
      e.dataTransfer?.setData('text/plain', f.path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    });
  }

  private row(f: VFile): HTMLElement {
    const kind = this.ws.assets.kindOf(f);
    const icon = TABS.find((t) => t.id === kind)?.icon ?? '·';
    const sid = kind === 'sound' ? this.ws.assets.soundIdForPath(f.path) : undefined;
    const el = h(
      'div',
      { class: `asset-row ${kind}${f.origin !== 'pak' ? ' imported' : ''}` },
      h('span', { class: 'asset-icon' }, icon),
      h('span', { class: 'asset-name' }, basename(f.path)),
      h('span', { class: 'asset-dir' }, sid ?? dirname(f.path)),
      kind === 'sound'
        ? h(
            'button',
            {
              class: 'icon-btn play-btn',
              title: 'Preview sound',
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                void previewSound(this.ws, f.path);
              },
            },
            '▶',
          )
        : null,
    );
    this.common(el, f);
    return el;
  }

  private cell(f: VFile): HTMLElement {
    const el = h(
      'div',
      { class: `asset-cell${f.origin !== 'pak' ? ' imported' : ''}` },
      thumbnail(this.ws, f.path, 64),
      h('div', { class: 'asset-cell-name' }, basename(f.path)),
    );
    this.common(el, f);
    return el;
  }
}
