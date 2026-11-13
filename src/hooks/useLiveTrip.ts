import { useCallback, useEffect, useRef, useState } from 'react';
import { announce, unlockAudio } from '@/lib/alerts';
import { aggregateTrip, sampleEmission, type EmissionLevel, type EmissionSample, type TripAggregate } from '@/lib/emissions';
import { bearing, cumulativeM, haversine, pointAlong, type Pt } from '@/lib/geo';
import { evaluateRisk, isRoughSurface, isSensitive, RISK_META, type RiskAlert, type RiskZone } from '@/lib/risk';
import { speak } from '@/lib/alerts';

export type TripMode = 'gps' | 'sim';
export type LivePos = Pt & { heading: number };
/** Coluna 3D de emissão: quanto PM2.5 por km foi emitido naquele trecho */
export type EmissionColumn = Pt & { mgPerKm: number; level: EmissionLevel };

export type LiveState = {
  active: boolean;
  mode: TripMode;
  pos: LivePos | null;
  speedKmh: number;
  accelG: number;
  level: EmissionLevel;
  distanceKm: number;
  pm25Mg: number;
  pm25InZonesMg: number;
  elapsedS: number;
  trail: Pt[];
  alerts: RiskAlert[];
  columns: EmissionColumn[];
  /** dica do treinador de condução (some sozinha) */
  coachTip: string | null;
  geoError: string | null;
  /** simulação chegou ao destino */
  arrived: boolean;
};

export type TripSummary = TripAggregate & { zonesHit: number; zonesRespected: number; startedAt: number; mode: TripMode };

type Inputs = { grossKg: number; zones: RiskZone[]; soundOn: boolean };
type StartOptions = { route?: Pt[]; aggressionPct?: number; timeWarp?: number };

const IDLE: LiveState = {
  active: false, mode: 'gps', pos: null, speedKmh: 0, accelG: 0, level: 'low', distanceKm: 0,
  pm25Mg: 0, pm25InZonesMg: 0, elapsedS: 0, trail: [], alerts: [], columns: [], coachTip: null, geoError: null, arrived: false,
};

const G = 9.81;

export function useLiveTrip(inputs: Inputs) {
  const [state, setState] = useState<LiveState>(IDLE);
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;

  const run = useRef({
    mode: 'gps' as TripMode,
    startedAt: 0,
    samples: [] as EmissionSample[],
    distanceM: 0,
    pm25: 0,
    pmZones: 0,
    elapsedS: 0,
    trail: [] as Pt[],
    zonesHit: new Set<string>(),
    announced: new Map<string, { stage: string; at: number }>(),
    zoneMaxKmh: new Map<string, { max: number; advised: number }>(),
    columns: [] as EmissionColumn[],
    colMg: 0,
    colM: 0,
    colHigh: false,
    highStreak: 0,
    lastCoachAt: 0,
    coachTip: null as string | null,
    // gps
    fix: null as (Pt & { speedMs: number | null; heading: number | null; ts: number }) | null,
    lastPos: null as Pt | null,
    lastSpeedKmh: 0,
    heading: 0,
    motionPeakG: 0,
    gravity: null as { x: number; y: number; z: number } | null,
    // simulação
    route: [] as Pt[],
    cum: [] as number[],
    aggression: 30,
    warp: 1,
    simSpeedKmh: 0,
  });
  const cleanup = useRef<(() => void)[]>([]);

  const stopListeners = useCallback(() => {
    cleanup.current.forEach((fn) => fn());
    cleanup.current = [];
  }, []);

  useEffect(() => stopListeners, [stopListeners]);

  const tick = useCallback(() => {
    const r = run.current;
    const { grossKg, zones, soundOn } = inputsRef.current;
    let pos: LivePos | null = null;
    let speedKmh = 0;
    let accelG = 0;
    let intervalS = 1;
    let arrived = false;

    if (r.mode === 'sim') {
      intervalS = r.warp;
      const total = r.cum[r.cum.length - 1] ?? 0;
      const here = pointAlong(r.route, r.cum, r.distanceM);
      const ahead = evaluateRisk(here, r.simSpeedKmh, zones);
      const cruise = 38 + r.aggression * 0.35;
      let target = cruise * (0.8 + 0.25 * Math.sin(r.distanceM / 350));
      // condutor preventivo respeita a velocidade recomendada; o agressivo ignora
      if (ahead.length && r.aggression < 60) target = Math.min(target, ahead[0].advisedKmh);
      if (total - r.distanceM < 120) target = Math.min(target, 15);
      const maxStep = (2 + r.aggression * 0.12) * intervalS; // km/h por tick
      const prev = r.simSpeedKmh;
      r.simSpeedKmh = Math.max(0, prev + Math.max(-maxStep, Math.min(maxStep, target - prev)));
      speedKmh = r.simSpeedKmh;
      const spike = Math.random() < (r.aggression / 100) * 0.4 ? 0.2 + Math.random() * 0.45 : 0;
      accelG = Math.abs(speedKmh - prev) / 3.6 / intervalS / G + spike;
      r.distanceM = Math.min(total, r.distanceM + (speedKmh / 3.6) * intervalS);
      pos = pointAlong(r.route, r.cum, r.distanceM);
      arrived = r.distanceM >= total - 1;
    } else {
      const fix = r.fix;
      if (fix) {
        const p = { lat: fix.lat, lng: fix.lng };
        let stepM = 0;
        if (r.lastPos) {
          const d = haversine(r.lastPos, p);
          if (d > 1 && d < 500) {
            stepM = d;
            r.heading = fix.heading ?? bearing(r.lastPos, p);
            r.lastPos = p;
          }
        } else {
          r.lastPos = p;
        }
        r.distanceM += stepM;
        speedKmh = fix.speedMs != null && fix.speedMs >= 0 ? fix.speedMs * 3.6 : stepM * 3.6;
        if (Date.now() - fix.ts > 6000) speedKmh = 0; // sinal de GPS parado
        pos = { ...p, heading: r.heading };
      }
      // aceleração: maior entre o pico do acelerômetro e a variação da velocidade do GPS
      const gpsAccelG = Math.abs(speedKmh - r.lastSpeedKmh) / 3.6 / G;
      accelG = Math.min(1.5, Math.max(r.motionPeakG, gpsAccelG));
      r.motionPeakG = 0;
      r.lastSpeedKmh = speedKmh;
    }

    r.elapsedS += intervalS;
    const alerts = pos ? evaluateRisk(pos, speedKmh, zones) : [];
    const inside = alerts.filter((a) => a.stage === 'inside');
    const sample = sampleEmission({ grossKg, speedKmh, accelG, intervalS, roughPavement: inside.some((a) => isRoughSurface(a.zone.type)) });
    r.samples.push(sample);
    r.pm25 += sample.emittedMg;
    if (inside.some((a) => isSensitive(a.zone.type))) r.pmZones += sample.emittedMg;
    for (const a of inside) {
      r.zonesHit.add(a.zone.id);
      if (isSensitive(a.zone.type)) {
        const z = r.zoneMaxKmh.get(a.zone.id) ?? { max: 0, advised: RISK_META[a.zone.type].advisedKmh };
        z.max = Math.max(z.max, speedKmh);
        r.zoneMaxKmh.set(a.zone.id, z);
      }
    }

    // colunas 3D: uma a cada ~45 m, com a emissão por km daquele trecho
    r.colMg += sample.emittedMg;
    r.colM += sample.distKm * 1000;
    r.colHigh ||= sample.level === 'high';
    if (pos && r.colM >= 45) {
      const perKm = r.colMg / (r.colM / 1000);
      r.columns = [...r.columns, { lat: pos.lat, lng: pos.lng, mgPerKm: perKm, level: r.colHigh ? 'high' : sample.level }].slice(-500);
      r.colMg = 0;
      r.colM = 0;
      r.colHigh = false;
    }

    // treinador de condução: fala quando a emissão fica alta por alguns segundos
    r.highStreak = sample.level === 'high' && speedKmh > 8 ? r.highStreak + 1 : 0;
    if (r.highStreak >= 2 && Date.now() - r.lastCoachAt > 25000) {
      r.lastCoachAt = Date.now();
      r.coachTip = accelG > 0.3 ? 'Acelerações e freadas fortes: antecipe o trânsito e use o pedal com suavidade.' : 'Velocidade alta aumenta o desgaste: reduza um pouco e mantenha constante.';
      if (soundOn && alerts.length === 0) speak(r.coachTip);
    } else if (r.coachTip && Date.now() - r.lastCoachAt > 7000) {
      r.coachTip = null;
    }

    // avisos: uma vez ao se aproximar e outra ao entrar em cada zona
    const now = Date.now();
    for (const a of alerts) {
      const prev = r.announced.get(a.zone.id);
      if (!prev || (prev.stage === 'approaching' && a.stage === 'inside')) {
        r.announced.set(a.zone.id, { stage: a.stage, at: now });
        if (speedKmh > 3 || a.stage === 'inside') announce(a, soundOn);
        break; // um aviso por vez
      } else {
        prev.at = now;
      }
    }
    for (const [id, v] of r.announced) if (now - v.at > 180000) r.announced.delete(id);

    if (pos) {
      const last = r.trail[r.trail.length - 1];
      if (!last || haversine(last, pos) > 4) r.trail = [...r.trail, { lat: pos.lat, lng: pos.lng }].slice(-600);
    }

    setState((s) => ({
      ...s,
      pos: pos ?? s.pos,
      speedKmh,
      accelG,
      level: sample.level,
      distanceKm: r.distanceM / 1000,
      pm25Mg: r.pm25,
      pm25InZonesMg: r.pmZones,
      elapsedS: r.elapsedS,
      trail: r.trail,
      alerts,
      columns: r.columns,
      coachTip: r.coachTip,
      arrived,
    }));
  }, []);

  const start = useCallback(
    async (mode: TripMode, opts: StartOptions = {}) => {
      stopListeners();
      unlockAudio();
      const r = run.current;
      Object.assign(r, {
        mode, startedAt: Date.now(), samples: [], distanceM: 0, pm25: 0, pmZones: 0, elapsedS: 0, trail: [],
        zonesHit: new Set<string>(), announced: new Map(), zoneMaxKmh: new Map(), columns: [], colMg: 0, colM: 0, colHigh: false,
        highStreak: 0, lastCoachAt: 0, coachTip: null, fix: null, lastPos: null, lastSpeedKmh: 0, heading: 0,
        motionPeakG: 0, gravity: null, route: opts.route ?? [], cum: cumulativeM(opts.route ?? []),
        aggression: opts.aggressionPct ?? 30, warp: opts.timeWarp ?? 1, simSpeedKmh: 0,
      });
      setState({ ...IDLE, active: true, mode });

      if (mode === 'gps') {
        if (!('geolocation' in navigator)) {
          setState((s) => ({ ...s, geoError: 'Este dispositivo não tem geolocalização.' }));
        } else {
          const id = navigator.geolocation.watchPosition(
            (p) => {
              r.fix = { lat: p.coords.latitude, lng: p.coords.longitude, speedMs: p.coords.speed, heading: p.coords.heading, ts: Date.now() };
              setState((s) => (s.geoError ? { ...s, geoError: null } : s));
            },
            (err) =>
              setState((s) => ({
                ...s,
                geoError: err.code === err.PERMISSION_DENIED ? 'Permita o acesso à localização para medir a viagem.' : 'Sem sinal de GPS no momento.',
              })),
            { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
          );
          cleanup.current.push(() => navigator.geolocation.clearWatch(id));
        }

        // acelerômetro (iOS exige pedir permissão a partir de um toque)
        const DME = window.DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
        let allowed = !!DME;
        if (DME && typeof DME.requestPermission === 'function') {
          try {
            allowed = (await DME.requestPermission()) === 'granted';
          } catch {
            allowed = false;
          }
        }
        if (allowed) {
          const onMotion = (e: DeviceMotionEvent) => {
            let x: number, y: number, z: number;
            const lin = e.acceleration;
            if (lin && lin.x != null && lin.y != null && lin.z != null) {
              ({ x, y, z } = lin as { x: number; y: number; z: number });
            } else {
              const a = e.accelerationIncludingGravity;
              if (!a || a.x == null || a.y == null || a.z == null) return;
              // estima a gravidade com um filtro passa-baixa e subtrai (funciona com o celular em qualquer posição)
              const g0 = r.gravity ?? { x: a.x, y: a.y, z: a.z };
              r.gravity = { x: g0.x + 0.05 * (a.x - g0.x), y: g0.y + 0.05 * (a.y - g0.y), z: g0.z + 0.05 * (a.z - g0.z) };
              x = a.x - r.gravity.x;
              y = a.y - r.gravity.y;
              z = a.z - r.gravity.z;
            }
            const g = Math.hypot(x, y, z) / G;
            if (g > r.motionPeakG) r.motionPeakG = Math.min(1.5, g);
          };
          window.addEventListener('devicemotion', onMotion);
          cleanup.current.push(() => window.removeEventListener('devicemotion', onMotion));
        }

        // mantém a tela ligada durante a viagem
        try {
          const lock = await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen');
          if (lock) cleanup.current.push(() => void lock.release().catch(() => undefined));
        } catch {
          /* sem wake lock */
        }
      }

      const timer = window.setInterval(tick, 1000);
      cleanup.current.push(() => window.clearInterval(timer));
    },
    [stopListeners, tick],
  );

  const stop = useCallback((): TripSummary => {
    stopListeners();
    const r = run.current;
    const durationS = r.mode === 'sim' ? Math.max(1, r.elapsedS) : Math.max(1, Math.round((Date.now() - r.startedAt) / 1000));
    const agg = aggregateTrip(r.samples, durationS, r.distanceM / 1000, r.pmZones);
    setState((s) => ({ ...s, active: false, alerts: [], coachTip: null, arrived: false }));
    const zonesRespected = [...r.zoneMaxKmh.values()].filter((z) => z.max <= z.advised + 5).length;
    return { ...agg, zonesHit: r.zonesHit.size, zonesRespected, startedAt: r.startedAt, mode: r.mode };
  }, [stopListeners]);

  return { state, start, stop };
}
