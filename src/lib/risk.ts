import { cumulativeM, distPointToSegmentM, haversine, type Pt } from '@/lib/geo';

export type RiskType = 'school' | 'hospital' | 'pavement' | 'works' | 'other';

export type RiskZone = {
  id: string;
  name: string;
  type: RiskType;
  lat: number;
  lng: number;
  radiusM: number;
  source: 'osm' | 'community';
  note?: string | null;
  userId?: string;
  /** confirmações de outros motoristas ("ainda está aí") */
  confirms?: number;
};

export const RISK_META: Record<RiskType, { label: string; color: string; advisedKmh: number; weight: number; voice: string }> = {
  school: { label: 'Escola', color: '#fbbf24', advisedKmh: 30, weight: 1, voice: 'zona escolar' },
  hospital: { label: 'Hospital', color: '#fb7185', advisedKmh: 30, weight: 1, voice: 'área hospitalar' },
  pavement: { label: 'Pavimento irregular', color: '#a78bfa', advisedKmh: 40, weight: 0.5, voice: 'trecho de pavimento irregular' },
  works: { label: 'Obras na via', color: '#fb923c', advisedKmh: 40, weight: 0.5, voice: 'trecho em obras' },
  other: { label: 'Zona de atenção', color: '#60a5fa', advisedKmh: 40, weight: 0.5, voice: 'zona de atenção' },
};

export const DEFAULT_RADIUS_M: Record<RiskType, number> = { school: 150, hospital: 150, pavement: 80, works: 100, other: 120 };

/** Zonas em que as pessoas ficam expostas (entram no Índice de Exposição Sensível). */
export const isSensitive = (t: RiskType) => t === 'school' || t === 'hospital';
/** Zonas em que o piso aumenta a abrasão do pneu. */
export const isRoughSurface = (t: RiskType) => t === 'pavement' || t === 'works';

export type RiskStage = 'approaching' | 'inside';

export type RiskAlert = {
  zone: RiskZone;
  stage: RiskStage;
  /** distância até a borda da zona (0 quando dentro) */
  distanceM: number;
  /** segundos até a borda na velocidade atual (null se parado) */
  etaS: number | null;
  advisedKmh: number;
};

const LOOKAHEAD_S = 20;
const MIN_WARN_M = 250;
const MAX_WARN_M = 600;

/**
 * Alerta preditivo: avisa antes de entrar na zona. A distância de aviso cresce com a velocidade
 * (≈ 20 s de antecedência), entre 250 m e 600 m.
 */
export function evaluateRisk(pos: Pt, speedKmh: number, zones: RiskZone[]): RiskAlert[] {
  const speedMs = Math.max(0, speedKmh) / 3.6;
  const warnM = Math.min(MAX_WARN_M, Math.max(MIN_WARN_M, speedMs * LOOKAHEAD_S));
  const out: RiskAlert[] = [];
  for (const zone of zones) {
    const edge = haversine(pos, zone) - zone.radiusM;
    if (edge > warnM) continue;
    const distanceM = Math.max(0, edge);
    out.push({
      zone,
      stage: edge <= 0 ? 'inside' : 'approaching',
      distanceM,
      etaS: speedMs > 0.5 ? distanceM / speedMs : null,
      advisedKmh: RISK_META[zone.type].advisedKmh,
    });
  }
  return out.sort((a, b) => a.distanceM - b.distanceM);
}

export type RouteZoneHit = { zone: RiskZone; distanceM: number; alongKm: number };

/** Zonas pelas quais a rota passa (a rota entra no raio da zona + margem). */
export function zonesAlongRoute(coords: Pt[], zones: RiskZone[], marginM = 60): RouteZoneHit[] {
  if (coords.length < 2) return [];
  const cum = cumulativeM(coords);
  const hits: RouteZoneHit[] = [];
  for (const zone of zones) {
    let best = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const d = distPointToSegmentM(zone, coords[i], coords[i + 1]);
      if (d < best) {
        best = d;
        bestIdx = i;
      }
    }
    if (best <= zone.radiusM + marginM) hits.push({ zone, distanceM: best, alongKm: cum[bestIdx] / 1000 });
  }
  return hits.sort((a, b) => a.alongKm - b.alongKm);
}

/** Junta listas de zonas, removendo duplicadas (mesmo id, ou mesmo tipo a menos de 60 m). */
export function mergeZones(...lists: RiskZone[][]): RiskZone[] {
  const out: RiskZone[] = [];
  const seen = new Set<string>();
  for (const z of lists.flat()) {
    if (seen.has(z.id)) continue;
    if (out.some((o) => o.type === z.type && haversine(o, z) < 60)) continue;
    seen.add(z.id);
    out.push(z);
  }
  return out;
}

/** Horário de entrada e saída de escolas (dias úteis): quando há mais crianças na calçada. */
export function isSchoolRush(d: Date = new Date()): boolean {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const h = d.getHours() + d.getMinutes() / 60;
  return (h >= 6.5 && h < 8) || (h >= 11.5 && h < 13.5) || (h >= 17 && h < 19);
}
