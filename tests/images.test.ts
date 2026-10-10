import { describe, expect, it } from 'vitest';
import { AssetLibrary, composeAlpha, composeAlphaGrid, whiteFromAlpha } from '../src/engine/assets';
import { premultiplyInPlace } from '../src/engine/renderer';
import { memoryFile } from '../src/engine/vfs';

function library(paths: string[]): AssetLibrary {
  const lib = new AssetLibrary();
  for (const p of paths) lib.vfs.set(memoryFile(p, new Uint8Array([1]), 'pak'));
  return lib;
}

describe('image resolution (PopCap ImageLib rules)', () => {
  it('prefers .jpg over .png like the game', () => {
    const lib = library(['reanim/Bean.png', 'reanim/Bean.jpg']);
    expect(lib.resolveImage('IMAGE_REANIM_BEAN')?.file.path).toBe('reanim/Bean.jpg');
  });

  it('finds "_name" and "name_" alpha images for any format', () => {
    const lib = library(['reanim/Bean.jpg', 'reanim/_Bean.png', 'reanim/Leaf.png', 'reanim/Leaf_.png', 'reanim/Plain.png']);
    const bean = lib.resolveImage('IMAGE_REANIM_BEAN')!;
    expect(lib.findAlphaImage(bean.file, bean.res)?.path).toBe('reanim/_Bean.png');
    const leaf = lib.resolveImage('IMAGE_REANIM_LEAF')!;
    expect(lib.findAlphaImage(leaf.file, leaf.res)?.path).toBe('reanim/Leaf_.png');
    const plain = lib.resolveImage('IMAGE_REANIM_PLAIN')!;
    expect(lib.findAlphaImage(plain.file, plain.res)).toBeUndefined();
  });

  it('uses an alpha-only image when there is no color image', () => {
    const lib = library(['reanim/_Glow.png']);
    const r = lib.resolveImage('IMAGE_REANIM_GLOW');
    expect(r?.file.path).toBe('reanim/_Glow.png');
    expect(r?.alphaOnly).toBe(true);
  });

  it('honours resources.xml alphaimage', async () => {
    const lib = library(['images/sky.jpg', 'images/sky_mask.png']);
    await lib.importFiles([
      {
        path: 'properties/resources.xml',
        data: new TextEncoder().encode('<ResourceManifest><Resources id="a"><SetDefaults path="images" idprefix="IMAGE_"/><Image id="SKY" path="sky" alphaimage="sky_mask"/></Resources></ResourceManifest>'),
      },
    ]);
    const r = lib.resolveImage('IMAGE_SKY')!;
    expect(r.file.path).toBe('images/sky.jpg');
    expect(lib.findAlphaImage(r.file, r.res)?.path).toBe('images/sky_mask.png');
  });
});

describe('pixel helpers', () => {
  it('premultiplies and clears the color of transparent pixels', () => {
    const d = new Uint8Array([255, 255, 255, 0, 200, 100, 50, 128, 10, 20, 30, 255]);
    premultiplyInPlace(d);
    expect(Array.from(d)).toEqual([0, 0, 0, 0, 100, 50, 25, 128, 10, 20, 30, 255]);
  });

  it('takes alpha from the mask blue channel', () => {
    const color = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    composeAlpha(color, new Uint8Array([9, 9, 0, 255, 9, 9, 200, 255]));
    expect(Array.from(color)).toEqual([1, 2, 3, 0, 4, 5, 6, 200]);
  });

  it('turns an alpha-only image white', () => {
    const d = new Uint8Array([50, 50, 50, 255, 0, 0, 0, 255]);
    whiteFromAlpha(d);
    expect(Array.from(d)).toEqual([255, 255, 255, 50, 255, 255, 255, 0]);
    const red = new Uint8Array([50, 50, 50, 255]);
    whiteFromAlpha(red, 0xff0000);
    expect(Array.from(red)).toEqual([255, 0, 0, 50]);
  });

  it('applies a one-cel alpha grid to every cel', () => {
    // 4x1 image with 2 columns of 2x1 cels; the mask is one 2x1 cel.
    const color = new Uint8Array(4 * 4).fill(255);
    composeAlphaGrid(color, 4, new Uint8Array([0, 0, 10, 255, 0, 0, 20, 255]), 2, 1, 1, 2);
    expect([3, 7, 11, 15].map((i) => color[i])).toEqual([10, 20, 10, 20]);
  });
});
