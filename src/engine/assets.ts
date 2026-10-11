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
import { parseImageFont, type FontDefinition } from '../formats/imageFont';
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

/** A PopCap ImageFont with its layer images (null where an image is missing). */
export interface LoadedFont {
  id: string;
  path: string;
  def: FontDefinition;
  images: (LoadedImage | null)[];
  /** Unique per load (text caches key on it). */
  serial: number;
}

let fontSerial = 1;

/** Font ids PvZ uses, offered when no resources.xml lists fonts (drawn with a system font until a pak is open). */
export const COMMON_PVZ_FONTS = [
  'FONT_HOUSEOFTERROR28',
  'FONT_HOUSEOFTERROR20',
  'FONT_HOUSEOFTERROR16',
  'FONT_DWARVENTODCRAFT24',
  'FONT_DWARVENTODCRAFT18',
  'FONT_DWARVENTODCRAFT15',
  'FONT_DWARVENTODCRAFT12',
  'FONT_BRIANNETOD16',
  'FONT_BRIANNETOD12',
  'FONT_CONTINUUMBOLD14',
  'FONT_PICO129',
  'FONT_TINYBOLD',
];

/** 'definitions' keeps decoded images and sounds (only reanim/particle files changed). */
export type InvalidateScope = 'all' | 'definitions';

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

/** Extension search order for paths without one, as in PopCap's ImageLib::GetImage (jpg, then png, then gif). */
const IMAGE_LOOKUP_EXTS = ['jpg', 'png', 'gif', 'jpeg', 'bmp', 'webp'];

export interface ResolvedImage {
  file: VFile;
  res?: ImageResource;
  /** Only a "_name" alpha image exists: the game draws it as white with that alpha. */
  alphaOnly?: boolean;
}

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
  private fonts = new Map<string, LoadedFont | null>();
  private fontLoads = new Map<string, Promise<LoadedFont | null>>();
  /** Lower-case paths of user-imported xml files that parse as particles. */
  private extraParticleXml = new Set<string>();
  private pathToImageId = new Map<string, string>();

  emitChange(scope: InvalidateScope = 'all'): void {
    this.dispatchEvent(new CustomEvent('change', { detail: { scope } }));
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
    let media = false;
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
      const kind = classify(path);
      if (kind === 'image' || kind === 'sound' || kind === 'other') media = true;
      if (extname(path) === 'xml' && classify(path) !== 'particle' && file.size < 4 * 1024 * 1024) {
        const head = f.data ? f.data.subarray(0, 4096) : new Uint8Array(await f.blob!.slice(0, 4096).arrayBuffer());
        if (/<\s*emitter[\s>]/i.test(decodeText(head))) this.extraParticleXml.add(path.toLowerCase());
      }
    }
    if (manifestChanged) await this.reloadManifest();
    this.invalidate(media || manifestChanged ? 'all' : 'definitions');
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
  invalidate(scope: InvalidateScope = 'all'): void {
    if (scope === 'all') {
      this.images.clear();
      this.imageLoads.clear();
      this.fonts.clear();
      this.fontLoads.clear();
    }
    this.reanims.clear();
    this.reanimCache.clear();
    this.particles.clear();
    this.particleCache.clear();
    this.emitChange(scope);
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
  resolveImage(ref: string): ResolvedImage | null {
    if (!ref) return null;
    const upper = ref.toUpperCase();
    const res = this.manifest.images.get(upper);
    if (res && !res.path.startsWith('!')) {
      const found = this.findImageAt(res.path);
      if (found) return { ...found, res };
    }
    for (const [prefix, dir] of ID_PREFIX_RULES) {
      if (upper.startsWith(prefix) && upper.length > prefix.length) {
        const found = this.findImageAt(dir + ref.slice(prefix.length));
        if (found) return { ...found, res: this.resourceForPath(found.file.path) };
      }
    }
    const found = this.findImageAt(ref);
    return found ? { ...found, res: this.resourceForPath(found.file.path) } : null;
  }

  /** An image file at a path (extension optional), or failing that an alpha-only "_name" image. */
  private findImageAt(path: string): { file: VFile; alphaOnly?: boolean } | null {
    const file = this.vfs.findWithExt(path, IMAGE_LOOKUP_EXTS);
    if (file) return { file };
    const alpha = this.alphaImageNear(stripExt(path));
    return alpha ? { file: alpha, alphaOnly: true } : null;
  }

  /** PopCap's alpha-image naming: "dir/_name" first, then "dir/name_". */
  private alphaImageNear(pathNoExt: string): VFile | undefined {
    const p = normPath(pathNoExt);
    const dir = dirname(p);
    const prefix = dir ? dir + '/' : '';
    return this.vfs.findWithExt(`${prefix}_${basename(p)}`, IMAGE_LOOKUP_EXTS) ?? this.vfs.findWithExt(`${p}_`, IMAGE_LOOKUP_EXTS);
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
    let source: HTMLCanvasElement | ImageBitmap;
    if (found.alphaOnly) {
      source = alphaOnlyImage(await decodeImageFile(file), res?.alphaColor);
    } else {
      source = await decodeImageFile(file);
      const alphaFile = this.findAlphaImage(file, res);
      if (alphaFile && alphaFile !== file) {
        try {
          const mask = await decodeImageFile(alphaFile);
          // Like the game, ignore masks whose size does not match the image.
          if (mask.width === source.width && mask.height === source.height) source = applyAlphaMask(source, mask, rawColor(file));
          else console.warn(`Alpha image ${alphaFile.path} is ${mask.width}x${mask.height}, but ${file.path} is ${source.width}x${source.height}; ignoring it.`);
        } catch (e) {
          console.warn('Alpha mask failed for', file.path, e);
        }
      }
    }
    if (res?.alphaGrid) {
      const gridFile = this.vfs.findWithExt(res.alphaGrid, IMAGE_LOOKUP_EXTS);
      if (gridFile) {
        try {
          const grid = await decodeImageFile(gridFile);
          const celW = Math.floor(source.width / res.cols);
          const celH = Math.floor(source.height / res.rows);
          // The game requires the grid alpha to be exactly one cel in size.
          if (grid.width === celW && grid.height === celH) source = applyAlphaMask(source, grid, rawColor(file), res.rows, res.cols);
          else console.warn(`Alpha grid ${gridFile.path} is ${grid.width}x${grid.height}, but a cel of ${file.path} is ${celW}x${celH}; ignoring it.`);
        } catch (e) {
          console.warn('Alpha grid failed for', file.path, e);
        }
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

  /**
   * The separate alpha image for an image file: resources.xml "alphaimage", else
   * "_name" / "name_" next to it. The game checks this for every format, not just JPEG.
   */
  findAlphaImage(file: VFile, res?: ImageResource): VFile | undefined {
    if (res?.alphaImage) {
      const f = this.vfs.findWithExt(res.alphaImage, IMAGE_LOOKUP_EXTS);
      if (f) return f;
    }
    return this.alphaImageNear(stripExt(file.path));
  }

  // ------------------------------------------------------------------ fonts

  /**
   * The descriptor file of a font id: resources.xml first, then data/<NAME>.txt (as in
   * FONT_HOUSEOFTERROR28 -> data/HouseofTerror28.txt), or the path itself. Null for a
   * system font ("!sys:Arial") or one that is not in the loaded files.
   */
  resolveFont(id: string): VFile | null {
    if (!id) return null;
    const res = this.manifest.fonts.get(id.toUpperCase());
    if (res) return res.path.startsWith('!') ? null : (this.vfs.findWithExt(res.path, ['txt']) ?? null);
    const name = id.toUpperCase().startsWith('FONT_') ? id.slice(5) : id;
    return this.vfs.findWithExt(`data/${name}`, ['txt']) ?? this.vfs.findWithExt(id, ['txt']) ?? null;
  }

  /** System font family for a "!sys:Family" font resource, if the id names one. */
  systemFontFamily(id: string): string | undefined {
    const path = this.manifest.fonts.get(id.toUpperCase())?.path;
    return path?.toLowerCase().startsWith('!sys:') ? path.slice(5) : undefined;
  }

  /** Font ids to offer: resources.xml fonts and font descriptors in data/, else the usual PvZ ones. */
  fontIds(): string[] {
    const ids = new Set<string>();
    for (const f of this.manifest.fonts.values()) ids.add(f.id);
    // Without resources.xml, guess fonts from descriptors in data/ (the game only uses declared ones).
    if (!this.manifest.fonts.size) {
      for (const f of this.vfs.list()) {
        const m = /^data\/([^/]+)\.txt$/i.exec(f.path);
        if (m && !/^(lawnstrings|properties)/i.test(m[1])) ids.add(`FONT_${m[1].toUpperCase()}`);
      }
    }
    // Without the game's resources.xml, also offer the usual PvZ font ids (drawn with a system font).
    if (!this.manifest.fonts.size) for (const f of COMMON_PVZ_FONTS) ids.add(f);
    return [...ids].sort();
  }

  /** Synchronous lookup: the loaded bitmap font, null if there is none (use a system font), undefined while loading. */
  font(id: string): LoadedFont | null | undefined {
    const key = id.toUpperCase();
    if (this.fonts.has(key)) return this.fonts.get(key);
    void this.loadFont(id);
    return undefined;
  }

  loadFont(id: string): Promise<LoadedFont | null> {
    const key = id.toUpperCase();
    let p = this.fontLoads.get(key);
    if (!p) {
      p = this.decodeFont(id).then(
        (f) => {
          this.fonts.set(key, f);
          this.dispatchEvent(new Event('image'));
          return f;
        },
        (err) => {
          console.warn(`Failed to load font ${id}`, err);
          this.fonts.set(key, null);
          return null;
        },
      );
      this.fontLoads.set(key, p);
    }
    return p;
  }

  private async decodeFont(id: string): Promise<LoadedFont | null> {
    const file = this.resolveFont(id);
    if (!file) return null;
    const dir = dirname(file.path);
    const rel = (p: string) => normPath(dir ? `${dir}/${p}` : p);
    // Read Include'd files first, so the parser can stay synchronous.
    const texts = new Map<string, string>();
    const pending = [file.path];
    while (pending.length && texts.size < 16) {
      const path = pending.shift()!;
      if (texts.has(pathKey(path))) continue;
      const f = this.vfs.findWithExt(path, ['txt']);
      if (!f) continue;
      const text = decodeText(await f.read());
      texts.set(pathKey(path), text);
      for (const m of text.matchAll(/\binclude\s+["']([^"']+)["']/gi)) pending.push(rel(m[1]));
    }
    const def = parseImageFont(texts.get(pathKey(file.path)) ?? '', (p) => texts.get(pathKey(rel(p))));
    if (!def.layers.length) return null;
    const images = await Promise.all(def.layers.map((l) => (l.image ? this.loadImage(rel(l.image)) : Promise.resolve(null))));
    return { id, path: file.path, def, images, serial: fontSerial++ };
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

  /** Promise for a (cached) reanim definition. */
  reanimAsync(path: string): Promise<ReanimDefinition | null> {
    const cached = this.reanim(path);
    if (cached !== undefined) return Promise.resolve(cached);
    return this.reanims.get(pathKey(path)) ?? Promise.resolve(null);
  }

  /** Promise for a (cached) particle definition. */
  particleAsync(path: string): Promise<ParticleDefinition | null> {
    const cached = this.particle(path);
    if (cached !== undefined) return Promise.resolve(cached);
    return this.particles.get(pathKey(path)) ?? Promise.resolve(null);
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
      // The game's image loaders ignore gamma and colour profiles, so keep the raw values.
      return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
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

type Drawable = CanvasImageSource & { width: number; height: number };

function pixelsOf(src: Drawable): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; data: ImageData } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, src.width);
  canvas.height = Math.max(1, src.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  return { canvas, ctx, data: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

/** Whether a colour image may carry its own alpha, so its colours must be read without premultiplying. */
function rawColor(file: VFile): boolean {
  return !/\.jpe?g$/i.test(file.path);
}

let rawGl: WebGL2RenderingContext | null | undefined;

/**
 * Straight-alpha RGBA bytes of an ImageBitmap decoded with premultiplyAlpha 'none'.
 * A 2D canvas stores premultiplied pixels, which turns colours under alpha 0 to
 * black; a WebGL texture upload keeps them, as ImageLib does. Null if unavailable.
 */
function straightPixels(src: Drawable): Uint8Array | null {
  if (typeof ImageBitmap === 'undefined' || !(src instanceof ImageBitmap)) return null;
  if (rawGl === undefined) rawGl = document.createElement('canvas').getContext('webgl2');
  const gl = rawGl;
  if (!gl || gl.isContextLost()) return null;
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    const out = new Uint8Array(src.width * src.height * 4);
    gl.readPixels(0, 0, src.width, src.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return gl.getError() === gl.NO_ERROR ? out : null;
  } catch {
    return null;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
  }
}

/**
 * Use a grayscale image's blue channel as the alpha of a color image (ImageLib's
 * alpha compose). With `rows`/`cols`, `alpha` is one cel and is applied to every
 * cel (resources.xml "alphagrid"). `raw` keeps colours hidden under alpha 0.
 */
export function applyAlphaMask(color: Drawable, alpha: Drawable, raw = false, rows = 1, cols = 1): HTMLCanvasElement {
  const mask = pixelsOf(alpha).data.data;
  const out = pixelsOf(color);
  const d = out.data.data;
  if (raw) {
    const bytes = straightPixels(color);
    if (bytes && bytes.length === d.length) d.set(bytes);
  }
  if (rows === 1 && cols === 1) composeAlpha(d, mask);
  else composeAlphaGrid(d, out.canvas.width, mask, alpha.width, alpha.height, rows, cols);
  out.ctx.putImageData(out.data, 0, 0);
  return out.canvas;
}

/** An alpha image with no color image becomes `color` (white unless resources.xml says) with that alpha, as in the game. */
export function alphaOnlyImage(alpha: Drawable, color = 0xffffff): HTMLCanvasElement {
  const out = pixelsOf(alpha);
  whiteFromAlpha(out.data.data, color);
  out.ctx.putImageData(out.data, 0, 0);
  return out.canvas;
}

/** Straight-alpha RGBA of width `w`: alpha of every cel := the cel-sized mask's blue channel. */
export function composeAlphaGrid(color: Uint8ClampedArray | Uint8Array, w: number, mask: Uint8ClampedArray | Uint8Array, celW: number, celH: number, rows: number, cols: number): void {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let y = 0; y < celH; y++) {
        for (let x = 0; x < celW; x++) color[((r * celH + y) * w + c * celW + x) * 4 + 3] = mask[(y * celW + x) * 4 + 2];
      }
    }
  }
}

/** Straight-alpha RGBA: alpha := mask blue channel. */
export function composeAlpha(color: Uint8ClampedArray | Uint8Array, mask: Uint8ClampedArray | Uint8Array): void {
  for (let i = 0; i < color.length && i < mask.length; i += 4) color[i + 3] = mask[i + 2];
}

/** Straight-alpha RGBA: rgb := `color` (0xRRGGBB, white by default), alpha := blue channel. */
export function whiteFromAlpha(d: Uint8ClampedArray | Uint8Array, color = 0xffffff): void {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = d[i + 2];
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }
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
