import { describe, expect, it } from 'vitest';
import { aggregateTrip, basePm25PerKm, classifyLevel, sampleEmission, simulateTrip, toPm10 } from './emissions';
import { circleRing, cumulativeM, haversine, pointAlong } from './geo';
import { evaluateRisk, mergeZones, zonesAlongRoute, type RiskZone } from './risk';
import { rankRoutes } from './routing';
import { describeModel, observedFactor, predictFactor, trainDriverModel } from './ai';
import { achievements, driverLevel, sortRanking, tireStats, weekStart, weeklyScore } from './insights';
import type { Trip } from './supabase';
import { maintenanceStatus } from './maintenance';
import { decodeTile, tilePoint, tilesFor, zonesFromTile } from './tilezones';

const zone = (id: string, type: RiskZone['type'], lat: number, lng: number, radiusM = 150): RiskZone => ({ id, name: id, type, lat, lng, radiusM, source: 'osm' });

describe('geo', () => {
  it('haversine: 1 grau de latitude ≈ 111 km', () => {
    expect(haversine({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111195, -2);
  });
  it('pointAlong anda a distância pedida', () => {
    const line = [{ lat: 0, lng: 0 }, { lat: 0.01, lng: 0 }];
    const p = pointAlong(line, cumulativeM(line), 500);
    expect(haversine(line[0], p)).toBeCloseTo(500, 0);
    expect(p.heading).toBeCloseTo(0, 3);
  });
  it('circleRing fecha o anel no raio certo', () => {
    const ring = circleRing({ lat: -23.5, lng: -47.45 }, 150);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(haversine({ lat: -23.5, lng: -47.45 }, { lat: ring[5][1], lng: ring[5][0] })).toBeCloseTo(150, 0);
  });
});

describe('emissões', () => {
  it('base: 10,7 mg/km de TSP × 42% a 1400 kg', () => {
    expect(basePm25PerKm(1400)).toBeCloseTo(4.494, 3);
    expect(toPm10(4.2)).toBeCloseTo(6, 6);
  });
  it('mais massa e mais aceleração emitem mais', () => {
    const light = sampleEmission({ grossKg: 1200, speedKmh: 50, accelG: 0.05, intervalS: 1 });
    const heavy = sampleEmission({ grossKg: 2200, speedKmh: 50, accelG: 0.05, intervalS: 1 });
    const harsh = sampleEmission({ grossKg: 1200, speedKmh: 50, accelG: 0.6, intervalS: 1 });
    expect(heavy.emittedMg / light.emittedMg).toBeCloseTo(2200 / 1200, 6);
    expect(harsh.emittedMg).toBeGreaterThan(light.emittedMg);
    expect(light.aggressiveMg).toBeGreaterThan(light.emittedMg);
    expect(harsh.aggressiveMg).toBeCloseTo(harsh.emittedMg, 9);
  });
  it('piso irregular aumenta 30%', () => {
    const a = sampleEmission({ grossKg: 1500, speedKmh: 40, accelG: 0, intervalS: 1 });
    const b = sampleEmission({ grossKg: 1500, speedKmh: 40, accelG: 0, intervalS: 1, roughPavement: true });
    expect(b.emittedMg / a.emittedMg).toBeCloseTo(1.3, 6);
  });
  it('níveis e eco-score', () => {
    expect(classifyLevel(40, 0.05)).toBe('low');
    expect(classifyLevel(40, 0.3)).toBe('moderate');
    expect(classifyLevel(40, 0.8)).toBe('high');
    const calm = Array.from({ length: 60 }, () => sampleEmission({ grossKg: 1500, speedKmh: 40, accelG: 0.03, intervalS: 1 }));
    const wild = Array.from({ length: 60 }, () => sampleEmission({ grossKg: 1500, speedKmh: 40, accelG: 0.9, intervalS: 1 }));
    expect(aggregateTrip(calm, 60, 0.67).smoothScore).toBe(100);
    expect(aggregateTrip(wild, 60, 0.67).smoothScore).toBe(0);
    expect(aggregateTrip(calm, 60, 0.67).pm25EmittedMg).toBeCloseTo(calm[0].emittedMg * 60, 6);
  });
  it('estimativa planejada bate com a soma de amostras', () => {
    const plan = simulateTrip(1500, 10, 40, 0);
    const perSecond = sampleEmission({ grossKg: 1500, speedKmh: 40, accelG: 0, intervalS: 1 });
    expect(plan.pm25EmittedMg).toBeCloseTo(perSecond.emittedMg * plan.durationS, 4);
    expect(simulateTrip(1500, 10, 40, 80).pm25EmittedMg).toBeGreaterThan(plan.pm25EmittedMg);
  });
});

describe('zonas de risco', () => {
  const school = zone('escola', 'school', 0.01, 0);
  it('avisa antes, depois dentro, e ignora longe', () => {
    const far = evaluateRisk({ lat: 0, lng: 0 }, 40, [school]); // ~960 m da borda
    expect(far).toHaveLength(0);
    const near = evaluateRisk({ lat: 0.0075, lng: 0 }, 40, [school]); // ~128 m da borda
    expect(near[0].stage).toBe('approaching');
    expect(near[0].distanceM).toBeCloseTo(128, -1);
    expect(near[0].etaS).toBeCloseTo(128 / (40 / 3.6), 0);
    const inside = evaluateRisk({ lat: 0.0095, lng: 0 }, 40, [school]);
    expect(inside[0].stage).toBe('inside');
    expect(inside[0].advisedKmh).toBe(30);
  });
  it('antecedência cresce com a velocidade', () => {
    const p = { lat: 0.0055, lng: 0 }; // ~350 m da borda
    expect(evaluateRisk(p, 30, [school])).toHaveLength(0);
    expect(evaluateRisk(p, 90, [school])).toHaveLength(1);
  });
  it('zonesAlongRoute e mergeZones', () => {
    const route = [{ lat: 0, lng: 0 }, { lat: 0.02, lng: 0 }];
    const hits = zonesAlongRoute(route, [school, zone('longe', 'hospital', 0.01, 0.02)]);
    expect(hits.map((h) => h.zone.id)).toEqual(['escola']);
    expect(mergeZones([school], [zone('dup', 'school', 0.0101, 0)], [school])).toHaveLength(1);
  });
  it('a rota de menor impacto evita zona sensível mesmo sendo um pouco mais longa', () => {
    const direct = { distanceKm: 2.22, durationMin: 4, coordinates: [{ lat: 0, lng: 0 }, { lat: 0.02, lng: 0 }] };
    const detour = { distanceKm: 2.4, durationMin: 4.4, coordinates: [{ lat: 0, lng: 0 }, { lat: 0.01, lng: 0.006 }, { lat: 0.02, lng: 0 }] };
    const r = rankRoutes([direct, detour], 1600, [school]);
    expect(r.fastest).toBe(0);
    expect(r.cleanest).toBe(1);
    expect(r.scores[0].exposureMg).toBeGreaterThan(0);
    expect(r.scores[1].exposureMg).toBe(0);
    // sem zonas, a mais curta vence
    expect(rankRoutes([direct, detour], 1600, []).cleanest).toBe(0);
  });
});

const trip = (o: Partial<Trip>): Trip => ({
  id: 'x', user_id: 'u', mode: 'gps', vehicle_model: 'v', gross_weight_kg: 1400, distance_km: 10, duration_s: 900, avg_speed_kmh: 40,
  max_speed_kmh: 60, peak_accel_g: 0.2, pm25_emitted_mg: 0, pm25_avoided_mg: 0, pm10_emitted_mg: 0, pm10_avoided_mg: 0, pm25_in_zones_mg: 0,
  smooth_score: 80, sensitive_zones_hit: 0, zones_respected: 0, origin_name: null, origin_lat: null, origin_lng: null, destination_name: null,
  destination_lat: null, destination_lng: null, passengers: 1, trunk_fill_pct: 0, started_at: '2026-11-09T12:00:00Z', created_at: '2026-11-09T12:00:00Z', ...o,
});

describe('IA local (fator pessoal)', () => {
  const base = basePm25PerKm(1400) * 10; // 10 km suaves a 40 km/h
  it('sem dados, usa o ponto de partida', () => {
    const m = trainDriverModel([]);
    expect(m.n).toBe(0);
    expect(predictFactor(m, 40)).toBeCloseTo(1.324, 3);
    expect(describeModel(m)).toMatch(/Ainda sem viagens/);
  });
  it('aprende o estilo do motorista e ignora estimativas', () => {
    expect(observedFactor(trip({ pm25_emitted_mg: base * 2 }))).toBeCloseTo(2, 6);
    expect(observedFactor(trip({ mode: 'plan', pm25_emitted_mg: base * 2 }))).toBeNull();
    const harsh = Array.from({ length: 30 }, () => trip({ pm25_emitted_mg: base * 2 }));
    const m = trainDriverModel([...harsh, trip({ mode: 'plan', pm25_emitted_mg: base * 9 })]);
    expect(m.n).toBe(30);
    expect(predictFactor(m, 40)).toBeGreaterThan(1.9);
    expect(predictFactor(m, 40)).toBeLessThan(2.05);
    const calm = trainDriverModel(Array.from({ length: 30 }, () => trip({ pm25_emitted_mg: base * 1.05 })));
    expect(predictFactor(calm, 40)).toBeLessThan(1.12);
  });
  it('capta a tendência com a velocidade', () => {
    const data = [20, 30, 40, 50, 60].flatMap((v) => Array.from({ length: 6 }, () => trip({ avg_speed_kmh: v, pm25_emitted_mg: base * (1 + v / 50) })));
    const m = trainDriverModel(data);
    expect(predictFactor(m, 60)).toBeGreaterThan(predictFactor(m, 20) + 0.5);
    expect(m.mae).toBeLessThan(0.1);
  });
});

describe('pneu, nível e conquistas', () => {
  const base = basePm25PerKm(1400);
  const t = [trip({ pm25_emitted_mg: base * 10 * 1.5, pm25_avoided_mg: base * 10 * 0.5, smooth_score: 90, zones_respected: 2 }), trip({ mode: 'plan', pm25_emitted_mg: 999 })];
  it('desgaste equivalente e economia em reais', () => {
    const s = tireStats(t, { setPriceBRL: 2000, lifeKm: 40000 });
    expect(s.drivenKm).toBe(10);
    expect(s.wearKm).toBeCloseTo(15, 6);
    expect(s.costBRL).toBeCloseTo(0.75, 6);
    expect(s.savedBRL).toBeCloseTo(0.25, 6);
    expect(s.projectedLifeKm).toBeCloseTo(40000 / 1.5, 3);
  });
  it('conquistas e nível contam só viagens reais', () => {
    const a = achievements(t);
    expect(a.find((x) => x.id === 'first')!.done).toBe(true);
    expect(a.find((x) => x.id === 'guardian')!.progress).toBe(2);
    expect(a.find((x) => x.id === 'km50')!.done).toBe(false);
    const l = driverLevel(t);
    expect(l.xp).toBe(120);
    expect(l.level).toBe(2);
    expect(driverLevel([]).level).toBe(1);
  });
});

describe('ranking semanal', () => {
  const now = new Date(2026, 10, 11, 15, 0); // quarta, 11/11/2026
  const at = (y: number, m: number, d: number) => new Date(y, m, d, 12).toISOString();
  it('a semana começa na segunda', () => {
    expect(weekStart(now)).toEqual(new Date(2026, 10, 9));
    expect(weekStart(new Date(2026, 10, 15, 23))).toEqual(new Date(2026, 10, 9)); // domingo ainda é a mesma semana
  });
  it('média ponderada por km, só GPS desta semana, com mínimo de km', () => {
    const t = [
      trip({ distance_km: 8, smooth_score: 90, zones_respected: 2, started_at: at(2026, 10, 10) }),
      trip({ distance_km: 2, smooth_score: 40, zones_respected: 1, started_at: at(2026, 10, 11) }),
      trip({ distance_km: 50, smooth_score: 10, started_at: at(2026, 10, 6) }), // semana passada
      trip({ mode: 'sim', distance_km: 50, smooth_score: 100, started_at: at(2026, 10, 10) }), // simulação não conta
    ];
    expect(weeklyScore(t, now)).toEqual({ ecoScore: 80, distanceKm: 10, zonesRespected: 3 });
    expect(weeklyScore(t.slice(1, 2), now)).toBeNull(); // 2 km: abaixo do mínimo
    expect(weeklyScore(t, now, ['gps', 'sim'])!.distanceKm).toBe(60);
  });
  it('ordena por nota e desempata por km', () => {
    const e = (nickname: string, ecoScore: number, distanceKm: number) => ({ nickname, ecoScore, distanceKm, zonesRespected: 0, isMe: false });
    expect(sortRanking([e('a', 80, 10), e('b', 90, 5), e('c', 80, 30)]).map((x) => x.nickname)).toEqual(['b', 'c', 'a']);
  });
});

describe('calibragem, rodízio e modo passageiro', () => {
  const now = new Date(2026, 10, 30, 12);
  it('lembra de calibrar depois de 30 dias e do rodízio a cada 10 mil km', () => {
    expect(maintenanceStatus({ calibratedAt: null, rotationAtKm: 0 }, 0, now).calibrationDue).toBe(true);
    const ok = maintenanceStatus({ calibratedAt: new Date(2026, 10, 20, 12).toISOString(), rotationAtKm: 2000 }, 9000, now);
    expect(ok).toMatchObject({ calibrationDue: false, daysSinceCalibration: 10, rotationDue: false, kmSinceRotation: 7000, kmToRotation: 3000 });
    const due = maintenanceStatus({ calibratedAt: new Date(2026, 9, 20, 12).toISOString(), rotationAtKm: 2000 }, 12500, now);
    expect(due).toMatchObject({ calibrationDue: true, rotationDue: true, kmToRotation: 0 });
  });
  it('viagem de passageiro não conta para pneu, nível, IA nem ranking', () => {
    const p = [trip({ mode: 'passenger', distance_km: 40, pm25_emitted_mg: 300, smooth_score: 5, started_at: new Date(2026, 10, 30, 9).toISOString() })];
    expect(tireStats(p).drivenKm).toBe(0);
    expect(driverLevel(p).xp).toBe(0);
    expect(trainDriverModel(p).n).toBe(0);
    expect(weeklyScore(p, now)).toBeNull();
  });
});

describe('zonas lidas dos blocos do mapa', () => {
  // mini-codificador de protobuf só para montar um bloco de teste
  const varint = (n: number) => { const o: number[] = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
  const zz = (n: number) => (n < 0 ? -n * 2 - 1 : n * 2);
  const str = (s: string) => [...new TextEncoder().encode(s)];
  const field = (num: number, wire: number, body: number[]) => [...varint((num << 3) | wire), ...(wire === 2 ? varint(body.length) : []), ...body];
  const sval = (s: string) => field(4, 2, field(1, 2, str(s)));
  const feature = (type: number, tags: number[], geom: number[]) => field(2, 2, [...field(3, 0, varint(type)), ...field(2, 2, tags.flatMap(varint)), ...field(4, 2, geom.flatMap(varint))]);
  const layer = (name: string, keys: string[], values: string[], feats: number[][]) => field(3, 2, [...field(1, 2, str(name)), ...feats.flat(), ...keys.flatMap((k) => field(3, 2, str(k))), ...values.flatMap(sval), ...field(5, 0, varint(4096))]);
  const point = (x: number, y: number) => [(1 << 3) | 1, zz(x), zz(y)];
  const line = (pts: [number, number][]) => [(1 << 3) | 1, zz(pts[0][0]), zz(pts[0][1]), ((pts.length - 1) << 3) | 2, ...pts.slice(1).flatMap(([x, y], i) => [zz(x - pts[i][0]), zz(y - pts[i][1])])];
  const tile = new Uint8Array([
    ...layer('poi', ['class', 'subclass', 'name'], ['school', 'kindergarten', 'Escola Azul', 'hospital', 'clinic', 'Clínica X', 'Santa Casa', 'bakery'], [
      feature(1, [0, 0, 1, 1, 2, 2], point(2048, 2048)), // escola
      feature(1, [0, 3, 1, 4, 2, 5], point(100, 100)), // clínica: não é hospital
      feature(1, [0, 3, 1, 3, 2, 6], point(4000, 300)), // hospital
      feature(1, [0, 7], point(10, 10)), // padaria: ignorada
    ]),
    ...layer('transportation', ['class', 'surface'], ['minor', 'unpaved', 'paved', 'path'], [
      feature(2, [0, 0, 1, 1], line([[0, 0], [1000, 1000], [2000, 1000]])), // rua de terra
      feature(2, [0, 0, 1, 2], line([[0, 50], [900, 50]])), // asfaltada: ignorada
      feature(2, [0, 3, 1, 1], line([[0, 90], [900, 90]])), // trilha: ignorada
    ]),
    ...layer('water', [], [], []),
  ]);
  it('decodifica camadas, propriedades e geometria', () => {
    const l = decodeTile(tile, ['poi', 'transportation']);
    expect(Object.keys(l)).toEqual(['poi', 'transportation']);
    expect(l.poi.features[0]).toEqual({ type: 1, props: { class: 'school', subclass: 'kindergarten', name: 'Escola Azul' }, points: [[2048, 2048]] });
    expect(l.transportation.features[0].points).toEqual([[0, 0], [1000, 1000], [2000, 1000]]);
  });
  it('vira escola, hospital e trecho sem pavimento no lugar certo', () => {
    const [x, y] = tilesFor([{ lat: -23.5015, lng: -47.4526 }], 0)[0].split('/').map(Number);
    const zones = zonesFromTile(x, y, decodeTile(tile, ['poi', 'transportation']));
    expect(zones.map((z) => [z.type, z.name])).toEqual([['school', 'Escola Azul'], ['hospital', 'Santa Casa'], ['pavement', 'Trecho sem pavimento']]);
    // o centro do bloco tem de cair dentro do próprio bloco, perto do ponto de origem (< ~2 km)
    const c = tilePoint(x, y, 2048, 2048, 4096);
    expect(zones[0]).toMatchObject({ lat: c.lat, lng: c.lng });
    expect(haversine(c, { lat: -23.5015, lng: -47.4526 })).toBeLessThan(2000);
    expect(tilesFor([c], 0)).toEqual([`${x}/${y}`]);
  });
});
