// Minimal Mapbox Vector Tile decoder. Decodes only the layers asked for and
// returns geometry already converted to world coordinates (0..1 web mercator),
// so the renderer never has to know which tile a feature came from.

class Reader {
  constructor(bytes, pos = 0, end = bytes.length) {
    this.b = bytes;
    this.p = pos;
    this.end = end;
  }
  varint() {
    let result = 0, mul = 1, byte;
    do {
      byte = this.b[this.p++];
      result += (byte & 0x7f) * mul;
      mul *= 128;
    } while (byte >= 0x80);
    return result;
  }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.p += 8;
    else if (wire === 2) this.p += this.varint();
    else if (wire === 5) this.p += 4;
    else throw new Error('bad wire type ' + wire);
  }
  sub() {
    const len = this.varint();
    const r = new Reader(this.b, this.p, this.p + len);
    this.p += len;
    return r;
  }
}

const utf8 = new TextDecoder();
const zigzag = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);

function readValue(r) {
  let value = null;
  while (r.p < r.end) {
    const tag = r.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 1) { const s = r.sub(); value = utf8.decode(r.b.subarray(s.p, s.end)); }
    else if (field === 2) { value = new DataView(r.b.buffer, r.b.byteOffset + r.p, 4).getFloat32(0, true); r.p += 4; }
    else if (field === 3) { value = new DataView(r.b.buffer, r.b.byteOffset + r.p, 8).getFloat64(0, true); r.p += 8; }
    else if (field === 4 || field === 5) value = r.varint();
    else if (field === 6) value = zigzag(r.varint());
    else if (field === 7) value = r.varint() !== 0;
    else r.skip(wire);
  }
  return value;
}

function readFeature(r) {
  const f = { type: 0, tags: null, geom: null };
  while (r.p < r.end) {
    const tag = r.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 2) f.tags = r.sub();
    else if (field === 3) f.type = r.varint();
    else if (field === 4) f.geom = r.sub();
    else r.skip(wire);
  }
  return f;
}

// Geometry commands -> array of Float64Array [x0,y0,x1,y1,...] in world units.
function readGeometry(g, toWorldX, toWorldY) {
  const parts = [];
  let cur = [], x = 0, y = 0;
  while (g.p < g.end) {
    const cmdInt = g.varint(), cmd = cmdInt & 7;
    let count = cmdInt >> 3;
    if (cmd === 1 || cmd === 2) {
      while (count-- > 0) {
        x += zigzag(g.varint());
        y += zigzag(g.varint());
        if (cmd === 1 && cur.length) { parts.push(Float64Array.from(cur)); cur = []; }
        cur.push(toWorldX(x), toWorldY(y));
      }
    } else if (cmd === 7) {
      if (cur.length >= 2) cur.push(cur[0], cur[1]);
    }
  }
  if (cur.length) parts.push(Float64Array.from(cur));
  return parts;
}

// Returns { layerName: [{ type, props, parts }] } for the wanted layers.
export function decodeTile(bytes, z, tx, ty, wanted) {
  const out = {};
  const n = 2 ** z;
  const r = new Reader(bytes);
  while (r.p < r.end) {
    const tag = r.varint(), field = tag >> 3, wire = tag & 7;
    if (field !== 3) { r.skip(wire); continue; }

    const layer = r.sub();
    let name = '', extent = 4096;
    const keys = [], values = [], features = [];
    while (layer.p < layer.end) {
      const t = layer.varint(), f = t >> 3, w = t & 7;
      if (f === 1) { const s = layer.sub(); name = utf8.decode(layer.b.subarray(s.p, s.end)); }
      else if (f === 2) features.push(layer.sub());
      else if (f === 3) { const s = layer.sub(); keys.push(utf8.decode(layer.b.subarray(s.p, s.end))); }
      else if (f === 4) values.push(readValue(layer.sub()));
      else if (f === 5) extent = layer.varint();
      else layer.skip(w);
    }
    if (!wanted.includes(name)) continue;

    const toWorldX = (x) => (tx + x / extent) / n;
    const toWorldY = (y) => (ty + y / extent) / n;
    out[name] = features.map((fr) => {
      const f = readFeature(fr);
      const props = {};
      if (f.tags) while (f.tags.p < f.tags.end) props[keys[f.tags.varint()]] = values[f.tags.varint()];
      return { type: f.type, props, parts: f.geom ? readGeometry(f.geom, toWorldX, toWorldY) : [] };
    });
  }
  return out;
}

// Some hosts hand back the raw gzip body instead of letting the browser inflate it.
export async function maybeGunzip(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || typeof DecompressionStream === 'undefined') return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
