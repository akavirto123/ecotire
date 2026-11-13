/** Indicadores que transformam o histórico em algo útil para o motorista: pneu, dinheiro e conquistas. */
import { basePm25PerKm } from '@/lib/emissions';
import type { Trip } from '@/lib/supabase';

export type TireSettings = { setPriceBRL: number; lifeKm: number };
export const DEFAULT_TIRE: TireSettings = { setPriceBRL: 2400, lifeKm: 40000 };

export type TireStats = {
  drivenKm: number;
  /** km de desgaste equivalente a dirigir sempre suave (acima de drivenKm = pneu gastando mais rápido) */
  wearKm: number;
  /** vida útil do jogo de pneus consumida nas viagens registradas, 0–100 */
  usedPct: number;
  costBRL: number;
  /** quanto a condução suave já economizou em pneu, comparada à agressiva de referência */
  savedBRL: number;
  /** projeção de vida útil no seu estilo de condução */
  projectedLifeKm: number;
};

/** Conta para pneu, nível e conquistas: você dirigindo de verdade ou em simulação (não estimativa nem passageiro). */
const driven = (t: Trip) => t.mode === 'gps' || t.mode === 'sim';

export function tireStats(trips: Trip[], cfg: TireSettings = DEFAULT_TIRE): TireStats {
  let drivenKm = 0;
  let wearKm = 0;
  let savedKm = 0;
  for (const t of trips.filter(driven)) {
    const base = basePm25PerKm(Number(t.gross_weight_kg) || 1500);
    drivenKm += Number(t.distance_km) || 0;
    wearKm += (Number(t.pm25_emitted_mg) || 0) / base;
    savedKm += (Number(t.pm25_avoided_mg) || 0) / base;
  }
  const perKm = cfg.lifeKm > 0 ? cfg.setPriceBRL / cfg.lifeKm : 0;
  const factor = drivenKm > 0 ? wearKm / drivenKm : 1;
  return {
    drivenKm,
    wearKm,
    usedPct: cfg.lifeKm > 0 ? Math.min(100, (wearKm / cfg.lifeKm) * 100) : 0,
    costBRL: wearKm * perKm,
    savedBRL: savedKm * perKm,
    projectedLifeKm: factor > 0 ? cfg.lifeKm / factor : cfg.lifeKm,
  };
}

export type Achievement = { id: string; title: string; desc: string; progress: number; goal: number; done: boolean };

export function achievements(trips: Trip[]): Achievement[] {
  const real = trips.filter(driven);
  const sum = (f: (t: Trip) => number) => real.reduce((s, t) => s + (Number(f(t)) || 0), 0);
  const mk = (id: string, title: string, desc: string, progress: number, goal: number): Achievement => ({
    id, title, desc, goal, progress: Math.min(goal, progress), done: progress >= goal,
  });
  return [
    mk('first', 'Primeira rodada', 'Conclua uma viagem ou simulação', real.length, 1),
    mk('smooth3', 'Pé leve', '3 viagens com Eco-Score 80 ou mais', real.filter((t) => t.smooth_score >= 80).length, 3),
    mk('guardian', 'Guardião das escolas', 'Respeite a velocidade em 10 zonas sensíveis', sum((t) => t.zones_respected), 10),
    mk('km50', 'Rodagem consciente', '50 km monitorados', Math.floor(sum((t) => t.distance_km)), 50),
    mk('avoid100', 'Ar mais limpo', 'Evite 100 mg de PM2.5', Math.floor(sum((t) => t.pm25_avoided_mg)), 100),
    mk('clean', 'Rota limpa', 'Uma viagem de 2 km ou mais sem emitir em zona sensível', real.filter((t) => Number(t.distance_km) >= 2 && Number(t.pm25_in_zones_mg) === 0).length, 1),
  ];
}

/** Nível do motorista: cada km vale mais pontos quanto maior o Eco-Score, mais bônus por zona respeitada. */
export function driverLevel(trips: Trip[]) {
  const xp = Math.round(
    trips.filter(driven).reduce((s, t) => s + (Number(t.distance_km) || 0) * (t.smooth_score / 10) + (t.zones_respected || 0) * 15, 0),
  );
  const level = 1 + Math.floor(Math.sqrt(xp / 40));
  const floor = 40 * (level - 1) ** 2;
  const next = 40 * level ** 2;
  const names = ['Iniciante', 'Atento', 'Preventivo', 'Eco-condutor', 'Guardião do ar', 'Mestre EcoTire'];
  return { xp, level, title: names[Math.min(names.length - 1, level - 1)], progress: (xp - floor) / (next - floor), toNext: next - xp };
}

// ---------- Ranking semanal ----------

export type RankEntry = { avatar?: string | null; nickname: string; ecoScore: number; distanceKm: number; zonesRespected: number; isMe: boolean; sample?: boolean };
export const RANK_MIN_KM = 5;

/** Segunda-feira 00:00 (horário local) da semana de `now`. */
export function weekStart(now: Date = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/**
 * Nota da semana de um motorista: Eco-Score médio ponderado pelos km, para valer a qualidade e não quanto se dirige.
 * `modes` define quais viagens contam (no ranking real, só GPS). null = ainda não atingiu o mínimo de km.
 */
export function weeklyScore(trips: Trip[], now: Date = new Date(), modes: Trip['mode'][] = ['gps']): Omit<RankEntry, 'nickname' | 'isMe'> | null {
  const from = weekStart(now).getTime();
  const week = trips.filter((t) => modes.includes(t.mode) && new Date(t.started_at).getTime() >= from);
  const km = week.reduce((s, t) => s + (Number(t.distance_km) || 0), 0);
  if (km < RANK_MIN_KM) return null;
  const weighted = week.reduce((s, t) => s + t.smooth_score * (Number(t.distance_km) || 0), 0);
  return {
    ecoScore: Math.round((weighted / km) * 10) / 10,
    distanceKm: Math.round(km * 10) / 10,
    zonesRespected: week.reduce((s, t) => s + (t.zones_respected || 0), 0),
  };
}

export function sortRanking(entries: RankEntry[]): RankEntry[] {
  return [...entries].sort((a, b) => b.ecoScore - a.ecoScore || b.distanceKm - a.distanceKm);
}

/** Ranking de exemplo para o modo demonstração (sem banco não há outros usuários). */
export const SAMPLE_RANKING: RankEntry[] = [
  { nickname: 'Marina', ecoScore: 94.2, distanceKm: 61.5, zonesRespected: 14, isMe: false, sample: true },
  { nickname: 'Caio', ecoScore: 88.7, distanceKm: 112.3, zonesRespected: 21, isMe: false, sample: true },
  { nickname: 'Bia', ecoScore: 81.5, distanceKm: 38.9, zonesRespected: 6, isMe: false, sample: true },
  { nickname: 'Rafa', ecoScore: 73.1, distanceKm: 84, zonesRespected: 9, isMe: false, sample: true },
];
