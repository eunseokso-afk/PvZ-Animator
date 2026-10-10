/** Web Audio playback for PvZ sounds (.ogg/.au from main.pak or imported files). */

import { decodeAu, isAu } from '../formats/au';
import type { VFile } from './vfs';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private decoded = new Map<string, AudioBuffer | null>();
  private live = new Set<AudioBufferSourceNode>();
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  volume = 0.8;
  muted = false;

  get context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  clearCache(): void {
    this.buffers.clear();
    this.decoded.clear();
  }

  /** Decode (cached by path). */
  load(file: VFile): Promise<AudioBuffer | null> {
    const key = file.path.toUpperCase();
    let p = this.buffers.get(key);
    if (!p) {
      p = this.decode(file).then(
        (b) => {
          this.decoded.set(key, b);
          return b;
        },
        (e) => {
          console.warn('Could not decode sound', file.path, e);
          this.decoded.set(key, null);
          return null;
        },
      );
      this.buffers.set(key, p);
    }
    return p;
  }

  /** Already-decoded buffer, if any. */
  peek(file: VFile): AudioBuffer | null | undefined {
    return this.decoded.get(file.path.toUpperCase());
  }

  private async decode(file: VFile): Promise<AudioBuffer> {
    const ctx = this.context;
    const bytes = await file.read();
    if (isAu(bytes)) {
      const pcm = decodeAu(bytes);
      const frames = pcm.channels[0]?.length ?? 0;
      const buf = ctx.createBuffer(pcm.channels.length, Math.max(1, frames), pcm.sampleRate);
      pcm.channels.forEach((ch, i) => buf.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
      return buf;
    }
    const copy = bytes.slice().buffer;
    return ctx.decodeAudioData(copy);
  }

  play(buffer: AudioBuffer, volume = 1, offset = 0): AudioBufferSourceNode {
    const ctx = this.context;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(this.master!);
    if (this.recordDest) gain.connect(this.recordDest);
    src.onended = () => this.live.delete(src);
    this.live.add(src);
    src.start(0, Math.max(0, offset));
    return src;
  }

  stopAll(): void {
    for (const s of this.live) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.live.clear();
  }

  /** A MediaStream carrying everything played until stopRecording(). */
  startRecording(): MediaStream {
    const ctx = this.context;
    this.recordDest = ctx.createMediaStreamDestination();
    return this.recordDest.stream;
  }

  stopRecording(): void {
    this.recordDest = null;
  }
}
