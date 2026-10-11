/**
 * PopCap ImageFont descriptors (data/*.txt in main.pak), as read by
 * SexyAppFramework's FontData::Load. A descriptor is a small script:
 *
 *   Define CharList ( ' ', 'A', 'B' );
 *   Define WidthList ( 7, 15, 14 );
 *   Define RectList ( (0,0,7,30), (7,0,15,30), (22,0,14,30) );
 *   CreateLayer Main;
 *   LayerSetImage Main 'HouseofTerror28.png';
 *   LayerSetAscent Main 24;
 *   LayerSetCharWidths Main CharList WidthList;
 *   LayerSetImageMap Main CharList RectList;
 *   SetDefaultPointSize 28;
 *
 * Text is laid out from the origin along the baseline: a glyph's image goes at
 * (x + layer offset + char offset, -(ascent - layer offset y - char offset y)).
 */

export type FontValue = string | number | FontValue[] | { ref: string };

export interface FontChar {
  rect: { x: number; y: number; w: number; h: number };
  offsetX: number;
  offsetY: number;
  width: number;
  /** Extra advance before the given next character. */
  kerning: Map<string, number>;
  /** LayerSetCharOrders: added to the layer's base order. */
  order: number;
}

export interface FontLayer {
  name: string;
  /** Image file name, relative to the descriptor's folder. */
  image: string;
  ascent: number;
  ascentPadding: number;
  height: number;
  lineSpacingOffset: number;
  spacing: number;
  baseOffset: number;
  offsetX: number;
  offsetY: number;
  /** 0..1 per channel (r, g, b, a). */
  colorMult: [number, number, number, number];
  /** 0..1 per channel (r, g, b, a), added to the colour after multiplying. */
  colorAdd: [number, number, number, number];
  /** LayerSetPointSize: the size the glyph images were made for (0 = the font's size). */
  pointSize: number;
  /** LayerSetBaseOrder: lower orders are drawn first. */
  baseOrder: number;
  /** 0 = normal, 1 = additive. */
  drawMode: number;
  minPointSize: number;
  maxPointSize: number;
  requireTags: string[];
  excludeTags: string[];
  chars: Map<string, FontChar>;
}

export interface FontDefinition {
  layers: FontLayer[];
  defaultPointSize: number;
  /** SetCharMap: characters drawn as other characters. */
  charMap: Map<string, string>;
  /** Files pulled in with Include (relative to the descriptor's folder). */
  includes: string[];
  /** Commands that could not be applied. */
  warnings: string[];
}

// ---------------------------------------------------------------- tokenizer and statements

type Token = { kind: 'str' | 'num' | 'id' | 'punct'; value: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === "'" || c === '"') {
      let s = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const e = src[i + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else s += src[i++];
      }
      i++;
      out.push({ kind: 'str', value: s });
    } else if (/\d/.test(c) || ((c === '-' || c === '+' || c === '.') && /[\d.]/.test(src[i + 1] ?? ''))) {
      const hex = /^0[xX][0-9a-fA-F]+/.exec(src.slice(i));
      if (hex) {
        out.push({ kind: 'num', value: String(parseInt(hex[0], 16)) });
        i += hex[0].length;
        continue;
      }
      const m = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
      if (!m) {
        i++;
        continue;
      }
      out.push({ kind: 'num', value: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ kind: 'id', value: m[0] });
      i += m[0].length;
    } else {
      out.push({ kind: 'punct', value: c });
      i++;
    }
  }
  return out;
}

/** Split into statements (terminated by ';'), each a list of values; ( ... ) become arrays. */
export function parseFontStatements(src: string): FontValue[][] {
  const tokens = tokenize(src);
  let pos = 0;
  const value = (): FontValue | undefined => {
    const t = tokens[pos];
    if (!t) return undefined;
    if (t.kind === 'punct' && t.value === '(') {
      pos++;
      const list: FontValue[] = [];
      while (pos < tokens.length && !(tokens[pos].kind === 'punct' && tokens[pos].value === ')')) {
        if (tokens[pos].kind === 'punct' && tokens[pos].value === ',') {
          pos++;
          continue;
        }
        const v = value();
        if (v === undefined) break;
        list.push(v);
      }
      pos++;
      return list;
    }
    pos++;
    if (t.kind === 'str') return t.value;
    if (t.kind === 'num') return parseFloat(t.value);
    if (t.kind === 'id') return { ref: t.value };
    return undefined;
  };
  const statements: FontValue[][] = [];
  let cur: FontValue[] = [];
  while (pos < tokens.length) {
    const t = tokens[pos];
    if (t.kind === 'punct' && t.value === ';') {
      if (cur.length) statements.push(cur);
      cur = [];
      pos++;
      continue;
    }
    if (t.kind === 'punct' && (t.value === ')' || t.value === ',')) {
      pos++;
      continue;
    }
    const v = value();
    if (v !== undefined) cur.push(v);
  }
  if (cur.length) statements.push(cur);
  return statements;
}

// ---------------------------------------------------------------- descriptor

function newLayer(name: string, base?: FontLayer): FontLayer {
  if (base) return { ...base, name, colorMult: [...base.colorMult], colorAdd: [...base.colorAdd], chars: new Map([...base.chars].map(([k, v]) => [k, { ...v, kerning: new Map(v.kerning) }])) };
  return {
    name,
    image: '',
    ascent: 0,
    ascentPadding: 0,
    height: 0,
    lineSpacingOffset: 0,
    spacing: 0,
    baseOffset: 0,
    offsetX: 0,
    offsetY: 0,
    colorMult: [1, 1, 1, 1],
    colorAdd: [0, 0, 0, 0],
    pointSize: 0,
    baseOrder: 0,
    drawMode: 0,
    minPointSize: -1,
    maxPointSize: -1,
    requireTags: [],
    excludeTags: [],
    chars: new Map(),
  };
}

/**
 * Parse a descriptor. `include` returns the text of an Include'd file (relative path),
 * or undefined if it is missing.
 */
export function parseImageFont(src: string, include?: (path: string) => string | undefined): FontDefinition {
  const def: FontDefinition = { layers: [], defaultPointSize: 0, charMap: new Map(), includes: [], warnings: [] };
  const defines = new Map<string, FontValue>();
  const layers = new Map<string, FontLayer>();
  const resolve = (v: FontValue | undefined): FontValue | undefined => {
    let guard = 0;
    while (v && typeof v === 'object' && !Array.isArray(v) && guard++ < 20) v = defines.get(v.ref.toLowerCase()) ?? v.ref;
    return v;
  };
  const list = (v: FontValue | undefined): FontValue[] => {
    const r = resolve(v);
    return Array.isArray(r) ? r.map((x) => resolve(x) as FontValue) : r === undefined ? [] : [r];
  };
  const num = (v: FontValue | undefined, d = 0): number => {
    const r = resolve(v);
    return typeof r === 'number' ? r : typeof r === 'string' && r.trim() !== '' && !isNaN(+r) ? +r : d;
  };
  const str = (v: FontValue | undefined): string => {
    const r = resolve(v);
    return typeof r === 'string' ? r : typeof r === 'number' ? String(r) : '';
  };
  const nums = (v: FontValue | undefined): number[] => list(v).map((x) => num(x));
  /**
   * FontData::GetColorFromDataElement: a list is (r, g, b[, a]) in 0..1; a single
   * number is an ARGB integer (often written in hex).
   */
  const color = (v: FontValue | undefined, fallback: number): [number, number, number, number] => {
    const r = resolve(v);
    if (Array.isArray(r)) {
      const c = r.map((x) => num(x, fallback));
      return [c[0] ?? fallback, c[1] ?? fallback, c[2] ?? fallback, c[3] ?? 1];
    }
    const n = num(r, NaN);
    if (Number.isFinite(n)) {
      const argb = n >>> 0;
      return [((argb >>> 16) & 255) / 255, ((argb >>> 8) & 255) / 255, (argb & 255) / 255, ((argb >>> 24) & 255) / 255];
    }
    return [fallback, fallback, fallback, 1];
  };
  const layerOf = (v: FontValue | undefined): FontLayer | undefined => {
    const name = v && typeof v === 'object' && !Array.isArray(v) ? v.ref : str(v);
    return layers.get(name.toLowerCase());
  };
  const charOf = (layer: FontLayer, c: string): FontChar => {
    let ch = layer.chars.get(c);
    if (!ch) {
      ch = { rect: { x: 0, y: 0, w: 0, h: 0 }, offsetX: 0, offsetY: 0, width: 0, kerning: new Map(), order: 0 };
      layer.chars.set(c, ch);
    }
    return ch;
  };

  const run = (text: string, depth: number) => {
    for (const st of parseFontStatements(text)) {
      const head = st[0];
      const cmd = (head && typeof head === 'object' && !Array.isArray(head) ? head.ref : '').toLowerCase();
      const a = st.slice(1);
      const layer = layerOf(a[0]);
      switch (cmd) {
        case 'define': {
          const name = a[0] && typeof a[0] === 'object' && !Array.isArray(a[0]) ? a[0].ref : str(a[0]);
          if (name) defines.set(name.toLowerCase(), a.length > 2 ? a.slice(1) : (a[1] ?? ''));
          break;
        }
        case 'include': {
          const path = str(a[0]);
          if (!path || depth > 8) break;
          def.includes.push(path);
          const sub = include?.(path);
          if (sub !== undefined) run(sub, depth + 1);
          break;
        }
        case 'createlayer':
        case 'createlayerfrom': {
          // CreateLayer <Name>; CreateLayerFrom <Name> <Source> copies an existing layer.
          // (A two-name CreateLayer is accepted as a copy too.)
          const name = a[0] && typeof a[0] === 'object' && !Array.isArray(a[0]) ? a[0].ref : str(a[0]);
          if (!name) break;
          const src = layerOf(a[1]);
          if (cmd === 'createlayerfrom' && !src) {
            def.warnings.push(`CreateLayerFrom ${name}: no layer named ${str(a[1])}`);
            break;
          }
          const l = newLayer(name, src);
          layers.set(name.toLowerCase(), l);
          def.layers.push(l);
          break;
        }
        case 'setdefaultpointsize':
          def.defaultPointSize = num(a[0]);
          break;
        case 'setcharmap': {
          const from = list(a[0]).map(str);
          const to = list(a[1]).map(str);
          from.forEach((f, i) => to[i] !== undefined && def.charMap.set(f, to[i]));
          break;
        }
        default:
          if (!layer) break;
          switch (cmd) {
            case 'layersetimage':
              layer.image = str(a[1]);
              break;
            case 'layersetascent':
              layer.ascent = num(a[1]);
              break;
            case 'layersetascentpadding':
              layer.ascentPadding = num(a[1]);
              break;
            case 'layersetheight':
              layer.height = num(a[1]);
              break;
            case 'layersetlinespacingoffset':
              layer.lineSpacingOffset = num(a[1]);
              break;
            case 'layersetspacing':
              layer.spacing = num(a[1]);
              break;
            case 'layersetbaseoffset':
              layer.baseOffset = num(a[1]);
              break;
            case 'layersetoffset': {
              const [x, y] = nums(a[1]);
              layer.offsetX = x ?? 0;
              layer.offsetY = y ?? 0;
              break;
            }
            case 'layersetdrawmode':
              layer.drawMode = num(a[1]);
              break;
            case 'layersetcolormult':
              layer.colorMult = color(a[1], 1);
              break;
            case 'layersetcoloradd':
              layer.colorAdd = color(a[1], 0);
              break;
            case 'layersetpointsize':
              layer.pointSize = num(a[1]);
              break;
            case 'layersetbaseorder':
              layer.baseOrder = num(a[1]);
              break;
            case 'layersetcharorders': {
              const chars = list(a[1]).map(str);
              const orders = nums(a[2]);
              chars.forEach((c, i) => (charOf(layer, c).order = orders[i] ?? 0));
              break;
            }
            case 'layerpointrange':
            case 'layersetpointrange':
              layer.minPointSize = num(a[1], -1);
              layer.maxPointSize = num(a[2], -1);
              break;
            case 'layerrequiretags':
              layer.requireTags = list(a[1]).map((t) => str(t).toUpperCase());
              break;
            case 'layerexcludetags':
              layer.excludeTags = list(a[1]).map((t) => str(t).toUpperCase());
              break;
            case 'layersetcharwidths': {
              const chars = list(a[1]).map(str);
              const widths = nums(a[2]);
              chars.forEach((c, i) => (charOf(layer, c).width = widths[i] ?? 0));
              break;
            }
            case 'layersetimagemap': {
              const chars = list(a[1]).map(str);
              const rects = list(a[2]);
              chars.forEach((c, i) => {
                const [x, y, w, h] = nums(rects[i]);
                charOf(layer, c).rect = { x: x ?? 0, y: y ?? 0, w: w ?? 0, h: h ?? 0 };
              });
              break;
            }
            case 'layersetcharoffsets': {
              const chars = list(a[1]).map(str);
              const offs = list(a[2]);
              chars.forEach((c, i) => {
                const [x, y] = nums(offs[i]);
                const ch = charOf(layer, c);
                ch.offsetX = x ?? 0;
                ch.offsetY = y ?? 0;
              });
              break;
            }
            case 'layersetkerningpairs': {
              const pairs = list(a[1]).map(str);
              const values = nums(a[2]);
              pairs.forEach((p, i) => {
                if (p.length >= 2) charOf(layer, p[0]).kerning.set(p[1], values[i] ?? 0);
              });
              break;
            }
          }
      }
    }
  };
  run(src, 0);
  return def;
}

// ---------------------------------------------------------------- layout

export interface GlyphQuad {
  layer: number;
  /** Source rect in the layer image. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Top-left and size on screen, relative to the text origin (left end of the baseline). */
  x: number;
  y: number;
  dw: number;
  dh: number;
  /** Draw order: the layer's base order plus the character's order. */
  order: number;
}

/** Layers drawn for normal text (no tags requested), like ImageFont with an empty tag list. */
export function activeLayers(def: FontDefinition): number[] {
  const size = def.defaultPointSize;
  return def.layers.flatMap((l, i) => {
    if (l.requireTags.length) return [];
    if (l.minPointSize >= 0 && size < l.minPointSize) return [];
    if (l.maxPointSize >= 0 && size > l.maxPointSize) return [];
    return [i];
  });
}

/** How much a layer's glyphs are scaled: the font's point size over the layer's (LayerSetPointSize). */
export function layerScale(def: FontDefinition, layer: FontLayer): number {
  return layer.pointSize > 0 && def.defaultPointSize > 0 ? def.defaultPointSize / layer.pointSize : 1;
}

/**
 * Glyph positions for a string (ImageFont::DrawStringEx / TodDrawStringMatrix): each
 * character advances by its width plus spacing and kerning, taking the widest layer.
 * Glyphs come out in the game's drawing order: by order (base order + char order),
 * and within one order character by character, all of a character's layers together.
 */
export function layoutText(def: FontDefinition, text: string): { quads: GlyphQuad[]; width: number } {
  const layers = activeLayers(def);
  const quads: GlyphQuad[] = [];
  let x = 0;
  const chars = [...text].map((c) => def.charMap.get(c) ?? c);
  chars.forEach((c, k) => {
    const next = chars[k + 1];
    let advance = x;
    for (const li of layers) {
      const layer = def.layers[li];
      const ch = layer.chars.get(c);
      if (!ch) continue;
      const s = layerScale(def, layer);
      if (ch.rect.w > 0 && ch.rect.h > 0) {
        quads.push({
          layer: li,
          sx: ch.rect.x,
          sy: ch.rect.y,
          sw: ch.rect.w,
          sh: ch.rect.h,
          x: x + (layer.offsetX + ch.offsetX) * s,
          y: -(layer.ascent - layer.offsetY - ch.offsetY) * s,
          dw: ch.rect.w * s,
          dh: ch.rect.h * s,
          order: layer.baseOrder + ch.order,
        });
      }
      const spacing = next !== undefined ? layer.spacing + (ch.kerning.get(next) ?? 0) : 0;
      advance = Math.max(advance, x + (ch.width + spacing) * s);
    }
    x = advance;
  });
  // Stable: equal orders keep the character-by-character sequence.
  quads.sort((a, b) => a.order - b.order);
  return { quads, width: x };
}

/** The ascent of the font's first active layer (for placing text by its top). */
export function fontAscent(def: FontDefinition): number {
  const li = activeLayers(def)[0];
  return li === undefined ? 0 : def.layers[li].ascent;
}
