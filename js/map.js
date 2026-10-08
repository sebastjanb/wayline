// Vector map drawn on a 2D canvas: OpenFreeMap tiles (OpenStreetMap data),
// own rotate + tilt projection, no WebGL. Black stays black, because black is
// transparent on the additive display.

import { decodeTile, maybeGunzip } from './mvt.js';
import { EARTH_CIRCUMFERENCE, yToLat, xToLon, distance } from './geo.js';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const TEMPLATE_KEY = 'glassnav.tiles';
const LAYERS = ['water', 'waterway', 'park', 'landcover', 'building', 'transportation', 'transportation_name', 'poi'];
const MAX_TILES = 48;
const DATA_MAX_ZOOM = 14;
const CAMERA_DISTANCE = 1100;

const ROAD_RANK = {
  motorway: 3, trunk: 3, primary: 3,
  secondary: 2, tertiary: 2,
  minor: 1, service: 1, busway: 1,
  path: 0, track: 0, pedestrian: 0, pier: 0,
};
const ROAD_WIDTH = [1.4, 2.4, 3.4, 4.6];
const ROAD_COLOR = ['rgba(140,146,160,.5)', '#7d8490', '#9ea4b0', '#c3c8d2'];

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
  const tile = { z, x, y, water: [], waterway: [], park: [], building: [], roadArea: [], roads: [[], [], [], []], labels: [], pois: [] };
  const polys = (name, into, keep) => {
    for (const f of layers[name] || []) {
      if (f.type !== 3 || (keep && !keep(f.props))) continue;
      for (const part of f.parts) into.push(shape(part));
    }
  };
  polys('water', tile.water);
  polys('park', tile.park);
  polys('landcover', tile.park, (p) => p.class === 'grass' || p.class === 'wood');
  polys('building', tile.building);
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
    tile.labels.push({ name, rank, x: (longest[mid - 2] + longest[mid]) / 2, y: (longest[mid - 1] + longest[mid + 1]) / 2 });
  }
  for (const f of layers.poi || []) {
    const name = f.props['name:en'] || f.props.name_en || f.props['name:latin'] || f.props.name;
    if (f.type !== 1 || !name || !f.parts.length) continue;
    tile.pois.push({ name, cls: f.props.class || '', sub: f.props.subclass || '', rank: f.props.rank || 99, x: f.parts[0][0], y: f.parts[0][1] });
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
    this.turnArrow = null;  // Float64Array: the route through the next turn
    this.labels = false;    // draw street names
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
    ctx.fillStyle = '#0c121d';
    ctx.fillRect(0, 0, this.size, this.size);

    const fill = (bucket, color) => {
      ctx.beginPath();
      for (const tile of tiles) for (const s of tile[bucket]) if (seen(s)) ring(s.pts);
      ctx.fillStyle = color;
      ctx.fill('evenodd');
    };
    fill('park', '#12301f');
    fill('water', '#123a66');
    ctx.beginPath();
    for (const tile of tiles) for (const s of tile.waterway) if (seen(s)) line(s.pts);
    ctx.strokeStyle = '#123a66';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (cam.zoom >= 16.4) fill('building', '#1a2233');
    fill('roadArea', '#1b2638');

    const widthScale = clamp(2 ** (cam.zoom - 16), 0.5, 1.5);
    for (let rank = cam.zoom < 13.5 ? 2 : cam.zoom < 15 ? 1 : 0; rank < 4; rank++) {
      ctx.beginPath();
      for (const tile of tiles) for (const s of tile.roads[rank]) if (seen(s)) line(s.pts);
      ctx.strokeStyle = ROAD_COLOR[rank];
      ctx.lineWidth = Math.max(1, ROAD_WIDTH[rank] * widthScale);
      ctx.stroke();
    }

    if (this.route) {
      const from = this.routeFrom;
      ctx.beginPath();
      line(this.route, from ? (from.index + 1) * 2 : 0, from);
      ctx.strokeStyle = 'rgba(140,90,255,.4)';
      ctx.lineWidth = 16;
      ctx.stroke();
      ctx.strokeStyle = '#9461ff';
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.strokeStyle = '#e6dcff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // The next turn, raised off the map: a white arrow bent along the route.
    if (this.turnArrow) {
      const pts = [];
      for (let i = 0; i < this.turnArrow.length; i += 2) {
        const q = toScreen(this.turnArrow[i], this.turnArrow[i + 1]);
        if (q) pts.push(q);
      }
      if (pts.length >= 2) {
        const tip = pts[pts.length - 1];
        let back = pts[pts.length - 2];
        for (let i = pts.length - 2; i >= 0 && Math.hypot(tip[0] - back[0], tip[1] - back[1]) < 6; i--) back = pts[i];
        const a = Math.atan2(tip[1] - back[1], tip[0] - back[0]);
        for (const [lift, color] of [[5, '#3a2a80'], [0, '#ffffff']]) {
          ctx.beginPath();
          pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1] + lift) : ctx.moveTo(q[0], q[1] + lift)));
          ctx.strokeStyle = color;
          ctx.lineWidth = 6;
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(tip[0] + Math.cos(a) * 16, tip[1] + Math.sin(a) * 20 + lift);
          ctx.lineTo(tip[0] + Math.cos(a + 2.2) * 13, tip[1] + Math.sin(a + 2.2) * 13 + lift);
          ctx.lineTo(tip[0] + Math.cos(a - 2.2) * 13, tip[1] + Math.sin(a - 2.2) * 13 + lift);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
        }
      }
    }

    // Street names: nearest first, skipping any that would overlap one already placed.
    if (this.labels && cam.zoom >= 15) {
      const wanted = [];
      for (const tile of tiles) for (const l of tile.labels) {
        if (l.x < x0 || l.x > x1 || l.y < y0 || l.y > y1) continue;
        const q = toScreen(l.x, l.y);
        if (!q || q[0] < 40 || q[0] > 560 || q[1] < 110 || q[1] > 520) continue;
        if (Math.hypot(q[0] - ax, q[1] - ay) < 46) continue;   // keep the arrow clear
        wanted.push({ name: l.name, q, order: Math.hypot(q[0] - ax, q[1] - ay) - l.rank * 60 });
      }
      wanted.sort((a, b) => a.order - b.order);
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#000';
      ctx.fillStyle = '#eef0f5';
      const placed = [], names = new Set();
      for (const l of wanted) {
        if (placed.length >= 7) break;
        if (names.has(l.name)) continue;
        const half = ctx.measureText(l.name).width / 2 + 8;
        if (placed.some((b) => Math.abs(b.q[0] - l.q[0]) < b.half + half && Math.abs(b.q[1] - l.q[1]) < 24)) continue;
        placed.push({ q: l.q, half });
        names.add(l.name);
        ctx.strokeText(l.name, l.q[0], l.q[1]);
        ctx.fillText(l.name, l.q[0], l.q[1]);
      }
    }

    for (const pin of this.pins) {
      const q = toScreen(pin.x, pin.y);
      if (!q) continue;
      ctx.beginPath();
      ctx.arc(q[0], q[1], pin.active ? 17 : 13, 0, 7);
      ctx.fillStyle = pin.active ? '#ffffff' : '#3d9bff';
      ctx.fill();
      ctx.fillStyle = pin.active ? '#0b1220' : '#ffffff';
      ctx.font = `700 ${pin.active ? 18 : 15}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pin.label, q[0], q[1] + 1);
    }

    if (this.dest) {
      const q = toScreen(this.dest.x, this.dest.y);
      if (q) {
        ctx.beginPath();
        ctx.arc(q[0], q[1], 13, 0, 7);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(q[0], q[1], 6, 0, 7);
        ctx.fillStyle = '#ff5a4f';
        ctx.fill();
      }
    }

    if (this.puck) {
      const q = toScreen(this.puck.x, this.puck.y);
      if (q && this.puck.arrow) {
        // A small arrow lying on the map, pointing the way the wearer faces.
        const dx = (this.puck.x - cx) * S, dy = (this.puck.y - cy) * S;
        const gx = dx * cosB + dy * sinB, gy = -dx * sinB + dy * cosB;
        const a = ((this.puck.heading == null ? cam.bearing : this.puck.heading) - cam.bearing) * Math.PI / 180;
        const cosA = Math.cos(a), sinA = Math.sin(a);
        const pts = [[0, -24], [17, 19], [0, 9], [-17, 19]].map(([x, y]) => project(gx + x * cosA - y * sinA, gy + x * sinA + y * cosA));
        for (const [lift, fillColor] of [[5, '#5b3fb3'], [0, '#ffffff']]) {
          ctx.beginPath();
          pts.forEach((v, i) => (i ? ctx.lineTo(v[0], v[1] + lift) : ctx.moveTo(v[0], v[1] + lift)));
          ctx.closePath();
          ctx.fillStyle = fillColor;
          ctx.fill();
        }
        ctx.strokeStyle = '#2a1d5c';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (q) {
        const halo = clamp((this.puck.accuracy || 0) / this.metersPerPixel(), 0, 90);
        if (halo > 18) {
          ctx.beginPath();
          ctx.arc(q[0], q[1], halo, 0, 7);
          ctx.fillStyle = 'rgba(61,155,255,.16)';
          ctx.fill();
        }
        if (this.puck.heading != null) {
          const a = (this.puck.heading - cam.bearing - 90) * Math.PI / 180;
          const cone = ctx.createRadialGradient(q[0], q[1], 8, q[0], q[1], 58);
          cone.addColorStop(0, 'rgba(120,190,255,.75)');
          cone.addColorStop(1, 'rgba(120,190,255,0)');
          ctx.beginPath();
          ctx.moveTo(q[0], q[1]);
          ctx.arc(q[0], q[1], 58, a - 0.5, a + 0.5);
          ctx.closePath();
          ctx.fillStyle = cone;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(q[0], q[1], 14, 0, 7);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(q[0], q[1], 10, 0, 7);
        ctx.fillStyle = '#2f8cff';
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
