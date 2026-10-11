import { describe, expect, it } from 'vitest';
import { activeLayers, fontAscent, layoutText, parseFontStatements, parseImageFont } from '../src/formats/imageFont';
import { DEFAULT_TRANSFORM } from '../src/formats/reanim';
import { SceneDocument } from '../src/editor/sceneDoc';
import { bakeScene } from '../src/engine/sceneRuntime';
import { AssetLibrary } from '../src/engine/assets';
import { fontSizeHint } from '../src/engine/text';

const FONT = `
// A tiny two-layer font.
Define CharList ( ' ', 'A', 'B', "'" );
Define WidthList ( 5, 10, 11, 3 );
Define RectList ( (0,0,0,0), (0,0,12,20), (12,0,12,20), (24,0,4,20) );
Define OffsetList ( (0,0), (-1,0), (-1,2), (0,0) );
CreateLayer Outline;
LayerSetImage Outline 'Tiny_outline.png';
LayerSetAscent Outline 16;
LayerSetSpacing Outline 1;
LayerSetCharWidths Outline CharList WidthList;
LayerSetImageMap Outline CharList RectList;
LayerSetCharOffsets Outline CharList OffsetList;
LayerSetKerningPairs Outline ( "AB" ) ( -2 );
LayerSetColorMult Outline (0.2, 0.1, 0, 1);
CreateLayerFrom Main Outline;
LayerSetImage Main "Tiny.png";
LayerSetColorMult Main (1, 1, 1, 1);
CreateLayer Glow;
LayerSetImage Glow 'Glow.png';
LayerRequireTags Glow ( 'GLOW' );
SetDefaultPointSize 18;
`;

describe('PopCap ImageFont descriptors', () => {
  it('tokenizes statements, lists, strings and comments', () => {
    const st = parseFontStatements("Define X ( 1, 'a', (2, 3) ); /* c */ CreateLayer Main; // done");
    expect(st).toEqual([
      [{ ref: 'Define' }, { ref: 'X' }, [1, 'a', [2, 3]]],
      [{ ref: 'CreateLayer' }, { ref: 'Main' }],
    ]);
  });

  it('reads layers, defines, copies and per-character data', () => {
    const def = parseImageFont(FONT);
    expect(def.defaultPointSize).toBe(18);
    expect(def.layers.map((l) => [l.name, l.image])).toEqual([
      ['Outline', 'Tiny_outline.png'],
      ['Main', 'Tiny.png'],
      ['Glow', 'Glow.png'],
    ]);
    const main = def.layers[1];
    // CreateLayerFrom Main Outline copies everything, then its own settings apply.
    expect(main.ascent).toBe(16);
    expect(main.colorMult).toEqual([1, 1, 1, 1]);
    expect(def.layers[0].colorMult).toEqual([0.2, 0.1, 0, 1]);
    expect(main.chars.get('B')).toMatchObject({ rect: { x: 12, y: 0, w: 12, h: 20 }, offsetX: -1, offsetY: 2, width: 11 });
    expect(main.chars.get('A')!.kerning.get('B')).toBe(-2);
    expect(main.chars.get("'")!.width).toBe(3);
    // Layers that require tags are not drawn for plain text.
    expect(activeLayers(def)).toEqual([0, 1]);
    expect(fontAscent(def)).toBe(16);
  });

  it('follows Include', () => {
    const def = parseImageFont("Include 'base.txt'; LayerSetAscent Main 9;", (p) => (p === 'base.txt' ? "CreateLayer Main; LayerSetImage Main 'x.png';" : undefined));
    expect(def.includes).toEqual(['base.txt']);
    expect(def.layers[0]).toMatchObject({ name: 'Main', image: 'x.png', ascent: 9 });
  });

  it('lays text out along the baseline with spacing and kerning, outline layer first', () => {
    const def = parseImageFont(FONT);
    const { quads, width } = layoutText(def, 'AB A');
    // A: x 0; B: 0 + 10 + spacing 1 + kerning -2 = 9; space: 9 + 11 + 1 = 21; A: 21 + 5 + 1 = 27.
    const main = quads.filter((q) => q.layer === 1);
    expect(main.map((q) => [q.x, q.y])).toEqual([
      [-1, -16],
      [9 - 1, -16 + 2],
      [27 - 1, -16],
    ]);
    expect(width).toBe(27 + 10);
    // Like the game, glyphs are drawn character by character (outline then fill of each).
    expect(quads.slice(0, 2).map((q) => q.layer)).toEqual([0, 1]);
  });

  it('copies layers with CreateLayerFrom and orders them with LayerSetBaseOrder', () => {
    const def = parseImageFont(`
      Define C ( 'A', 'B' ); Define W ( 10, 10 ); Define R ( (0,0,8,8), (8,0,8,8) );
      CreateLayer Main; LayerSetImage Main 'f.png'; LayerSetAscent Main 8;
      LayerSetCharWidths Main C W; LayerSetImageMap Main C R;
      CreateLayerFrom Shadow Main; LayerSetOffset Shadow (2, 2); LayerSetBaseOrder Shadow -1;
      CreateLayerFrom Ghost Missing;`);
    expect(def.layers.map((l) => l.name)).toEqual(['Main', 'Shadow']);
    expect(def.warnings).toHaveLength(1);
    const { quads } = layoutText(def, 'AB');
    // The shadow (order -1) goes under both letters, then the main glyphs.
    expect(quads.map((q) => [q.layer, q.x, q.y])).toEqual([
      [1, 2, -6],
      [1, 12, -6],
      [0, 0, -8],
      [0, 10, -8],
    ]);
  });

  it('scales layers drawn at another point size and reads colours like the game', () => {
    const def = parseImageFont(`
      Define C ( 'A' ); Define W ( 20 ); Define R ( (0,0,20,30) );
      CreateLayer Main; LayerSetImage Main 'f.png'; LayerSetAscent Main 24; LayerSetPointSize Main 28;
      LayerSetCharWidths Main C W; LayerSetImageMap Main C R;
      LayerSetColorMult Main 0xFF808080; LayerSetColorAdd Main (0.5, 0, 0);
      CreateLayer Big; LayerPointRange Big 20 100;
      SetDefaultPointSize 14;`);
    const { quads, width } = layoutText(def, 'A');
    expect(quads[0]).toMatchObject({ x: 0, y: -12, dw: 10, dh: 15 });
    expect(width).toBe(10);
    expect(def.layers[0].colorMult.map((v) => Math.round(v * 255))).toEqual([128, 128, 128, 255]);
    expect(def.layers[0].colorAdd).toEqual([0.5, 0, 0, 1]);
    // Big is only for 20..100 pt, and the font is 14 pt.
    expect(activeLayers(def)).toEqual([0]);
  });
});

describe('text in scenes', () => {
  it('bakes a text layer into a reanim text track whose words change at keys', () => {
    const doc = SceneDocument.create('S');
    doc.state.length = 4;
    doc.addLayer('text', 'FONT_HOUSEOFTERROR28', 'Title', { x: 10, y: 20, text: 'Hi' }, 0);
    doc.setKey(0, 2, { text: 'Bye' }, 'k');
    const { definition } = bakeScene(doc.state, { assets: new AssetLibrary(), prefab: () => null });
    const t = definition.tracks[1];
    expect(t.transforms.map((x) => [x.text, x.font, x.f])).toEqual([
      ['Hi', 'FONT_HOUSEOFTERROR28', 0],
      ['Hi', 'FONT_HOUSEOFTERROR28', 0],
      ['Bye', 'FONT_HOUSEOFTERROR28', 0],
      ['Bye', 'FONT_HOUSEOFTERROR28', 0],
    ]);
    expect(t.transforms[0]).toMatchObject({ ...DEFAULT_TRANSFORM, x: 10, y: 20, text: 'Hi', font: 'FONT_HOUSEOFTERROR28' });
  });

  it('guesses a point size from the font id', () => {
    expect(fontSizeHint('FONT_HOUSEOFTERROR28')).toBe(28);
    expect(fontSizeHint('FONT_TINYBOLD')).toBe(18);
    expect(fontSizeHint('FONT_PICO129')).toBe(12);
  });
});
