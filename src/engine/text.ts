/**
 * Text for reanim text tracks and scene text layers. A PvZ font id (FONT_*) is drawn
 * with the game's bitmap font when the font is in the loaded files, otherwise with a
 * similar-sized system font. Like TodDrawStringMatrix, the text origin is the left end
 * of the baseline: the image is drawn at (ox, oy) relative to it.
 */

import type { AssetLibrary, LoadedFont, LoadedImage } from './assets';
import type { Blend } from './renderer';
import { filterable } from './renderer';
import { layoutText } from '../formats/imageFont';

/** One image of a rendered text, drawn at (ox, oy) relative to the text origin. */
export interface TextRun {
  img: LoadedImage;
  ox: number;
  oy: number;
  /** Additive font layers (LayerSetDrawMode 1) add to what is behind the text. */
  blend: Blend;
}

export interface TextRender {
  /** Draw in this order. */
  runs: TextRun[];
  /** Bounds of all runs relative to the text origin: x0, y0, x1, y1. */
  bounds: [number, number, number, number];
}

const cache = new Map<string, TextRender>();
let serial = 2_000_000;
/** Canvases wider than this fail in some browsers; longer text is cut off. */
const MAX_TEXT_W = 16384;

/** The rendered text, or undefined while its font is still loading. */
export function renderText(assets: AssetLibrary, text: string, fontId: string): TextRender | undefined {
  const font = assets.font(fontId);
  if (font === undefined) return undefined;
  const key = `${font ? `f${font.serial}` : `s:${fontId.toUpperCase()}:${assets.systemFontFamily(fontId) ?? ''}`}\u0000${text}`;
  let out = cache.get(key);
  if (out) {
    cache.delete(key);
    cache.set(key, out);
    return out;
  }
  out = font ? bitmapText(font, text) : systemText(text, fontId, assets.systemFontFamily(fontId));
  cache.set(key, out);
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return out;
}

function image(c: HTMLCanvasElement, label: string): LoadedImage {
  return { path: `text:${label}`, source: c, width: c.width, height: c.height, rows: 1, cols: 1, celWidth: c.width, celHeight: c.height, serial: serial++ };
}

/** Point size hinted by a font id (FONT_HOUSEOFTERROR28 -> 28). */
export function fontSizeHint(fontId: string): number {
  const m = /(\d+)\D*$/.exec(fontId);
  let n = m ? parseInt(m[1], 10) : NaN;
  // Pixel-font names like Pico129 carry extra digits: read them as 12.
  if (n > 72 && m) n = parseInt(m[1].slice(0, 2), 10);
  return n >= 6 && n <= 72 ? n : 18;
}

function systemText(text: string, fontId: string, family?: string): TextRender {
  const size = fontSizeHint(fontId);
  const font = `bold ${size}px ${family ? `"${family}", ` : ''}"Trebuchet MS", "Segoe UI", sans-serif`;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  const m = ctx.measureText(text || ' ');
  const ascent = Math.ceil(m.fontBoundingBoxAscent || size * 0.8);
  const descent = Math.ceil(m.fontBoundingBoxDescent || size * 0.25);
  const pad = 2;
  c.width = Math.max(1, Math.min(MAX_TEXT_W, Math.ceil(m.width) + pad * 2));
  c.height = Math.max(1, ascent + descent + pad * 2);
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, pad, pad + ascent);
  const ox = -pad;
  const oy = -pad - ascent;
  return { runs: [{ img: image(c, text), ox, oy, blend: 'normal' }], bounds: [ox, oy, ox + c.width, oy + c.height] };
}

/**
 * Each layer's image with the layer colour applied once (colour = mult + add, as
 * ImageFont colours a glyph with min(color x mult + add, 255)).
 */
const tintedLayers = new WeakMap<LoadedFont, (CanvasImageSource | null)[]>();

function layerImages(font: LoadedFont): (CanvasImageSource | null)[] {
  let out = tintedLayers.get(font);
  if (out) return out;
  out = font.def.layers.map((layer, i) => {
    const img = font.images[i];
    if (!img) return null;
    const eff = layer.colorMult.map((m, k) => Math.min(1, m + layer.colorAdd[k]));
    if (eff.every((v) => v === 1)) return filterable(img.source);
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img.source, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const d = data.data;
    for (let p = 0; p < d.length; p += 4) {
      d[p] *= eff[0];
      d[p + 1] *= eff[1];
      d[p + 2] *= eff[2];
      d[p + 3] *= eff[3];
    }
    ctx.putImageData(data, 0, 0);
    return c;
  });
  tintedLayers.set(font, out);
  return out;
}

function bitmapText(font: LoadedFont, text: string): TextRender {
  const sources = layerImages(font);
  const { quads } = layoutText(font.def, text);
  const drawn = quads.filter((q) => sources[q.layer]);
  // Consecutive glyphs with the same blend go into one image (drawing them in order into a
  // canvas gives the same result as drawing each on the stage).
  const groups: { blend: Blend; quads: typeof drawn }[] = [];
  for (const q of drawn) {
    const blend: Blend = font.def.layers[q.layer].drawMode === 1 ? 'additive' : 'normal';
    const last = groups[groups.length - 1];
    if (last && last.blend === blend) last.quads.push(q);
    else groups.push({ blend, quads: [q] });
  }
  const runs: TextRun[] = [];
  let bounds: [number, number, number, number] | null = null;
  for (const g of groups) {
    const x0 = Math.floor(Math.min(...g.quads.map((q) => q.x)));
    const y0 = Math.floor(Math.min(...g.quads.map((q) => q.y)));
    const quadsIn = g.quads.filter((q) => q.x + q.dw - x0 <= MAX_TEXT_W);
    if (!quadsIn.length) continue;
    const x1 = Math.ceil(Math.max(...quadsIn.map((q) => q.x + q.dw)));
    const y1 = Math.ceil(Math.max(...quadsIn.map((q) => q.y + q.dh)));
    const c = document.createElement('canvas');
    c.width = Math.max(1, x1 - x0);
    c.height = Math.max(1, y1 - y0);
    const ctx = c.getContext('2d')!;
    for (const q of quadsIn) ctx.drawImage(sources[q.layer]!, q.sx, q.sy, q.sw, q.sh, q.x - x0, q.y - y0, q.dw, q.dh);
    runs.push({ img: image(c, text), ox: x0, oy: y0, blend: g.blend });
    bounds = bounds ? [Math.min(bounds[0], x0), Math.min(bounds[1], y0), Math.max(bounds[2], x1), Math.max(bounds[3], y1)] : [x0, y0, x1, y1];
  }
  return { runs, bounds: bounds ?? [0, 0, 0, 0] };
}
