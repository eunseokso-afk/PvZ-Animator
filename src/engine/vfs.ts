/**
 * Case-insensitive virtual file system combining the opened main.pak with
 * loose files the user imports. Paths use forward slashes.
 */

import type { PakArchive, PakEntry } from '../formats/pak';

/** pak: from main.pak · import: user files · generated: saved documents · demo: built-in demo assets */
export type FileOrigin = 'pak' | 'import' | 'generated' | 'demo';

export interface VFile {
  /** Display path, forward slashes, original case. */
  path: string;
  size: number;
  origin: FileOrigin;
  fileTime?: bigint;
  read(): Promise<Uint8Array>;
  /** Present for pak entries: still-encrypted bytes for fast repacking. */
  pak?: { archive: PakArchive; entry: PakEntry };
  /** For in-memory files. */
  bytes?: Uint8Array;
}

export function normPath(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/^\/+/, '');
  // Resolve "dir/../"
  const parts: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export function pathKey(p: string): string {
  return normPath(p).toUpperCase();
}

export function extname(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function basename(p: string): string {
  const s = normPath(p);
  const slash = s.lastIndexOf('/');
  return slash >= 0 ? s.slice(slash + 1) : s;
}

export function dirname(p: string): string {
  const s = normPath(p);
  const slash = s.lastIndexOf('/');
  return slash >= 0 ? s.slice(0, slash) : '';
}

export function stripExt(p: string): string {
  const s = normPath(p);
  const slash = s.lastIndexOf('/');
  const dot = s.lastIndexOf('.');
  return dot > slash + 1 ? s.slice(0, dot) : s;
}

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
export const SOUND_EXTS = ['ogg', 'au', 'wav', 'mp3', 'flac', 'm4a', 'aac', 'oga', 'opus', 'webm'];

export function memoryFile(path: string, bytes: Uint8Array, origin: FileOrigin = 'import'): VFile {
  return { path: normPath(path), size: bytes.length, origin, bytes, read: async () => bytes };
}

export class VirtualFS {
  private map = new Map<string, VFile>();
  /** Bumped on every change, so views can cheaply detect staleness. */
  version = 0;

  get size(): number {
    return this.map.size;
  }

  set(file: VFile): void {
    file.path = normPath(file.path);
    this.map.set(pathKey(file.path), file);
    this.version++;
  }

  get(path: string): VFile | undefined {
    return this.map.get(pathKey(path));
  }

  has(path: string): boolean {
    return this.map.has(pathKey(path));
  }

  delete(path: string): boolean {
    const ok = this.map.delete(pathKey(path));
    if (ok) this.version++;
    return ok;
  }

  clearOrigin(origin: FileOrigin): void {
    for (const [k, f] of this.map) if (f.origin === origin) this.map.delete(k);
    this.version++;
  }

  list(): VFile[] {
    return [...this.map.values()];
  }

  /** Find "<base>.<ext>" for the first matching extension. */
  findWithExt(base: string, exts: string[]): VFile | undefined {
    const b = normPath(base);
    const existing = extname(b);
    if (existing && exts.includes(existing)) {
      const f = this.get(b);
      if (f) return f;
    }
    for (const e of exts) {
      const f = this.get(`${b}.${e}`);
      if (f) return f;
    }
    return undefined;
  }
}
