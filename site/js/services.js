// Place search (Photon) and routing (Valhalla). Both run on OpenStreetMap data,
// answer cross-origin requests and need no API key. Live traffic comes from
// TomTom through the Worker in traffic/, which holds the key.

import { decodePolyline6, distance, lonToX, latToY } from './geo.js';

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const TRAFFIC = 'https://wayline-traffic.tokglass.workers.dev/traffic';
const TRAFFIC_POINTS = 150;

export const MODES = [
  { id: 'pedestrian', label: 'Walk' },
  { id: 'bicycle', label: 'Bike' },
  { id: 'auto', label: 'Drive' },
];

async function getJson(url, signal, ms = 15000) {
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  const response = await fetch(url, { signal: signal || timeout });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

// Photon first. When it is down, a search the wearer asked for (not the
// suggestions while typing: Nominatim's rules forbid that use) goes to
// Nominatim, biased to the area around the wearer.
export async function searchPlaces(query, lat, lon, fallback = false) {
  try {
    return await searchPhoton(query, lat, lon);
  } catch (error) {
    if (!fallback) throw error;
    return searchNominatim(query, lat, lon);
  }
}

async function searchNominatim(query, lat, lon) {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '10', addressdetails: '1', 'accept-language': 'en' });
  if (lat != null) params.set('viewbox', [lon - 0.4, lat + 0.25, lon + 0.4, lat - 0.25].map((n) => n.toFixed(4)).join(','));
  const json = await getJson(`${NOMINATIM}?${params}`);
  return json.map((r) => {
    const a = r.address || {};
    const pLat = Number(r.lat), pLon = Number(r.lon);
    const street = [a.road, a.house_number].filter(Boolean).join(' ');
    const name = r.name || street || r.display_name.split(',')[0];
    const detail = [r.name ? street : '', a.city || a.town || a.village || a.county, a.country].filter(Boolean).join(', ');
    return { name, detail, kind: r.type || '', lat: pLat, lon: pLon, meters: lat == null ? null : distance(lat, lon, pLat, pLon) };
  });
}

async function searchPhoton(query, lat, lon) {
  const params = new URLSearchParams({ q: query, limit: '10', lang: 'en' });
  if (lat != null) { params.set('lat', lat.toFixed(5)); params.set('lon', lon.toFixed(5)); }
  const json = await getJson(`${PHOTON}?${params}`, null, 7000);
  return (json.features || []).map((f) => {
    const p = f.properties, [pLon, pLat] = f.geometry.coordinates;
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const name = p.name || street || p.city || 'Unnamed place';
    const detail = [p.name ? street : '', p.city || p.county, p.name && !p.city ? p.country : '']
      .filter(Boolean).join(', ');
    return { name, detail, kind: p.osm_value || '', lat: pLat, lon: pLon, meters: lat == null ? null : distance(lat, lon, pLat, pLon) };
  });
}

// `via` are points the route must pass, in order, without stopping: used to
// follow a way that the traffic service found faster.
export async function fetchRoute(from, to, mode, via = [], avoid = []) {
  const request = {
    locations: [
      { lat: from.lat, lon: from.lon },
      ...via.map(([lat, lon]) => ({ lat, lon, type: 'through', radius: 30 })),
      { lat: to.lat, lon: to.lon },
    ],
    costing: mode,
    // Roads to keep off: closures reported by traffic, or a road the driver just refused.
    ...(avoid.length ? { exclude_locations: avoid.map(([lat, lon]) => ({ lat, lon })) } : {}),
    units: 'kilometers',
    language: 'en-US',
  };
  const json = await getJson(`${VALHALLA}?json=${encodeURIComponent(JSON.stringify(request))}`);
  const leg = json.trip && json.trip.legs && json.trip.legs[0];
  if (!leg || json.trip.legs.length !== 1) throw new Error('no route');

  const latlon = decodePolyline6(leg.shape);
  const count = latlon.length / 2;
  const world = new Float64Array(latlon.length);
  const cum = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    world[i * 2] = lonToX(latlon[i * 2 + 1]);
    world[i * 2 + 1] = latToY(latlon[i * 2]);
    if (i) cum[i] = cum[i - 1] + distance(latlon[i * 2 - 2], latlon[i * 2 - 1], latlon[i * 2], latlon[i * 2 + 1]);
  }
  const maneuvers = leg.maneuvers.map((m) => ({
    type: m.type,
    text: m.instruction,
    street: (m.street_names && m.street_names[0]) || (m.begin_street_names && m.begin_street_names[0]) || '',
    say: m.verbal_pre_transition_instruction || m.instruction,
    alert: m.verbal_transition_alert_instruction || '',
    after: m.verbal_post_transition_instruction || '',
    begin: m.begin_shape_index,
    exit: m.roundabout_exit_count || 0,
  }));
  return { latlon, world, cum, count, maneuvers, total: cum[count - 1], time: json.trip.summary.time, mode };
}

export const trafficAvailable = () => !!TRAFFIC;

// Live traffic for the rest of a driving route, from `along` metres onward.
// Jams come back as distances along the route, ready to draw and to announce.
export async function fetchTraffic(route, along, wantFaster) {
  const { latlon, cum, count, total } = route;
  // An even sample of the remaining line is enough for TomTom to follow it.
  const path = [];
  const step = Math.max(1, (total - along) / (TRAFFIC_POINTS - 1));
  let next = along;
  for (let i = 0; i < count - 1 && path.length < TRAFFIC_POINTS - 1; i++) {
    while (cum[i + 1] >= next && path.length < TRAFFIC_POINTS - 1) {
      const span = cum[i + 1] - cum[i], t = span ? (next - cum[i]) / span : 0;
      path.push([latlon[i * 2] + (latlon[i * 2 + 2] - latlon[i * 2]) * t, latlon[i * 2 + 1] + (latlon[i * 2 + 3] - latlon[i * 2 + 1]) * t]);
      next += step;
    }
  }
  const end = [latlon[count * 2 - 2], latlon[count * 2 - 1]];
  path.push(end);
  const response = await fetch(TRAFFIC, {
    method: 'POST',
    // A plain-text body keeps this a "simple" request: no CORS preflight.
    body: JSON.stringify({ from: path[0], to: end, path, alt: !!wantFaster }),
    signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || 'HTTP ' + response.status);

  // Nearest route point to a position, as metres along the route.
  const alongOf = ([lat, lon]) => {
    const kx = Math.cos(lat * Math.PI / 180);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < count; i++) {
      const dx = (latlon[i * 2 + 1] - lon) * kx, dy = latlon[i * 2] - lat, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return cum[best];
  };
  const jams = (json.jams || [])
    .map((j) => ({ from: alongOf(j.a), to: alongOf(j.b), kind: j.kind, level: j.level, delay: j.delay }))
    .filter((j) => j.to - j.from > 20);
  return { at: Date.now(), along, left: total - along, time: json.time, delay: json.delay, free: json.free, jams, best: json.best || null };
}
