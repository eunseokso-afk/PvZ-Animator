/**
 * PopCap PAK archives (Plants vs. Zombies `main.pak`).
 *
 * Layout (every byte XOR-ed with 0xF7 in PvZ):
 *   u32 magic   = 0xBAC04AC0
 *   u32 version = 0
 *   repeated:
 *     u8  flags          (0x80 = end of directory)
 *     u8  nameLength
 *     u8[nameLength] name (Windows path, backslashes)
 *     u32 size
 *     u64 FILETIME       (100ns ticks since 1601-01-01)
 *   file data, concatenated in directory order
 *
 * Because the cipher is a per-byte XOR with a constant, encrypted file bodies
 * can be copied between archives without decrypting them.
 */

export const PAK_MAGIC = 0xbac04ac0;
export const PAK_XOR_KEY = 0xf7;
const FLAG_END = 0x80;

export interface PakEntry {
  /** Name exactly as stored in the archive (usually with backslashes). */
  name: string;
  size: number;
  /** Windows FILETIME. */
  fileTime: bigint;
  /** Absolute byte offset of the data inside the archive. */
  offset: number;
}

export function xorBytes(data: Uint8Array, key: number): Uint8Array {
  if (key === 0) return data;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key;
  return out;
}

/** In-place XOR. */
export function xorInPlace(data: Uint8Array, key: number): Uint8Array {
  if (key === 0) return data;
  for (let i = 0; i < data.length; i++) data[i] ^= key;
  return data;
}

const FILETIME_UNIX_EPOCH = 116444736000000000n;

export function fileTimeToDate(ft: bigint): Date {
  return new Date(Number((ft - FILETIME_UNIX_EPOCH) / 10000n));
}

export function dateToFileTime(d: Date): bigint {
  return BigInt(d.getTime()) * 10000n + FILETIME_UNIX_EPOCH;
}

function latin1Decode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function latin1Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 256 ? c : 63; // '?'
  }
  return out;
}

export class PakFormatError extends Error {}

/** Detect the XOR key from the first four bytes; returns null if not a PAK. */
export function detectPakKey(head: Uint8Array): number | null {
  if (head.length < 8) return null;
  const magic = (k: number) =>
    ((head[0] ^ k) | ((head[1] ^ k) << 8) | ((head[2] ^ k) << 16) | ((head[3] ^ k) << 24)) >>> 0;
  if (magic(PAK_XOR_KEY) === PAK_MAGIC) return PAK_XOR_KEY;
  if (magic(0) === PAK_MAGIC) return 0;
  return null;
}

/**
 * Parse the directory of a PAK archive.
 * `header` must contain at least the whole directory; returns null if more
 * bytes are needed.
 */
export function parsePakDirectory(header: Uint8Array, key: number): { entries: PakEntry[]; dataStart: number } | null {
  const b = (i: number) => header[i] ^ key;
  let p = 0;
  const need = (k: number) => p + k <= header.length;
  if (!need(8)) return null;
  const magic = (b(0) | (b(1) << 8) | (b(2) << 16) | (b(3) << 24)) >>> 0;
  if (magic !== PAK_MAGIC) throw new PakFormatError('Not a PopCap PAK file (bad magic).');
  const version = (b(4) | (b(5) << 8) | (b(6) << 16) | (b(7) << 24)) >>> 0;
  if (version > 0) throw new PakFormatError(`Unsupported PAK version ${version}.`);
  p = 8;
  const entries: PakEntry[] = [];
  let pos = 0;
  for (;;) {
    if (!need(1)) return null;
    const flags = b(p);
    p += 1;
    if (flags & FLAG_END) break;
    if (!need(1)) return null;
    const nameLen = b(p);
    p += 1;
    if (!need(nameLen + 12)) return null;
    const nameBytes = new Uint8Array(nameLen);
    for (let i = 0; i < nameLen; i++) nameBytes[i] = b(p + i);
    p += nameLen;
    const size = (b(p) | (b(p + 1) << 8) | (b(p + 2) << 16) | (b(p + 3) << 24)) >>> 0;
    p += 4;
    let ft = 0n;
    for (let i = 7; i >= 0; i--) ft = (ft << 8n) | BigInt(b(p + i));
    p += 8;
    entries.push({ name: latin1Decode(nameBytes), size, fileTime: ft, offset: pos });
    pos += size;
  }
  for (const e of entries) e.offset += p;
  return { entries, dataStart: p };
}

/** A PAK archive backed by a Blob (a File from an <input>, usually). */
export class PakArchive {
  private constructor(
    readonly blob: Blob,
    readonly key: number,
    readonly entries: PakEntry[],
    readonly dataStart: number,
  ) {}

  static async open(blob: Blob): Promise<PakArchive> {
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const key = detectPakKey(head);
    if (key === null) throw new PakFormatError('Not a PopCap PAK file (bad magic).');
    let chunk = 256 * 1024;
    for (;;) {
      const len = Math.min(chunk, blob.size);
      const header = new Uint8Array(await blob.slice(0, len).arrayBuffer());
      const dir = parsePakDirectory(header, key);
      if (dir) {
        const last = dir.entries[dir.entries.length - 1];
        if (last && last.offset + last.size > blob.size) {
          throw new PakFormatError('PAK directory points past the end of the file (truncated archive?).');
        }
        return new PakArchive(blob, key, dir.entries, dir.dataStart);
      }
      if (len >= blob.size) throw new PakFormatError('PAK directory is truncated.');
      chunk *= 4;
    }
  }

  /** Read and decrypt one entry. */
  async read(entry: PakEntry): Promise<Uint8Array> {
    const raw = new Uint8Array(await this.blob.slice(entry.offset, entry.offset + entry.size).arrayBuffer());
    return xorInPlace(raw, this.key);
  }

  /** The still-encrypted bytes of an entry (for fast repacking with the same key). */
  rawSlice(entry: PakEntry): Blob {
    return this.blob.slice(entry.offset, entry.offset + entry.size);
  }
}

export interface PakWriteFile {
  /** Path inside the archive; forward slashes are converted to backslashes. */
  name: string;
  /** Plain (decrypted) bytes, or already-encrypted bytes when `encrypted` is true. */
  data: Uint8Array | Blob;
  size: number;
  encrypted?: boolean;
  fileTime?: bigint;
}

/** Build the (encrypted) directory block for a PAK archive. */
export function buildPakDirectory(files: PakWriteFile[], key = PAK_XOR_KEY): Uint8Array {
  let len = 8 + 1;
  const names = files.map((f) => latin1Encode(f.name.replace(/\//g, '\\')));
  for (const n of names) {
    if (n.length > 255) throw new PakFormatError(`Path too long for PAK: ${latin1Decode(n)}`);
    len += 1 + 1 + n.length + 4 + 8;
  }
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, PAK_MAGIC, true);
  dv.setUint32(4, 0, true);
  let p = 8;
  const now = dateToFileTime(new Date());
  files.forEach((f, idx) => {
    out[p++] = 0;
    out[p++] = names[idx].length;
    out.set(names[idx], p);
    p += names[idx].length;
    dv.setUint32(p, f.size, true);
    p += 4;
    dv.setBigUint64(p, f.fileTime ?? now, true);
    p += 8;
  });
  out[p++] = FLAG_END;
  return xorInPlace(out, key);
}

/**
 * Assemble a PAK archive as a Blob. Plain files are encrypted; files marked
 * `encrypted` (raw slices from another archive with the same key) are copied.
 */
export function writePak(files: PakWriteFile[], key = PAK_XOR_KEY): Blob {
  const parts: BlobPart[] = [buildPakDirectory(files, key) as BlobPart];
  for (const f of files) {
    if (f.encrypted) {
      parts.push(f.data as BlobPart);
    } else if (f.data instanceof Blob) {
      throw new PakFormatError('Plain Blob data must be read into memory before packing.');
    } else {
      parts.push(xorBytes(f.data, key) as BlobPart);
    }
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}
