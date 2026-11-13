import type { Pt } from '@/lib/geo';
import { DEFAULT_RADIUS_M, type RiskType, type RiskZone } from '@/lib/risk';

// Servidores públicos do Overpass. A consulta vai para todos ao mesmo tempo e vale a primeira resposta boa,
// porque cada um deles fica lento ou fora do ar com frequência.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

type OsmElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

const cache = new Map<string, OsmElement[]>();

async function runQuery(query: string, signal?: AbortSignal): Promise<OsmElement[]> {
  const hit = cache.get(query);
  if (hit) return hit;
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, 35000);
  try {
    const elements = await Promise.any(
      ENDPOINTS.map(async (url) => {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctrl.signal });
        if (!res.ok) throw new Error(`Overpass ${res.status}`);
        return ((await res.json()).elements ?? []) as OsmElement[];
      }),
    );
    cache.set(query, elements);
    return elements;
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    ctrl.abort(); // cancela os servidores que ainda não responderam
  }
}

const BAD_SURFACE = /^(unpaved|gravel|fine_gravel|dirt|earth|ground|mud|sand|compacted|cobblestone|sett|unhewn_cobblestone|pebblestone)$/;
const BAD_SMOOTHNESS = /^(bad|very_bad|horrible|very_horrible|impassable)$/;

function toZones(els: OsmElement[]): RiskZone[] {
  const out: RiskZone[] = [];
  for (const el of els) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    const t = el.tags ?? {};
    let type: RiskType | null = null;
    let name = t.name;
    if (t.amenity === 'school' || t.amenity === 'kindergarten') {
      type = 'school';
      name ??= 'Escola (sem nome)';
    } else if (t.amenity === 'hospital') {
      type = 'hospital';
      name ??= 'Hospital (sem nome)';
    } else if (t.highway === 'construction') {
      type = 'works';
      name = name ? `Obras: ${name}` : 'Via em obras';
    } else if (t.highway && (BAD_SURFACE.test(t.surface ?? '') || BAD_SMOOTHNESS.test(t.smoothness ?? ''))) {
      type = 'pavement';
      name = name ? `${name} (piso irregular)` : 'Trecho de piso irregular';
    }
    if (!type) continue;
    out.push({ id: `osm-${el.type}-${el.id}`, name, type, lat, lng, radiusM: DEFAULT_RADIUS_M[type], source: 'osm' });
  }
  return out;
}

const ROADS = '["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)$"]';
const AMENITIES = 'nwr["amenity"~"^(school|kindergarten|hospital)$"]';

export type BoundingBox = { south: number; west: number; north: number; east: number };
const box = (b: BoundingBox) => `${b.south.toFixed(4)},${b.west.toFixed(4)},${b.north.toFixed(4)},${b.east.toFixed(4)}`;

/** Caixa que envolve os pontos, com folga em metros. Consultas por caixa são muito mais rápidas que por linha. */
export function boundsOf(points: Pt[], padM = 300): BoundingBox {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const dLat = padM / 111320;
  const dLng = padM / (111320 * Math.cos((lats[0] * Math.PI) / 180));
  return { south: Math.min(...lats) - dLat, north: Math.max(...lats) + dLat, west: Math.min(...lngs) - dLng, east: Math.max(...lngs) + dLng };
}

/** Escolas e hospitais dentro da caixa (consulta leve). */
export async function fetchSensitiveInBounds(b: BoundingBox, signal?: AbortSignal): Promise<RiskZone[]> {
  return toZones(await runQuery(`[out:json][timeout:20];${AMENITIES}(${box(b)});out center tags 600;`, signal));
}

/** Piso irregular e obras dentro da caixa (consulta mais pesada, feita em separado). */
export async function fetchRoadIssuesInBounds(b: BoundingBox, signal?: AbortSignal): Promise<RiskZone[]> {
  const q = `[out:json][timeout:25];(way${ROADS}["surface"~"^(unpaved|gravel|fine_gravel|dirt|earth|ground|mud|sand|compacted|cobblestone|sett|unhewn_cobblestone|pebblestone)$"](${box(b)});way${ROADS}["smoothness"~"^(bad|very_bad|horrible|very_horrible|impassable)$"](${box(b)});way["highway"="construction"](${box(b)}););out center tags 400;`;
  return toZones(await runQuery(q, signal));
}

/** Zonas de risco ao redor de um ponto (posição atual). */
export async function fetchZonesAround(p: Pt, radiusM: number, signal?: AbortSignal): Promise<RiskZone[]> {
  const b = boundsOf([p], radiusM);
  const [a, r] = await Promise.allSettled([fetchSensitiveInBounds(b, signal), fetchRoadIssuesInBounds(b, signal)]);
  if (a.status === 'rejected' && r.status === 'rejected') throw a.reason;
  return [...(a.status === 'fulfilled' ? a.value : []), ...(r.status === 'fulfilled' ? r.value : [])];
}

/** Escolas e hospitais na área visível do mapa. */
export const fetchZonesInBounds = fetchSensitiveInBounds;
