/**
 * Text for reanim text tracks and scene text layers. A PvZ font id (FONT_*) is drawn
 * with the game's bitmap font when the font is in the loaded files, otherwise with a
 * similar-sized system font. Like TodDrawStringMatrix, the text origin is the left end
 * of the baseline: the image is drawn at (ox, oy) relative to it.
 */

import type { AssetLibrary, LoadedFont, LoadedImage } from './assets';
import { layoutText } from '../formats/imageFont';

export interface TextImage extends LoadedImage {
  /** Where the image's top-left sits relative to the text origin. */
  ox: number;
  oy: number;
}

const cache = new Map<string, TextImage>();
let serial = 2_000_000;

/** The rendered text, or undefined while its font is still loading. */
export function textImage(assets: AssetLibrary, text: string, fontId: string): TextImage | undefined {
  const font = assets.font(fontId);
  if (font === undefined) return undefined;
  const key = `${font ? `f${font.serial}` : `s:${fontId.toUpperCase()}:${assets.systemFontFamily(fontId) ?? ''}`}\u0000${text}`;
  let img = cache.get(key);
  if (img) {
    cache.delete(key);
    cache.set(key, img);
    return img;
  }
  img = font ? bitmapText(font, text) : systemText(text, fontId, assets.systemFontFamily(fontId));
  cache.set(key, img);
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return img;
}

function finish(c: HTMLCanvasElement, ox: number, oy: number, label: string): TextImage {
  return { path: `text:${label}`, source: c, width: c.width, height: c.height, rows: 1, cols: 1, celWidth: c.width, celHeight: c.height, serial: serial++, ox, oy };
}

/** Point size hinted by a font id (FONT_HOUSEOFTERROR28 -> 28). */
export function fontSizeHint(fontId: string): number {
  const m = /(\d+)\D*$/.exec(fontId);
  let n = m ? parseInt(m[1], 10) : NaN;
  // Pixel-font names like Pico129 carry extra digits: read them as 12.
  if (n > 72 && m) n = parseInt(m[1].slice(0, 2), 10);
  return n >= 6 && n <= 72 ? n : 18;
}

function systemText(text: string, fontId: string, family?: string): TextImage {
  const size = fontSizeHint(fontId);
  const font = `bold ${size}px ${family ? `"${family}", ` : ''}"Trebuchet MS", "Segoe UI", sans-serif`;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  const m = ctx.measureText(text || ' ');
  const ascent = Math.ceil(m.fontBoundingBoxAscent || size * 0.8);
  const descent = Math.ceil(m.fontBoundingBoxDescent || size * 0.25);
  const pad = 2;
  c.width = Math.max(1, Math.ceil(m.width) + pad * 2);
  c.height = Math.max(1, ascent + descent + pad * 2);
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, pad, pad + ascent);
  return finish(c, -pad, -pad - ascent, text);
}

function bitmapText(font: LoadedFont, text: string): TextImage {
  const { quads } = layoutText(font.def, text);
  const drawn = quads.filter((q) => font.images[q.layer]);
  if (!drawn.length) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return finish(c, 0, 0, text);
  }
  const x0 = Math.floor(Math.min(...drawn.map((q) => q.x)));
  const y0 = Math.floor(Math.min(...drawn.map((q) => q.y)));
  const x1 = Math.ceil(Math.max(...drawn.map((q) => q.x + q.sw)));
  const y1 = Math.ceil(Math.max(...drawn.map((q) => q.y + q.sh)));
  const c = document.createElement('canvas');
  c.width = Math.max(1, x1 - x0);
  c.height = Math.max(1, y1 - y0);
  const ctx = c.getContext('2d')!;
  // One pass per layer, so a layer's colour applies to its glyphs only and outlines stay under fills.
  for (const li of [...new Set(drawn.map((q) => q.layer))]) {
    const layer = font.def.layers[li];
    const img = font.images[li]!;
    const lc = document.createElement('canvas');
    lc.width = c.width;
    lc.height = c.height;
    const lctx = lc.getContext('2d', { willReadFrequently: true })!;
    for (const q of drawn) if (q.layer === li) lctx.drawImage(img.source, q.sx, q.sy, q.sw, q.sh, q.x - x0, q.y - y0, q.sw, q.sh);
    const [mr, mg, mb, ma] = layer.colorMult;
    const [ar, ag, ab, aa] = layer.colorAdd;
    if (mr !== 1 || mg !== 1 || mb !== 1 || ma !== 1 || ar || ag || ab || aa) {
      const data = lctx.getImageData(0, 0, lc.width, lc.height);
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        d[i] = d[i] * mr + ar;
        d[i + 1] = d[i + 1] * mg + ag;
        d[i + 2] = d[i + 2] * mb + ab;
        d[i + 3] = d[i + 3] * ma + aa;
      }
      lctx.putImageData(data, 0, 0);
    }
    ctx.globalCompositeOperation = layer.drawMode === 1 ? 'lighter' : 'source-over';
    ctx.drawImage(lc, 0, 0);
  }
  ctx.globalCompositeOperation = 'source-over';
  return finish(c, x0, y0, text);
}
