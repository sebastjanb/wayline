// Vector map drawn on a 2D canvas: OpenFreeMap tiles (OpenStreetMap data),
// own rotate + tilt projection, no WebGL. Black stays black, because black is
// transparent on the additive display.

import { decodeTile, maybeGunzip } from './mvt.js';
import { EARTH_CIRCUMFERENCE, yToLat, xToLon, distance } from './geo.js';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const TEMPLATE_KEY = 'glassnav.tiles';
const LAYERS = ['water', 'waterway', 'park', 'landcover', 'transportation', 'transportation_name', 'poi'];
const MAX_TILES = 48;
const DATA_MAX_ZOOM = 14;
const CAMERA_DISTANCE = 1100;

const ROAD_RANK = {
  motorway: 3, trunk: 3, primary: 3,
  secondary: 2, tertiary: 2,
  minor: 1, service: 1, busway: 1,
  path: 0, track: 0, pedestrian: 0, pier: 0,
};
const ROAD_WIDTH = [1.6, 3.2, 5, 7];
const ROAD_COLOR = ['rgba(160,174,214,.42)', '#8794ba', '#a7b3d6', '#c6cfec'];

// Places worth a pin on the map: colour and symbol by kind.
const POI_STYLES = [
  { glyph: 'bed', color: '#a56bff', kinds: ['lodging', 'hotel', 'hostel', 'motel', 'guest_house'] },
  { glyph: 'star', color: '#e0a52e', kinds: ['attraction', 'museum', 'monument', 'castle', 'viewpoint', 'gallery', 'art_gallery', 'zoo', 'theme_park', 'aquarium', 'stadium', 'theatre'] },
  { glyph: 'food', color: '#f0803c', kinds: ['restaurant', 'fast_food', 'food_court'] },
  { glyph: 'cup', color: '#f0803c', kinds: ['cafe', 'bar', 'beer', 'pub'] },
  { glyph: 'tree', color: '#3fb56f', kinds: ['park', 'garden'] },
];
const poiStyle = (cls, sub) => POI_STYLES.find((s) => s.kinds.includes(cls) || s.kinds.includes(sub)) || null;

// White symbol inside a pin, centred on (x, y), about 14 px across.
function drawGlyph(ctx, glyph, x, y) {
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (glyph === 'star') {
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 3.3 : 7.6, a = -Math.PI / 2 + i * Math.PI / 5;
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.fill();
  } else if (glyph === 'bed') {
    ctx.rect(x - 7.5, y - 5.5, 2.4, 11);
    ctx.rect(x - 7.5, y + 0.5, 15, 3.4);
    ctx.rect(x + 5.1, y + 0.5, 2.4, 5);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x - 2.4, y - 1.8, 2.1, 0, 7);
    ctx.fill();
  } else if (glyph === 'food') {
    ctx.moveTo(x - 3.5, y - 7); ctx.lineTo(x - 3.5, y + 7);
    ctx.moveTo(x - 6, y - 7); ctx.lineTo(x - 6, y - 2.5); ctx.lineTo(x - 1, y - 2.5); ctx.lineTo(x - 1, y - 7);
    ctx.moveTo(x + 4.5, y + 7); ctx.lineTo(x + 4.5, y - 7); ctx.quadraticCurveTo(x + 8, y - 3, x + 4.5, y + 0.5);
    ctx.stroke();
  } else if (glyph === 'cup') {
    ctx.rect(x - 6, y - 4.5, 9.5, 9.5);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + 4.5, y - 0.5, 3, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  } else {
    ctx.arc(x, y - 2.2, 5.6, 0, 7);
    ctx.rect(x - 1.2, y + 2, 2.4, 5.5);
    ctx.fill();
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function shape(pts) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minx) minx = pts[i];
    if (pts[i] > maxx) maxx = pts[i];
    if (pts[i + 1] < miny) miny = pts[i + 1];
    if (pts[i + 1] > maxy) maxy = pts[i + 1];
  }
  return { pts, minx, miny, maxx, maxy };
}

function buildTile(z, x, y, layers) {
  const tile = { z, x, y, water: [], waterway: [], park: [], roadArea: [], roads: [[], [], [], []], labels: [], pois: [] };
  const polys = (name, into, keep) => {
    for (const f of layers[name] || []) {
      if (f.type !== 3 || (keep && !keep(f.props))) continue;
      for (const part of f.parts) into.push(shape(part));
    }
  };
  polys('water', tile.water);
  polys('park', tile.park);
  polys('landcover', tile.park, (p) => p.class === 'grass' || p.class === 'wood');
  for (const f of layers.waterway || []) {
    if (f.type === 2) for (const part of f.parts) tile.waterway.push(shape(part));
  }
  for (const f of layers.transportation || []) {
    const rank = ROAD_RANK[f.props.class];
    if (rank === undefined) continue;
    if (f.type === 3) { for (const part of f.parts) tile.roadArea.push(shape(part)); continue; }
    if (f.type === 2) for (const part of f.parts) tile.roads[rank].push(shape(part));
  }
  // One label per named street piece, at the middle of its longest part.
  for (const f of layers.transportation_name || []) {
    const name = f.props['name:latin'] || f.props.name;
    const rank = ROAD_RANK[f.props.class];
    if (f.type !== 2 || !name || rank === undefined) continue;
    let longest = null;
    for (const part of f.parts) if (!longest || part.length > longest.length) longest = part;
    if (!longest || longest.length < 4) continue;
    const mid = (longest.length >> 2) * 2;
    // The two ends of the middle segment give the label its place and its slant.
    tile.labels.push({ name: name.toUpperCase(), rank, ax: longest[mid - 2], ay: longest[mid - 1], bx: longest[mid], by: longest[mid + 1] });
  }
  for (const f of layers.poi || []) {
    const name = f.props['name:en'] || f.props.name_en || f.props['name:latin'] || f.props.name;
    if (f.type !== 1 || !name || !f.parts.length) continue;
    const cls = f.props.class || '', kind = f.props.subclass || '';
    tile.pois.push({ name, cls, sub: kind, rank: f.props.rank || 99, style: poiStyle(cls, kind), x: f.parts[0][0], y: f.parts[0][1] });
  }
  return tile;
}

class TileStore {
  constructor(onLoad) {
    this.onLoad = onLoad;
    this.tiles = new Map();   // key -> tile | { pending } | { failedAt }
    this.template = null;
    this.templatePromise = null;
    this.stats = { loaded: 0, failed: 0, lastError: '' };   // shown on the diagnostics screen
  }

  // The tile URL carries a dataset version, so it comes from the TileJSON.
  getTemplate() {
    if (this.template) return Promise.resolve(this.template);
    if (!this.templatePromise) {
      this.templatePromise = fetch(TILEJSON)
        .then((r) => r.json())
        .then((json) => {
          this.template = json.tiles[0];
          try { localStorage.setItem(TEMPLATE_KEY, this.template); } catch {}
          return this.template;
        })
        .catch(() => {
          this.templatePromise = null;
          let saved = null;
          try { saved = localStorage.getItem(TEMPLATE_KEY); } catch {}
          if (!saved) throw new Error('map tiles unreachable');
          return saved;
        });
    }
    return this.templatePromise;
  }

  // Returns the tile if it is ready, and starts loading it otherwise.
  get(z, x, y) {
    const n = 2 ** z;
    if (y < 0 || y >= n) return null;
    x = ((x % n) + n) % n;
    const key = `${z}/${x}/${y}`;
    const hit = this.tiles.get(key);
    if (hit) {
      if (hit.failedAt && Date.now() - hit.failedAt > 15000) this.tiles.delete(key);
      else {
        if (hit.z !== undefined) { this.tiles.delete(key); this.tiles.set(key, hit); }
        return hit.z !== undefined ? hit : null;
      }
    }
    this.load(z, x, y, key);
    return null;
  }

  load(z, x, y, key = `${z}/${x}/${y}`) {
    const existing = this.tiles.get(key);
    if (existing && existing.z !== undefined) return Promise.resolve(existing);
    if (existing && existing.pending) return existing.pending;
    const pending = this.getTemplate()
      // A stalled download on a weak connection must fail, so it can be retried.
      .then((tpl) => fetch(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y),
        AbortSignal.timeout ? { signal: AbortSignal.timeout(30000) } : undefined))
      .then((r) => {
        if (r.status === 204 || r.status === 404) return new ArrayBuffer(0);
        if (!r.ok) throw new Error('tile ' + r.status);
        return r.arrayBuffer();
      })
      .then(maybeGunzip)
      .then((bytes) => {
        const tile = buildTile(z, x, y, bytes.length ? decodeTile(bytes, z, x, y, LAYERS) : {});
        this.tiles.set(key, tile);
        this.stats.loaded++;
        this.evict();
        this.onLoad();
        return tile;
      })
      .catch((err) => {
        this.tiles.set(key, { failedAt: Date.now() });
        this.stats.failed++;
        this.stats.lastError = String(err && err.message || err);
        this.onLoad();
        return null;
      });
    this.tiles.set(key, { pending });
    return pending;
  }

  evict() {
    for (const [key, tile] of this.tiles) {
      if (this.tiles.size <= MAX_TILES) break;
      if (tile.z !== undefined) this.tiles.delete(key);
    }
  }
}

export class MapView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.size = 600;
    this.onTiles = null;
    this.store = new TileStore(() => { this.requestRender(); if (this.onTiles) this.onTiles(); });
    this.cam = { x: 0.5, y: 0.5, zoom: 16, bearing: 0, pitch: 0 };
    this.target = { ...this.cam };
    this.anchor = { x: 300, y: 300 };
    this.mask = { x: 300, y: 300, r: 290 };
    this.visible = true;
    this.puck = null;       // { x, y, heading, accuracy }
    this.route = null;      // Float64Array of world coordinates
    this.routeFrom = null;  // { index, x, y }: the route is drawn from here on
    this.dest = null;       // { x, y }
    this.pins = [];         // [{ x, y, label, active }]
    this.routeStyle = 'preview';   // 'preview' (blue dots) or 'guide' (white dots)
    this.labels = false;    // draw street names
    this.landmarks = true;  // draw pins for notable places
    this.keepLandmark = null;   // a pin the wearer has focused stays on the map
    this.onLandmarks = null;    // told which pins were drawn, and where
    this.raf = 0;
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.requestRender();
  }

  setCamera(next, immediate = false) {
    Object.assign(this.target, next);
    if (immediate) Object.assign(this.cam, this.target);
    this.requestRender();
  }

  setLayout(anchor, mask) {
    this.anchor = anchor;
    this.mask = mask;
    this.requestRender();
  }

  // Zoom and centre that put every point inside a box of `box` screen pixels.
  fit(pts, box) {
    const b = shape(pts);
    const span = Math.max(b.maxx - b.minx, b.maxy - b.miny, 1e-7);
    return { x: (b.minx + b.maxx) / 2, y: (b.miny + b.maxy) / 2, zoom: clamp(Math.log2(box / (span * 256)), 3, 17.5) };
  }

  panBy(dx, dy) {
    const S = 256 * 2 ** this.cam.zoom;
    const b = this.cam.bearing * Math.PI / 180, cos = Math.cos(b), sin = Math.sin(b);
    this.setCamera({
      x: this.target.x - (dx * cos - dy * sin) / S,
      y: clamp(this.target.y - (dx * sin + dy * cos) / S, 0.02, 0.98),
    }, true);
  }

  metersPerPixel() {
    return Math.cos(yToLat(this.cam.y) * Math.PI / 180) * EARTH_CIRCUMFERENCE / (256 * 2 ** this.cam.zoom);
  }

  // Tile columns and rows that a square of half-width `reach` around a point
  // touches: usually one to four tiles. City tiles are close to 1 MB each, so
  // nothing outside the view is ever requested.
  tilesAround(z, x, y, reach) {
    const n = 2 ** z, out = [];
    const x0 = Math.floor((x - reach) * n), x1 = Math.min(x0 + 2, Math.floor((x + reach) * n));
    const y0 = Math.max(0, Math.floor((y - reach) * n)), y1 = Math.min(n - 1, y0 + 2, Math.floor((y + reach) * n));
    for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) out.push([tx, ty]);
    return out;
  }

  // Loads the full-detail tiles within `reach` of a point. Points of interest
  // only exist at the deepest zoom, so nearby search waits on this.
  loadAround(x, y, reach) {
    const n = 2 ** DATA_MAX_ZOOM;
    return Promise.all(this.tilesAround(DATA_MAX_ZOOM, x, y, reach)
      .map(([tx, ty]) => this.store.load(DATA_MAX_ZOOM, ((tx % n) + n) % n, ty)));
  }

  // Named places from the loaded tiles, nearest first.
  nearby(lat, lon, matches, limit = 12) {
    const seen = new Set(), found = [];
    for (const tile of this.store.tiles.values()) {
      if (tile.z !== DATA_MAX_ZOOM) continue;
      for (const poi of tile.pois) {
        if (!matches(poi)) continue;
        const pLat = yToLat(poi.y), pLon = xToLon(poi.x);
        const key = poi.name + '|' + pLat.toFixed(4) + '|' + pLon.toFixed(4);
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ name: poi.name, kind: poi.sub || poi.cls, lat: pLat, lon: pLon, meters: distance(lat, lon, pLat, pLon) });
      }
    }
    return found.sort((a, b) => a.meters - b.meters).slice(0, limit);
  }

  // Animation frames can be throttled or paused by the host; a timer makes
  // sure the map still draws, and with it the tile loading that drawing starts.
  requestRender() {
    if (this.raf) return;
    const run = () => { if (this.raf) this.frame(); };
    this.raf = requestAnimationFrame(run);
    this.rafTimer = setTimeout(run, 300);
  }

  frame() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.rafTimer);
    this.raf = 0;
    const c = this.cam, t = this.target, k = 0.2;
    // A far target is a jump, not a glide: gliding there would draw, and so
    // download, every tile on the way.
    const far = 900 / (256 * 2 ** c.zoom);
    if (Math.abs(t.x - c.x) > far || Math.abs(t.y - c.y) > far) { c.x = t.x; c.y = t.y; c.zoom = t.zoom; }
    c.x += (t.x - c.x) * k;
    c.y += (t.y - c.y) * k;
    c.zoom += (t.zoom - c.zoom) * k;
    c.pitch += (t.pitch - c.pitch) * k;
    const turn = ((t.bearing - c.bearing + 540) % 360) - 180;
    c.bearing = (c.bearing + turn * k + 360) % 360;
    const S = 256 * 2 ** c.zoom;
    const moving = Math.abs(t.x - c.x) * S > 0.3 || Math.abs(t.y - c.y) * S > 0.3 ||
      Math.abs(t.zoom - c.zoom) > 0.005 || Math.abs(t.pitch - c.pitch) > 0.2 || Math.abs(turn) > 0.3;
    if (!moving) { c.x = t.x; c.y = t.y; c.zoom = t.zoom; c.pitch = t.pitch; c.bearing = (t.bearing + 360) % 360; }
    this.draw();
    if (moving) this.requestRender();
  }

  draw() {
    const { ctx, cam, anchor, mask } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.size, this.size);
    if (!this.visible) return;

    const S = 256 * 2 ** cam.zoom;
    const b = cam.bearing * Math.PI / 180, cosB = Math.cos(b), sinB = Math.sin(b);
    const tilted = cam.pitch > 0.5;
    const p = cam.pitch * Math.PI / 180, cosP = Math.cos(p), sinP = Math.sin(p);
    const D = CAMERA_DISTANCE;
    // Ground closer to the viewer than this would project behind the camera.
    const nearLimit = tilted ? 0.65 * D / sinP : Infinity;
    const cx = cam.x, cy = cam.y, ax = anchor.x, ay = anchor.y;

    const project = (rx, ry) => {
      if (!tilted) return [ax + rx, ay + ry];
      const k = D / (D - ry * sinP);
      return [ax + rx * k, ay + ry * cosP * k];
    };
    const toScreen = (wx, wy) => {
      const dx = (wx - cx) * S, dy = (wy - cy) * S;
      const rx = dx * cosB + dy * sinB, ry = -dx * sinB + dy * cosB;
      return ry > nearLimit ? null : project(rx, ry);
    };

    // Adds one polyline to the current path, cut off at the near limit.
    const line = (pts, start = 0, head = null) => {
      let px = 0, py = 0, wasIn = false, pen = false, first = true;
      const step = (wx, wy) => {
        const dx = (wx - cx) * S, dy = (wy - cy) * S;
        const rx = dx * cosB + dy * sinB, ry = -dx * sinB + dy * cosB;
        const isIn = ry <= nearLimit;
        if (isIn) {
          if (!pen) {
            if (!first && !wasIn) {
              const t = (nearLimit - py) / (ry - py);
              const e = project(px + (rx - px) * t, nearLimit);
              ctx.moveTo(e[0], e[1]);
              const q = project(rx, ry);
              ctx.lineTo(q[0], q[1]);
            } else {
              const q = project(rx, ry);
              ctx.moveTo(q[0], q[1]);
            }
            pen = true;
          } else {
            const q = project(rx, ry);
            ctx.lineTo(q[0], q[1]);
          }
        } else if (wasIn) {
          const t = (nearLimit - py) / (ry - py);
          const e = project(px + (rx - px) * t, nearLimit);
          ctx.lineTo(e[0], e[1]);
          pen = false;
        }
        px = rx; py = ry; wasIn = isIn; first = false;
      };
      if (head) step(head.x, head.y);
      for (let i = start; i < pts.length; i += 2) step(pts[i], pts[i + 1]);
    };

    // Adds one closed ring to the current path, clipped against the near limit.
    const ring = (pts) => {
      let poly = [];
      for (let i = 0; i < pts.length; i += 2) {
        const dx = (pts[i] - cx) * S, dy = (pts[i + 1] - cy) * S;
        poly.push(dx * cosB + dy * sinB, -dx * sinB + dy * cosB);
      }
      if (tilted) {
        const out = [];
        for (let i = 0; i < poly.length; i += 2) {
          const j = (i + 2) % poly.length;
          const x1 = poly[i], y1 = poly[i + 1], x2 = poly[j], y2 = poly[j + 1];
          const in1 = y1 <= nearLimit, in2 = y2 <= nearLimit;
          if (in1) out.push(x1, y1);
          if (in1 !== in2) {
            const t = (nearLimit - y1) / (y2 - y1);
            out.push(x1 + (x2 - x1) * t, nearLimit);
          }
        }
        poly = out;
      }
      if (poly.length < 6) return;
      for (let i = 0; i < poly.length; i += 2) {
        const q = project(poly[i], poly[i + 1]);
        if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
      }
      ctx.closePath();
    };

    // Skip anything that cannot reach the visible disc.
    const reach = mask.r * (tilted ? 3 : 1.15) / S;

    // Tiles: only the ones the view touches, at the data zoom for this view.
    // Chosen from where the zoom is heading, so a zoom animation does not fetch
    // a set of tiles for every level it passes through.
    const tz = clamp(Math.floor(this.target.zoom) - 2, 0, DATA_MAX_ZOOM);
    const tiles = [];
    for (const [tx, ty] of this.tilesAround(tz, cx, cy, reach)) {
      const tile = this.store.get(tz, tx, ty);
      if (tile) tiles.push(tile);
    }

    const x0 = cx - reach, x1 = cx + reach, y0 = cy - reach, y1 = cy + reach;
    const seen = (s) => s.maxx >= x0 && s.minx <= x1 && s.maxy >= y0 && s.miny <= y1;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.fillStyle = '#0a1532';
    ctx.fillRect(0, 0, this.size, this.size);

    const fill = (bucket, color) => {
      ctx.beginPath();
      for (const tile of tiles) for (const s of tile[bucket]) if (seen(s)) ring(s.pts);
      ctx.fillStyle = color;
      ctx.fill('evenodd');
    };
    fill('park', '#0f2a33');
    fill('water', '#0c2358');
    ctx.beginPath();
    for (const tile of tiles) for (const s of tile.waterway) if (seen(s)) line(s.pts);
    ctx.strokeStyle = '#0c2358';
    ctx.lineWidth = 2;
    ctx.stroke();
    fill('roadArea', '#1a2850');

    const widthScale = clamp(2 ** (cam.zoom - 16), 0.4, 1.6);
    for (let rank = cam.zoom < 13.5 ? 2 : cam.zoom < 15 ? 1 : 0; rank < 4; rank++) {
      ctx.beginPath();
      for (const tile of tiles) for (const s of tile.roads[rank]) if (seen(s)) line(s.pts);
      ctx.strokeStyle = ROAD_COLOR[rank];
      ctx.lineWidth = Math.max(1, ROAD_WIDTH[rank] * widthScale);
      ctx.stroke();
    }

    // The route is a string of dots, the way walking directions are drawn.
    if (this.route) {
      const from = this.routeFrom, guiding = this.routeStyle === 'guide';
      const path = [];
      if (from) { const q = toScreen(from.x, from.y); if (q) path.push(q); }
      for (let i = from ? (from.index + 1) * 2 : 0; i < this.route.length; i += 2) {
        const q = toScreen(this.route[i], this.route[i + 1]);
        if (q) path.push(q);
      }
      const gap = guiding ? 22 : 15, radius = guiding ? 5.5 : 4.5;
      let next = guiding ? gap : 0;   // while guiding, the first dot sits clear of the marker
      ctx.beginPath();
      for (let i = 1; i < path.length; i++) {
        const [x0, y0] = path[i - 1], [x1, y1] = path[i];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (!len) continue;
        for (; next <= len; next += gap) {
          const x = x0 + (x1 - x0) * next / len, y = y0 + (y1 - y0) * next / len;
          if (x < -10 || x > 610 || y < -10 || y > 610) continue;
          ctx.moveTo(x + radius, y);
          ctx.arc(x, y, radius, 0, 7);
        }
        next -= len;
      }
      ctx.fillStyle = guiding ? '#ffffff' : '#6fb1ff';
      ctx.fill();
      // A dark rim keeps white dots readable where they run along a pale street.
      ctx.strokeStyle = guiding ? '#0e1b3d' : '#ffffff';
      ctx.lineWidth = guiding ? 2 : 1.5;
      ctx.stroke();
    }

    const placed = [];   // screen spots already taken by a label or a pin

    // Street names lie along their streets, in capitals on a dark plate. Nearest
    // first; a name that would overlap one already placed is skipped.
    if (this.labels && cam.zoom >= 14.5) {
      const minRank = cam.zoom < 15.5 ? 2 : cam.zoom < 16.3 ? 1 : 0;
      const wanted = [];
      for (const tile of tiles) for (const l of tile.labels) {
        if (l.rank < minRank || l.ax < x0 || l.ax > x1 || l.ay < y0 || l.ay > y1) continue;
        const a = toScreen(l.ax, l.ay), b = toScreen(l.bx, l.by);
        if (!a || !b) continue;
        const q = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (Math.hypot(q[0] - mask.x, q[1] - mask.y) > mask.r * 0.82 || q[1] < 135 || q[1] > 470) continue;
        if (Math.hypot(q[0] - ax, q[1] - ay) < 46) continue;   // keep the marker clear
        let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (angle > Math.PI / 2) angle -= Math.PI;
        if (angle < -Math.PI / 2) angle += Math.PI;
        wanted.push({ name: l.name, q, angle, order: Math.hypot(q[0] - ax, q[1] - ay) - l.rank * 70 });
      }
      wanted.sort((a, b) => a.order - b.order);
      ctx.font = '600 14px system-ui, sans-serif';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const names = new Set();
      for (const l of wanted) {
        if (placed.length >= 6) break;
        if (names.has(l.name)) continue;
        const half = ctx.measureText(l.name).width / 2 + 7;
        if (placed.some((p) => Math.hypot(p.q[0] - l.q[0], p.q[1] - l.q[1]) < p.half + half)) continue;
        placed.push({ q: l.q, half });
        names.add(l.name);
        ctx.save();
        ctx.translate(l.q[0], l.q[1]);
        ctx.rotate(l.angle);
        ctx.fillStyle = 'rgba(8,16,40,.85)';
        ctx.fillRect(-half, -11, half * 2, 22);
        ctx.fillStyle = '#dfe6fa';
        ctx.fillText(l.name, 0, 1);
        ctx.restore();
      }
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }

    // Landmarks: a coloured pin with a symbol and the name beside it. The most
    // notable few in view, never on top of a street name or each other.
    if (this.landmarks && cam.zoom >= 15) {
      const found = [];
      for (const tile of tiles) for (const poi of tile.pois) {
        if (!poi.style || poi.x < x0 || poi.x > x1 || poi.y < y0 || poi.y > y1) continue;
        if (this.dest && Math.abs(poi.x - this.dest.x) * S < 18 && Math.abs(poi.y - this.dest.y) * S < 18) continue;
        const q = toScreen(poi.x, poi.y);
        if (!q || Math.hypot(q[0] - mask.x, q[1] - mask.y) > mask.r * 0.8 || q[1] < 150 || q[1] > 470 || q[0] < 40 || q[0] > 430) continue;
        if (Math.hypot(q[0] - ax, q[1] - ay) < 60) continue;
        // Sights, hotels and parks come before places to eat, which are everywhere.
        const everyday = poi.style.glyph === 'food' || poi.style.glyph === 'cup' ? 400 : 0;
        const kept = poi.name + poi.x === this.keepLandmark ? -1e6 : 0;
        found.push({ poi, q, order: kept + everyday + poi.rank * 40 + Math.hypot(q[0] - ax, q[1] - ay) });
      }
      found.sort((a, b) => a.order - b.order);
      let shown = 0;
      const drawn = [];
      for (const { poi, q } of found) {
        if (shown >= 4) break;
        const name = poi.name.length > 20 ? poi.name.slice(0, 19).trimEnd() + '…' : poi.name;
        ctx.font = '600 15px system-ui, sans-serif';
        const half = 16 + ctx.measureText(name).width / 2 + 10;
        const centre = [q[0] + half - 16, q[1] - 20];
        if (placed.some((p) => Math.hypot(p.q[0] - centre[0], p.q[1] - centre[1]) < p.half + half)) continue;
        placed.push({ q: centre, half });
        shown++;
        drawn.push({ poi, q });
        // Pin: a disc with a point underneath, tip on the place itself.
        ctx.beginPath();
        ctx.moveTo(q[0], q[1]);
        ctx.lineTo(q[0] - 8, q[1] - 11);
        ctx.arc(q[0], q[1] - 21, 13.5, Math.PI * 0.8, Math.PI * 0.2);
        ctx.closePath();
        ctx.fillStyle = poi.style.color;
        ctx.fill();
        drawGlyph(ctx, poi.style.glyph, q[0], q[1] - 21);
        ctx.font = '600 15px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(6,12,32,.9)';
        ctx.strokeText(name, q[0] + 19, q[1] - 20);
        ctx.fillStyle = '#f2f5fc';
        ctx.fillText(name, q[0] + 19, q[1] - 20);
      }
      if (this.onLandmarks) this.onLandmarks(drawn);
    } else if (this.onLandmarks) this.onLandmarks([]);

    for (const pin of this.pins) {
      const q = toScreen(pin.x, pin.y);
      if (!q) continue;
      ctx.beginPath();
      ctx.arc(q[0], q[1], pin.active ? 17 : 13, 0, 7);
      ctx.fillStyle = pin.active ? '#ffffff' : '#4f8dff';
      ctx.fill();
      ctx.fillStyle = pin.active ? '#0b1220' : '#ffffff';
      ctx.font = `700 ${pin.active ? 18 : 15}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pin.label, q[0], q[1] + 1);
    }

    // Destination: a blue dot in a white ring.
    if (this.dest) {
      const q = toScreen(this.dest.x, this.dest.y);
      if (q) {
        ctx.beginPath();
        ctx.arc(q[0], q[1], 12.5, 0, 7);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(q[0], q[1], 8.5, 0, 7);
        ctx.fillStyle = '#2f7bff';
        ctx.fill();
      }
    }

    // The wearer: a white ring lying on the map with an arrow for where they face.
    if (this.puck) {
      const q = toScreen(this.puck.x, this.puck.y);
      if (q) {
        const halo = clamp((this.puck.accuracy || 0) / this.metersPerPixel(), 0, 90);
        if (halo > 28) {
          ctx.beginPath();
          ctx.arc(q[0], q[1], halo, 0, 7);
          ctx.fillStyle = 'rgba(79,141,255,.14)';
          ctx.fill();
        }
        const squash = tilted ? Math.max(0.62, cosP + 0.12) : 1;
        ctx.beginPath();
        ctx.ellipse(q[0], q[1], 21, 21 * squash, 0, 0, 7);
        ctx.fillStyle = '#101d42';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.beginPath();
        if (this.puck.heading == null) {
          ctx.arc(q[0], q[1], 5, 0, 7);
        } else {
          const a = (this.puck.heading - cam.bearing) * Math.PI / 180, cosA = Math.cos(a), sinA = Math.sin(a);
          [[0, -12], [8.5, 9], [0, 4.5], [-8.5, 9]].forEach(([x, y], i) => {
            const px = q[0] + x * cosA - y * sinA, py = q[1] + (x * sinA + y * cosA) * squash;
            if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
          });
          ctx.closePath();
        }
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }
    }

    // Fade the map out to black so it floats instead of filling the lens.
    const fade = ctx.createRadialGradient(mask.x, mask.y, mask.r * 0.72, mask.x, mask.y, mask.r);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, this.size, this.size);
    if (mask.top != null) {
      // Far streets bunch up near the horizon: fade them out before they turn into glare.
      const sky = ctx.createLinearGradient(0, mask.top, 0, mask.top + 110);
      sky.addColorStop(0, 'rgba(0,0,0,0)');
      sky.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, this.size, this.size);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
