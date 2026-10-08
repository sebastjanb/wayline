// Place search (Photon) and routing (Valhalla). Both run on OpenStreetMap data,
// answer cross-origin requests and need no API key.

import { decodePolyline6, distance, lonToX, latToY } from './geo.js';

const PHOTON = 'https://photon.komoot.io/api/';
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';

export const MODES = [
  { id: 'pedestrian', label: 'Walk' },
  { id: 'bicycle', label: 'Bike' },
  { id: 'auto', label: 'Drive' },
];

async function getJson(url, signal) {
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
  const response = await fetch(url, { signal: signal || timeout });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

export async function searchPlaces(query, lat, lon) {
  const params = new URLSearchParams({ q: query, limit: '10', lang: 'en' });
  if (lat != null) { params.set('lat', lat.toFixed(5)); params.set('lon', lon.toFixed(5)); }
  const json = await getJson(`${PHOTON}?${params}`);
  return (json.features || []).map((f) => {
    const p = f.properties, [pLon, pLat] = f.geometry.coordinates;
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const name = p.name || street || p.city || 'Unnamed place';
    const detail = [p.name ? street : '', p.city || p.county, p.name && !p.city ? p.country : '']
      .filter(Boolean).join(', ');
    return { name, detail, kind: p.osm_value || '', lat: pLat, lon: pLon, meters: lat == null ? null : distance(lat, lon, pLat, pLon) };
  });
}

export async function fetchRoute(from, to, mode) {
  const request = {
    locations: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }],
    costing: mode,
    units: 'kilometers',
    language: 'en-US',
  };
  const json = await getJson(`${VALHALLA}?json=${encodeURIComponent(JSON.stringify(request))}`);
  const leg = json.trip && json.trip.legs && json.trip.legs[0];
  if (!leg) throw new Error('no route');

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
