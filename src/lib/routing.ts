import { basePm25PerKm, PAVEMENT_FACTOR, simulateTrip, speedFactor } from '@/lib/emissions';
import type { Pt } from '@/lib/geo';
import { isRoughSurface, isSensitive, isSchoolRush, zonesAlongRoute, type RiskZone, type RouteZoneHit } from '@/lib/risk';

export type RouteResult = { distanceKm: number; durationMin: number; coordinates: Pt[] };

export type SearchResult = { id: string; name: string; lat: number; lng: number };

export async function searchAddress(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&countrycodes=br&accept-language=pt-BR`,
      { signal },
    );
    const data = (await res.json()) as { place_id: number; display_name: string; lat: string; lon: string }[];
    return data.map((p) => ({ id: String(p.place_id), name: p.display_name, lat: parseFloat(p.lat), lng: parseFloat(p.lon) }));
  } catch {
    return [];
  }
}

export async function reverseGeocode(p: Pt): Promise<string | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${p.lat}&lon=${p.lng}&zoom=17&accept-language=pt-BR`,
    );
    const data = await res.json();
    return data.address?.road || data.display_name?.split(',')[0] || null;
  } catch {
    return null;
  }
}

/** Até 3 rotas alternativas (OSRM público). */
export async function getRoutes(origin: Pt, destination: Pt, signal?: AbortSignal): Promise<RouteResult[]> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson&alternatives=3`;
    const data = await (await fetch(url, { signal })).json();
    if (!data.routes?.length) return [];
    return (data.routes as { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[]).map((r) => ({
      distanceKm: r.distance / 1000,
      durationMin: r.duration / 60,
      coordinates: r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
    }));
  } catch {
    return [];
  }
}

export type RouteScore = {
  route: RouteResult;
  hits: RouteZoneHit[];
  sensitiveHits: number;
  roughKm: number;
  avgSpeedKmh: number;
  pm25Mg: number;
  /** Índice de Exposição Sensível: mg de PM2.5 emitidos dentro de zonas com pessoas vulneráveis */
  exposureMg: number;
  /** Custo ambiental = PM2.5 total + exposição ponderada. Quanto menor, melhor. */
  costMg: number;
};

/** Peso da exposição: 1 mg emitido ao lado de escola/hospital conta como (1 + peso) mg no custo. */
export const EXPOSURE_WEIGHT = 2;

/**
 * Rota de menor particulado: compara rotas pelo PM2.5 estimado e por quanto
 * dele é emitido dentro de zonas sensíveis, e não só por tempo ou distância.
 */
export function scoreRoute(route: RouteResult, grossKg: number, zones: RiskZone[], aggressionPct = 30, schoolRush = isSchoolRush()): RouteScore {
  const hits = zonesAlongRoute(route.coordinates, zones);
  const avgSpeedKmh = route.durationMin > 0 ? Math.min(120, Math.max(10, route.distanceKm / (route.durationMin / 60))) : 45;
  const roughKm = Math.min(
    route.distanceKm,
    hits.filter((h) => isRoughSurface(h.zone.type)).reduce((s, h) => s + (2 * h.zone.radiusM) / 1000, 0),
  );
  const pm25Mg = simulateTrip(grossKg, route.distanceKm, avgSpeedKmh, aggressionPct, roughKm).pm25EmittedMg;
  const perKm = basePm25PerKm(grossKg) * speedFactor(avgSpeedKmh);
  let exposureMg = 0;
  let sensitiveHits = 0;
  for (const h of hits) {
    if (!isSensitive(h.zone.type)) continue;
    sensitiveHits++;
    // comprimento aproximado da corda que a rota percorre dentro da zona
    const half = Math.sqrt(Math.max(0, h.zone.radiusM ** 2 - Math.min(h.distanceM, h.zone.radiusM) ** 2));
    // em horário de entrada/saída, emitir ao lado de escola pesa o dobro
    exposureMg += perKm * ((2 * half) / 1000) * (h.zone.type === 'school' && schoolRush ? 2 : 1);
  }
  return { route, hits, sensitiveHits, roughKm, avgSpeedKmh, pm25Mg, exposureMg, costMg: pm25Mg + EXPOSURE_WEIGHT * exposureMg };
}

export function rankRoutes(routes: RouteResult[], grossKg: number, zones: RiskZone[], aggressionPct = 30, schoolRush = isSchoolRush()) {
  const scores = routes.map((r) => scoreRoute(r, grossKg, zones, aggressionPct, schoolRush));
  let cleanest = 0;
  let fastest = 0;
  scores.forEach((s, i) => {
    if (s.costMg < scores[cleanest].costMg) cleanest = i;
    if (s.route.durationMin < scores[fastest].route.durationMin) fastest = i;
  });
  return { scores, cleanest, fastest };
}

export { PAVEMENT_FACTOR };
