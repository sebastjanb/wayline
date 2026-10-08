// Follows a route: snaps each position fix onto the route line and works out
// what the wearer needs to know next.

import { bearing } from './geo.js';

const METERS_PER_DEGREE = 111320;

export class RouteGuide {
  constructor(route) {
    this.route = route;
    this.index = 0;
  }

  // Closest point on segments [from, to], measured in metres on a local flat grid.
  closest(lat, lon, from, to) {
    const { latlon } = this.route;
    const kx = METERS_PER_DEGREE * Math.cos(lat * Math.PI / 180), ky = METERS_PER_DEGREE;
    let best = { off: Infinity, index: from, t: 0 };
    for (let i = from; i <= to; i++) {
      const ax = (latlon[i * 2 + 1] - lon) * kx, ay = (latlon[i * 2] - lat) * ky;
      const bx = (latlon[i * 2 + 3] - lon) * kx, by = (latlon[i * 2 + 2] - lat) * ky;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
      const off = Math.hypot(ax + dx * t, ay + dy * t);
      if (off < best.off) best = { off, index: i, t };
    }
    return best;
  }

  update(lat, lon) {
    const { latlon, world, cum, count, maneuvers, total, time } = this.route;
    const last = count - 2;
    if (last < 0) return null;
    // Look near the last known spot first, so a route that doubles back on
    // itself does not jump to the wrong pass.
    let hit = this.closest(lat, lon, Math.max(0, this.index - 3), Math.min(last, this.index + 40));
    if (hit.off > 60) hit = this.closest(lat, lon, 0, last);
    this.index = hit.index;

    const i = hit.index, t = hit.t;
    const along = cum[i] + (cum[i + 1] - cum[i]) * t;
    let current = 0;
    for (let m = 0; m < maneuvers.length; m++) {
      if (maneuvers[m].begin <= i) current = m; else break;
    }
    const next = maneuvers[current + 1] || null;
    return {
      index: i,
      off: hit.off,
      x: world[i * 2] + (world[i * 2 + 2] - world[i * 2]) * t,
      y: world[i * 2 + 1] + (world[i * 2 + 3] - world[i * 2 + 1]) * t,
      course: bearing(latlon[i * 2], latlon[i * 2 + 1], latlon[i * 2 + 2], latlon[i * 2 + 3]),
      along,
      remaining: total - along,
      secondsLeft: total ? time * (total - along) / total : 0,
      current: maneuvers[current],
      next,
      nextIndex: current + 1,
      toNext: next ? Math.max(0, cum[next.begin] - along) : total - along,
    };
  }

  // The stretch of route between two distances, in world coordinates.
  slice(from, to) {
    const { world, cum, count, total } = this.route;
    from = Math.max(0, from);
    to = Math.min(total, to);
    const at = (meters) => {
      let i = 0;
      while (i < count - 2 && cum[i + 1] < meters) i++;
      const span = cum[i + 1] - cum[i], t = span ? (meters - cum[i]) / span : 0;
      return [world[i * 2] + (world[i * 2 + 2] - world[i * 2]) * t, world[i * 2 + 1] + (world[i * 2 + 3] - world[i * 2 + 1]) * t];
    };
    const out = [...at(from)];
    for (let i = 0; i < count; i++) if (cum[i] > from && cum[i] < to) out.push(world[i * 2], world[i * 2 + 1]);
    out.push(...at(to));
    return Float64Array.from(out);
  }

  // Position `meters` along the route: the look-ahead target and the desk demo.
  pointAt(meters) {
    const { latlon, cum, count } = this.route;
    let i = 0;
    while (i < count - 2 && cum[i + 1] < meters) i++;
    const span = cum[i + 1] - cum[i];
    const t = span ? Math.min(1, Math.max(0, (meters - cum[i]) / span)) : 0;
    return {
      lat: latlon[i * 2] + (latlon[i * 2 + 2] - latlon[i * 2]) * t,
      lon: latlon[i * 2 + 1] + (latlon[i * 2 + 3] - latlon[i * 2 + 1]) * t,
      course: bearing(latlon[i * 2], latlon[i * 2 + 1], latlon[i * 2 + 2], latlon[i * 2 + 3]),
    };
  }
}
