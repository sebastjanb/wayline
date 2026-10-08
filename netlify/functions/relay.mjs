// Hands a destination from the phone page to the glasses. The phone stores a
// place under a 6-digit pairing code; the glasses collect it once and it is gone.

import { getStore } from '@netlify/blobs';

const MAX_AGE_MS = 10 * 60 * 1000;
const CODE = /^\d{6}$/;

// The app itself is served from another origin (GitHub Pages), so every
// answer carries CORS headers. Nothing here is secret: the pairing code is the key.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};
const empty = () => new Response(null, { status: 204, headers: CORS });
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, 'Content-Type': 'application/json' },
});
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

export default async (request) => {
  // Strong consistency: the glasses poll seconds after the phone writes.
  if (request.method === 'OPTIONS') return empty();
  const store = getStore({ name: 'relay', consistency: 'strong' });

  if (request.method === 'GET') {
    const code = new URL(request.url).searchParams.get('code') || '';
    if (!CODE.test(code)) return json({ error: 'bad code' }, 400);
    const entry = await store.get(code, { type: 'json' });
    if (!entry) return empty();
    await store.delete(code);
    if (Date.now() - entry.at > MAX_AGE_MS) return empty();
    return json({ place: entry.place });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const place = body && body.place;
    if (!body || !CODE.test(body.code) || !place) return json({ error: 'bad request' }, 400);
    const lat = Number(place.lat), lon = Number(place.lon);
    const name = text(place.name, 120);
    if (!name || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return json({ error: 'bad place' }, 400);
    await store.setJSON(body.code, { at: Date.now(), place: { name, detail: text(place.detail, 160), lat, lon } });
    return json({ ok: true });
  }

  return json({ error: 'method not allowed' }, 405);
};

export const config = { path: '/api/relay' };
