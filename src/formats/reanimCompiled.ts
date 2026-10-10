/**
 * Compiled reanim files (compiled/reanim/*.reanim.compiled).
 *
 * The game caches parsed definitions as a zlib-compressed memory image:
 *   u32 cookie = 0xDEADFED4
 *   u32 uncompressedSize
 *   zlib stream:
 *     u32 schema hash
 *     ReanimatorDefinition { u32 tracksPtr; i32 trackCount; f32 fps; u32 atlasPtr }
 *     [u32 sizeof(ReanimatorTrack) = 12]
 *     trackCount x ReanimatorTrack { u32 namePtr; u32 transformsPtr; i32 transformCount }
 *     per track:
 *       string name                    (i32 length + bytes, no terminator)
 *       [u32 sizeof(ReanimatorTransform) = 44]
 *       transformCount x { f32 x,y,kx,ky,sx,sy,f,a; u32 image, font, text }
 *       per transform: string image, string font, string text
 * The bracketed element sizes are validated by the loader; we accept files
 * with or without them. Unset floats hold -10000.
 */

import { fillInMissing, FIELD_PLACEHOLDER, normalizeTrackLengths, type PartialTransform, type ReanimDefinition, type ReanimTrack } from './reanim';

export const COMPILED_COOKIE = 0xdeadfed4;
const TRACK_SIZE = 12;
const TRANSFORM_SIZE = 44;

export class CompiledFormatError extends Error {}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

export async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  return streamToBytes(ds.readable);
}

export async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  return streamToBytes(cs.readable);
}

/** Strip the 8-byte header and inflate. */
export async function decompressCompiled(data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 8) throw new CompiledFormatError('File too small to be a compiled definition.');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, true) !== COMPILED_COOKIE) throw new CompiledFormatError('Bad compiled-definition cookie.');
  const expected = dv.getUint32(4, true);
  const body = await inflateZlib(data.subarray(8));
  if (body.length !== expected) {
    throw new CompiledFormatError(`Decompressed size mismatch (${body.length} != ${expected}).`);
  }
  return body;
}

class Reader {
  p = 0;
  private dv: DataView;
  constructor(private bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining() {
    return this.bytes.length - this.p;
  }
  need(n: number) {
    if (this.p + n > this.bytes.length) throw new CompiledFormatError('Unexpected end of compiled data.');
  }
  u32() {
    this.need(4);
    const v = this.dv.getUint32(this.p, true);
    this.p += 4;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.dv.getInt32(this.p, true);
    this.p += 4;
    return v;
  }
  f32() {
    this.need(4);
    const v = this.dv.getFloat32(this.p, true);
    this.p += 4;
    return v;
  }
  peekU32() {
    this.need(4);
    return this.dv.getUint32(this.p, true);
  }
  str() {
    const len = this.i32();
    if (len < 0 || len > 100000) throw new CompiledFormatError(`Implausible string length ${len}.`);
    this.need(len);
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.bytes[this.p + i]);
    this.p += len;
    return s;
  }
  /** Consume an optional element-size marker before an array. */
  elementSize(expected: number, count: number) {
    if (this.remaining >= 4 && this.peekU32() === expected) {
      // Ambiguity guard: without the marker, the next u32 would be a pointer
      // field, which is never equal to the struct size in practice.
      this.p += 4;
    } else if (count > 0 && this.remaining < count * expected) {
      throw new CompiledFormatError('Array data is truncated.');
    }
  }
}

export function parseCompiledReanimBody(body: Uint8Array): ReanimDefinition & { schemaHash: number } {
  const r = new Reader(body);
  const schemaHash = r.u32();
  r.u32(); // tracks pointer
  const trackCount = r.i32();
  const fps = r.f32();
  r.u32(); // atlas pointer
  if (trackCount < 0 || trackCount > 10000) throw new CompiledFormatError(`Implausible track count ${trackCount}.`);
  if (!(fps > 0 && fps < 10000)) throw new CompiledFormatError(`Implausible fps ${fps}.`);
  const counts: number[] = [];
  if (trackCount > 0) {
    r.elementSize(TRACK_SIZE, trackCount);
    for (let t = 0; t < trackCount; t++) {
      r.u32(); // name pointer
      r.u32(); // transforms pointer
      const n = r.i32();
      if (n < 0 || n > 100000) throw new CompiledFormatError(`Implausible frame count ${n}.`);
      counts.push(n);
    }
  }
  const tracks: ReanimTrack[] = [];
  for (let t = 0; t < trackCount; t++) {
    const name = r.str();
    const n = counts[t];
    const raws: PartialTransform[] = [];
    if (n > 0) {
      r.elementSize(TRANSFORM_SIZE, n);
      for (let k = 0; k < n; k++) {
        const vals = [r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32()];
        r.u32();
        r.u32();
        r.u32();
        const keep = (v: number) => (v === FIELD_PLACEHOLDER || !Number.isFinite(v) ? undefined : v);
        raws.push({
          x: keep(vals[0]),
          y: keep(vals[1]),
          kx: keep(vals[2]),
          ky: keep(vals[3]),
          sx: keep(vals[4]),
          sy: keep(vals[5]),
          f: keep(vals[6]),
          a: keep(vals[7]),
        });
      }
      for (let k = 0; k < n; k++) {
        raws[k].i = r.str();
        raws[k].font = r.str();
        raws[k].text = r.str();
      }
    }
    tracks.push({ name, transforms: fillInMissing(raws) });
  }
  return { schemaHash, fps, tracks: normalizeTrackLengths(tracks) };
}

export async function parseCompiledReanim(data: Uint8Array): Promise<ReanimDefinition> {
  const body = await decompressCompiled(data);
  return parseCompiledReanimBody(body);
}

/** Build a compiled body (used by tests and for round-trip checks). */
export function buildCompiledReanimBody(def: ReanimDefinition, schemaHash = 0, withElementSizes = true): Uint8Array {
  const bytes: number[] = [];
  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  const u32 = (v: number) => {
    dv.setUint32(0, v >>> 0, true);
    bytes.push(...new Uint8Array(buf));
  };
  const f32 = (v: number) => {
    dv.setFloat32(0, v, true);
    bytes.push(...new Uint8Array(buf));
  };
  const str = (s: string) => {
    u32(s.length);
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
  };
  u32(schemaHash);
  u32(0);
  u32(def.tracks.length);
  f32(def.fps);
  u32(0);
  if (def.tracks.length) {
    if (withElementSizes) u32(TRACK_SIZE);
    for (const t of def.tracks) {
      u32(0);
      u32(0);
      u32(t.transforms.length);
    }
  }
  for (const t of def.tracks) {
    str(t.name);
    if (t.transforms.length) {
      if (withElementSizes) u32(TRANSFORM_SIZE);
      for (const tr of t.transforms) {
        for (const v of [tr.x, tr.y, tr.kx, tr.ky, tr.sx, tr.sy, tr.f, tr.a]) f32(v);
        u32(0);
        u32(0);
        u32(0);
      }
      for (const tr of t.transforms) {
        str(tr.i);
        str(tr.font);
        str(tr.text);
      }
    }
  }
  return new Uint8Array(bytes);
}

export async function buildCompiledReanim(def: ReanimDefinition, schemaHash = 0): Promise<Uint8Array> {
  const body = buildCompiledReanimBody(def, schemaHash);
  const z = await deflateZlib(body);
  const out = new Uint8Array(8 + z.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, COMPILED_COOKIE, true);
  dv.setUint32(4, body.length, true);
  out.set(z, 8);
  return out;
}
