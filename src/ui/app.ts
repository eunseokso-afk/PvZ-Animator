/** Application shell: layout, menus, shortcuts, file import and wiring between panels. */

import { loadDemoAssets } from '../demo';
import type { AssetKind } from '../engine/assets';
import { apply, invert } from '../engine/math';
import { interpolateTransform, transformMatrix } from '../engine/reanimRuntime';
import { basename, extname, IMAGE_EXTS, SOUND_EXTS, stripExt, type VFile } from '../engine/vfs';
import { isAnimTrackName } from '../formats/reanim';
import { ReanimDocument } from '../editor/reanimDoc';
import type { EditorDocument, Workspace } from '../editor/workspace';
import { AssetBrowser } from './assetBrowser';
import { downloadBlob, h, isTextInput, pickFiles } from './dom';
import { applyToLibrary, exportCurrentDoc, exportFrames, exportPak, exportVideo, extractFile, loadProject, saveProject } from './exporters';
import { ReanimInspector } from './inspector';
import { ParticleInspector, ParticlePanel } from './particleEditor';
import { clearThumbnails, pickAsset, pickImage, previewSound } from './pickers';
import { Timeline } from './timeline';
import { Viewport } from './viewport';
import { alertDialog, closeMenus, confirmDialog, openDialog, promptText, showMenu, toast, type MenuItem } from './widgets';

const LAYOUT_KEY = 'pvz-animator-layout';

interface Layout {
  left: number;
  right: number;
  bottom: number;
}

export class App {
  readonly root: HTMLElement;
  private viewport: Viewport;
  private timeline: Timeline;
  private reanimInspector: ReanimInspector;
  private particleInspector: ParticleInspector;
  private particlePanel: ParticlePanel;
  private browser: AssetBrowser;
  private rightHost: HTMLElement;
  private bottomHost: HTMLElement;
  private statusText: HTMLElement;
  private statusRight: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private layout: Layout;

  constructor(private ws: Workspace) {
    this.layout = this.loadLayout();
    const welcome = this.buildWelcome();
    this.viewport = new Viewport(ws, { welcome });
    this.viewport.requestClose = (doc) => this.closeDoc(doc);
    this.viewport.trackMenu = (doc, ti) => this.trackMenu(doc, ti);
    this.viewport.dropHandler = (doc, asset, x, y, under) => void this.dropOnStage(doc, asset, x, y, under);
    this.timeline = new Timeline(ws, {
      trackMenu: (doc, ti) => this.trackMenu(doc, ti),
      editRange: (doc, name) => void this.editRange(doc, name),
      addSoundCue: (doc, frame) => void this.addSoundCue(doc, frame),
      addParticleCue: (doc, frame) => void this.addParticleCue(doc, frame),
      renameTrack: (doc, ti) => void this.renameTrack(doc, ti),
      previewSound: (p) => p && void previewSound(ws, p),
    });
    this.reanimInspector = new ReanimInspector(ws);
    this.particleInspector = new ParticleInspector(ws);
    this.particlePanel = new ParticlePanel(ws, this.viewport);
    this.browser = new AssetBrowser(ws, {
      openPak: () => void this.openPak(),
      openFolder: () => void this.openFolder(),
      importFiles: (accept) => void this.importFiles(accept),
      loadDemo: () => void this.loadDemo(),
      assetMenu: (f, kind, e) => this.assetMenu(f, kind, e),
      activate: (f, kind) => void this.activateAsset(f, kind),
    });
    this.rightHost = h('aside', { class: 'right-panel' });
    this.bottomHost = h('section', { class: 'bottom-panel' });
    this.statusText = h('span', { class: 'status-text' }, 'Ready. Open main.pak or try the demo assets to get started.');
    this.statusRight = h('span', { class: 'status-right' });

    const left = h('aside', { class: 'left-panel' }, this.browser.el);
    const main = h(
      'div',
      { class: 'main' },
      left,
      this.splitter('left'),
      h('section', { class: 'center-panel' }, this.viewport.el),
      this.splitter('right'),
      this.rightHost,
    );
    this.root = h(
      'div',
      { class: 'app' },
      this.buildMenubar(),
      main,
      this.splitter('bottom'),
      this.bottomHost,
      h('footer', { class: 'statusbar' }, this.statusText, this.statusRight),
    );
    this.applyLayout();

    ws.on('status', (e) => {
      const { message, level } = e.detail as { message: string; level: 'info' | 'error' | 'success' };
      this.statusText.textContent = message;
      this.statusText.className = `status-text ${level}`;
      if (level === 'error') toast(message, 'error', 6000);
    });
    ws.on('docs', () => this.swapPanels());
    ws.on('change', () => this.updateChrome());
    ws.on('assets', (e) => {
      if ((e.detail as { scope?: string } | undefined)?.scope !== 'definitions') clearThumbnails();
      this.updateChrome();
    });
    ws.on('settings', () => this.updateChrome());
    this.swapPanels();
    this.bindKeys();
    this.bindFileDrop();
    window.addEventListener('beforeunload', (e) => {
      if (ws.docs.some((d) => d.dirty)) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  // ------------------------------------------------------------ layout

  private loadLayout(): Layout {
    const def: Layout = { left: 270, right: 320, bottom: 250 };
    try {
      return { ...def, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') };
    } catch {
      return def;
    }
  }

  private applyLayout() {
    const s = this.root.style;
    s.setProperty('--left-w', `${this.layout.left}px`);
    s.setProperty('--right-w', `${this.layout.right}px`);
    s.setProperty('--bottom-h', `${this.layout.bottom}px`);
  }

  private splitter(which: 'left' | 'right' | 'bottom'): HTMLElement {
    const el = h('div', { class: `splitter ${which === 'bottom' ? 'horizontal' : 'vertical'}` });
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const start = { ...this.layout };
      const sx = e.clientX;
      const sy = e.clientY;
      const move = (ev: PointerEvent) => {
        if (which === 'left') this.layout.left = Math.min(600, Math.max(170, start.left + ev.clientX - sx));
        if (which === 'right') this.layout.right = Math.min(700, Math.max(220, start.right - (ev.clientX - sx)));
        if (which === 'bottom') this.layout.bottom = Math.min(window.innerHeight - 200, Math.max(120, start.bottom - (ev.clientY - sy)));
        this.applyLayout();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        try {
          localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.layout));
        } catch {
          /* ignore */
        }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    return el;
  }

  private swapPanels() {
    const doc = this.ws.active;
    const right = doc?.kind === 'particle' ? this.particleInspector.el : this.reanimInspector.el;
    const bottom = doc?.kind === 'particle' ? this.particlePanel.el : this.timeline.el;
    if (this.rightHost.firstChild !== right) this.rightHost.replaceChildren(right);
    if (this.bottomHost.firstChild !== bottom) this.bottomHost.replaceChildren(bottom);
    if (doc?.kind === 'particle') {
      this.particleInspector.refresh(true);
      this.particlePanel.refresh();
    } else {
      this.reanimInspector.refresh();
      this.timeline.draw();
      if (!doc) this.reanimInspector.el.replaceChildren(h('div', { class: 'insp-hint' }, h('p', null, 'No document open.'), h('p', { class: 'dim' }, 'Double-click a reanim or particle file in the asset browser, or create a new one from the File menu.')));
    }
    this.updateChrome();
  }

  private updateChrome() {
    const doc = this.ws.active;
    if (this.undoBtn) {
      this.undoBtn.disabled = !doc?.undoLabel;
      this.undoBtn.title = doc?.undoLabel ? `Undo ${doc.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
      this.redoBtn.disabled = !doc?.redoLabel;
      this.redoBtn.title = doc?.redoLabel ? `Redo ${doc.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
    }
    const files = this.ws.assets.vfs.size;
    this.statusRight.textContent = `${this.viewport.rendererKind === 'webgl2' ? 'WebGL2' : 'Canvas'} · ${files} files${doc ? ` · ${Math.round(doc.view.zoom * 100)}%` : ''}`;
    document.title = doc ? `${doc.name}${doc.dirty ? ' •' : ''} — PvZ Animator` : 'PvZ Animator';
  }

  // ------------------------------------------------------------ menubar

  private buildMenubar(): HTMLElement {
    const menu = (label: string, items: () => MenuItem[]) => {
      const btn = h('button', { class: 'menu-btn' }, label);
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const r = btn.getBoundingClientRect();
        showMenu(items(), r.left, r.bottom + 2);
      });
      return btn;
    };
    this.undoBtn = h('button', { class: 'tool-btn', title: 'Undo', onclick: () => this.undo() }, '↶');
    this.redoBtn = h('button', { class: 'tool-btn', title: 'Redo', onclick: () => this.redo() }, '↷');
    return h(
      'header',
      { class: 'menubar' },
      h('div', { class: 'logo', title: 'PvZ Animator' }, h('span', { class: 'logo-mark' }, '❀'), h('span', null, 'PvZ Animator')),
      menu('File', () => this.fileMenu()),
      menu('Edit', () => this.editMenu()),
      menu('View', () => this.viewMenu()),
      menu('Help', () => this.helpMenu()),
      h('div', { class: 'menubar-sep' }),
      this.undoBtn,
      this.redoBtn,
      h('div', { class: 'menubar-sep' }),
      h('button', { class: 'tool-btn labeled', title: 'Open main.pak (Ctrl+O)', onclick: () => void this.openPak() }, '📦 main.pak'),
      h('button', { class: 'tool-btn labeled', title: 'Import sounds (.ogg, .au, .wav, .mp3)', onclick: () => void this.importFiles('audio/*,.ogg,.au,.wav,.mp3') }, '♪ Sounds'),
      h('button', { class: 'tool-btn labeled', title: 'Import images (.png, .jpg)', onclick: () => void this.importFiles('image/*,.png,.jpg,.jpeg,.gif') }, '▣ Images'),
      h('div', { class: 'menubar-sep' }),
      h('button', { class: 'tool-btn labeled', title: 'New reanim animation', onclick: () => this.ws.newReanim() }, '＋ Reanim'),
      h('button', { class: 'tool-btn labeled', title: 'New particle effect', onclick: () => this.ws.newParticle() }, '＋ Particle'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'tool-btn labeled accent', title: 'Merge your changes into a new main.pak', onclick: () => void exportPak(this.ws) }, '⬇ Build main.pak'),
    );
  }

  private fileMenu(): MenuItem[] {
    const ws = this.ws;
    const doc = ws.active;
    return [
      { label: 'Open main.pak…', shortcut: 'Ctrl+O', action: () => void this.openPak() },
      { label: 'Open extracted game folder…', action: () => void this.openFolder() },
      { label: 'Import files…', action: () => void this.importFiles() },
      { label: 'Import sounds…', action: () => void this.importFiles('audio/*,.ogg,.au,.wav,.mp3') },
      { label: 'Load demo assets', action: () => void this.loadDemo() },
      { separator: true },
      { label: 'New reanim', action: () => ws.newReanim() },
      { label: 'New particle effect', action: () => ws.newParticle() },
      { separator: true },
      { label: 'Open project…', action: () => void this.openProject() },
      { label: 'Save project…', shortcut: 'Ctrl+S', action: () => void saveProject(ws) },
      { separator: true },
      { label: 'Save document to library', shortcut: 'Ctrl+Shift+S', disabled: !doc, action: () => doc && this.saveToLibrary(doc) },
      { label: doc?.kind === 'particle' ? 'Export particle .xml…' : 'Export .reanim…', shortcut: 'Ctrl+E', disabled: !doc, action: () => exportCurrentDoc(ws) },
      { label: 'Build main.pak…', shortcut: 'Ctrl+Shift+E', action: () => void exportPak(ws) },
      { label: 'Export video (WebM, with sound)…', disabled: doc?.kind !== 'reanim', action: () => void exportVideo(ws) },
      { label: 'Export PNG frames / sprite sheet…', disabled: doc?.kind !== 'reanim', action: () => void exportFrames(ws) },
      { separator: true },
      { label: 'Close document', shortcut: 'Alt+W', disabled: !doc, action: () => doc && void this.closeDoc(doc) },
    ];
  }

  private editMenu(): MenuItem[] {
    const ws = this.ws;
    const doc = ws.active;
    const r = ws.reanim;
    const ti = r?.ui.track ?? -1;
    const items: MenuItem[] = [
      { label: doc?.undoLabel ? `Undo ${doc.undoLabel}` : 'Undo', shortcut: 'Ctrl+Z', disabled: !doc?.undoLabel, action: () => this.undo() },
      { label: doc?.redoLabel ? `Redo ${doc.redoLabel}` : 'Redo', shortcut: 'Ctrl+Y', disabled: !doc?.redoLabel, action: () => this.redo() },
    ];
    if (r) {
      items.push(
        { separator: true },
        { label: 'Add part from image…', action: () => void this.addPartFromPicker(r) },
        { label: 'Copy pose', shortcut: 'Ctrl+C', disabled: ti < 0, action: () => this.copyPose() },
        { label: 'Paste pose', shortcut: 'Ctrl+V', disabled: ti < 0 || !ws.clipboard, action: () => this.pastePose() },
        { label: 'Toggle key', shortcut: 'K', disabled: ti < 0, action: () => this.toggleKey() },
        { separator: true },
        { label: 'Insert frame', shortcut: 'Shift+I', action: () => (r.insertFrames(r.ui.frame + 1, 1), ws.emit('change')) },
        { label: 'Delete frame', shortcut: 'Shift+Del', action: () => (r.deleteFrames(r.ui.frame, 1), ws.emit('change')) },
        { label: 'New animation range…', action: () => void this.editRange(r) },
        { label: 'Add sound cue…', action: () => void this.addSoundCue(r, r.ui.frame) },
        { label: 'Add particle cue…', action: () => void this.addParticleCue(r, r.ui.frame) },
        {
          label: 'Simplify keys on all parts',
          action: () => {
            r.checkpoint('Simplify keys');
            r.state.tracks.forEach((_, i) => r.simplifyTrack(i));
            ws.emit('change');
          },
        },
      );
      if (ti >= 0) items.push({ separator: true }, { label: 'Part', submenu: this.trackMenu(r, ti) });
    }
    items.push(
      { separator: true },
      {
        label: 'Detect tweens when opening reanims',
        checked: ws.settings.simplifyOnImport,
        action: () => {
          ws.settings.simplifyOnImport = !ws.settings.simplifyOnImport;
          ws.saveSettings();
        },
      },
      {
        label: 'Embed cues in exported reanims',
        checked: ws.settings.embedCues,
        action: () => {
          ws.settings.embedCues = !ws.settings.embedCues;
          ws.saveSettings();
        },
      },
    );
    return items;
  }

  private viewMenu(): MenuItem[] {
    const ws = this.ws;
    const s = ws.settings;
    const toggle = (key: 'grid' | 'onion' | 'showBounds' | 'lawnGuide') => () => {
      s[key] = !s[key];
      ws.saveSettings();
    };
    return [
      { label: 'Fit to view', shortcut: 'F', action: () => this.viewport.fit() },
      { label: 'Zoom 100%', shortcut: '0', action: () => this.viewport.setZoom(1) },
      { label: 'Zoom in', shortcut: '+', action: () => this.zoomBy(1.25) },
      { label: 'Zoom out', shortcut: '-', action: () => this.zoomBy(0.8) },
      { separator: true },
      { label: 'Onion skin', shortcut: 'O', checked: s.onion, action: toggle('onion') },
      { label: 'Grid', shortcut: 'G', checked: s.grid, action: toggle('grid') },
      { label: 'Show part outlines', shortcut: 'B', checked: s.showBounds, action: toggle('showBounds') },
      { label: 'Lawn cell guide (80×100)', shortcut: 'L', checked: s.lawnGuide, action: toggle('lawnGuide') },
      {
        label: 'Background',
        submenu: (['dark', 'light', 'checker', 'lawn', 'night'] as const).map((b) => ({
          label: b[0].toUpperCase() + b.slice(1),
          checked: s.background === b,
          action: () => {
            s.background = b;
            ws.saveSettings();
          },
        })),
      },
    ];
  }

  private helpMenu(): MenuItem[] {
    return [
      { label: 'Keyboard shortcuts', shortcut: '?', action: () => void this.showShortcuts() },
      { label: 'About the formats', action: () => void this.showFormats() },
    ];
  }

  private zoomBy(f: number) {
    const doc = this.ws.active;
    if (doc) this.viewport.setZoom(doc.view.zoom * f);
  }

  private buildWelcome(): HTMLElement {
    return h(
      'div',
      { class: 'welcome' },
      h('div', { class: 'welcome-logo' }, '❀'),
      h('h1', null, 'PvZ Animator'),
      h('p', { class: 'welcome-sub' }, 'Edit Plants vs. Zombies reanim animations and particle effects, sync them with sounds, and pack them back into main.pak.'),
      h(
        'div',
        { class: 'welcome-actions' },
        h('button', { class: 'btn primary big', onclick: () => void this.openPak() }, '📦 Open main.pak'),
        h('button', { class: 'btn big', onclick: () => void this.loadDemo() }, '✨ Try demo assets'),
      ),
      h(
        'div',
        { class: 'welcome-actions' },
        h('button', { class: 'btn', onclick: () => this.ws.newReanim() }, '＋ New reanim'),
        h('button', { class: 'btn', onclick: () => this.ws.newParticle() }, '＋ New particle effect'),
        h('button', { class: 'btn', onclick: () => void this.openFolder() }, '📁 Open game folder'),
        h('button', { class: 'btn', onclick: () => void this.openProject() }, '📂 Open project'),
      ),
      h(
        'ol',
        { class: 'welcome-steps' },
        h('li', null, h('b', null, 'Load'), ' your main.pak — everything stays on your computer.'),
        h('li', null, h('b', null, 'Open'), ' a reanim (e.g. PeaShooterSingle) or particle file from the asset browser.'),
        h('li', null, h('b', null, 'Animate'), ': drag parts on the stage, set keys on the timeline, add sound and particle cues.'),
        h('li', null, h('b', null, 'Export'), ' a .reanim / .xml, a video, or a rebuilt main.pak.'),
      ),
      h('p', { class: 'dim small' }, 'Tip: you can also drop main.pak, a game folder, images or sounds anywhere on this window.'),
    );
  }

  // ------------------------------------------------------------ file actions

  private async openPak() {
    const [file] = await pickFiles({ accept: '.pak' });
    if (file) await this.loadPak(file);
  }

  private async loadPak(file: File) {
    this.ws.status(`Reading ${file.name}…`);
    try {
      const n = await this.ws.assets.openPak(file, file.name);
      this.ws.status(`Opened ${file.name}: ${n} files.`, 'success');
      this.browser.setTab('reanim');
    } catch (e) {
      this.ws.status(`Could not open ${file.name}: ${(e as Error).message}`, 'error');
    }
  }

  private async openFolder() {
    const files = await pickFiles({ directory: true });
    if (files.length) await this.importFileList(files.map((f) => ({ file: f, rel: f.webkitRelativePath || f.name })), true);
  }

  private async importFiles(accept?: string) {
    const files = await pickFiles({ multiple: true, accept });
    if (files.length) await this.importFileList(files.map((f) => ({ file: f, rel: f.name })), false);
  }

  private async openProject() {
    const [file] = await pickFiles({ accept: '.json,.pvzanim.json' });
    if (!file) return;
    try {
      await loadProject(this.ws, file);
    } catch (e) {
      this.ws.status(`Could not open project: ${(e as Error).message}`, 'error');
    }
  }

  private async loadDemo() {
    try {
      await loadDemoAssets(this.ws);
    } catch (e) {
      this.ws.status(`Demo failed: ${(e as Error).message}`, 'error');
    }
  }

  /** Decide where a loose file goes inside the game folder. */
  private async placeLoose(file: File): Promise<string> {
    const name = file.name;
    const lower = name.toLowerCase();
    const ext = extname(lower);
    if (lower === 'resources.xml') return 'properties/resources.xml';
    if (lower.endsWith('.reanim.compiled')) return `compiled/reanim/${name}`;
    if (lower.endsWith('.xml.compiled')) return `compiled/particles/${name}`;
    if (ext === 'reanim') return `reanim/${name}`;
    if (ext === 'xml') return `particles/${name}`;
    if (SOUND_EXTS.includes(ext)) return `sounds/${name}`;
    if (IMAGE_EXTS.includes(ext)) return `${this.ws.active?.kind === 'particle' ? 'particles' : 'reanim'}/${name}`;
    return name;
  }

  private async importFileList(items: { file: File; rel: string }[], fromFolder: boolean): Promise<string[]> {
    const ws = this.ws;
    const pak = items.find((i) => i.file.name.toLowerCase() === 'main.pak');
    if (pak) await this.loadPak(pak.file);
    const project = items.find((i) => i.file.name.toLowerCase().endsWith('.pvzanim.json'));
    if (project && !fromFolder) {
      await loadProject(ws, project.file);
      return [];
    }
    const known = (p: string) => {
      const lower = p.toLowerCase();
      const ext = extname(lower);
      return ext === 'reanim' || ext === 'xml' || ext === 'txt' || lower.endsWith('.compiled') || IMAGE_EXTS.includes(ext) || SOUND_EXTS.includes(ext);
    };
    const out: { path: string; blob: Blob }[] = [];
    for (const it of items) {
      if (it === pak || it === project) continue;
      let path: string;
      if (fromFolder) {
        // Strip the selected folder's own name.
        path = it.rel.replace(/\\/g, '/').split('/').slice(1).join('/') || it.file.name;
        if (!known(path)) continue;
      } else {
        path = await this.placeLoose(it.file);
      }
      out.push({ path, blob: it.file });
    }
    if (out.length) {
      await ws.assets.importFiles(out);
      ws.status(`Imported ${out.length} file${out.length === 1 ? '' : 's'}${out.length === 1 ? `: ${out[0].path}` : ''}.`, 'success');
      const first = out[0];
      const kind = ws.assets.kindOf(ws.assets.vfs.get(first.path)!);
      if (out.length === 1 && (kind === 'reanim' || kind === 'particle')) await ws.openAsset(first.path);
      else if (out.every((o) => ws.assets.kindOf(ws.assets.vfs.get(o.path)!) === kind)) this.browser.setTab(kind);
    } else if (!pak) {
      ws.status('No supported files found (images, sounds, .reanim, particle .xml).', 'error');
    }
    return out.map((o) => o.path);
  }

  private bindFileDrop() {
    const isFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragover', (e) => {
      if (isFiles(e)) {
        e.preventDefault();
        this.root.classList.add('drop-target');
      }
    });
    window.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) this.root.classList.remove('drop-target');
    });
    window.addEventListener('drop', async (e) => {
      this.root.classList.remove('drop-target');
      if (!isFiles(e)) return;
      e.preventDefault();
      const entries = [...(e.dataTransfer?.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
      const items: { file: File; rel: string }[] = [];
      let folder = false;
      const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
        if (entry.isFile) {
          const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
          items.push({ file, rel: prefix + entry.name });
        } else if (entry.isDirectory) {
          folder = true;
          const reader = (entry as FileSystemDirectoryEntry).createReader();
          for (;;) {
            const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
            if (!batch.length) break;
            for (const child of batch) await walk(child, prefix + entry.name + '/');
          }
        }
      };
      if (entries.length) {
        for (const en of entries) await walk(en, '');
      } else {
        for (const f of e.dataTransfer?.files ?? []) items.push({ file: f, rel: f.name });
      }
      if (folder) await this.importFileList(items.filter((i) => i.rel.includes('/')), true);
      const loose = items.filter((i) => !i.rel.includes('/'));
      if (!loose.length) return;
      const paths = await this.importFileList(loose, false);
      this.placeDroppedFiles(paths, e.clientX, e.clientY);
    });
  }

  /** Files dropped from the desktop onto the stage become parts; onto the timeline, sound cues. */
  private placeDroppedFiles(paths: string[], clientX: number, clientY: number) {
    const doc = this.ws.reanim;
    if (!doc || !paths.length) return;
    const kinds = paths.map((p) => this.ws.assets.kindOf(this.ws.assets.vfs.get(p)!));
    const frame = this.timeline.frameAtClient(clientX, clientY);
    if (frame !== null) {
      paths.forEach((p, i) => {
        if (kinds[i] !== 'sound') return;
        const cue = doc.addSoundCue(frame, p);
        doc.ui.cue = { kind: 'sound', uid: cue.uid };
      });
      this.ws.emit('change');
      return;
    }
    const pos = this.viewport.stagePoint(clientX, clientY);
    if (!pos) return;
    paths.forEach((p, i) => {
      if (kinds[i] === 'image' || kinds[i] === 'sound' || kinds[i] === 'particle') this.viewport.onAssetDrop({ kind: kinds[i], path: p }, [pos[0] + i * 12, pos[1] + i * 12]);
    });
  }

  // ------------------------------------------------------------ documents

  private saveToLibrary(doc: EditorDocument) {
    applyToLibrary(this.ws, doc);
    this.ws.status(`Saved ${doc.path} to the library (included in Build main.pak).`, 'success');
  }

  private async closeDoc(doc: EditorDocument) {
    if (doc.dirty) {
      const r = await openDialog({
        title: 'Close document',
        body: h('div', { class: 'dialog-text' }, `"${doc.name}" has changes that are not in the library or an exported file.`),
        buttons: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Discard', value: 'discard', danger: true },
          { label: 'Save to library', value: 'save', primary: true },
        ],
      });
      if (r === 'save') applyToLibrary(this.ws, doc);
      else if (r !== 'discard') return;
    }
    this.ws.closeDoc(doc);
  }

  private undo() {
    const doc = this.ws.active;
    if (doc?.undo()) {
      this.ws.invalidatePreviews();
      this.ws.emit('change');
      this.ws.status(`Undo: ${doc.redoLabel ?? ''}`);
    }
  }

  private redo() {
    const doc = this.ws.active;
    if (doc?.redo()) {
      this.ws.invalidatePreviews();
      this.ws.emit('change');
      this.ws.status(`Redo: ${doc.undoLabel ?? ''}`);
    }
  }

  // ------------------------------------------------------------ reanim helpers

  trackMenu(doc: ReanimDocument, ti: number): MenuItem[] {
    const ws = this.ws;
    const track = doc.state.tracks[ti];
    if (!track) return [];
    const n = doc.state.tracks.length;
    const emit = () => ws.emit('change');
    return [
      { label: 'Rename…', shortcut: 'F2', action: () => void this.renameTrack(doc, ti) },
      {
        label: 'Change image…',
        disabled: isAnimTrackName(track.name),
        action: async () => {
          const r = await pickImage(ws, `Image for "${track.name}" from frame ${doc.ui.frame}`, 'reanim', track.transforms[doc.ui.frame]?.i);
          if (r) {
            doc.setFields(ti, doc.ui.frame, { i: r.id }, 'Change image');
            emit();
          }
        },
      },
      { label: 'Duplicate', shortcut: 'Ctrl+D', action: () => ((doc.ui.track = doc.duplicateTrack(ti)), emit()) },
      { label: 'Delete', shortcut: 'Del', action: () => (doc.removeTrack(ti), emit()) },
      { separator: true },
      { label: 'Bring to front', disabled: ti >= n - 1, action: () => (doc.moveTrack(ti, n - 1), emit()) },
      { label: 'Bring forward', shortcut: ']', disabled: ti >= n - 1, action: () => (doc.moveTrack(ti, ti + 1), emit()) },
      { label: 'Send backward', shortcut: '[', disabled: ti <= 0, action: () => (doc.moveTrack(ti, ti - 1), emit()) },
      { label: 'Send to back', disabled: ti <= 0, action: () => (doc.moveTrack(ti, 0), emit()) },
      { separator: true },
      {
        label: 'Hide in editor',
        shortcut: 'H',
        checked: doc.ui.hidden.has(track.uid),
        action: () => {
          if (!doc.ui.hidden.delete(track.uid)) doc.ui.hidden.add(track.uid);
          emit();
        },
      },
      {
        label: 'Lock',
        checked: doc.ui.locked.has(track.uid),
        action: () => {
          if (!doc.ui.locked.delete(track.uid)) doc.ui.locked.add(track.uid);
          emit();
        },
      },
      {
        label: 'Simplify keys',
        action: () => {
          doc.checkpoint('Simplify keys');
          doc.simplifyTrack(ti);
          emit();
        },
      },
      { label: 'Add particle cue on this part…', action: () => void this.addParticleCue(doc, doc.ui.frame, track.name) },
    ];
  }

  private async renameTrack(doc: ReanimDocument, ti: number) {
    const track = doc.state.tracks[ti];
    if (!track) return;
    const name = await promptText('Rename part', 'Track name', track.name);
    if (name && name.trim() && name.trim() !== track.name) {
      doc.renameTrack(ti, doc.findTrack(name.trim()) >= 0 ? doc.uniqueTrackName(name.trim()) : name.trim());
      this.ws.emit('change');
    }
  }

  private async editRange(doc: ReanimDocument, name?: string) {
    const existing = name ? doc.animRanges().find((r) => r.name === name) : undefined;
    const lo = Math.min(doc.ui.frame, doc.ui.frameEnd);
    const hi = Math.max(doc.ui.frame, doc.ui.frameEnd);
    const nameInput = h('input', { type: 'text', value: existing?.name ?? 'anim_new', class: 'wide' });
    const startInput = h('input', { type: 'number', value: existing?.start ?? lo, min: 0, max: doc.frameCount - 1 });
    const endInput = h('input', { type: 'number', value: existing?.end ?? (hi > lo ? hi : doc.frameCount - 1), min: 0, max: doc.frameCount - 1 });
    const r = await openDialog({
      title: existing ? 'Edit animation range' : 'New animation range',
      body: h(
        'div',
        { class: 'form-col' },
        h('label', { class: 'field-col' }, 'Name (anim_ prefix is added if missing)', nameInput),
        h('div', { class: 'insp-grid2' }, h('label', { class: 'field-col' }, 'First frame', startInput), h('label', { class: 'field-col' }, 'Last frame', endInput)),
        h('p', { class: 'dim small' }, 'The game plays an animation by name (e.g. anim_idle). Shift-click frames on the timeline to pre-fill a range.'),
      ),
      buttons: [{ label: 'Cancel', value: 'cancel' }, ...(existing ? [{ label: 'Delete', value: 'delete', danger: true }] : []), { label: existing ? 'Apply' : 'Create', value: 'ok', primary: true }],
    });
    if (r === 'delete' && existing) {
      doc.removeAnimRange(existing.name);
    } else if (r === 'ok') {
      let n = nameInput.value.trim().replace(/\s+/g, '_') || 'anim_new';
      if (!isAnimTrackName(n)) n = 'anim_' + n;
      doc.setAnimRange(n, parseInt(startInput.value, 10) || 0, parseInt(endInput.value, 10) || 0, existing?.name);
      doc.ui.anim = n;
      doc.ui.frame = doc.ui.frameEnd = doc.activeRange().start;
    } else return;
    this.ws.emit('change');
  }

  private async addSoundCue(doc: ReanimDocument, frame: number) {
    const sel = this.ws.selectedAsset;
    const path = sel?.kind === 'sound' ? sel.path : await pickAsset(this.ws, 'sound', 'Add sound cue');
    if (!path) return;
    const cue = doc.addSoundCue(frame, path);
    doc.ui.cue = { kind: 'sound', uid: cue.uid };
    doc.ui.track = -1;
    this.ws.emit('change');
    this.ws.status(`Added sound cue ${basename(path)} at frame ${frame}.`);
  }

  private async addParticleCue(doc: ReanimDocument, frame: number, track = '') {
    const sel = this.ws.selectedAsset;
    const path = sel?.kind === 'particle' ? sel.path : await pickAsset(this.ws, 'particle', 'Add particle cue');
    if (!path) return;
    if (!track && doc.ui.track >= 0 && !isAnimTrackName(doc.state.tracks[doc.ui.track]?.name ?? '')) track = doc.state.tracks[doc.ui.track].name;
    const cue = doc.addParticleCue(frame, path, track);
    doc.ui.cue = { kind: 'particle', uid: cue.uid };
    this.ws.invalidatePreviews();
    this.ws.emit('change');
  }

  private async addPartFromPicker(doc: ReanimDocument) {
    const r = await pickImage(this.ws, 'Add part from image', 'reanim');
    if (!r) return;
    await this.addPart(doc, r.path, r.id, 0, 0);
  }

  private async addPart(doc: ReanimDocument, path: string, id: string, cx: number, cy: number) {
    const img = await this.ws.assets.loadImage(id);
    const w = img?.celWidth ?? 0;
    const hh = img?.celHeight ?? 0;
    const name = stripExt(basename(path)).toLowerCase();
    const ti = doc.addTrack(name, id, Math.round(cx - w / 2), Math.round(cy - hh / 2));
    doc.ui.track = ti;
    doc.ui.cue = null;
    this.ws.emit('change');
    this.ws.status(`Added part "${doc.state.tracks[ti].name}" (${id}).`);
  }

  private async dropOnStage(doc: ReanimDocument, asset: { kind: string; path: string }, x: number, y: number, under: number) {
    const ws = this.ws;
    if (asset.kind === 'image') {
      await this.addPart(doc, asset.path, ws.assets.imageIdForPath(asset.path), x, y);
    } else if (asset.kind === 'sound') {
      const cue = doc.addSoundCue(doc.ui.frame, asset.path);
      doc.ui.cue = { kind: 'sound', uid: cue.uid };
      ws.emit('change');
    } else if (asset.kind === 'particle') {
      let track = '';
      let lx = x;
      let ly = y;
      if (under >= 0) {
        const t = doc.state.tracks[under];
        const inv = invert(transformMatrix(interpolateTransform(t.transforms, ws.frameTime(doc))));
        if (inv) {
          track = t.name;
          [lx, ly] = apply(inv, x, y);
        }
      }
      const cue = doc.addParticleCue(doc.ui.frame, asset.path, track, Math.round(lx), Math.round(ly));
      doc.ui.cue = { kind: 'particle', uid: cue.uid };
      ws.invalidatePreviews();
      ws.emit('change');
    } else if (asset.kind === 'reanim' || asset.kind === 'particle') {
      void ws.openAsset(asset.path);
    }
  }

  private copyPose() {
    const doc = this.ws.reanim;
    const t = doc?.selectedTrack?.transforms[doc.ui.frame];
    if (t) {
      this.ws.clipboard = { ...t };
      this.ws.status('Copied pose.');
      this.ws.emit('change');
    }
  }

  private pastePose() {
    const doc = this.ws.reanim;
    const c = this.ws.clipboard;
    if (!doc || !c || doc.ui.track < 0) return;
    const lo = Math.min(doc.ui.frame, doc.ui.frameEnd);
    const hi = Math.max(doc.ui.frame, doc.ui.frameEnd);
    doc.checkpoint('Paste pose');
    for (let f = lo; f <= hi; f++) doc.setFields(doc.ui.track, f, { x: c.x, y: c.y, kx: c.kx, ky: c.ky, sx: c.sx, sy: c.sy, a: c.a });
    this.ws.emit('change');
  }

  private toggleKey() {
    const doc = this.ws.reanim;
    if (!doc || doc.ui.track < 0) return;
    doc.toggleKey(doc.ui.track, doc.ui.frame);
    this.ws.emit('change');
  }

  // ------------------------------------------------------------ assets

  private assetMenu(f: VFile, kind: AssetKind, e: MouseEvent) {
    const ws = this.ws;
    const r = ws.reanim;
    const items: MenuItem[] = [];
    if (kind === 'reanim' || kind === 'particle') items.push({ label: 'Open', action: () => void ws.openAsset(f.path) });
    if (kind === 'image' && r) {
      items.push(
        { label: 'Add as new part', action: () => void this.addPart(r, f.path, ws.assets.imageIdForPath(f.path), 0, 0) },
        {
          label: 'Use for selected part (from current frame)',
          disabled: r.ui.track < 0,
          action: () => {
            r.setFields(r.ui.track, r.ui.frame, { i: ws.assets.imageIdForPath(f.path) }, 'Change image');
            ws.emit('change');
          },
        },
      );
    }
    if (kind === 'image' && ws.particle) {
      const p = ws.particle;
      items.push({ label: 'Use for selected emitter', action: () => (p.editEmitter('Change image', (em) => (em.image = ws.assets.imageIdForPath(f.path))), ws.emit('change')) });
    }
    if (kind === 'sound') {
      items.push({ label: 'Play', action: () => void previewSound(ws, f.path) });
      if (r) items.push({ label: `Add sound cue at frame ${r.ui.frame}`, action: () => ((ws.selectedAsset = { kind, path: f.path }), void this.addSoundCue(r, r.ui.frame)) });
    }
    if (kind === 'particle' && r) items.push({ label: `Add particle cue at frame ${r.ui.frame}`, action: () => ((ws.selectedAsset = { kind, path: f.path }), void this.addParticleCue(r, r.ui.frame)) });
    if (items.length) items.push({ separator: true });
    const id = kind === 'image' ? ws.assets.imageIdForPath(f.path) : kind === 'sound' ? ws.assets.soundIdForPath(f.path) : undefined;
    items.push(
      { label: 'Extract file…', action: () => void extractFile(f) },
      { label: 'Copy path', action: () => void navigator.clipboard?.writeText(f.path) },
      ...(id ? [{ label: `Copy id (${id})`, action: () => void navigator.clipboard?.writeText(id) }] : []),
    );
    if (f.origin !== 'pak') {
      items.push({
        label: 'Remove imported file',
        action: async () => {
          if (await confirmDialog('Remove file', `Remove ${f.path} from the library?`, 'Remove', true)) ws.assets.removeFile(f.path);
        },
      });
    }
    showMenu(items, e.clientX, e.clientY);
  }

  private async activateAsset(f: VFile, kind: AssetKind) {
    const ws = this.ws;
    if (kind === 'reanim' || kind === 'particle') await ws.openAsset(f.path);
    else if (kind === 'sound') await previewSound(ws, f.path);
    else if (kind === 'image') {
      if (ws.reanim) await this.addPart(ws.reanim, f.path, ws.assets.imageIdForPath(f.path), 0, 0);
      else if (ws.particle) {
        const p = ws.particle;
        p.editEmitter('Change image', (em) => (em.image = ws.assets.imageIdForPath(f.path)));
        ws.emit('change');
      }
    } else if (kind === 'other') {
      const data = await f.read();
      downloadBlob(new Blob([data as BlobPart]), basename(f.path));
    }
  }

  // ------------------------------------------------------------ keyboard

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (document.querySelector('.overlay')) return;
      if (isTextInput(e.target)) return;
      // Keep Space from also "clicking" whichever toolbar button has focus.
      if (e.key === ' ' && e.target instanceof HTMLButtonElement) e.target.blur();
      const ws = this.ws;
      const doc = ws.active;
      const r = ws.reanim;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key;
      const handled = () => {
        e.preventDefault();
        closeMenus();
      };
      if (ctrl) {
        const k = key.toLowerCase();
        if (k === 'z' && !e.shiftKey) return handled(), this.undo();
        if ((k === 'z' && e.shiftKey) || k === 'y') return handled(), this.redo();
        if (k === 's' && e.shiftKey) return handled(), doc && this.saveToLibrary(doc);
        if (k === 's') return handled(), void saveProject(ws);
        if (k === 'e' && e.shiftKey) return handled(), void exportPak(ws);
        if (k === 'e') return handled(), exportCurrentDoc(ws);
        if (k === 'o') return handled(), void this.openPak();
        if (k === 'c' && r) return handled(), this.copyPose();
        if (k === 'v' && r) return handled(), this.pastePose();
        if (k === 'd' && r && r.ui.track >= 0) return handled(), (r.ui.track = r.duplicateTrack(r.ui.track)), ws.emit('change');
        return;
      }
      if (e.altKey && key.toLowerCase() === 'w') return handled(), doc && void this.closeDoc(doc);
      if (key === '?') return handled(), void this.showShortcuts();
      if (key === 'f' || key === 'F') return handled(), this.viewport.fit();
      if (key === '0') return handled(), this.viewport.setZoom(1);
      if (key === '+' || key === '=') return handled(), this.zoomBy(1.25);
      if (key === '-') return handled(), this.zoomBy(0.8);
      const toggle = (k: 'grid' | 'onion' | 'showBounds' | 'lawnGuide') => {
        ws.settings[k] = !ws.settings[k];
        ws.saveSettings();
      };
      if (key === 'g') return handled(), toggle('grid');
      if (key === 'o') return handled(), toggle('onion');
      if (key === 'b') return handled(), toggle('showBounds');
      if (key === 'l') return handled(), toggle('lawnGuide');
      if (doc?.kind === 'particle') {
        if (key === ' ') return handled(), (doc.ui.playing = !doc.ui.playing), ws.emit('change');
        if (key === 'r') return handled(), this.viewport.restartParticles();
        return;
      }
      if (!r) return;
      if (key === ' ') return handled(), ws.togglePlay();
      const nudge = (dx: number, dy: number) => {
        if (r.ui.track < 0) return;
        const t = r.state.tracks[r.ui.track].transforms[r.ui.frame];
        r.setFields(r.ui.track, r.ui.frame, { x: t.x + dx, y: t.y + dy }, 'Nudge part');
        ws.emit('change');
      };
      const step = e.shiftKey ? 10 : 1;
      if (e.altKey && key.startsWith('Arrow')) {
        handled();
        if (key === 'ArrowLeft') nudge(-step, 0);
        if (key === 'ArrowRight') nudge(step, 0);
        if (key === 'ArrowUp') nudge(0, -step);
        if (key === 'ArrowDown') nudge(0, step);
        return;
      }
      if (key === 'ArrowLeft' || key === ',') return handled(), ws.stepFrame(-1);
      if (key === 'ArrowRight' || key === '.') return handled(), ws.stepFrame(1);
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        handled();
        const parts = r.state.tracks.map((t, i) => ({ t, i })).filter(({ t }) => !isAnimTrackName(t.name)).map(({ i }) => i).reverse();
        if (!parts.length) return;
        const pos = parts.indexOf(r.ui.track);
        const next = pos < 0 ? 0 : Math.max(0, Math.min(parts.length - 1, pos + (key === 'ArrowDown' ? 1 : -1)));
        r.ui.track = parts[next];
        r.ui.cue = null;
        ws.emit('change');
        return;
      }
      if (key === 'Home') return handled(), ws.setFrame(r.activeRange().start);
      if (key === 'End') return handled(), ws.setFrame(r.activeRange().end);
      if (key === 'k' || key === 'K') return handled(), this.toggleKey();
      if (key === 'I' && e.shiftKey) return handled(), r.insertFrames(r.ui.frame + 1, 1), ws.emit('change');
      if (key === 'F2' && r.ui.track >= 0) return handled(), void this.renameTrack(r, r.ui.track);
      if (key === 'h' && r.ui.track >= 0) {
        handled();
        const uid = r.state.tracks[r.ui.track].uid;
        if (!r.ui.hidden.delete(uid)) r.ui.hidden.add(uid);
        ws.emit('change');
        return;
      }
      if ((key === ']' || key === '[') && r.ui.track >= 0) {
        handled();
        const to = r.ui.track + (key === ']' ? 1 : -1);
        r.moveTrack(r.ui.track, to);
        ws.emit('change');
        return;
      }
      if (key === 'Delete' || key === 'Backspace') {
        handled();
        if (e.shiftKey) {
          r.deleteFrames(r.ui.frame, 1);
        } else if (r.ui.cue) {
          r.removeCue(r.ui.cue.kind, r.ui.cue.uid);
        } else if (r.ui.track >= 0) {
          r.removeTrack(r.ui.track);
        }
        ws.emit('change');
      }
    });
  }

  // ------------------------------------------------------------ help

  private async showShortcuts() {
    const rows: [string, string][] = [
      ['Space', 'Play / pause'],
      ['← / →  or  , / .', 'Previous / next frame'],
      ['Home / End', 'First / last frame of the animation'],
      ['↑ / ↓', 'Select part above / below'],
      ['Alt + arrows', 'Nudge selected part 1 px (Shift: 10 px)'],
      ['K', 'Toggle key at the current frame'],
      ['Shift+I / Shift+Del', 'Insert / delete frame'],
      ['Del', 'Delete selected part or cue'],
      ['[ / ]', 'Send part backward / forward'],
      ['H', 'Hide part in the editor'],
      ['F2', 'Rename part'],
      ['Ctrl+C / Ctrl+V', 'Copy / paste pose'],
      ['Ctrl+D', 'Duplicate part'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
      ['Ctrl+S', 'Save project'],
      ['Ctrl+Shift+S', 'Save document to library'],
      ['Ctrl+E / Ctrl+Shift+E', 'Export document / build main.pak'],
      ['F / 0 / + / -', 'Fit / 100% / zoom in / zoom out'],
      ['O / G / B / L', 'Onion skin / grid / outlines / lawn guide'],
      ['Mouse', 'Drag part to move · corner handles scale · top handle rotates (Shift snaps) · right/middle drag or drag empty space to pan · wheel zooms'],
      ['Timeline', 'Click to select · Shift-click for a range · double-click toggles a key · drag a key to move it · drag animation bar edges to resize'],
    ];
    await alertDialog('Keyboard shortcuts', h('table', { class: 'shortcut-table' }, rows.map(([k, v]) => h('tr', null, h('td', { class: 'mono' }, k), h('td', null, v)))));
  }

  private async showFormats() {
    await alertDialog(
      'About the formats',
      h(
        'div',
        { class: 'dialog-text formats' },
        h('h4', null, 'main.pak'),
        h('p', null, 'A PopCap archive: a directory of file names, sizes and timestamps followed by the file data, every byte XOR-ed with 0xF7. PvZ Animator reads it in place and can write a new one with your changes merged in.'),
        h('h4', null, 'Reanim (.reanim)'),
        h('p', null, 'Each track is one part (an image) with a transform per frame: x, y, kx/ky (skew = rotation in degrees), sx/sy (scale), a (alpha), f (0 visible, -1 hidden) and i (image id). Only changed values are written. Tracks named anim_* mark animation ranges. Compiled files (compiled/reanim/*.compiled) can be opened too and are saved as XML.'),
        h('h4', null, 'Particles (particles/*.xml)'),
        h('p', null, 'A list of <Emitter>s. Most properties are float tracks: "5", "[min max]" (random), "1,80 0" (value at 80% of the lifetime, then interpolate to the end) and curve keywords like EaseIn. Durations are in centiseconds.'),
        h('h4', null, 'Sounds & cues'),
        h('p', null, 'Sound and particle cues are an editor feature — the game triggers sounds from code. Cues are saved in projects and, optionally, in a hidden track (_pvzanim_cues) of exported reanims that the game ignores.'),
        h('h4', null, 'Images'),
        h('p', null, 'IMAGE_REANIM_FOO resolves to reanim/FOO.png (or a resources.xml entry); IMAGE_FOO to particles/FOO.png or images/FOO.png. JPEGs use _name.png alpha masks like the game does.'),
      ),
    );
  }
}
