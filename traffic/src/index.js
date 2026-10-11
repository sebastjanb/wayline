// Wayline traffic on Cloudflare Workers. The app is a public static page, so
// the TomTom key cannot live in it; it is a secret of this Worker.
//
//   POST /traffic   { from: [lat, lon], to: [lat, lon], path: [[lat, lon], …], alt: true }
//
// Answers how long the given path takes right now, where it is slow, and
// (with alt) whether another way is faster:
//   { time, delay, free, jams: [{ a: [lat, lon], b: [lat, lon], kind, level, delay }],
//     best: { time, length, via: [[lat, lon], …] } | null }
//
// Nothing is stored. Positions are passed to TomTom and to nobody else.

const TOMTOM = 'https://api.tomtom.com/routing/1/calculateRoute';
const MAX_PATH = 200;
const VIA_POINTS = 8;

const json = (body, status, cors) => new Response(JSON.stringify(body), {
  status: status || 200,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors),
});

const isPoint = (p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
  && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
const round = (n) => Math.round(n * 1e5) / 1e5;
const pair = (p) => `${round(p[0])},${round(p[1])}`;

function query(env, extra) {
  return new URLSearchParams(Object.assign({
    key: env.TOMTOM_KEY,
    traffic: 'true',
    travelMode: 'car',
    routeType: 'fastest',
    computeTravelTimeFor: 'all',
  }, extra)).toString();
}

async function tomtom(url, body) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const error = new Error('TomTom answered ' + response.status);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const route = data.routes && data.routes[0];
  if (!route) throw new Error('TomTom found no route');
  return route;
}

const points = (route) => route.legs.flatMap((leg) => leg.points || []);

// Slow stretches of the route, as start and end positions the app can find on its own line.
export function jams(route) {
  const pts = points(route);
  return (route.sections || [])
    .filter((s) => s.sectionType === 'TRAFFIC' && pts[s.startPointIndex] && pts[s.endPointIndex])
    .map((s) => ({
      a: [round(pts[s.startPointIndex].latitude), round(pts[s.startPointIndex].longitude)],
      b: [round(pts[s.endPointIndex].latitude), round(pts[s.endPointIndex].longitude)],
      kind: s.simpleCategory === 'ROAD_CLOSURE' ? 'closed' : s.simpleCategory === 'ROAD_WORK' ? 'works' : 'jam',
      // TomTom: 0 unknown, 1 minor, 2 moderate, 3 major, 4 undefined (closures).
      level: s.simpleCategory === 'ROAD_CLOSURE' ? 3 : Math.min(3, Math.max(1, s.magnitudeOfDelay || 1)),
      delay: s.delayInSeconds || 0,
    }));
}

// A few evenly spaced points of the faster way, enough for the app's own router to follow it.
export function viaPoints(route, count) {
  const pts = points(route);
  const out = [];
  for (let i = 1; i <= count; i++) {
    const p = pts[Math.round(i * (pts.length - 1) / (count + 1))];
    if (p) out.push([round(p.latitude), round(p.longitude)]);
  }
  return out;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).includes(origin);
    const cors = allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/traffic') return json({ error: 'not_found' }, 404, cors);
    if (!allowed) return json({ error: 'origin_not_allowed' }, 403);
    if (!env.TOMTOM_KEY) return json({ error: 'no_key' }, 503, cors);

    let ask;
    try { ask = JSON.parse(await request.text()); } catch (e) { return json({ error: 'bad_request' }, 400, cors); }
    const path = Array.isArray(ask.path) ? ask.path.slice(0, MAX_PATH) : [];
    if (!isPoint(ask.from) || !isPoint(ask.to) || path.length < 2 || !path.every(isPoint)) {
      return json({ error: 'bad_request' }, 400, cors);
    }

    const base = `${TOMTOM}/${pair(ask.from)}:${pair(ask.to)}/json`;
    try {
      const [mine, best] = await Promise.all([
        // supportingPoints makes TomTom measure this path rather than choose its own.
        tomtom(`${base}?${query(env, { sectionType: 'traffic' })}`,
          { supportingPoints: path.map((p) => ({ latitude: round(p[0]), longitude: round(p[1]) })) }),
        ask.alt ? tomtom(`${base}?${query(env, {})}`).catch(() => null) : null,
      ]);
      const s = mine.summary;
      return json({
        time: s.travelTimeInSeconds,
        delay: s.trafficDelayInSeconds || 0,
        free: s.noTrafficTravelTimeInSeconds || s.travelTimeInSeconds,
        jams: jams(mine),
        best: best ? { time: best.summary.travelTimeInSeconds, length: best.summary.lengthInMeters, via: viaPoints(best, VIA_POINTS) } : null,
      }, 200, cors);
    } catch (e) {
      // 403: wrong key or daily quota used up. The app then falls back to plain times.
      return json({ error: e.status === 403 ? 'key_refused' : e.status === 429 ? 'quota' : 'upstream', detail: String(e.message) }, 502, cors);
    }
  },
};
