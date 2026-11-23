// A region drawn on the map, stored with the species note.
// { type: 'rect', points: [[lat, lng], [lat, lng]] }   two opposite corners
// { type: 'poly', points: [[lat, lng], ...] }          3+ vertices

export function inRegion(r, region) {
  if (!region) return true;
  if (r.lat == null || r.lng == null) return false;
  return pointInRegion(r.lat, r.lng, region);
}

export function pointInRegion(lat, lng, region) {
  const pts = region.points;
  if (region.type === 'rect') {
    const [[a, b], [c, d]] = pts;
    return lat >= Math.min(a, c) && lat <= Math.max(a, c) && lng >= Math.min(b, d) && lng <= Math.max(b, d);
  }
  // Ray casting; planar is fine at collecting-trip scale
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [yi, xi] = pts[i];
    const [yj, xj] = pts[j];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function filterRegion(records, region) {
  return region ? records.filter(r => inRegion(r, region)) : records;
}

// Validate data from sync or import
export function cleanRegion(region) {
  if (!region || (region.type !== 'rect' && region.type !== 'poly') || !Array.isArray(region.points)) return null;
  const points = region.points
    .filter(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
      && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 360)
    .slice(0, 500)
    .map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]);
  if (region.type === 'rect' ? points.length !== 2 : points.length < 3) return null;
  return { type: region.type, points };
}
