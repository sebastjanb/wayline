// Web mercator in "world" units: x and y both run 0..1 across the planet.

const RAD = Math.PI / 180;
export const EARTH_CIRCUMFERENCE = 40075016.686;

export const lonToX = (lon) => (lon + 180) / 360;
export const latToY = (lat) => {
  const s = Math.sin(lat * RAD);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
export const xToLon = (x) => x * 360 - 180;
export const yToLat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / RAD;

export function distance(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Clockwise from north, 0..360.
export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

// Signed smallest difference a - b, in -180..180.
export const angleDiff = (a, b) => ((a - b + 540) % 360) - 180;

// Valhalla encodes shapes with six decimals of precision.
export function decodePolyline6(str) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, byte;
      do {
        byte = str.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lon += delta;
    }
    out.push(lat / 1e6, lon / 1e6);
  }
  return out; // [lat0, lon0, lat1, lon1, ...]
}

export function formatDistance(meters, imperial) {
  if (imperial) {
    const feet = meters * 3.28084;
    if (feet < 500) return `${Math.max(10, Math.round(feet / 10) * 10)} ft`;
    const miles = meters / 1609.344;
    return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
  }
  if (meters < 1000) return `${meters < 100 ? Math.max(5, Math.round(meters / 5) * 5) : Math.round(meters / 10) * 10} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

export function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
