/**
 * Modelo de estimativa de material particulado por desgaste de pneus.
 *
 * Referência de ordem de grandeza: EMEP/EEA Guidebook 2019 (1.A.3.b.vi) —
 * desgaste de pneus de automóveis ≈ 10,7 mg/km de TSP, dos quais ≈ 60% são PM10
 * e ≈ 42% são PM2.5. Os fatores de massa, velocidade, aceleração e pavimento
 * são um modelo simplificado do EcoTire: os valores são ESTIMATIVAS.
 */

export const TSP_REF_MG_PER_KM = 10.7;
export const REF_MASS_KG = 1400;
export const PM10_FRACTION = 0.6;
export const PM25_FRACTION = 0.42;
export const PM10_TO_PM25_RATIO = PM10_FRACTION / PM25_FRACTION;
/** Piso irregular (terra, paralelepípedo, asfalto ruim) aumenta a abrasão. */
export const PAVEMENT_FACTOR = 1.3;
/** Aceleração típica de uma condução agressiva, usada como linha de comparação. */
export const REF_AGGRESSIVE_ACCEL_G = 0.35;

export type EmissionLevel = 'low' | 'moderate' | 'high';

export const toPm10 = (pm25Mg: number) => pm25Mg * PM10_TO_PM25_RATIO;
export const toTsp = (pm25Mg: number) => pm25Mg / PM25_FRACTION;

/** PM2.5 (mg/km) em velocidade constante, proporcional à massa total do veículo. */
export function basePm25PerKm(grossKg: number): number {
  return TSP_REF_MG_PER_KM * PM25_FRACTION * (grossKg / REF_MASS_KG);
}

export function speedFactor(speedKmh: number): number {
  return speedKmh <= 60 ? 1 : 1 + ((speedKmh - 60) / 100) ** 1.5;
}

export function accelFactor(accelG: number): number {
  return 1 + Math.min(Math.max(accelG, 0), 1.2) * 1.8;
}

export function classifyLevel(speedKmh: number, accelG: number): EmissionLevel {
  const aggressiveness = speedFactor(speedKmh) * accelFactor(accelG);
  if (aggressiveness > 2.2) return 'high';
  if (aggressiveness > 1.4) return 'moderate';
  return 'low';
}

export type SampleInput = {
  grossKg: number;
  speedKmh: number;
  accelG: number;
  intervalS: number;
  roughPavement?: boolean;
};

export type EmissionSample = {
  speedKmh: number;
  accelG: number;
  distKm: number;
  /** mg de PM2.5 emitidos no intervalo */
  emittedMg: number;
  /** mg que seriam emitidos com condução agressiva de referência */
  aggressiveMg: number;
  level: EmissionLevel;
};

export function sampleEmission(i: SampleInput): EmissionSample {
  const distKm = (i.speedKmh * i.intervalS) / 3600;
  const base = basePm25PerKm(i.grossKg) * speedFactor(i.speedKmh) * (i.roughPavement ? PAVEMENT_FACTOR : 1);
  const emittedMg = base * accelFactor(i.accelG) * distKm;
  const aggressiveMg = base * Math.max(accelFactor(i.accelG), accelFactor(REF_AGGRESSIVE_ACCEL_G)) * distKm;
  return {
    speedKmh: i.speedKmh,
    accelG: i.accelG,
    distKm,
    emittedMg,
    aggressiveMg,
    level: classifyLevel(i.speedKmh, i.accelG),
  };
}

/** Eco-Score 0–100: fração do percurso em emissão moderada/alta, mais emissão dentro de zonas de risco. */
export function computeSmoothScore(samples: EmissionSample[], zoneShare = 0): number {
  const moving = samples.filter((s) => s.speedKmh > 1);
  if (moving.length === 0) return 100;
  const high = moving.filter((s) => s.level === 'high').length / moving.length;
  const moderate = moving.filter((s) => s.level === 'moderate').length / moving.length;
  const score = 100 * (1 - (high + 0.35 * moderate)) - 15 * Math.min(1, Math.max(0, zoneShare));
  return Math.round(Math.max(0, Math.min(100, score)));
}

export type TripAggregate = {
  distanceKm: number;
  durationS: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  peakAccelG: number;
  pm25EmittedMg: number;
  pm25AvoidedMg: number;
  pm10EmittedMg: number;
  pm10AvoidedMg: number;
  pm25InZonesMg: number;
  smoothScore: number;
};

export function aggregateTrip(
  samples: EmissionSample[],
  durationS: number,
  distanceKm: number,
  pm25InZonesMg = 0,
): TripAggregate {
  const pm25EmittedMg = samples.reduce((s, x) => s + x.emittedMg, 0);
  const pm25AvoidedMg = samples.reduce((s, x) => s + Math.max(0, x.aggressiveMg - x.emittedMg), 0);
  return {
    distanceKm,
    durationS,
    avgSpeedKmh: durationS > 0 ? (distanceKm / durationS) * 3600 : 0,
    maxSpeedKmh: samples.reduce((m, x) => Math.max(m, x.speedKmh), 0),
    peakAccelG: samples.reduce((m, x) => Math.max(m, x.accelG), 0),
    pm25EmittedMg,
    pm25AvoidedMg,
    pm10EmittedMg: toPm10(pm25EmittedMg),
    pm10AvoidedMg: toPm10(pm25AvoidedMg),
    pm25InZonesMg,
    smoothScore: computeSmoothScore(samples, pm25EmittedMg > 0 ? pm25InZonesMg / pm25EmittedMg : 0),
  };
}

/** Estimativa para um trajeto planejado (sem sensores). aggressionPct: 0 = suave, 100 = agressiva. */
export function simulateTrip(
  grossKg: number,
  distanceKm: number,
  avgSpeedKmh: number,
  aggressionPct: number,
  roughKm = 0,
): TripAggregate {
  const durationS = avgSpeedKmh > 0 ? (distanceKm / avgSpeedKmh) * 3600 : 0;
  const accelG = (Math.max(0, Math.min(100, aggressionPct)) / 100) * 0.6;
  const smoothKm = Math.max(0, distanceKm - roughKm);
  const perKm = basePm25PerKm(grossKg) * speedFactor(avgSpeedKmh);
  const effKm = smoothKm + Math.min(roughKm, distanceKm) * PAVEMENT_FACTOR;
  const emitted = perKm * accelFactor(accelG) * effKm;
  const aggressive = perKm * Math.max(accelFactor(accelG), accelFactor(REF_AGGRESSIVE_ACCEL_G)) * effKm;
  const level = classifyLevel(avgSpeedKmh, accelG);
  const levelScore = level === 'high' ? 0 : level === 'moderate' ? 65 : 100;
  return {
    distanceKm,
    durationS,
    avgSpeedKmh,
    maxSpeedKmh: avgSpeedKmh * 1.12,
    peakAccelG: accelG,
    pm25EmittedMg: emitted,
    pm25AvoidedMg: Math.max(0, aggressive - emitted),
    pm10EmittedMg: toPm10(emitted),
    pm10AvoidedMg: toPm10(Math.max(0, aggressive - emitted)),
    pm25InZonesMg: 0,
    smoothScore: Math.round(levelScore - (aggressionPct / 100) * (level === 'low' ? 25 : 15)),
  };
}

export const EMISSION_COLORS: Record<EmissionLevel, string> = {
  low: '#34d399',
  moderate: '#fbbf24',
  high: '#fb7185',
};

export const EMISSION_LABELS: Record<EmissionLevel, string> = {
  low: 'Baixa',
  moderate: 'Moderada',
  high: 'Alta',
};
