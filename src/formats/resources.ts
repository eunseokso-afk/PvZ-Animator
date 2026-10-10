/**
 * PopCap ResourceManager manifests (properties/resources.xml).
 *
 *   <Resources id="DelayLoad_Background1">
 *     <SetDefaults path="images" idprefix="IMAGE_"/>
 *     <Image id="BACKGROUND1" path="background1" rows="1" cols="1"/>
 *     <Sound id="SOUND_..." path="sounds/..."/>
 *   </Resources>
 */

import { attr, elements, parseXmlFragment, type XmlElement } from './xml';

export interface ImageResource {
  id: string;
  /** Path without extension, forward slashes. */
  path: string;
  rows: number;
  cols: number;
  alphaImage?: string;
  /** One cel-sized alpha image applied to every cel. */
  alphaGrid?: string;
  /** 0xRRGGBB colour given to alpha-only images (default white). */
  alphaColor?: number;
  group: string;
}

export interface SimpleResource {
  id: string;
  path: string;
  group: string;
}

export interface ResourceManifest {
  images: Map<string, ImageResource>;
  sounds: Map<string, SimpleResource>;
  fonts: Map<string, SimpleResource>;
}

export function emptyManifest(): ResourceManifest {
  return { images: new Map(), sounds: new Map(), fonts: new Map() };
}

function joinPath(dir: string, p: string): string {
  p = p.replace(/\\/g, '/');
  if (!dir) return p;
  return dir.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + p;
}

export function parseResourcesXml(src: string, into: ResourceManifest = emptyManifest()): ResourceManifest {
  // Like ResourceManager, <SetDefaults> only changes the attributes it gives,
  // and the defaults carry over from one <Resources> group to the next.
  let defPath = '';
  let defPrefix = '';
  const walkGroup = (group: XmlElement, groupId: string) => {
    for (const el of elements(group.children)) {
      const tag = el.tag.toLowerCase();
      if (tag === 'setdefaults') {
        const p = attr(el, 'path');
        if (p !== undefined) defPath = p.replace(/[\\/]+$/, '');
        const ip = attr(el, 'idprefix');
        if (ip !== undefined) defPrefix = ip;
        continue;
      }
      const id = attr(el, 'id');
      const path = attr(el, 'path');
      if (!id || path === undefined) {
        if (tag === 'resources') walkGroup(el, attr(el, 'id') ?? groupId);
        continue;
      }
      const fullId = (defPrefix + id).toUpperCase();
      const fullPath = path.startsWith('!') ? path : joinPath(defPath, path);
      if (tag === 'image') {
        const alphaImage = attr(el, 'alphaimage');
        const alphaGrid = attr(el, 'alphagrid');
        const alphaColor = parseInt(attr(el, 'alphacolor') ?? '', 16);
        into.images.set(fullId, {
          id: fullId,
          path: fullPath,
          rows: Math.max(1, parseInt(attr(el, 'rows') ?? '1', 10) || 1),
          cols: Math.max(1, parseInt(attr(el, 'cols') ?? '1', 10) || 1),
          alphaImage: alphaImage ? joinPath(defPath, alphaImage) : undefined,
          alphaGrid: alphaGrid ? joinPath(defPath, alphaGrid) : undefined,
          alphaColor: Number.isFinite(alphaColor) ? alphaColor & 0xffffff : undefined,
          group: groupId,
        });
      } else if (tag === 'sound') {
        into.sounds.set(fullId, { id: fullId, path: fullPath, group: groupId });
      } else if (tag === 'font') {
        into.fonts.set(fullId, { id: fullId, path: fullPath, group: groupId });
      }
    }
  };

  for (const top of elements(parseXmlFragment(src))) {
    const tag = top.tag.toLowerCase();
    if (tag === 'resourcemanifest') {
      for (const g of elements(top.children)) {
        if (g.tag.toLowerCase() === 'resources') walkGroup(g, attr(g, 'id') ?? '');
      }
    } else if (tag === 'resources') {
      walkGroup(top, attr(top, 'id') ?? '');
    }
  }
  return into;
}
