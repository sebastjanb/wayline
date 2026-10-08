import { MapView } from './map.js';
import { RouteGuide } from './guide.js';
import { searchPlaces, fetchRoute, MODES } from './services.js';
import { lonToX, latToY, xToLon, yToLat, distance, bearing, angleDiff, formatDistance, formatDuration, EARTH_CIRCUMFERENCE } from './geo.js';

const APP_VERSION = '2.3';

// The app is static and can live on any host. The phone relay is a server
// function, so it and the phone page stay on Netlify.
const RELAY = 'https://wayline-glasses.netlify.app/api/relay';
const PHONE_PAGE = 'wayline-glasses.netlify.app/phone';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ?demo walks the route by itself, for testing at a desk. ?demo=10 sets the speed-up.
const DEMO = params.has('demo') ? Math.max(1, Number(params.get('demo')) || 6) : 0;
const FIXED = params.has('lat') && params.has('lon')
  ? { lat: Number(params.get('lat')), lon: Number(params.get('lon')) }
  : DEMO ? { lat: 51.51521, lon: -0.14191 } : null;

const SETTINGS_KEY = 'glassnav.settings';
const SETTINGS_VERSION = 1;
const settings = Object.assign(
  { v: SETTINGS_VERSION, imperial: false, voice: true, headingUp: true, flipCompass: false, mode: 'pedestrian', last: null, pairCode: '', locOk: false },
  readSettings(),
);

function readSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return saved && saved.v === SETTINGS_VERSION ? saved : {};
  } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

const CATEGORIES = {
  cafes: { title: 'Cafes nearby', query: 'cafe', kinds: ['cafe'] },
  restaurants: { title: 'Restaurants nearby', query: 'restaurant', kinds: ['restaurant', 'fast_food', 'food_court'] },
  parks: { title: 'Parks nearby', query: 'park', kinds: ['park', 'garden', 'nature_reserve'] },
  attractions: { title: 'Attractions nearby', query: 'attraction', kinds: ['attraction', 'museum', 'viewpoint', 'gallery', 'art_gallery', 'castle', 'monument', 'zoo', 'theme_park', 'aquarium'] },
};

// Distance before a turn at which it is announced, and the earlier heads-up.
const ANNOUNCE = { pedestrian: [20, 70], bicycle: [40, 160], auto: [90, 400] };
const ARRIVE_WITHIN = { pedestrian: 12, bicycle: 18, auto: 30 };

// Anything that throws ends up on screen: the glasses have no console.
let lastError = '';
window.addEventListener('error', (e) => { lastError = e.message || 'script error'; renderStatus(); });
window.addEventListener('unhandledrejection', (e) => { lastError = String(e.reason && e.reason.message || e.reason); renderStatus(); });

// Sets every element bound to a name: the turn card shows on two screens.
function bind(name, value, html = false) {
  for (const el of document.querySelectorAll(`[data-bind="${name}"]`)) {
    if (html) el.innerHTML = value; else el.textContent = value;
  }
}

// Netlify's free plan draws a badge in the bottom-right corner; keep clear of it.
if (location.hostname.endsWith('netlify.app')) document.body.classList.add('host-badge');
const EDGE = document.body.classList.contains('host-badge') ? 42 : 0;

const map = new MapView($('map'));
map.onTiles = () => renderStatus();
const loc = { fixes: 0, error: '', lastAt: 0 };
const compass = { events: 0 };

const state = {
  screen: 'home',
  fix: null,          // { lat, lon, accuracy }
  course: null,       // direction of travel, from successive fixes
  heading: null,      // where the wearer faces, from the compass
  headingAt: 0,
  follow: true,
  homeZoom: 16,
  places: [],
  place: null,
  route: null,
  routeToken: 0,
  routeWaiting: false,   // the place card is open but no fix has arrived yet
  guide: null,
  progress: null,
  said: {},
  offCount: 0,
  rerouteAt: 0,
  rerouting: false,
};
const lastFocus = {};

// ---------------------------------------------------------------- feedback

let toastTimer = 0;
function toast(text, ms = 2600) {
  const el = $('toast');
  clearTimeout(toastTimer);
  el.textContent = text;
  el.classList.toggle('show', Boolean(text));
  if (text && ms) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// Says why the home map is empty, instead of leaving a blank lens.
function renderStatus() {
  const { loaded, failed } = map.store.stats;
  const denied = !state.fix && loc.error.startsWith('code 1');
  const notAsked = !state.fix && !FIXED && (!loc.asked || (locPending && Date.now() - watchStartedAt > 6000));
  let text = '';
  if (lastError) text = 'Error: ' + lastError;
  else if (notAsked || denied) text = 'Location is off. Middle tap, Permissions, allow Location.';
  else if (!state.fix) {
    text = loc.error.startsWith('code 2') ? 'The phone has no position yet. Still trying…'
      : loc.error.startsWith('code 3') ? 'Location is slow. Still trying…'
      : 'Finding your location…';
  }
  else if (!loaded) text = failed ? 'Map could not load. Check the connection.' : 'Loading map…';
  $('status').textContent = text;

  // One select press asks for location.
  const offer = !lastError && (notAsked || denied);
  const ask = $('enable-location'), wasHidden = ask.hidden;
  ask.hidden = !offer;
  if (offer && wasHidden && state.screen === 'home') ask.focus();
  if (!offer && document.activeElement === ask) $('open-type').focus();

  // Always on screen, so a fault can be read without opening any menu.
  renderDebug();
  if (state.screen === 'diag') renderDiagnostics();
}

// loc: position state and how many requests failed. key: how many swipes and
// selects reached the app, and the last one. at: which control has the focus.
const input = { keys: 0, last: '-' };
function renderDebug() {
  const { loaded, failed } = map.store.stats;
  const where = state.fix ? `ok ±${Math.round(state.fix.accuracy)}m` : loc.error ? loc.error.slice(0, 6) : locPending ? 'asking' : 'idle';
  const focus = document.activeElement && (document.activeElement.id || document.activeElement.textContent.trim().slice(0, 10)) || 'none';
  $('debug').textContent = `v${APP_VERSION} · loc ${where} ×${loc.errors || 0} · perm ${permission} · map ${loaded}/${failed} · key ${input.keys} ${input.last} · at ${focus}${navigator.onLine ? '' : ' · offline'}`;
}

function speak(text) {
  if (!settings.voice || !text || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.onerror = () => {};   // audio-busy during calls: the screen still shows the turn
    speechSynthesis.speak(utterance);
  } catch {}
}

// ----------------------------------------------------------------- screens

function activate(screen) {
  const leaving = state.screen;
  if (document.activeElement && document.activeElement.id) lastFocus[leaving] = document.activeElement.id;
  const guiding = ['nav', 'steps', 'arrived'];
  if (guiding.includes(leaving) && !guiding.includes(screen)) stopGuidance();
  if (screen !== 'nav') state.look = false;
  state.screen = screen;
  for (const el of document.querySelectorAll('.screen')) el.classList.toggle('active', el.id === screen);
  toast('');
  if (screen === 'home') { $('query').value = ''; $('suggest').textContent = ''; state.follow = true; }
  if (screen === 'phone') waitForPhone();
  if (screen === 'settings') renderSettings();
  if (screen === 'diag') renderDiagnostics();
  const remembered = lastFocus[screen] && $(lastFocus[screen]);
  const first = remembered && remembered.offsetParent ? remembered : focusables()[0];
  if (first) first.focus({ preventScroll: false });
  refresh();
}

// Screens that only exist to pick a destination. Leaving one forwards replaces
// it, so Back from the results goes home and the five-entry history limit holds.
const ENTRY_SCREENS = ['type', 'phone'];

// On the glasses a history change made while a permission request is still
// unanswered can hang the app. While one is out, screens change without
// touching history, and history is caught up once the answer arrives.
let locPending = false, historyBehind = false;

function go(screen) {
  if (locPending) {
    historyBehind = true;
    activate(screen);
    return;
  }
  const depth = history.state && history.state.depth || 0;
  if (ENTRY_SCREENS.includes(state.screen) && depth > 0) history.replaceState({ screen, depth }, '');
  else history.pushState({ screen, depth: depth + 1 }, '');
  activate(screen);
}

function catchUpHistory() {
  if (!historyBehind) return;
  historyBehind = false;
  const depth = history.state && history.state.depth || 0;
  if (state.screen !== 'home' && depth === 0) history.pushState({ screen: state.screen, depth: 1 }, '');
}

function goHome() {
  const depth = history.state && history.state.depth || 0;
  if (depth > 0) history.go(-depth); else activate('home');
}

window.addEventListener('popstate', (e) => {
  const screen = e.state && e.state.screen || 'home';
  // Guidance cannot be resumed by Back or Forward, only started from Start.
  activate(((screen === 'nav' || screen === 'steps') && !state.guide) || (screen === 'place' && !state.place) ? 'home' : screen);
});

// ------------------------------------------------------- directional input

function focusables() {
  const root = $(state.screen);
  return [...root.querySelectorAll('button, input')].filter((el) => !el.disabled && el.offsetParent);
}

function moveFocus(dx, dy) {
  const items = focusables();
  if (!items.length) return;
  const from = document.activeElement;
  if (!items.includes(from)) { items[0].focus(); return; }
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of items) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const ox = b.left + b.width / 2 - ax, oy = b.top + b.height / 2 - ay;
    const forward = ox * dx + oy * dy;
    if (forward < 8) continue;
    const sideways = Math.abs(ox * dy) + Math.abs(oy * dx);
    const score = forward + sideways * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) {
    best.focus();
    best.scrollIntoView({ block: 'nearest' });
  }
}

// Select can reach the page as an Enter key, as a click, or as both. Enter is
// turned into a click here, and a second click on the same control within a
// moment is dropped, so one select is always exactly one press.
let lastClick = { target: null, at: 0 };
document.addEventListener('click', (e) => {
  const button = e.target.closest && e.target.closest('button');
  if (!button) return;
  const now = Date.now();
  if (button === lastClick.target && now - lastClick.at < 220) {
    e.stopImmediatePropagation();
    e.preventDefault();
    return;
  }
  lastClick = { target: button, at: now };
}, true);

document.addEventListener('keydown', (e) => {
  input.keys++;
  input.last = e.key.replace('Arrow', '');
  setTimeout(renderDebug, 0);
  if (e.key === 'Enter' && document.activeElement && document.activeElement.tagName === 'BUTTON') {
    e.preventDefault();
    document.activeElement.click();
    return;
  }
  const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  if (arrows[e.key] && state.look) {
    e.preventDefault();
    map.panBy(-arrows[e.key][0] * 90, -arrows[e.key][1] * 90);
  } else if (arrows[e.key]) {
    e.preventDefault();
    moveFocus(...arrows[e.key]);
  } else if (e.key === 'Escape' || (e.key === 'Backspace' && e.target.tagName !== 'INPUT')) {
    e.preventDefault();
    if (history.state && history.state.depth) history.back();
    else if (state.screen !== 'home') activate('home');
  }
});

// ------------------------------------------------------- position, heading

let lastSavedAt = 0;

function onFix(lat, lon, accuracy, course = null) {
  const prev = state.fix;
  if (course != null) state.course = course;
  else if (prev && distance(prev.lat, prev.lon, lat, lon) > 6) {
    state.course = bearing(prev.lat, prev.lon, lat, lon);
    calibrateCompass(state.course);
  }
  state.fix = { lat, lon, accuracy };
  settings.last = { lat, lon };
  if (Date.now() - lastSavedAt > 30000) { lastSavedAt = Date.now(); saveSettings(); }
  if (state.screen === 'place' && state.routeWaiting) loadRoute();
  if (state.guide) guide();
  refresh();
  renderStatus();
}

let watchStartedAt = 0, preciseLocation = true, locBusy = false, locTimer = 0;
let permission = 'unknown';   // 'granted' | 'prompt' | 'denied' | 'unknown'

// Position comes from one-shot requests in a loop, never more than one at a
// time. A standing watch can fire its error callback without pause when the
// phone has no position to give, which starves the app of time to take input;
// a loop cannot be driven faster than it chooses to ask.
function startLocation() {
  if (FIXED) { onFix(FIXED.lat, FIXED.lon, 8); return; }
  if (!navigator.geolocation) { loc.error = 'geolocation not supported'; renderStatus(); return; }
  if (locBusy) return;
  clearTimeout(locTimer);
  locBusy = true;
  locPending = !state.fix;
  watchStartedAt = Date.now();
  loc.asked = (loc.asked || 0) + 1;

  let settled = false;
  const settle = (delay) => {
    if (settled) return false;
    settled = true;
    clearTimeout(guard);
    locBusy = false;
    if (locPending) { locPending = false; catchUpHistory(); }
    locTimer = setTimeout(startLocation, delay);
    return true;
  };
  // A request the host never answers must not stall the loop.
  const guard = setTimeout(() => {
    if (!settle(3000)) return;
    loc.errors = (loc.errors || 0) + 1;
    loc.error = 'code 3: no answer';
    renderStatus();
  }, 20000);

  navigator.geolocation.getCurrentPosition(
    (p) => {
      if (!settle(state.guide ? 1000 : 2500)) return;
      loc.fixes++;
      loc.error = '';
      loc.lastAt = Date.now();
      if (!settings.locOk) { settings.locOk = true; saveSettings(); }
      onFix(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
    },
    (err) => {
      if (!settle(err.code === 1 ? 8000 : 3000)) return;
      loc.errors = (loc.errors || 0) + 1;
      loc.error = `code ${err.code}: ${err.message}`;
      if (err.code === 1 && settings.locOk) { settings.locOk = false; saveSettings(); }
      // No position this way: try the other way next (precise needs GPS, coarse
      // is answered from the network).
      if (err.code !== 1) preciseLocation = !preciseLocation;
      renderStatus();
    },
    { enableHighAccuracy: preciseLocation, timeout: 12000, maximumAge: 3000 },
  );
  renderStatus();
}

// Location is asked for at launch. On the glasses the wearer may still have to
// allow it (middle tap, Permissions), so the app keeps checking and starts the
// moment it is allowed, with no restart. Buttons stay usable meanwhile, because
// navigation leaves history alone while a request is unanswered.
let permissionStatus = null, locationRetries = 0;

function beginLocation() {
  if (FIXED) { startLocation(); return; }
  let query = null;
  try { query = navigator.permissions && navigator.permissions.query && navigator.permissions.query({ name: 'geolocation' }); } catch {}
  const begin = () => {
    startLocation();
    renderStatus();
    setInterval(keepTryingLocation, 4000);
  };
  if (!query) { begin(); return; }
  query.then((status) => {
    permissionStatus = status;
    permission = status.state;
    status.onchange = () => {
      permission = status.state;
      if (permission === 'granted' && !state.fix) startLocation();
      renderStatus();
    };
    begin();
  }).catch(begin);
}

// The request loop retries by itself; this only keeps the permission reading
// and the on-screen status fresh.
function keepTryingLocation() {
  if (permissionStatus) permission = permissionStatus.state;
  if (!state.fix && !FIXED) renderStatus();
}

let lastAimAt = 0;
let compassOn = false, sawAbsolute = false, rawAlpha = null;
const calibration = { n: 0, standard: 0, raw: 0 };

function onOrientation(e) {
  let heading = null;
  if (typeof e.webkitCompassHeading === 'number') {
    heading = e.webkitCompassHeading;
    rawAlpha = null;
  } else if (e.alpha != null) {
    const absolute = e.type === 'deviceorientationabsolute' || e.absolute;
    if (absolute) sawAbsolute = true; else if (sawAbsolute) return;
    rawAlpha = e.alpha;
    heading = settings.flipCompass ? e.alpha : 360 - e.alpha;
  }
  if (heading == null) return;
  compass.events++;
  heading = (heading + 360) % 360;
  state.heading = state.heading == null ? heading : (state.heading + angleDiff(heading, state.heading) * 0.25 + 360) % 360;
  state.headingAt = Date.now();
  // Ten redraws a second is plenty for a turning map and leaves time for input.
  if (state.headingAt - lastAimAt > 100) { lastAimAt = state.headingAt; aimCamera(); }
}

// The W3C says alpha grows anticlockwise; some devices report a clockwise
// compass heading instead. Walking in a straight line tells the two apart.
function calibrateCompass(course) {
  if (rawAlpha == null || Date.now() - state.headingAt > 2000) return;
  calibration.standard += Math.abs(angleDiff(360 - rawAlpha, course));
  calibration.raw += Math.abs(angleDiff(rawAlpha, course));
  if (++calibration.n < 6) return;
  const flip = calibration.raw + 25 * calibration.n < calibration.standard;
  const keep = calibration.standard + 25 * calibration.n < calibration.raw;
  if (flip && !settings.flipCompass) { settings.flipCompass = true; saveSettings(); }
  if (keep && settings.flipCompass) { settings.flipCompass = false; saveSettings(); }
  calibration.n = calibration.standard = calibration.raw = 0;
}

// Must be called from a select gesture: the permission prompt needs one.
async function startCompass() {
  if (compassOn || typeof DeviceOrientationEvent === 'undefined') return;
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const answer = await Promise.race([
        DeviceOrientationEvent.requestPermission(),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 6000)),
      ]);
      if (answer !== 'granted') return;
    } catch { return; }
  }
  compassOn = true;
  window.addEventListener('deviceorientationabsolute', onOrientation);
  window.addEventListener('deviceorientation', onOrientation);
}

// Compass when it is fresh, otherwise the direction of travel.
function facing() {
  if (state.heading != null && Date.now() - state.headingAt < 3000) return state.heading;
  return state.course;
}

// --------------------------------------------------------------- the map

const world = (p) => ({ x: lonToX(p.lon), y: latToY(p.lat) });

function aimCamera() {
  const { screen, fix, progress } = state;
  const head = facing();
  if (screen === 'home') {
    if (map.puck) map.puck.heading = head;
    if (state.follow && fix) map.setCamera({ ...world(fix), zoom: state.homeZoom, pitch: 0, bearing: settings.headingUp && head != null ? head : 0 });
    else map.requestRender();
  } else if (screen === 'nav' && map.puck) {
    map.puck.heading = head;
    if (head == null && progress) map.puck.heading = progress.course;
    if (state.look) { map.requestRender(); return; }   // looking around: the wearer moves the map
    const up = settings.headingUp;
    map.setCamera({
      x: map.puck.x, y: map.puck.y, zoom: up ? 17.6 : 17,
      pitch: up ? 55 : 0,
      bearing: up ? (head != null ? head : progress ? progress.course : 0) : 0,
    });
  } else map.requestRender();
}

function refresh() {
  const { screen, fix, route, place, progress } = state;
  map.visible = screen === 'home' || screen === 'place' || screen === 'nav';
  map.routeStyle = screen === 'nav' ? 'guide' : 'preview';
  map.pins = [];
  map.route = null;
  map.routeFrom = null;
  map.dest = null;
  map.labels = true;
  map.puck = fix ? { ...world(fix), accuracy: fix.accuracy, heading: facing() } : null;

  if (screen === 'home') {
    map.setLayout({ x: 300, y: 280 }, { x: 300, y: 280, r: 280 });
    if (!fix && settings.last && state.follow) map.setCamera({ ...world(settings.last), zoom: state.homeZoom, pitch: 0, bearing: 0 });
  } else if (screen === 'place' && place) {
    const cy = 232 - EDGE / 2;
    map.setLayout({ x: 300, y: cy }, { x: 300, y: cy, r: 250 - EDGE / 2 });
    map.dest = world(place);
    if (route) {
      map.route = route.world;
      map.setCamera({ ...map.fit(route.world, 250 - EDGE), pitch: 0, bearing: 0 });
    } else {
      map.setCamera({ ...map.dest, zoom: 16, pitch: 0, bearing: 0 });
    }
  } else if (screen === 'nav' && route) {
    // Guidance fills the lens: streets run from the arrow up to the horizon.
    const up = settings.headingUp;
    map.setLayout({ x: 300, y: (up ? 400 : 320) - EDGE / 2 }, { x: 300, y: 300, r: 400, top: up ? 90 : null });
    map.route = route.world;
    map.dest = world(place);
    if (progress) {
      map.routeFrom = { index: progress.index, x: progress.x, y: progress.y };
      // Ride the route line while the fix agrees with it, so the puck does not jitter.
      if (progress.off < 25) { map.puck.x = progress.x; map.puck.y = progress.y; }
    }
  }
  aimCamera();
}

// Landmark pins on the home map can be selected: an unseen button sits on each
// pin, so the directional focus reaches it and select opens its route card.
const pinButtons = new Map();
map.onLandmarks = (shown) => {
  const live = state.screen === 'home' ? shown : [];
  const seen = new Set();
  for (const { poi, q } of live) {
    const key = poi.name + poi.x;
    seen.add(key);
    let button = pinButtons.get(key);
    if (!button) {
      button = document.createElement('button');
      button.className = 'pin';
      button.setAttribute('aria-label', poi.name);
      button.addEventListener('click', () => openPlace({
        name: poi.name, detail: '', kind: poi.sub || poi.cls, lat: yToLat(poi.y), lon: xToLon(poi.x), meters: null,
      }));
      button.addEventListener('focus', () => { map.keepLandmark = key; });
      button.addEventListener('blur', () => { if (map.keepLandmark === key) map.keepLandmark = null; });
      $('pins').append(button);
      pinButtons.set(key, button);
    }
    button.style.transform = `translate(${Math.round(q[0] - 22)}px, ${Math.round(q[1] - 43)}px)`;
  }
  for (const [key, button] of pinButtons) {
    if (seen.has(key)) continue;
    if (document.activeElement === button && state.screen === 'home') $('open-type').focus();
    button.remove();
    pinButtons.delete(key);
  }
};

// Pinch-and-drag pans the home map. Recenter puts it back on the wearer.
let drag = null;
$('map').addEventListener('pointerdown', (e) => {
  if (state.screen !== 'home') return;
  drag = { x: e.clientX, y: e.clientY };
  $('map').setPointerCapture(e.pointerId);
});
$('map').addEventListener('pointermove', (e) => {
  if (!drag) return;
  state.follow = false;
  map.panBy(e.clientX - drag.x, e.clientY - drag.y);
  drag = { x: e.clientX, y: e.clientY };
});
for (const type of ['pointerup', 'pointercancel']) $('map').addEventListener(type, () => { drag = null; });

// ------------------------------------------------------------------ search

const origin = () => state.fix || settings.last;

function showResults(title, places) {
  state.places = places;
  $('results-title').textContent = title;
  const list = $('results-list');
  list.textContent = '';
  places.forEach((place, i) => {
    const button = document.createElement('button');
    button.id = 'result-' + i;
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = i + 1;
    const text = document.createElement('span');
    text.className = 'text';
    const name = document.createElement('div');
    name.className = 'line-1';
    name.textContent = place.name;
    const detail = document.createElement('div');
    detail.className = 'line-2';
    detail.textContent = place.detail || place.kind.replace(/_/g, ' ');
    text.append(name, detail);
    const far = document.createElement('span');
    far.className = 'far';
    far.textContent = place.meters == null ? '' : formatDistance(place.meters, settings.imperial);
    button.append(num, text, far);
    button.addEventListener('click', () => openPlace(place));
    list.append(button);
  });
  lastFocus.results = 'result-0';
  if (state.screen === 'results') activate('results'); else go('results');
}

async function runSearch(query, title = `“${query}”`) {
  const here = origin();
  toast('Searching…', 0);
  try {
    const places = await searchPlaces(query, here && here.lat, here && here.lon);
    if (!places.length) { toast('No places found'); return []; }
    showResults(title, places);
    return places;
  } catch {
    toast('Search needs a connection');
    return [];
  }
}

const NEARBY_METERS = 900;

async function runCategory(id) {
  const category = CATEGORIES[id], here = origin();
  if (!here) { toast('No location yet, so nearby search cannot run.', 4000); return; }
  toast('Looking nearby…', 0);
  const find = () => map.nearby(here.lat, here.lon, (poi) => category.kinds.includes(poi.cls) || category.kinds.includes(poi.sub));

  // The map on screen usually holds the places already. Only when it does not,
  // wait for the tiles, and never for long: a slow connection falls back to search.
  let places = find();
  if (places.length < 3) {
    const reach = NEARBY_METERS / (EARTH_CIRCUMFERENCE * Math.cos(here.lat * Math.PI / 180));
    await Promise.race([
      map.loadAround(lonToX(here.lon), latToY(here.lat), reach),
      new Promise((resolve) => setTimeout(resolve, 7000)),
    ]);
    places = find();
  }
  if (state.screen !== 'home') return;
  if (places.length) showResults(category.title, places.map((p) => ({ ...p, detail: '' })));
  else await runSearch(category.query, category.title);
}

$('query').addEventListener('change', () => {
  const query = $('query').value.trim();
  if (query) runSearch(query);
});

// ------------------------------------------------------------- own keyboard

const KEY_PAGES = [
  { label: '123', rows: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'] },
  { label: 'ABC', rows: ['1234567890', "-/.,'&()", 'čšžćđ'] },
];
let keyPage = 0;

function buildKeyboard() {
  const keys = $('keys');
  const key = (label, className, onPress) => {
    const button = document.createElement('button');
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener('click', onPress);
    return button;
  };
  const row = (...children) => {
    const div = document.createElement('div');
    div.className = 'key-row';
    div.append(...children);
    return div;
  };
  const type = (char) => { $('query').value += char; suggestSoon(); };

  KEY_PAGES.forEach((page, index) => {
    const div = document.createElement('div');
    div.className = 'key-page';
    div.hidden = index !== 0;
    for (const chars of page.rows) div.append(row(...[...chars].map((c) => key(c, '', () => type(c)))));
    keys.append(div);
  });
  keys.querySelector('button').id = 'key-first';

  const flip = key(KEY_PAGES[0].label, 'wide', () => {
    keyPage = 1 - keyPage;
    keys.querySelectorAll('.key-page').forEach((div, index) => { div.hidden = index !== keyPage; });
    flip.textContent = KEY_PAGES[keyPage].label;
  });
  const erase = key('⌫', 'wide', () => { $('query').value = $('query').value.slice(0, -1); suggestSoon(); });
  erase.setAttribute('aria-label', 'Delete');
  const search = key('Search', 'go primary', () => {
    const query = $('query').value.trim();
    if (query) runSearch(query);
  });
  keys.append(row(flip, key('space', 'space', () => type(' ')), erase, search));
}

// Two live suggestions above the keys, so most addresses need only a few letters.
let suggestTimer = 0, suggestToken = 0;
function suggestSoon() {
  clearTimeout(suggestTimer);
  const token = ++suggestToken;
  const query = $('query').value.trim();
  if (query.length < 3) { $('suggest').textContent = ''; return; }
  suggestTimer = setTimeout(async () => {
    const here = origin();
    let places = [];
    try { places = await searchPlaces(query, here && here.lat, here && here.lon); } catch { return; }
    if (token !== suggestToken || state.screen !== 'type') return;
    $('suggest').textContent = '';
    for (const place of places.slice(0, 2)) {
      const button = document.createElement('button');
      const detail = document.createElement('small');
      detail.textContent = place.detail || place.kind.replace(/_/g, ' ');
      button.append(place.name, detail);
      button.addEventListener('click', () => openPlace(place));
      $('suggest').append(button);
    }
  }, 600);
}

$('open-type').addEventListener('click', () => {
  lastFocus.type = 'key-first';
  go('type');
});

// ------------------------------------------------- address from the phone

// The phone page stores a place under this code; the glasses collect it here.
const PHONE_WAIT_MS = 5 * 60 * 1000;
let phoneToken = 0;

async function waitForPhone() {
  const token = ++phoneToken;
  if (!/^\d{6}$/.test(settings.pairCode)) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    settings.pairCode = String(random[0] % 1000000).padStart(6, '0');
    saveSettings();
  }
  $('phone-url').textContent = PHONE_PAGE;
  $('phone-code').textContent = settings.pairCode;
  $('phone-status').textContent = 'Waiting for phone…';
  $('phone-action').textContent = 'Cancel';
  const until = Date.now() + PHONE_WAIT_MS;
  while (token === phoneToken && state.screen === 'phone' && Date.now() < until) {
    try {
      const response = await fetch(RELAY + '?code=' + settings.pairCode, { cache: 'no-store' });
      if (token !== phoneToken || state.screen !== 'phone') return;
      if (response.status === 200) {
        const { place } = await response.json();
        if (place && typeof place.name === 'string' && isFinite(place.lat) && isFinite(place.lon)) {
          openPlace({ name: place.name, detail: String(place.detail || ''), kind: '', lat: Number(place.lat), lon: Number(place.lon), meters: null });
          return;
        }
      } else if (response.status !== 204) {
        $('phone-status').textContent = 'Phone link not available (' + response.status + ')';
      } else {
        $('phone-status').textContent = 'Waiting for phone…';
      }
    } catch {
      $('phone-status').textContent = 'No connection. Retrying…';
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  if (token === phoneToken && state.screen === 'phone') {
    $('phone-status').textContent = 'Stopped waiting.';
    $('phone-action').textContent = 'Wait again';
  }
}

$('open-phone').addEventListener('click', () => {
  lastFocus.phone = 'phone-action';
  go('phone');
});
$('phone-action').addEventListener('click', () => {
  if ($('phone-action').textContent === 'Cancel') history.back(); else waitForPhone();
});
for (const chip of document.querySelectorAll('[data-category]')) {
  chip.addEventListener('click', () => runCategory(chip.dataset.category));
}

// -------------------------------------------------------------- place card

const modeLabel = () => MODES.find((m) => m.id === settings.mode).label;
const clock = (date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function renderModes() {
  for (const button of document.querySelectorAll('#modes button')) button.classList.toggle('on', button.dataset.mode === settings.mode);
}

function openPlace(place) {
  state.place = place;
  state.route = null;
  $('place-name').textContent = place.name;
  renderModes();
  lastFocus.place = 'start';
  go('place');
  return loadRoute();
}

// Big number on the card: minutes below an hour, hours and minutes above.
function showTravelTime(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  $('place-min').textContent = minutes < 60 ? minutes : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
  $('place-unit').textContent = minutes < 60 ? 'min' : 'h';
}

async function loadRoute() {
  const token = ++state.routeToken;
  const { place, fix } = state;
  state.route = null;
  $('start').disabled = true;
  $('place-min').textContent = '–';
  $('place-unit').textContent = 'min';
  $('place-eta').textContent = '';
  state.routeWaiting = !fix;
  if (!fix) { $('place-summary').textContent = 'Waiting for location…'; return false; }
  $('place-summary').textContent = 'Finding route…';
  try {
    const route = await fetchRoute(fix, place, settings.mode);
    if (token !== state.routeToken) return false;
    state.route = route;
    showTravelTime(route.time);
    $('place-summary').textContent = `${modeLabel()} ${formatDistance(route.total, settings.imperial)}`;
    $('place-eta').textContent = `ETA ${clock(new Date(Date.now() + route.time * 1000))}`;
    $('start').disabled = false;
    if (state.screen === 'place') {
      if (document.activeElement === document.body) $('start').focus();
      refresh();
    }
    return true;
  } catch {
    if (token !== state.routeToken) return false;
    $('place-summary').textContent = `No ${modeLabel().toLowerCase()} route found`;
    if (state.screen === 'place') { refresh(); if (document.activeElement === document.body) document.querySelector('#modes .on').focus(); }
    return false;
  }
}

for (const button of document.querySelectorAll('#modes button')) {
  button.addEventListener('click', () => {
    if (settings.mode === button.dataset.mode) return;
    settings.mode = button.dataset.mode;
    saveSettings();
    renderModes();
    loadRoute();
    refresh();
  });
}

$('start').addEventListener('click', async () => {
  // History must not change until the permission prompt has been answered.
  await startCompass();
  startGuidance();
});

// ---------------------------------------------------------------- guidance

let demoTimer = 0;

function startGuidance() {
  if (!state.route || !state.fix) return;
  state.guide = new RouteGuide(state.route);
  state.said = {};
  state.offCount = 0;
  state.progress = null;
  lastFocus.nav = 'compass';
  state.look = false;
  saveSettings();
  go('nav');
  speak(spoken(state.route.maneuvers[0]));
  guide();
  refresh();
  if (DEMO) {
    let meters = 0;
    clearInterval(demoTimer);
    demoTimer = setInterval(() => {
      if (!state.guide) return;
      meters += 1.4 * DEMO * 0.2;
      const p = state.guide.pointAt(meters);
      onFix(p.lat, p.lon, 5, p.course);
    }, 200);
  }
}

function stopGuidance() {
  clearInterval(demoTimer);
  state.guide = null;
  state.progress = null;
  state.look = false;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (FIXED) onFix(FIXED.lat, FIXED.lon, 8);
}

const isArrival = (m) => m.type >= 4 && m.type <= 6;

// Spoken guidance gives the direction only, never the street name.
const SPOKEN = {
  9: 'Bear right', 18: 'Bear right', 20: 'Bear right', 23: 'Keep right', 37: 'Bear right',
  10: 'Turn right', 11: 'Turn sharp right', 12: 'Make a U-turn', 13: 'Make a U-turn',
  14: 'Turn sharp left', 15: 'Turn left',
  16: 'Bear left', 19: 'Bear left', 21: 'Bear left', 24: 'Keep left', 38: 'Bear left',
  27: 'Leave the roundabout', 39: 'Take the elevator', 40: 'Take the stairs', 41: 'Take the escalator',
};
function spoken(m) {
  if (isArrival(m)) return m.type === 5 ? 'Your destination is on the right' : m.type === 6 ? 'Your destination is on the left' : 'You have arrived';
  if (m.type === 26) return m.exit ? `At the roundabout, take exit ${m.exit}` : 'Enter the roundabout';
  // Start: "Walk east on Oxford Street" becomes "Walk east".
  if (m.type >= 1 && m.type <= 3) return m.text.split(/ onto | on | to | at /)[0].replace(/\.$/, '');
  return SPOKEN[m.type] || 'Continue straight';
}

function turnLabel(m) {
  if (isArrival(m)) return state.place.name;
  if (m.street) return m.street;
  // No street name: keep the action, drop the rest ("Bear left onto the walkway").
  return m.text.split(/ onto | on | to | at /)[0].replace(/\.$/, '');
}

function guide() {
  const { fix, route, place } = state;
  const p = state.guide.update(fix.lat, fix.lon);
  if (!p) return;
  state.progress = p;
  const mode = route.mode;

  if (p.remaining < ARRIVE_WITHIN[mode]) {
    const last = route.maneuvers[route.maneuvers.length - 1];
    speak(spoken(last));
    $('arrived-name').textContent = place.name;
    state.guide = null;
    clearInterval(demoTimer);
    history.replaceState({ screen: 'arrived', depth: history.state.depth }, '');
    activate('arrived');
    return;
  }

  // Off the route for several fixes in a row: plan again from here.
  const tolerance = Math.max(30, Math.min(60, fix.accuracy || 0));
  state.offCount = p.off > tolerance ? state.offCount + 1 : 0;
  if (state.offCount >= 3 && !state.rerouting && Date.now() - state.rerouteAt > 8000) reroute();

  const next = p.next || p.current;
  bind('turn-icon', turnIcon(next.type), true);
  bind('turn-street', turnLabel(next));
  bind('turn-distance', formatDistance(p.toNext, settings.imperial));
  bind('nav-min', formatDuration(p.secondsLeft));
  bind('nav-arrive', `Arriving at ${clock(new Date(Date.now() + p.secondsLeft * 1000))}`);
  if (state.screen === 'steps' && state.stepShown !== p.nextIndex) renderSteps();

  if (p.next && !isArrival(p.next)) {
    const [now, soon] = ANNOUNCE[mode];
    const said = state.said[p.nextIndex] || 0;
    if (p.toNext <= now && !(said & 2)) {
      state.said[p.nextIndex] = 3;
      speak(spoken(p.next));
    } else if (p.toNext <= soon && p.toNext > now * 1.6 && !(said & 1)) {
      state.said[p.nextIndex] = said | 1;
      speak(`In ${formatDistance(p.toNext, settings.imperial).replace(' m', ' meters').replace(' km', ' kilometers').replace(' ft', ' feet').replace(' mi', ' miles')}, ${spoken(p.next).toLowerCase()}`);
    }
  }
}

async function reroute() {
  state.rerouting = true;
  state.rerouteAt = Date.now();
  toast('Rerouting…', 0);
  try {
    const route = await fetchRoute(state.fix, state.place, state.route.mode);
    if (state.guide) {
      state.route = route;
      state.guide = new RouteGuide(route);
      state.said = {};
      state.offCount = 0;
      speak('Rerouting. ' + spoken(route.maneuvers[0]));
      guide();
      refresh();
    }
    toast('');
  } catch {
    toast('Could not reroute');
  }
  state.rerouting = false;
}

// Arrow drawn from the bend angle: 0 is straight on, 90 is a right turn.
function turnIcon(type) {
  const svg = (body) => `<svg viewBox="0 0 64 64">${body}</svg>`;
  if (isArrival({ type })) {
    return svg('<path d="M32 56C20 42 15 34 15 26a17 17 0 0134 0c0 8-5 16-17 30z"/><circle cx="32" cy="26" r="5" fill="currentColor" stroke="none"/>');
  }
  if (type === 12 || type === 13) {
    const flip = type === 12 ? ' transform="translate(64 0) scale(-1 1)"' : '';
    return svg(`<g${flip}><path d="M42 56V26a10 10 0 00-20 0v16"/><path d="M12 34l10 10 10-10"/></g>`);
  }
  if (type === 26 || type === 27) {
    return svg('<circle cx="30" cy="34" r="10"/><path d="M30 58V44M38 27l12-12M38 15h12v12"/>');
  }
  const angles = { 9: 42, 18: 42, 20: 42, 23: 42, 37: 42, 10: 90, 11: 135, 16: -42, 19: -42, 21: -42, 24: -42, 38: -42, 15: -90, 14: -135 };
  const a = (angles[type] || 0) * Math.PI / 180;
  const bendY = a ? 36 : 30, len = a ? 22 : 20;
  const tx = 32 + Math.sin(a) * len, ty = bendY - Math.cos(a) * len;
  const wing = (offset) => `${tx - Math.sin(a + offset) * 13} ${ty + Math.cos(a + offset) * 13}`;
  return svg(`<path d="M32 58V${bendY}L${tx} ${ty}"/><path d="M${wing(0.6)}L${tx} ${ty}L${wing(-0.6)}"/>`);
}

// Step by step: every turn of the route, with the one coming up marked.
function renderSteps() {
  const { route, progress } = state;
  const upcoming = progress ? progress.nextIndex : 1;
  state.stepShown = upcoming;
  const list = $('steps-list');
  list.textContent = '';
  route.maneuvers.forEach((m, i) => {
    if (i === 0) return;   // the first entry is "start walking", not a turn
    const button = document.createElement('button');
    button.id = 'step-' + i;
    button.className = i < upcoming ? 'done' : i === upcoming ? 'now' : '';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.innerHTML = turnIcon(m.type);
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = isArrival(m) ? `Arrive at ${state.place.name}` : m.text.replace(/\.$/, '');
    const far = document.createElement('span');
    far.className = 'far';
    far.textContent = formatDistance(route.cum[m.begin] - route.cum[route.maneuvers[i - 1].begin], settings.imperial);
    button.append(dot, what, far);
    list.append(button);
  });
  const current = $('step-' + Math.min(upcoming, route.maneuvers.length - 1));
  if (current && state.screen === 'steps') { current.focus(); current.scrollIntoView({ block: 'center' }); }
}

$('details').addEventListener('click', () => {
  lastFocus.steps = '';
  go('steps');
  renderSteps();
});

// Look around: the map lets go of the wearer and the arrows move it. Select returns.
function setLook(on) {
  if (state.look === on) return;
  state.look = on;
  $('look-hint').textContent = on ? 'Swipe to move the map. Select to go back.' : 'Swipe up to look around';
  if (on) map.setCamera({ pitch: 0, zoom: 16.5 });
  refresh();
}
$('look').addEventListener('focus', () => { if (state.screen === 'nav') setLook(true); });
$('look').addEventListener('click', () => { setLook(false); $('compass').focus(); });

$('exit').addEventListener('click', goHome);
$('done').addEventListener('click', goHome);

$('compass').addEventListener('click', async () => {
  settings.headingUp = !settings.headingUp;
  saveSettings();
  if (settings.headingUp) await startCompass();
  $('compass-label').textContent = settings.headingUp ? 'Facing' : 'North up';
  refresh();
});

function renderMute() {
  $('mute').classList.toggle('voice-off', !settings.voice);
  $('mute-label').textContent = settings.voice ? 'Sound on' : 'Muted';
}
$('mute').addEventListener('click', () => {
  settings.voice = !settings.voice;
  saveSettings();
  renderMute();
  if (!settings.voice && 'speechSynthesis' in window) speechSynthesis.cancel();
});

// ------------------------------------------------------------ home, settings

$('recenter').addEventListener('click', async () => {
  state.follow = true;
  await startCompass();
  if (!state.fix) startLocation();   // ask again: a select gesture may be what the prompt was waiting for
  refresh();
});
$('zoom-in').addEventListener('click', () => zoomHome(1));
$('zoom-out').addEventListener('click', () => zoomHome(-1));
function zoomHome(step) {
  state.homeZoom = Math.min(18, Math.max(11, state.homeZoom + step));
  map.setCamera({ zoom: state.homeZoom });
}

$('open-settings').addEventListener('click', () => go('settings'));
$('open-diag').addEventListener('click', () => go('diag'));
$('diag-refresh').addEventListener('click', renderDiagnostics);

function renderDiagnostics() {
  const { loaded, failed, lastError: tileError } = map.store.stats;
  const engine = (navigator.userAgent.match(/(Chrome|Version|Firefox)\/[\d.]+/) || [navigator.userAgent.slice(0, 40)])[0];
  const lines = [
    `App ${APP_VERSION} · ${engine}`,
    `Screen ${innerWidth}×${innerHeight} @${devicePixelRatio}`,
    `Location: ${loc.fixes} fixes${state.fix ? `, ±${Math.round(state.fix.accuracy)} m, ${Math.round((Date.now() - loc.lastAt) / 1000)} s ago` : ''}`,
    `Location error: ${loc.error || 'none'}`,
    `Location permission: ${permission}, asked ${loc.asked || 0}×, ${preciseLocation ? 'precise' : 'coarse'}`,
    state.fix ? `Position: ${state.fix.lat.toFixed(4)}, ${state.fix.lon.toFixed(4)}` : 'Position: none',
    `Compass: ${compass.events} readings`,
    `Map tiles: ${loaded} loaded, ${failed} failed`,
    `Tile source: ${map.store.template ? 'ok' : 'not reached'}`,
    `Tile error: ${tileError || 'none'}`,
    `Script error: ${lastError || 'none'}`,
    `Online: ${navigator.onLine}`,
  ];
  $('diag-lines').textContent = lines.join('\n');
}

function renderSettings() {
  $('set-units').textContent = `Units: ${settings.imperial ? 'Miles' : 'Kilometres'}`;
  $('set-voice').textContent = `Voice guidance: ${settings.voice ? 'On' : 'Off'}`;
  $('set-orientation').textContent = `Map: ${settings.headingUp ? 'Follows where you face' : 'North up'}`;
  $('set-compass').textContent = `Compass direction: ${settings.flipCompass ? 'Reversed' : 'Standard'}`;
  renderMute();
}
const toggles = { 'set-units': 'imperial', 'set-voice': 'voice', 'set-orientation': 'headingUp', 'set-compass': 'flipCompass' };
for (const [id, key] of Object.entries(toggles)) {
  $(id).addEventListener('click', () => {
    settings[key] = !settings[key];
    saveSettings();
    renderSettings();
  });
}

// ------------------------------------------------ voice assistant (WebMCP)

// Lets the glasses' assistant drive the app. Off unless the device enables it.
function registerAgentTools() {
  if (!document.modelContext || !document.modelContext.registerTool) return;
  const tools = [{
    name: 'navigate_to',
    description: 'Start turn-by-turn navigation to a place or address the user names.',
    inputSchema: {
      type: 'object',
      properties: { destination: { type: 'string', description: 'Place name or address to navigate to.' } },
      required: ['destination'],
    },
    annotations: { untrustedContentHint: true },
    async execute(input) {
      const query = String(input && input.destination || '').trim().slice(0, 200);
      if (!query) return { error: 'missing_destination', next_action: 'Ask the user where they want to go.' };
      const here = origin();
      const places = await searchPlaces(query, here && here.lat, here && here.lon);
      if (!places.length) return { error: 'not_found', next_action: 'Tell the user the place was not found.' };
      const ready = await openPlace(places[0]);
      if (!ready) return { place: places[0].name, routed: false, next_action: 'Tell the user no route was found yet.' };
      startGuidance();
      return { place: places[0].name, minutes: Math.round(state.route.time / 60), next_action: 'Tell the user navigation has started.' };
    },
  }, {
    name: 'stop_navigation',
    description: 'Stop the current turn-by-turn navigation.',
    async execute() {
      goHome();
      return { stopped: true };
    },
  }];
  for (const tool of tools) {
    try { document.modelContext.registerTool(tool).catch(() => {}); } catch {}
  }
}

// -------------------------------------------------------------------- boot

buildKeyboard();
history.replaceState({ screen: 'home', depth: 0 }, '');
renderMute();
activate('home');
renderStatus();
beginLocation();
$('enable-location').addEventListener('click', () => {
  startLocation();
  toast('Asking for location…', 2000);
});
window.addEventListener('online', renderStatus);
window.addEventListener('offline', renderStatus);
// Where no permission prompt exists the compass can start straight away.
if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission !== 'function') startCompass();
registerAgentTools();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}
