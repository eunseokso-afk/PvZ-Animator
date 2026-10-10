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
  begin(clear?: RGBA): void;
  /** `m` maps source-rect pixel coords (0..sw, 0..sh) to canvas CSS pixels. */
  drawImage(img: LoadedImage, sx: number, sy: number, sw: number, sh: number, m: Readonly<Mat>, color: RGBA, blend: Blend): void;
  fillRect(m: Readonly<Mat>, w: number, h: number, color: RGBA, blend: Blend): void;
  end(): void;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: true });
  if (gl) {
    try {
      return new WebGLRenderer(canvas, gl);
    } catch (e) {
      console.warn('WebGL2 renderer failed, falling back to canvas 2D', e);
    }
  }
  return new Canvas2DRenderer(canvas);
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
  private prog: WebGLProgram;
  private vbo: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private data = new Float32Array(MAX_QUADS * 6 * FLOATS_PER_VERTEX);
  private quads = 0;
  private currentTex: WebGLTexture | null = null;
  private textures = new WeakMap<object, WebGLTexture>();
  private white: WebGLTexture;
  private uView: WebGLUniformLocation;
  private cssW = 1;
  private cssH = 1;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private gl: WebGL2RenderingContext,
  ) {
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
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img.source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(img.source, t);
    this.currentTex = null;
    return t;
  }

  private flush(): void {
    if (this.quads === 0) return;
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
    if (color[3] <= 0 || sw <= 0 || sh <= 0) return;
    const tex = this.texture(img);
    this.quad(tex, m, sw, sh, sx / img.width, sy / img.height, (sx + sw) / img.width, (sy + sh) / img.height, color, blend);
  }

  fillRect(m: Readonly<Mat>, w: number, h: number, color: RGBA, blend: Blend): void {
    if (color[3] <= 0) return;
    this.quad(this.white, m, w, h, 0, 0, 1, 1, color, blend);
  }

  end(): void {
    this.flush();
  }
}

class Canvas2DRenderer implements Renderer {
  readonly kind = 'canvas2d' as const;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
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

  begin(clear: RGBA = [0, 0, 0, 0]): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
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
    if (color[3] <= 0) return;
    this.setup(m, color, blend);
    this.ctx.drawImage(img.source, sx, sy, sw, sh, 0, 0, sw, sh);
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
