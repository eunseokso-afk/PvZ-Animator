/**
 * Asset library: resolves PopCap resource ids (IMAGE_REANIM_*, SOUND_*) to
 * files in the virtual file system and decodes images, sounds and
 * definitions on demand.
 */

import { PakArchive } from '../formats/pak';
import { parseReanimXml, type ReanimDefinition } from '../formats/reanim';
import { parseCompiledReanim } from '../formats/reanimCompiled';
import { parseParticleXml, type ParticleDefinition } from '../formats/particles';
import { emptyManifest, parseResourcesXml, type ImageResource, type ResourceManifest } from '../formats/resources';
import { decodeText } from '../formats/xml';
import { basename, dirname, extname, IMAGE_EXTS, memoryFile, normPath, pathKey, SOUND_EXTS, stripExt, VirtualFS, type VFile } from './vfs';

export interface LoadedImage {
  path: string;
  source: HTMLCanvasElement | ImageBitmap;
  width: number;
  height: number;
  rows: number;
  cols: number;
  celWidth: number;
  celHeight: number;
  /** Unique per decode; renderers key GPU textures on it. */
  serial: number;
  alphaMask?: Uint8Array;
}

export type AssetKind = 'reanim' | 'particle' | 'image' | 'sound' | 'other';

let imageSerial = 1;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
};

export const RESOURCES_PATH = 'properties/resources.xml';

/** Directory search rules from the game's definition loader (gDefLoadResPaths). */
const ID_PREFIX_RULES: [string, string][] = [
  ['IMAGE_REANIM_', 'reanim/'],
  ['IMAGE_REANIM_', 'images/'],
  ['IMAGE_', 'particles/'],
  ['IMAGE_', 'images/'],
  ['IMAGE_', ''],
];

export function classify(path: string): AssetKind {
  const p = normPath(path).toLowerCase();
  const ext = extname(p);
  if (ext === 'reanim' || p.endsWith('.reanim.compiled')) return 'reanim';
  if (ext === 'xml' && (p.startsWith('particles/') || p.includes('/particles/'))) return 'particle';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (SOUND_EXTS.includes(ext)) return 'sound';
  return 'other';
}

export class AssetLibrary extends EventTarget {
  readonly vfs = new VirtualFS();
  manifest: ResourceManifest = emptyManifest();
  pak: PakArchive | null = null;
  pakName = '';

  private images = new Map<string, LoadedImage | null>();
  private imageLoads = new Map<string, Promise<LoadedImage | null>>();
  private reanims = new Map<string, Promise<ReanimDefinition | null>>();
  private reanimCache = new Map<string, ReanimDefinition | null>();
  private particles = new Map<string, Promise<ParticleDefinition | null>>();
  private particleCache = new Map<string, ParticleDefinition | null>();
  /** Lower-case paths of user-imported xml files that parse as particles. */
  private extraParticleXml = new Set<string>();
  private pathToImageId = new Map<string, string>();

  emitChange(): void {
    this.dispatchEvent(new Event('change'));
  }

  // ------------------------------------------------------------------ loading

  async openPak(file: Blob, name = 'main.pak'): Promise<number> {
    const pak = await PakArchive.open(file);
    this.vfs.clearOrigin('pak');
    for (const entry of pak.entries) {
      const path = normPath(entry.name);
      if (this.vfs.get(path)?.origin === 'import') continue; // user overrides win
      this.vfs.set({
        path,
        size: entry.size,
        origin: 'pak',
        fileTime: entry.fileTime,
        read: () => pak.read(entry),
        pak: { archive: pak, entry },
      });
    }
    this.pak = pak;
    this.pakName = name;
    await this.reloadManifest();
    this.invalidate();
    return pak.entries.length;
  }

  /**
   * Add loose files. `path` is where the file should live inside the game
   * folder. Files given as Blobs are read lazily.
   */
  async importFiles(files: { path: string; data?: Uint8Array; blob?: Blob }[], origin: 'import' | 'generated' | 'demo' = 'import'): Promise<void> {
    let manifestChanged = false;
    for (const f of files) {
      const path = normPath(f.path);
      let file: VFile;
      if (f.data) {
        file = memoryFile(path, f.data, origin);
      } else if (f.blob) {
        const blob = f.blob;
        file = { path, size: blob.size, origin, read: async () => new Uint8Array(await blob.arrayBuffer()) };
      } else continue;
      this.vfs.set(file);
      if (pathKey(path) === pathKey(RESOURCES_PATH)) manifestChanged = true;
      if (extname(path) === 'xml' && classify(path) !== 'particle' && file.size < 4 * 1024 * 1024) {
        const head = f.data ? f.data.subarray(0, 4096) : new Uint8Array(await f.blob!.slice(0, 4096).arrayBuffer());
        if (/<\s*emitter[\s>]/i.test(decodeText(head))) this.extraParticleXml.add(path.toLowerCase());
      }
    }
    if (manifestChanged) await this.reloadManifest();
    this.invalidate();
  }

  removeFile(path: string): void {
    if (this.vfs.delete(path)) this.invalidate();
  }

  private async reloadManifest(): Promise<void> {
    this.manifest = emptyManifest();
    const f = this.vfs.get(RESOURCES_PATH);
    if (f) {
      try {
        parseResourcesXml(decodeText(await f.read()), this.manifest);
      } catch (e) {
        console.warn('Failed to parse resources.xml', e);
      }
    }
    this.pathToImageId.clear();
    for (const res of this.manifest.images.values()) this.pathToImageId.set(pathKey(res.path), res.id);
  }

  /** Drop decoded caches (after files change). */
  invalidate(): void {
    this.images.clear();
    this.imageLoads.clear();
    this.reanims.clear();
    this.reanimCache.clear();
    this.particles.clear();
    this.particleCache.clear();
    this.emitChange();
  }

  // ------------------------------------------------------------------ listing

  kindOf(file: VFile): AssetKind {
    const k = classify(file.path);
    if (k === 'other' && this.extraParticleXml.has(file.path.toLowerCase())) return 'particle';
    return k;
  }

  list(kind?: AssetKind): VFile[] {
    const all = this.vfs.list();
    const out = kind ? all.filter((f) => this.kindOf(f) === kind) : all;
    return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  }

  // ------------------------------------------------------------------ images

  /** Resolve an image id or path to a file plus its cel layout. */
  resolveImage(ref: string): { file: VFile; res?: ImageResource } | null {
    if (!ref) return null;
    const upper = ref.toUpperCase();
    const res = this.manifest.images.get(upper);
    if (res && !res.path.startsWith('!')) {
      const file = this.vfs.findWithExt(res.path, IMAGE_EXTS);
      if (file) return { file, res };
    }
    for (const [prefix, dir] of ID_PREFIX_RULES) {
      if (upper.startsWith(prefix) && upper.length > prefix.length) {
        const file = this.vfs.findWithExt(dir + ref.slice(prefix.length), IMAGE_EXTS);
        if (file) return { file, res: this.resourceForPath(file.path) };
      }
    }
    const file = this.vfs.findWithExt(ref, IMAGE_EXTS);
    if (file) return { file, res: this.resourceForPath(file.path) };
    return null;
  }

  private resourceForPath(path: string): ImageResource | undefined {
    const id = this.pathToImageId.get(pathKey(stripExt(path)));
    return id ? this.manifest.images.get(id) : undefined;
  }

  /** The id the game would use to reference an image file. */
  imageIdForPath(path: string): string {
    const p = normPath(path);
    const id = this.pathToImageId.get(pathKey(stripExt(p)));
    if (id) return id;
    const dir = dirname(p).toLowerCase();
    const base = stripExt(basename(p)).toUpperCase();
    if (dir === 'reanim') return 'IMAGE_REANIM_' + base;
    if (dir === 'particles') return 'IMAGE_' + base;
    return 'IMAGE_' + stripExt(p).toUpperCase();
  }

  /** Synchronous lookup; starts loading if needed and returns undefined until ready. */
  image(ref: string): LoadedImage | null | undefined {
    if (!ref) return null;
    const key = ref.toUpperCase();
    if (this.images.has(key)) return this.images.get(key);
    void this.loadImage(ref);
    return undefined;
  }

  loadImage(ref: string): Promise<LoadedImage | null> {
    const key = ref.toUpperCase();
    let p = this.imageLoads.get(key);
    if (!p) {
      p = this.decodeImageRef(ref).then(
        (img) => {
          this.images.set(key, img);
          this.dispatchEvent(new Event('image'));
          return img;
        },
        (err) => {
          console.warn(`Failed to load image ${ref}`, err);
          this.images.set(key, null);
          return null;
        },
      );
      this.imageLoads.set(key, p);
    }
    return p;
  }

  private async decodeImageRef(ref: string): Promise<LoadedImage | null> {
    const found = this.resolveImage(ref);
    if (!found) return null;
    const { file, res } = found;
    let source: HTMLCanvasElement | ImageBitmap = await decodeImageFile(file);
    const alphaFile = this.findAlphaImage(file, res);
    if (alphaFile) {
      try {
        source = applyAlphaMask(source, await decodeImageFile(alphaFile));
      } catch (e) {
        console.warn('Alpha mask failed for', file.path, e);
      }
    }
    const rows = res?.rows ?? 1;
    const cols = res?.cols ?? 1;
    return {
      path: file.path,
      source,
      width: source.width,
      height: source.height,
      rows,
      cols,
      celWidth: Math.floor(source.width / cols),
      celHeight: Math.floor(source.height / rows),
      serial: imageSerial++,
    };
  }

  /** PopCap looks for "_name" or "name_" grayscale alpha images next to JPEGs. */
  private findAlphaImage(file: VFile, res?: ImageResource): VFile | undefined {
    if (res?.alphaImage) {
      const f = this.vfs.findWithExt(res.alphaImage, IMAGE_EXTS);
      if (f) return f;
    }
    const ext = extname(file.path);
    if (ext !== 'jpg' && ext !== 'jpeg') return undefined;
    const dir = dirname(file.path);
    const base = stripExt(basename(file.path));
    const prefix = dir ? dir + '/' : '';
    return this.vfs.findWithExt(`${prefix}_${base}`, IMAGE_EXTS) ?? this.vfs.findWithExt(`${prefix}${base}_`, IMAGE_EXTS);
  }

  // ------------------------------------------------------------------ sounds

  resolveSound(ref: string): VFile | undefined {
    if (!ref) return undefined;
    const res = this.manifest.sounds.get(ref.toUpperCase());
    if (res) {
      const f = this.vfs.findWithExt(res.path, SOUND_EXTS);
      if (f) return f;
    }
    return this.vfs.findWithExt(ref, SOUND_EXTS);
  }

  soundIdForPath(path: string): string | undefined {
    const key = pathKey(stripExt(path));
    for (const s of this.manifest.sounds.values()) if (pathKey(s.path) === key) return s.id;
    return undefined;
  }

  // ------------------------------------------------------------------ definitions

  async readText(path: string): Promise<string> {
    const f = this.vfs.get(path);
    if (!f) throw new Error(`File not found: ${path}`);
    return decodeText(await f.read());
  }

  async loadReanimFile(path: string): Promise<ReanimDefinition> {
    const f = this.vfs.get(path);
    if (!f) throw new Error(`File not found: ${path}`);
    const bytes = await f.read();
    if (path.toLowerCase().endsWith('.compiled')) return parseCompiledReanim(bytes);
    return parseReanimXml(decodeText(bytes));
  }

  async loadParticleFile(path: string): Promise<ParticleDefinition> {
    const f = this.vfs.get(path);
    if (!f) throw new Error(`File not found: ${path}`);
    return parseParticleXml(decodeText(await f.read()));
  }

  /** Find a reanim by bare name (as used by attacher tracks). */
  findReanimPath(name: string): string | undefined {
    const candidates = [`reanim/${name}.reanim`, `compiled/reanim/${name}.reanim.compiled`, name];
    for (const c of candidates) {
      const f = this.vfs.get(c);
      if (f) return f.path;
    }
    return undefined;
  }

  /** Cached reanim definition by path; undefined while loading. */
  reanim(path: string): ReanimDefinition | null | undefined {
    const key = pathKey(path);
    if (this.reanimCache.has(key)) return this.reanimCache.get(key);
    if (!this.reanims.has(key)) {
      this.reanims.set(
        key,
        this.loadReanimFile(path).then(
          (d) => {
            this.reanimCache.set(key, d);
            this.dispatchEvent(new Event('image'));
            return d;
          },
          () => {
            this.reanimCache.set(key, null);
            return null;
          },
        ),
      );
    }
    return undefined;
  }

  particle(path: string): ParticleDefinition | null | undefined {
    const key = pathKey(path);
    if (this.particleCache.has(key)) return this.particleCache.get(key);
    if (!this.particles.has(key)) {
      this.particles.set(
        key,
        this.loadParticleFile(path).then(
          (d) => {
            this.particleCache.set(key, d);
            this.dispatchEvent(new Event('image'));
            return d;
          },
          () => {
            this.particleCache.set(key, null);
            return null;
          },
        ),
      );
    }
    return undefined;
  }
}

export async function decodeImageFile(file: VFile): Promise<HTMLCanvasElement | ImageBitmap> {
  const bytes = await file.read();
  const type = MIME[extname(file.path)] ?? 'image/png';
  const blob = new Blob([bytes as BlobPart], { type });
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { premultiplyAlpha: 'none' });
    } catch {
      // fall through to <img>
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d')!.drawImage(img, 0, 0);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Combine a color image with a grayscale alpha image (red channel = alpha). */
export function applyAlphaMask(color: CanvasImageSource & { width: number; height: number }, alpha: CanvasImageSource & { width: number; height: number }): HTMLCanvasElement {
  const w = color.width;
  const h = color.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(alpha, 0, 0, w, h);
  const a = ctx.getImageData(0, 0, w, h).data;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(color, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) d[i + 3] = a[i];
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Alpha value (0..255) at a pixel, computing the mask lazily. */
export function imageAlphaAt(img: LoadedImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
  if (!img.alphaMask) {
    try {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img.source, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height).data;
      const m = new Uint8Array(img.width * img.height);
      for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3];
      img.alphaMask = m;
    } catch {
      img.alphaMask = new Uint8Array(img.width * img.height).fill(255);
    }
  }
  return img.alphaMask[Math.floor(y) * img.width + Math.floor(x)];
}
