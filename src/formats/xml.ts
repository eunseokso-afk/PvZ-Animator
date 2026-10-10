/**
 * A small, forgiving XML parser.
 *
 * PopCap's data files are "XML-ish": reanim and particle files have no single
 * root element, and resources.xml uses value-less attributes. The browser's
 * DOMParser rejects all of that, so we parse by hand.
 */

export interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isNameChar(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 95 || // _
    c === 45 || // -
    c === 46 || // .
    c === 58 || // :
    c > 127
  );
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/** Parse an XML document or fragment; returns the top-level nodes. */
export function parseXmlFragment(src: string): XmlNode[] {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const root: XmlElement = { tag: '#root', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const n = src.length;
  let i = 0;
  let textStart = 0;

  const flushText = (end: number) => {
    if (end > textStart) {
      stack[stack.length - 1].children.push(decodeEntities(src.slice(textStart, end)));
    }
  };

  while (i < n) {
    if (src.charCodeAt(i) !== 60 /* < */) {
      i++;
      continue;
    }
    // Comment
    if (src.startsWith('<!--', i)) {
      flushText(i);
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      textStart = i;
      continue;
    }
    // CDATA
    if (src.startsWith('<![CDATA[', i)) {
      flushText(i);
      const end = src.indexOf(']]>', i + 9);
      const stop = end < 0 ? n : end;
      stack[stack.length - 1].children.push(src.slice(i + 9, stop));
      i = end < 0 ? n : end + 3;
      textStart = i;
      continue;
    }
    // Processing instruction / declaration
    if (src.startsWith('<?', i) || src.startsWith('<!', i)) {
      flushText(i);
      const end = src.indexOf('>', i + 2);
      i = end < 0 ? n : end + 1;
      textStart = i;
      continue;
    }
    // Closing tag
    if (src.charCodeAt(i + 1) === 47 /* / */) {
      let j = i + 2;
      while (j < n && isNameChar(src.charCodeAt(j))) j++;
      const name = src.slice(i + 2, j).toLowerCase();
      const end = src.indexOf('>', j);
      if (!name) {
        // Not a tag after all; treat as text.
        i++;
        continue;
      }
      flushText(i);
      // Pop to the matching element; ignore stray closers.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag.toLowerCase() === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? n : end + 1;
      textStart = i;
      continue;
    }
    // Opening tag
    let j = i + 1;
    while (j < n && isNameChar(src.charCodeAt(j))) j++;
    const tag = src.slice(i + 1, j);
    if (!tag) {
      i++;
      continue;
    }
    flushText(i);
    const el: XmlElement = { tag, attrs: {}, children: [] };
    let selfClosing = false;
    // Attributes
    while (j < n) {
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      const c = src.charCodeAt(j);
      if (c === 62 /* > */) {
        j++;
        break;
      }
      if (c === 47 /* / */) {
        if (src.charCodeAt(j + 1) === 62) {
          selfClosing = true;
          j += 2;
          break;
        }
        j++;
        continue;
      }
      const nameStart = j;
      while (j < n && isNameChar(src.charCodeAt(j))) j++;
      if (j === nameStart) {
        j++; // skip junk character
        continue;
      }
      const attrName = src.slice(nameStart, j);
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      let value = '';
      if (src.charCodeAt(j) === 61 /* = */) {
        j++;
        while (j < n && isSpace(src.charCodeAt(j))) j++;
        const q = src.charCodeAt(j);
        if (q === 34 || q === 39) {
          const end = src.indexOf(String.fromCharCode(q), j + 1);
          const stop = end < 0 ? n : end;
          value = decodeEntities(src.slice(j + 1, stop));
          j = end < 0 ? n : end + 1;
        } else {
          const vs = j;
          while (j < n && !isSpace(src.charCodeAt(j)) && src.charCodeAt(j) !== 62) {
            if (src.charCodeAt(j) === 47 && src.charCodeAt(j + 1) === 62) break;
            j++;
          }
          value = decodeEntities(src.slice(vs, j));
        }
      }
      el.attrs[attrName] = value;
    }
    stack[stack.length - 1].children.push(el);
    if (!selfClosing) stack.push(el);
    i = j;
    textStart = i;
  }
  flushText(n);
  return root.children;
}

export function isElement(node: XmlNode): node is XmlElement {
  return typeof node !== 'string';
}

export function elements(nodes: XmlNode[]): XmlElement[] {
  return nodes.filter(isElement);
}

export function textContent(node: XmlNode): string {
  if (typeof node === 'string') return node;
  let out = '';
  for (const c of node.children) out += textContent(c);
  return out;
}

export function findChild(el: XmlElement, tag: string): XmlElement | undefined {
  const t = tag.toLowerCase();
  for (const c of el.children) {
    if (typeof c !== 'string' && c.tag.toLowerCase() === t) return c;
  }
  return undefined;
}

/** Find all elements with the given tag at any depth. */
export function findAll(nodes: XmlNode[], tag: string, out: XmlElement[] = []): XmlElement[] {
  const t = tag.toLowerCase();
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.tag.toLowerCase() === t) out.push(n);
    findAll(n.children, tag, out);
  }
  return out;
}

/** Look up an attribute case-insensitively. */
export function attr(el: XmlElement, name: string): string | undefined {
  if (name in el.attrs) return el.attrs[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(el.attrs)) if (k.toLowerCase() === lower) return el.attrs[k];
  return undefined;
}

/** Decode bytes as UTF-8, falling back to Windows-1252 for legacy files. */
export function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (utf8.indexOf('�') < 0) return utf8;
  try {
    return new TextDecoder('windows-1252').decode(bytes);
  } catch {
    return utf8;
  }
}
