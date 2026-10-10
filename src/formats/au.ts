/**
 * Sun/NeXT .au audio decoder. Several PvZ sounds ship as .au, which browsers
 * cannot decode natively.
 */

export interface DecodedPcm {
  sampleRate: number;
  channels: Float32Array[];
}

export class AuFormatError extends Error {}

function ulawToLinear(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  if (sign) sample = -sample;
  return sample / 32768;
}

function alawToLinear(a: number): number {
  a ^= 0x55;
  const sign = a & 0x80;
  const exponent = (a >> 4) & 0x07;
  const mantissa = a & 0x0f;
  let sample = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
  if (!sign) sample = -sample;
  return sample / 32768;
}

export function isAu(bytes: Uint8Array): boolean {
  return bytes.length >= 24 && bytes[0] === 0x2e && bytes[1] === 0x73 && bytes[2] === 0x6e && bytes[3] === 0x64;
}

export function decodeAu(bytes: Uint8Array): DecodedPcm {
  if (!isAu(bytes)) throw new AuFormatError('Not an .au file.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = dv.getUint32(4, false);
  let size = dv.getUint32(8, false);
  const encoding = dv.getUint32(12, false);
  const sampleRate = dv.getUint32(16, false);
  const channelCount = Math.max(1, dv.getUint32(20, false));
  if (offset > bytes.length) throw new AuFormatError('Bad data offset.');
  if (size === 0xffffffff || offset + size > bytes.length) size = bytes.length - offset;

  let bytesPerSample: number;
  let read: (p: number) => number;
  switch (encoding) {
    case 1:
      bytesPerSample = 1;
      read = (p) => ulawToLinear(bytes[p]);
      break;
    case 2:
      bytesPerSample = 1;
      read = (p) => dv.getInt8(p) / 128;
      break;
    case 3:
      bytesPerSample = 2;
      read = (p) => dv.getInt16(p, false) / 32768;
      break;
    case 4:
      bytesPerSample = 3;
      read = (p) => ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8)) / 2147483648;
      break;
    case 5:
      bytesPerSample = 4;
      read = (p) => dv.getInt32(p, false) / 2147483648;
      break;
    case 6:
      bytesPerSample = 4;
      read = (p) => dv.getFloat32(p, false);
      break;
    case 7:
      bytesPerSample = 8;
      read = (p) => dv.getFloat64(p, false);
      break;
    case 27:
      bytesPerSample = 1;
      read = (p) => alawToLinear(bytes[p]);
      break;
    default:
      throw new AuFormatError(`Unsupported .au encoding ${encoding}.`);
  }
  const frames = Math.floor(size / (bytesPerSample * channelCount));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  let p = offset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      channels[c][i] = read(p);
      p += bytesPerSample;
    }
  }
  return { sampleRate: sampleRate || 8000, channels };
}

/** Encode PCM as a 16-bit WAV file (used for generated demo sounds). */
export function encodeWav(pcm: DecodedPcm): Uint8Array {
  const ch = pcm.channels.length;
  const frames = pcm.channels[0]?.length ?? 0;
  const dataSize = frames * ch * 2;
  const out = new Uint8Array(44 + dataSize);
  const dv = new DataView(out.buffer);
  const ascii = (p: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[p + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, pcm.sampleRate, true);
  dv.setUint32(28, pcm.sampleRate * ch * 2, true);
  dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true);
  ascii(36, 'data');
  dv.setUint32(40, dataSize, true);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, pcm.channels[c][i]));
      dv.setInt16(p, Math.round(v * 32767), true);
      p += 2;
    }
  }
  return out;
}
