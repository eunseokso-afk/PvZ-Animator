/**
 * Sprite renderer with per-sprite affine matrix, color multiply and additive
 * blending (both needed for faithful reanim/particle previews). Uses WebGL2,
 * with a Canvas 2D fallback.
 */

import type { LoadedImage } from './assets';
import type { Mat } from './math';

export type Blend = 'normal' | 'additive';
/** r, g, b may exceed 1 (over-brightening); a is 0..1. */
export type RGBA = [number, number, number, number];

export interface Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly kind: 'webgl2' | 'canvas2d';
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  /**
   * Start a frame. `underlay` is what shows behind the canvas (the viewport background);
   * the 2D fallback draws it in so additive blending has something to add to.
   */
  begin(clear?: RGBA, underlay?: CanvasImageSource): void;
  /** `m` maps source-rect pixel coords (0..sw, 0..sh) to canvas CSS pixels. */
  drawImage(img: LoadedImage, sx: number, sy: number, sw: number, sh: number, m: Readonly<Mat>, color: RGBA, blend: Blend): void;
  fillRect(m: Readonly<Mat>, w: number, h: number, color: RGBA, blend: Blend): void;
  end(): void;
  /** Free the GPU context now instead of waiting for garbage collection. */
  dispose(): void;
  /**
   * The rendered pixels as straight-alpha ImageData (for PNG export). Additive light
   * drawn over transparency is kept visible by raising alpha to the brightest channel.
   */
  readPixels(): ImageData;
  /** Whether the canvas really got a drawing buffer of its full size (WebGL may grant less). */
  fits(): boolean;
}

/**
 * Create a renderer drawing into `canvas`. If WebGL2 is unavailable the canvas
 * cannot be reused for a 2D context, so the fallback draws into a fresh canvas
 * that takes the original's place in the DOM; always use `renderer.canvas`.
 * `onRestored` runs after a lost WebGL context comes back, to request a redraw.
 */
export function createRenderer(canvas: HTMLCanvasElement, onRestored?: () => void, opts: { force2d?: boolean } = {}): Renderer {
  if (opts.force2d) return new Canvas2DRenderer(canvas);
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: true });
  if (gl) {
    try {
      return new WebGLRenderer(canvas, gl, onRestored);
    } catch (e) {
      console.warn('WebGL2 renderer failed, falling back to canvas 2D', e);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }
  let target = canvas;
  if (gl) {
    target = document.createElement('canvas');
    target.className = canvas.className;
    target.style.cssText = canvas.style.cssText;
    canvas.replaceWith(target);
  }
  return new Canvas2DRenderer(target);
}

const VS = `#version 300 es
in vec2 aPos;
in vec2 aUV;
in vec4 aColor;
uniform vec2 uView;
out vec2 vUV;
out vec4 vColor;
void main() {
  vec2 p = aPos / uView * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
  vUV = aUV;
  vColor = aColor;
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vUV;
in vec4 vColor;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUV) * vColor;
}`;

const FLOATS_PER_VERTEX = 8;
const MAX_QUADS = 4096;

class WebGLRenderer implements Renderer {
  readonly kind = 'webgl2' as const;
  private prog!: WebGLProgram;
  private vbo!: WebGLBuffer;
  private vao!: WebGLVertexArrayObject;
  private data = new Float32Array(MAX_QUADS * 6 * FLOATS_PER_VERTEX);
  private quads = 0;
  private currentTex: WebGLTexture | null = null;
  private textures = new WeakMap<object, WebGLTexture>();
  private white!: WebGLTexture;
  private uView!: WebGLUniformLocation;
  private cssW = 1;
  private cssH = 1;
  /** True while the browser has taken the GL context away (GPU reset, too many contexts…). */
  private lost = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private gl: WebGL2RenderingContext,
    onRestored?: () => void,
  ) {
    this.init();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // allow the context to be restored
      this.lost = true;
      this.quads = 0;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      // Every GL object died with the old context; rebuild them and re-upload textures lazily.
      this.textures = new WeakMap();
      this.currentTex = null;
      try {
        this.init();
        this.lost = false;
      } catch (e) {
        console.warn('Could not restore the WebGL context', e);
      }
      onRestored?.();
    });
  }

  private init(): void {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
    this.prog = prog;
    this.uView = gl.getUniformLocation(prog, 'uView')!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_VERTEX * 4;
    const bind = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    };
    bind('aPos', 2, 0);
    bind('aUV', 2, 8);
    bind('aColor', 4, 16);
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssW = Math.max(1, cssWidth);
    this.cssH = Math.max(1, cssHeight);
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  begin(clear: RGBA = [0, 0, 0, 0]): void {
    // (The browser composites this canvas over the underlay; additive quads write alpha 0.)
    this.quads = 0;
    if (this.lost) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(clear[0] * clear[3], clear[1] * clear[3], clear[2] * clear[3], clear[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.uView, this.cssW, this.cssH);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.quads = 0;
    this.currentTex = null;
  }

  private texture(img: LoadedImage): WebGLTexture {
    let t = this.textures.get(img.source);
    if (t) return t;
    // Uploading rebinds TEXTURE_2D, so draw pending quads with their own texture first.
    this.flush();
    const gl = this.gl;
    t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    // Upload explicitly premultiplied bytes. UNPACK_PREMULTIPLY_ALPHA_WEBGL is ignored for
    // ImageBitmap sources, and game art often hides white or black in fully transparent
    // pixels, which would otherwise show up as solid boxes with our premultiplied blending.
    const w = Math.max(1, img.source.width);
    const h = Math.max(1, img.source.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, premultipliedPixels(img.source));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(img.source, t);
    this.currentTex = null;
    return t;
  }

  private flush(): void {
    if (this.quads === 0 || this.lost) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.quads * 6 * FLOATS_PER_VERTEX);
    gl.drawArrays(gl.TRIANGLES, 0, this.quads * 6);
    this.quads = 0;
  }

  private quad(tex: WebGLTexture, m: Readonly<Mat>, w: number, h: number, u0: number, v0: number, u1: number, v1: number, color: RGBA, blend: Blend) {
    if (tex !== this.currentTex) {
      this.flush();
      this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
      this.currentTex = tex;
    }
    if (this.quads >= MAX_QUADS) this.flush();
    const a = Math.max(0, Math.min(1, color[3]));
    const r = color[0] * a;
    const g = color[1] * a;
    const b = color[2] * a;
    const oa = blend === 'additive' ? 0 : a;
    const corners: [number, number, number, number][] = [
      [0, 0, u0, v0],
      [w, 0, u1, v0],
      [0, h, u0, v1],
      [w, 0, u1, v0],
      [w, h, u1, v1],
      [0, h, u0, v1],
    ];
    let p = this.quads * 6 * FLOATS_PER_VERTEX;
    const d = this.data;
    for (const [x, y, u, v] of corners) {
      d[p++] = m[0] * x + m[2] * y + m[4];
      d[p++] = m[1] * x + m[3] * y + m[5];
      d[p++] = u;
      d[p++] = v;
      d[p++] = r;
      d[p++] = g;
      d[p++] = b;
      d[p++] = oa;
    }
    this.quads++;
  }

  drawImage(img: LoadedImage, sx: number, sy: number, sw: number, sh: number, m: Readonly<Mat>, color: RGBA, blend: Blend): void {
    if (this.lost || color[3] <= 0 || sw <= 0 || sh <= 0) return;
    const tex = this.texture(img);
    this.quad(tex, m, sw, sh, sx / img.width, sy / img.height, (sx + sw) / img.width, (sy + sh) / img.height, color, blend);
  }

  fillRect(m: Readonly<Mat>, w: number, h: number, color: RGBA, blend: Blend): void {
    if (this.lost || color[3] <= 0) return;
    this.quad(this.white, m, w, h, 0, 0, 1, 1, color, blend);
  }

  end(): void {
    this.flush();
  }

  dispose(): void {
    this.lost = true;
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  fits(): boolean {
    return this.lost || (this.gl.drawingBufferWidth >= this.canvas.width && this.gl.drawingBufferHeight >= this.canvas.height);
  }

  readPixels(): ImageData {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const raw = new Uint8Array(w * h * 4);
    if (!this.lost) gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new ImageData(w, h);
    const d = out.data;
    for (let y = 0; y < h; y++) {
      // GL rows run bottom-up.
      const src = (h - 1 - y) * w * 4;
      const dst = y * w * 4;
      for (let x = 0; x < w * 4; x += 4) {
        const r = raw[src + x];
        const g = raw[src + x + 1];
        const b = raw[src + x + 2];
        // Additive sprites add colour with alpha 0; over transparency, show that light.
        const a = Math.max(raw[src + x + 3], r, g, b);
        if (a === 0) continue;
        d[dst + x] = Math.min(255, Math.round((r * 255) / a));
        d[dst + x + 1] = Math.min(255, Math.round((g * 255) / a));
        d[dst + x + 2] = Math.min(255, Math.round((b * 255) / a));
        d[dst + x + 3] = a;
      }
    }
    return out;
  }
}

class Canvas2DRenderer implements Renderer {
  readonly kind = 'canvas2d' as const;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser could not create a WebGL2 or 2D drawing context.');
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  begin(clear: RGBA = [0, 0, 0, 0], underlay?: CanvasImageSource): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // A 2D canvas cannot hold "added light with alpha 0" like WebGL does, so draw the
    // background in here for 'lighter' (additive) sprites to add to.
    if (underlay) ctx.drawImage(underlay, 0, 0, this.canvas.width, this.canvas.height);
    if (clear[3] > 0) {
      ctx.fillStyle = `rgba(${clear[0] * 255},${clear[1] * 255},${clear[2] * 255},${clear[3]})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  private setup(m: Readonly<Mat>, color: RGBA, blend: Blend) {
    const d = this.dpr;
    this.ctx.setTransform(m[0] * d, m[1] * d, m[2] * d, m[3] * d, m[4] * d, m[5] * d);
    this.ctx.globalAlpha = Math.max(0, Math.min(1, color[3]));
    this.ctx.globalCompositeOperation = blend === 'additive' ? 'lighter' : 'source-over';
  }

  drawImage(img: LoadedImage, sx: number, sy: number, sw: number, sh: number, m: Readonly<Mat>, color: RGBA, blend: Blend): void {
    if (color[3] <= 0 || sw <= 0 || sh <= 0) return;
    this.setup(m, color, blend);
    if (color[0] >= 0.999 && color[1] >= 0.999 && color[2] >= 0.999) this.ctx.drawImage(filterable(img.source), sx, sy, sw, sh, 0, 0, sw, sh);
    else this.ctx.drawImage(this.tinted(img, sx, sy, sw, sh, color), 0, 0, sw, sh, 0, 0, sw, sh);
  }

  /** Tinted copies of image cels, most recently used last. */
  private tintCache = new Map<string, HTMLCanvasElement>();

  /**
   * The source rect with its colour multiplied by `color`, computed per pixel on
   * straight-alpha values so soft edges keep their colour (composite-operation tricks
   * leave tint-coloured halos there). Over-brightening above 1 is clamped.
   */
  private tinted(img: LoadedImage, sx: number, sy: number, sw: number, sh: number, color: RGBA): HTMLCanvasElement {
    const q = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    const [r, g, b] = [q(color[0]), q(color[1]), q(color[2])];
    const key = `${img.serial}|${sx},${sy},${sw},${sh}|${r},${g},${b}`;
    let c = this.tintCache.get(key);
    if (c) {
      this.tintCache.delete(key);
      this.tintCache.set(key, c);
      return c;
    }
    c = document.createElement('canvas');
    const w = Math.max(1, Math.ceil(sw));
    const h = Math.max(1, Math.ceil(sh));
    c.width = w;
    c.height = h;
    const t = c.getContext('2d', { willReadFrequently: true })!;
    t.drawImage(img.source, sx, sy, sw, sh, 0, 0, sw, sh);
    const data = t.getImageData(0, 0, w, h);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = (d[i] * r) / 255;
      d[i + 1] = (d[i + 1] * g) / 255;
      d[i + 2] = (d[i + 2] * b) / 255;
    }
    t.putImageData(data, 0, 0);
    this.tintCache.set(key, c);
    if (this.tintCache.size > 300) this.tintCache.delete(this.tintCache.keys().next().value!);
    return c;
  }

  fillRect(m: Readonly<Mat>, w: number, h: number, color: RGBA, blend: Blend): void {
    if (color[3] <= 0) return;
    this.setup(m, color, blend);
    const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    this.ctx.fillStyle = `rgb(${c(color[0])},${c(color[1])},${c(color[2])})`;
    this.ctx.fillRect(0, 0, w, h);
  }

  end(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalAlpha = 1;
    this.ctx.globalCompositeOperation = 'source-over';
  }

  dispose(): void {
    this.tintCache.clear();
  }

  readPixels(): ImageData {
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }

  fits(): boolean {
    return true;
  }
}

const filterableCopies = new WeakMap<object, HTMLCanvasElement>();

/**
 * An image that 2D drawImage can scale or rotate correctly. Images are decoded as
 * straight-alpha ImageBitmaps (to match the game's alpha rules), and Chromium filters
 * those without premultiplying, which turns colour hidden in transparent pixels into
 * light or dark rims. A 1:1 copy into a canvas (which stores premultiplied pixels) fixes it.
 */
export function filterable(src: CanvasImageSource & { width: number; height: number }): CanvasImageSource {
  if (typeof ImageBitmap === 'undefined' || !(src instanceof ImageBitmap)) return src;
  let copy = filterableCopies.get(src);
  if (!copy) {
    copy = document.createElement('canvas');
    copy.width = Math.max(1, src.width);
    copy.height = Math.max(1, src.height);
    copy.getContext('2d')!.drawImage(src, 0, 0);
    filterableCopies.set(src, copy);
  }
  return copy;
}

/** Multiply color by alpha in place (straight-alpha RGBA bytes in, premultiplied out). */
export function premultiplyInPlace(d: Uint8Array | Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255) continue;
    if (a === 0) {
      d[i] = d[i + 1] = d[i + 2] = 0;
      continue;
    }
    d[i] = Math.round((d[i] * a) / 255);
    d[i + 1] = Math.round((d[i + 1] * a) / 255);
    d[i + 2] = Math.round((d[i + 2] * a) / 255);
  }
}

let scratch: HTMLCanvasElement | null = null;

/** Premultiplied RGBA bytes of an image, ready for texImage2D. */
export function premultipliedPixels(src: CanvasImageSource & { width: number; height: number }): Uint8Array {
  const w = Math.max(1, src.width);
  const h = Math.max(1, src.height);
  scratch ??= document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  premultiplyInPlace(data);
  scratch.width = scratch.height = 1; // release the backing store
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

const textCache = new Map<string, LoadedImage>();
let textSerial = 1_000_000;

/** Render a text string into a white image (for reanim text tracks). */
export function textImage(text: string, fontHint: string): LoadedImage {
  const key = fontHint + '\u0000' + text;
  let img = textCache.get(key);
  if (img) return img;
  const size = /(\d+)/.exec(fontHint)?.[1] ?? '18';
  const font = `bold ${size}px "Trebuchet MS", "Segoe UI", sans-serif`;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  c.width = Math.max(1, Math.ceil(metrics.width) + 4);
  c.height = Math.ceil(parseInt(size, 10) * 1.4);
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  ctx.fillText(text, 2, 2);
  img = { path: `text:${text}`, source: c, width: c.width, height: c.height, rows: 1, cols: 1, celWidth: c.width, celHeight: c.height, serial: textSerial++ };
  if (textCache.size > 200) textCache.clear();
  textCache.set(key, img);
  return img;
}
