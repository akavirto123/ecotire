export type Pt = { lat: number; lng: number };

const EARTH_R = 6371000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Distância em metros entre dois pontos. */
export function haversine(a: Pt, b: Pt): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

/** Rumo (0-360°, 0 = norte) de a para b. */
export function bearing(a: Pt, b: Pt): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Distância (m) de um ponto até o segmento a-b (projeção local, precisa em distâncias curtas). */
export function distPointToSegmentM(p: Pt, a: Pt, b: Pt): number {
  const ky = (Math.PI / 180) * EARTH_R;
  const kx = ky * Math.cos(rad(p.lat));
  const ax = (a.lng - p.lng) * kx;
  const ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx;
  const by = (b.lat - p.lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Distância acumulada (m) em cada vértice da linha. */
export function cumulativeM(coords: Pt[]): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  return cum;
}

/** Ponto e rumo a uma distância (m) do início da linha. */
export function pointAlong(coords: Pt[], cum: number[], distM: number): Pt & { heading: number } {
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(total, distM));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const a = coords[i - 1];
  const b = coords[i];
  const seg = cum[i] - cum[i - 1];
  const t = seg === 0 ? 0 : (d - cum[i - 1]) / seg;
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, heading: bearing(a, b) };
}

/** Polígono circular (anel [lng, lat]) para desenhar zonas no mapa. */
export function circleRing(center: Pt, radiusM: number, steps = 28): [number, number][] {
  const ring: [number, number][] = [];
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(rad(center.lat)));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([center.lng + dLng * Math.cos(a), center.lat + dLat * Math.sin(a)]);
  }
  return ring;
}

/** Simplificação Ramer–Douglas–Peucker (tolerância em metros). */
export function simplify(points: Pt[], toleranceM: number): Pt[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distPointToSegmentM(points[i], points[s], points[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > toleranceM) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
