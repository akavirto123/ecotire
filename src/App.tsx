import { BellRing, CarFront, ChevronDown, ChevronUp, CircleHelp, Flame, LayoutDashboard, Loader2, LogOut, Navigation, Palette, Volume2, VolumeX } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
// painel e garagem (com o 3D do carro) só baixam quando abertos: a primeira tela fica bem mais leve
const DashboardPanel = lazy(() => import('@/components/DataPanels').then((m) => ({ default: m.DashboardPanel })));
const GaragePanel = lazy(() => import('@/components/DataPanels').then((m) => ({ default: m.GaragePanel })));
import { AuthScreen } from '@/components/AuthScreen';
import { Map3D, type MapRoute } from '@/components/Map3D';
import { AlertBanner, DriveHud, PlannerPanel, ReportZoneForm, SummaryCard } from '@/components/TripPanels';
import { Tour, type TourStep } from '@/components/ui';
import { useAuth, type AppUser } from '@/hooks/useAuth';
import { useLiveTrip, type TripSummary } from '@/hooks/useLiveTrip';
import { useRiskZones } from '@/hooks/useRiskZones';
import { preloadVoice, setVoiceChoice, setVoiceEnabled, speak, unlockAudio, type VoiceChoice } from '@/lib/alerts';
import { simulateHeat } from '@/lib/heatsim';
import { requestMotionPermission, motionSupported, startBumpSensor } from '@/lib/bumps';
import { setSfxMuted, sfx } from '@/lib/sfx';
import { trainDriverModel } from '@/lib/ai';
import * as db from '@/lib/db';
import { simulateTrip, type TripAggregate } from '@/lib/emissions';
import { haversine, type Pt } from '@/lib/geo';
import { DEFAULT_TIRE, driverLevel, tireStats, type TireSettings } from '@/lib/insights';
import { DEFAULT_MAINTENANCE, maintenanceStatus, type Maintenance } from '@/lib/maintenance';
import { THEMES, setTheme, useTheme } from '@/lib/theme';
import type { BoundingBox } from '@/lib/overpass';
import { DEFAULT_RADIUS_M, RISK_META, type RiskType, type RiskZone } from '@/lib/risk';
import { getRoutes, rankRoutes, reverseGeocode, type RouteResult } from '@/lib/routing';
import type { NewTrip, Trip } from '@/lib/supabase';
import { VEHICLE_CATEGORIES, defaultTripConfig, grossWeightKg, type TripConfig, type Vehicle } from '@/lib/vehicles';

type Tab = 'trip' | 'dash' | 'garage';

const TOUR: TourStep[] = [
  { title: 'Bem-vindo ao EcoTire', text: 'Waze e Google Maps escolhem a rota mais rápida. O EcoTire mostra quanto material particulado o pneu solta em cada rota e ajuda você a dirigir de um jeito que gasta menos pneu e polui menos.' },
  { title: 'Planeje pela rota de menor impacto', text: 'Na aba Viagem, informe partida e destino. O app compara as rotas pelo PM2.5 estimado e pelo que é emitido ao lado de escolas e hospitais. Toque numa rota para escolher.' },
  { title: 'Dirija com alertas e treinador', text: 'Use "Iniciar viagem com GPS" no celular ou "Simular percurso" no computador. O app avisa por voz antes de cada zona de risco e dá dicas quando a emissão sobe.' },
  { title: 'Veja o replay 3D', text: 'Ao terminar, colunas 3D aparecem no mapa: quanto mais alta e vermelha, mais você emitiu naquele trecho. Assim dá para ver onde melhorar.' },
  { title: 'Acompanhe pneu, economia e conquistas', text: 'No Painel você vê a vida útil do pneu, quanto já economizou em reais dirigindo suave, seu nível e as conquistas. Na Garagem, escolha ou cadastre o seu veículo em 3D.' },
];
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function useIsDesktop() {
  const [v, setV] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const h = (e: MediaQueryListEvent) => setV(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return v;
}

function useStored<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`ecotire:${key}`);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`ecotire:${key}`, JSON.stringify(value));
    } catch {
      /* ignora */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="grid h-full place-items-center"><Loader2 className="h-8 w-8 animate-spin text-eco" aria-label="Carregando" /></div>;
  }
  return user ? <Shell user={user} /> : <AuthScreen />;
}

function Shell({ user }: { user: AppUser }) {
  const { signOut, setUsage } = useAuth();
  const isDesktop = useIsDesktop();
  const [tab, setTab] = useState<Tab>('trip');
  // modo leve: liga sozinho em aparelhos mais fracos (poucos núcleos/memória ou celular)
  const weakDevice = useMemo(() => {
    const nav = navigator as Navigator & { deviceMemory?: number };
    return (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4 || window.matchMedia('(pointer: coarse)').matches;
  }, []);
  const [lite, setLite] = useStored('lite-mode', weakDevice);

  // som: voz + bipes, só bipes, ou mudo
  const [soundMode, setSoundMode] = useStored<'voice' | 'chime' | 'off'>('sound-mode', 'voice');
  const soundOn = soundMode !== 'off';
  useEffect(() => {
    setSfxMuted(!soundOn);
    setVoiceEnabled(soundMode === 'voice');
  }, [soundMode, soundOn]);
  const [voice, setVoice] = useStored<VoiceChoice>('voice-choice', 'dora');
  useEffect(() => setVoiceChoice(voice), [voice]);
  const say = speak; // a própria fala respeita o modo de som (voz, só bipe ou mudo)
  const nextSound = () => {
    unlockAudio();
    const next = soundMode === 'voice' ? 'chime' : soundMode === 'chime' ? 'off' : 'voice';
    setSoundMode(next);
    setToast(next === 'voice' ? 'Avisos com voz' : next === 'chime' ? 'Só bipes, sem voz' : 'Sons desligados');
  };
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3800);
    return () => window.clearTimeout(t);
  }, [toast]);
  const [vehicleId, setVehicleId] = useStored('vehicle', VEHICLE_CATEGORIES[0].id);
  const [aggression, setAggression] = useStored('aggression', 30);
  const [tire, setTire] = useStored<TireSettings>('tire', DEFAULT_TIRE);
  const [maintenance, setMaintenance] = useStored<Maintenance>(`care:${user.id}`, DEFAULT_MAINTENANCE);
  const [passenger, setPassenger] = useState(false);
  const [heatOn, setHeatOn] = useStored('heat', false);
  const [heat, setHeat] = useState<db.HeatCell[]>([]);
  // exemplo de comunidade (simulado) para testar e apresentar o mapa de calor
  const [heatSim, setHeatSim] = useStored('heat-sim', false);
  const [collapsed, setCollapsed] = useState(false);
  const theme = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tourSeen, setTourSeen] = useStored('tour-seen', false);
  const [tourOpen, setTourOpen] = useState(!tourSeen);

  // ----- dados do usuário -----
  const [customVehicles, setCustomVehicles] = useState<Vehicle[]>([]);
  const [community, setCommunity] = useState<RiskZone[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripsLoading, setTripsLoading] = useState(true);
  const [tripsError, setTripsError] = useState<string | null>(null);

  const loadTrips = useCallback(async () => {
    try {
      setTrips(await db.listTrips(user.id));
      setTripsError(null);
    } catch (e) {
      setTripsError((e as Error).message);
    } finally {
      setTripsLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    void loadTrips();
    db.listVehicles(user.id).then(setCustomVehicles).catch(() => undefined);
    db.listRiskZones().then(setCommunity).catch(() => undefined);
  }, [user.id, loadTrips]);

  const model = useMemo(() => trainDriverModel(trips), [trips]);
  // comemora quando o motorista sobe de nível
  const level = useMemo(() => driverLevel(trips), [trips]);
  const lastLevel = useRef<number | null>(null);
  useEffect(() => {
    if (tripsLoading) return;
    if (lastLevel.current != null && level.level > lastLevel.current) {
      sfx('level');
      setToast(`Você subiu para o nível ${level.level}: ${level.title}`);
    }
    lastLevel.current = level.level;
  }, [level, tripsLoading]);
  const careDue = useMemo(() => {
    const st = maintenanceStatus(maintenance, tireStats(trips).drivenKm);
    if (st.calibrationDue && st.daysSinceCalibration != null) return `Faz ${st.daysSinceCalibration} dias que você calibrou os pneus. Pneu murcho gasta mais.`;
    if (st.rotationDue) return 'Hora do rodízio dos pneus: veja em Painel > Calibragem e rodízio.';
    return null;
  }, [maintenance, trips]);
  const vehicles = useMemo(() => [...VEHICLE_CATEGORIES, ...customVehicles], [customVehicles]);
  const vehicle = vehicles.find((v) => v.id === vehicleId) ?? vehicles[0];

  // ----- planejamento -----
  const [config, setConfig] = useState<TripConfig>(defaultTripConfig);
  const grossKg = grossWeightKg(vehicle, config);
  const [routes, setRoutes] = useState<RouteResult[]>([]);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeFailed, setRouteFailed] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [bounds, setBounds] = useState<BoundingBox | null>(null);

  const { origin, destination } = config;
  useEffect(() => {
    setPicked(null);
    setRouteFailed(false);
    if (!origin || !destination) {
      setRoutes([]);
      return;
    }
    const ctrl = new AbortController();
    setRouteLoading(true);
    getRoutes(origin, destination, ctrl.signal).then((r) => {
      if (ctrl.signal.aborted) return;
      setRoutes(r);
      setRouteFailed(r.length === 0);
      setRouteLoading(false);
    });
    return () => ctrl.abort();
  }, [origin, destination]);

  // uma única linha passando por todas as rotas alternativas (ida, volta, ida), para buscar zonas em todas
  const zoneSearchLine = useMemo(() => {
    if (!routes.length) return undefined;
    return routes.flatMap((r, i) => (i % 2 ? [...r.coordinates].reverse() : r.coordinates));
  }, [routes]);

  // ----- viagem ao vivo -----
  const zonesRef = useRef<RiskZone[]>([]);
  const live = useLiveTrip({ grossKg, zones: zonesRef.current, soundOn });
  const livePos = live.state.active ? live.state.pos : null;
  const { zones, chargers, routeChargers, loading: zonesLoading, error: zonesError } = useRiskZones(community, zoneSearchLine, livePos, live.state.active ? null : bounds);
  zonesRef.current = zones;

  const ranking = useMemo(() => (routes.length ? rankRoutes(routes, grossKg, zones, aggression) : null), [routes, grossKg, zones, aggression]);
  const selected = picked ?? ranking?.cleanest ?? 0;
  const selectedRoute = routes[selected];

  const columnsRef = useRef(live.state.columns);
  columnsRef.current = live.state.columns;
  const [summary, setSummary] = useState<TripSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [street, setStreet] = useState<string | null>(null);
  const lastStreetAt = useRef<Pt | null>(null);
  const lastStreetTime = useRef(0);

  const toRow = (agg: TripAggregate, mode: Trip['mode'], zonesHit: number, startedAt: number, zonesRespected = 0): NewTrip => ({
    mode,
    vehicle_model: vehicle.name,
    gross_weight_kg: Math.round(grossKg),
    distance_km: round(agg.distanceKm),
    duration_s: Math.round(agg.durationS),
    avg_speed_kmh: round(agg.avgSpeedKmh, 1),
    max_speed_kmh: round(agg.maxSpeedKmh, 1),
    peak_accel_g: round(agg.peakAccelG),
    pm25_emitted_mg: round(agg.pm25EmittedMg),
    pm25_avoided_mg: round(agg.pm25AvoidedMg),
    pm10_emitted_mg: round(agg.pm10EmittedMg),
    pm10_avoided_mg: round(agg.pm10AvoidedMg),
    pm25_in_zones_mg: round(agg.pm25InZonesMg),
    smooth_score: agg.smoothScore,
    sensitive_zones_hit: zonesHit,
    zones_respected: zonesRespected,
    origin_name: origin?.name ?? null,
    origin_lat: origin?.lat ?? null,
    origin_lng: origin?.lng ?? null,
    destination_name: destination?.name ?? null,
    destination_lat: destination?.lat ?? null,
    destination_lng: destination?.lng ?? null,
    passengers: config.passengers,
    trunk_fill_pct: config.trunkFillPct,
    started_at: new Date(startedAt).toISOString(),
  });

  const save = async (row: NewTrip) => {
    setSaving(true);
    setSaveError(null);
    try {
      await db.insertTrip(user.id, row);
      await loadTrips();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const startGps = () => {
    sfx('start');
    preloadVoice();
    say('Viagem iniciada. Boa viagem.');
    setSummary(null);
    setStreet(null);
    void live.start('gps');
  };
  const startSim = () => {
    if (!selectedRoute) return;
    sfx('start');
    say('Viagem iniciada. Boa viagem.');
    setSummary(null);
    setStreet(null);
    // acelera o tempo para a simulação durar cerca de um minuto e meio
    const timeWarp = Math.max(2, Math.min(12, Math.round((selectedRoute.durationMin * 60) / 90)));
    void live.start('sim', { route: selectedRoute.coordinates, aggressionPct: aggression, timeWarp });
  };
  const finish = useCallback(() => {
    const columns = columnsRef.current;
    const s = live.stop();
    sfx('stop');
    say('Você chegou. Viagem salva.');
    setSummary(s);
    const mode: Trip['mode'] = s.mode === 'gps' && passenger ? 'passenger' : s.mode;
    void save(toRow(s, mode, s.zonesHit, s.startedAt, s.zonesRespected));
    if (s.mode === 'gps') {
      void db.clearLiveStatus(user.id).catch(() => undefined);
      // contribui (sem identificação) para o mapa de calor: PM2.5 de cada trecho de ~45 m
      const cells = columns.map((c) => ({ lat: Math.round(c.lat * 1000) / 1000, lng: Math.round(c.lng * 1000) / 1000, mg: Math.round(c.mgPerKm * 0.045 * 1000) / 1000 }));
      void db.addHeat(cells).catch(() => undefined);
    }
  }, [live.stop, vehicle, grossKg, config, passenger, user.id]);

  useEffect(() => {
    if (live.state.arrived && live.state.active) finish();
  }, [live.state.arrived, live.state.active, finish]);

  const savePlan = () => {
    const score = ranking?.scores[selected];
    if (!score) return;
    const agg = simulateTrip(grossKg, score.route.distanceKm, score.avgSpeedKmh, aggression, score.roughKm);
    void save(toRow({ ...agg, pm25InZonesMg: score.exposureMg }, 'plan', score.sensitiveHits, Date.now())).then(() => setTab('dash'));
  };

  // posição ao vivo para o gestor da frota (a cada 10 s, só em viagem com GPS e com o banco ligado)
  const liveRef = useRef(live.state);
  liveRef.current = live.state;
  const gpsActive = live.state.active && live.state.mode === 'gps' && !user.demo;
  useEffect(() => {
    if (!gpsActive) return;
    const push = () => {
      const st = liveRef.current;
      if (st.pos) void db.pushLiveStatus(user.id, { lat: st.pos.lat, lng: st.pos.lng, speedKmh: st.speedKmh, level: st.level }).catch(() => undefined);
    };
    const t = window.setInterval(push, 10000);
    return () => window.clearInterval(t);
  }, [gpsActive, user.id]);

  // mapa de calor da comunidade na área visível
  useEffect(() => {
    if (!heatOn || !bounds) return;
    let alive = true;
    db.listHeat(bounds).then((c) => alive && setHeat(c)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [heatOn, bounds, summary]);

  // nome da rua durante a viagem
  useEffect(() => {
    if (!livePos) return;
    // no máximo uma consulta a cada 4 s (o serviço público de endereços limita a 1 por segundo)
    if (Date.now() - lastStreetTime.current < 4000) return;
    if (lastStreetAt.current && haversine(lastStreetAt.current, livePos) < 150) return;
    lastStreetTime.current = Date.now();
    lastStreetAt.current = { lat: livePos.lat, lng: livePos.lng };
    void reverseGeocode(livePos).then((s) => s && setStreet(s));
  }, [livePos]);

  // ----- aviso de 1 toque durante a viagem (estilo Waze, sem tirar os olhos da via por muito tempo) -----
  const quickReport = async (type: RiskType) => {
    const p = live.state.pos;
    if (!p) return;
    try {
      const saved = await db.insertRiskZone(user.id, { name: `${RISK_META[type].label} (reportado)`, type, lat: p.lat, lng: p.lng, radiusM: DEFAULT_RADIUS_M[type] });
      setCommunity((c) => [...c, saved]);
      sfx('report');
      setToast('Aviso enviado. Outros motoristas vão ver e confirmar.');
    } catch (e) {
      setToast(`Não foi possível enviar: ${(e as Error).message}`);
    }
  };
  const voted = useRef(new Set<string>());
  const [, bumpVotes] = useState(0);
  const votePrompt = live.state.active
    ? live.state.alerts.find((a) => a.zone.source === 'community' && a.zone.userId !== user.id && !voted.current.has(a.zone.id) && (a.zone.type === 'pavement' || a.zone.type === 'works' || a.zone.type === 'other'))?.zone ?? null
    : null;
  const vote = (zoneId: string, stillThere: boolean) => {
    voted.current.add(zoneId);
    bumpVotes((n) => n + 1);
    void db.voteZone(zoneId, stillThere).catch(() => undefined);
    setToast(stillThere ? 'Obrigado: aviso confirmado.' : 'Obrigado: se outros também negarem, o aviso some.');
  };

  // ----- detecção automática de buracos (acelerômetro; no carro: suspensão e câmeras) -----
  const [bumpOn, setBumpOn] = useState(false);
  const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  const [bumpCount, setBumpCount] = useState(0);
  const communityRef = useRef(community);
  communityRef.current = community;
  const handleBump = useCallback(
    async (strengthG: number, demo: boolean) => {
      const p = liveRef.current.pos;
      if (!p) return;
      setBumpCount((n) => n + 1);
      try {
        navigator.vibrate?.([60, 40, 60]);
      } catch {
        /* sem vibração */
      }
      const near = communityRef.current
        .filter((z) => z.type === 'pavement' && haversine(z, p) < 45)
        .sort((a, b) => haversine(a, p) - haversine(b, p))[0];
      if (near && near.userId === user.id) {
        setToast('Solavanco no mesmo buraco que você já avisou.');
        return;
      }
      if (near) {
        if (!voted.current.has(near.id)) {
          voted.current.add(near.id);
          void db.voteZone(near.id, true).catch(() => undefined);
        }
        sfx('report');
        say('Buraco confirmado para a comunidade.');
        setToast('Solavanco detectado: buraco confirmado automaticamente para a comunidade.');
        return;
      }
      try {
        const g = strengthG.toFixed(1).replace('.', ',');
        const saved = await db.insertRiskZone(user.id, {
          name: demo ? 'Buraco (sensor, demonstração)' : `Buraco (sensor, ${g} g)`,
          type: 'pavement',
          lat: p.lat,
          lng: p.lng,
          radiusM: DEFAULT_RADIUS_M.pavement,
        });
        setCommunity((c) => [...c, saved]);
        sfx('report');
        say('Buraco detectado. Aviso enviado para a comunidade.');
        setToast(`Solavanco de ${g} g detectado: aviso de buraco criado sozinho.`);
      } catch (e) {
        setToast(`Não foi possível enviar: ${(e as Error).message}`);
      }
    },
    [user.id],
  );
  useEffect(() => {
    if (!live.state.active || !bumpOn) return;
    return startBumpSensor(() => liveRef.current.speedKmh, (b) => void handleBump(b.strengthG, false));
  }, [live.state.active, bumpOn, handleBump]);
  useEffect(() => {
    if (!live.state.active) setBumpCount(0);
  }, [live.state.active]);
  const toggleBump = async () => {
    if (bumpOn) return setBumpOn(false);
    if (await requestMotionPermission()) setBumpOn(true);
    else setToast('O navegador não liberou o sensor de movimento.');
  };

  // ----- reportar zona -----
  const [report, setReport] = useState<{ point: Pt | null } | null>(null);
  const saveZone = async (z: { name: string; type: RiskType; radiusM: number; note: string }) => {
    if (!report?.point) return 'Escolha um ponto no mapa.';
    try {
      const saved = await db.insertRiskZone(user.id, { ...z, ...report.point });
      setCommunity((c) => [...c, saved]);
      setReport(null);
      setCollapsed(false);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  // ----- mapa -----
  const mapRoutes: MapRoute[] = useMemo(
    () => (live.state.active && live.state.mode === 'gps' && !selectedRoute ? [] : routes.map((r, i) => ({ coords: r.coordinates, selected: i === selected, cleanest: i === ranking?.cleanest }))),
    [routes, selected, ranking?.cleanest, live.state.active, live.state.mode, selectedRoute],
  );
  const padding = useMemo(
    () => (isDesktop ? { top: 100, bottom: 50, left: 450, right: 70 } : { top: 90, bottom: Math.round(window.innerHeight * (collapsed ? 0.14 : 0.56)), left: 30, right: 30 }),
    [isDesktop, collapsed],
  );
  const activeZoneIds = useMemo(() => live.state.alerts.map((a) => a.zone.id), [live.state.alerts]);
  const reportPreview = useMemo<RiskZone[]>(
    () => (report?.point ? [{ id: 'novo', name: 'Nova zona', type: 'other', ...report.point, radiusM: 120, source: 'community' }] : []),
    [report],
  );
  const mapZones = useMemo(() => [...zones, ...reportPreview], [zones, reportPreview]);
  const topAlert = live.state.active ? live.state.alerts[0] : undefined;

  // ao trocar o conteúdo do painel (planejar, dirigir, resumo, reportar), volta para o topo
  const panelRef = useRef<HTMLElement>(null);
  const view = report ? 'report' : live.state.active ? 'drive' : summary ? 'summary' : 'plan';
  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [view, tab]);

  const tabs: { id: Tab; label: string; icon: typeof Navigation }[] = [
    { id: 'trip', label: 'Viagem', icon: Navigation },
    { id: 'dash', label: 'Painel', icon: LayoutDashboard },
    { id: 'garage', label: 'Garagem', icon: CarFront },
  ];

  return (
    <div className="relative h-full overflow-hidden">
      {tourOpen && <Tour steps={TOUR} onClose={() => { setTourOpen(false); setTourSeen(true); }} />}
      <Map3D
        lite={lite}
        origin={origin}
        destination={destination}
        routes={mapRoutes}
        zones={mapZones}
        activeZoneIds={activeZoneIds}
        live={livePos}
        trail={live.state.active ? live.state.trail : []}
        columns={live.state.active || summary ? live.state.columns : []}
        heat={heatOn ? (heatSim && bounds ? [...heat, ...simulateHeat(bounds, zones, selectedRoute?.coordinates)] : heat) : null}
        chargers={chargers}
        liveIntensity={live.state.level === 'high' ? 1 : live.state.level === 'moderate' ? 0.5 : Math.min(0.25, live.state.speedKmh / 240)}
        liveLevel={live.state.level}
        routeHaze={selectedRoute && ranking ? { coords: selectedRoute.coordinates, mgPerKm: ranking.scores[selected].pm25Mg / Math.max(0.1, selectedRoute.distanceKm) } : null}
        follow={live.state.active}
        picking={!!report && !report.point}
        padding={padding}
        theme={theme}
        onPick={(p) => { setReport({ point: p }); setCollapsed(false); }}
        onBounds={setBounds}
        onSelectRoute={setPicked}
      />

      <header className="glass enter-top absolute inset-x-2 top-2 z-30 flex items-center gap-2 rounded-2xl px-3 py-2 lg:inset-x-4 lg:top-4 lg:px-4">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" className="h-8 w-8" />
        <span className="hidden font-display text-base font-extrabold sm:block">ECO<span className="text-eco">TIRE</span></span>
        <nav className="mx-auto flex gap-1 sm:ml-6 sm:mr-auto" aria-label="Seções">
          {tabs.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-label={t.label} title={t.label} aria-current={tab === t.id ? 'page' : undefined}
              className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition ${tab === t.id ? 'bg-eco/15 text-eco' : 'text-mist hover:bg-white/5 hover:text-white'}`}>
              <t.icon className="h-4 w-4" /> <span className={tab === t.id ? '' : 'hidden sm:inline'}>{t.label}</span>
            </button>
          ))}
        </nav>
        <span className="hidden max-w-[180px] truncate rounded-xl border border-line px-3 py-1.5 text-xs text-mist md:block" title="Veículo selecionado">{vehicle.name}</span>
        <button type="button" onClick={nextSound} className="rounded-xl p-2 text-mist hover:bg-white/10 hover:text-white" aria-label="Trocar modo de som: voz, só bipes ou mudo" title={soundMode === 'voice' ? 'Avisos com voz (clique: só bipes)' : soundMode === 'chime' ? 'Só bipes (clique: mudo)' : 'Mudo (clique: voz)'}>
          {soundMode === 'voice' ? <Volume2 className="h-5 w-5 text-eco" /> : soundMode === 'chime' ? <BellRing className="h-5 w-5 text-eco" /> : <VolumeX className="h-5 w-5" />}
        </button>
        <div className="relative">
          <button type="button" onClick={() => setPaletteOpen(!paletteOpen)} className="rounded-xl p-2 text-mist hover:bg-white/10 hover:text-white" aria-expanded={paletteOpen} aria-label="Trocar paleta de cores" title="Paleta de cores"><Palette className="h-5 w-5" /></button>
          {paletteOpen && (
            <div className="glass rise absolute right-0 top-12 z-40 w-56 rounded-2xl p-2" role="menu">
              {THEMES.map((t) => (
                <button key={t.id} type="button" role="menuitemradio" aria-checked={theme === t.id} onClick={() => { setTheme(t.id); setPaletteOpen(false); }}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm hover:bg-white/10 ${theme === t.id ? 'text-eco' : 'text-white'}`}>
                  <span className="h-5 w-5 rounded-full border border-white/20" style={{ background: `linear-gradient(135deg, ${t.swatch[0]} 50%, ${t.swatch[1]} 50%)` }} />
                  {t.name}
                </button>
              ))}
              <div className="my-1.5 h-px bg-white/10" />
              <button type="button" role="menuitemcheckbox" aria-checked={lite} onClick={() => setLite(!lite)}
                className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-sm text-white hover:bg-white/10">
                <span>Modo leve<span className="block text-[11px] text-mist">sem prédios 3D, mais rápido</span></span>
                <span className={`relative h-5 w-9 shrink-0 rounded-full transition ${lite ? 'bg-eco' : 'bg-white/15'}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${lite ? 'left-[18px]' : 'left-0.5'}`} />
                </span>
              </button>
              <div className="my-1.5 h-px bg-white/10" />
              <div className="px-2.5 pb-1 pt-0.5 text-[11px] uppercase tracking-wider text-mist">Voz dos avisos</div>
              {([['dora', 'Dora', 'voz de IA feminina'], ['alex', 'Alex', 'voz de IA masculina'], ['device', 'Do aparelho', 'voz do sistema']] as const).map(([id, name, hint]) => (
                <button key={id} type="button" role="menuitemradio" aria-checked={voice === id}
                  onClick={() => { unlockAudio(); setVoice(id); setVoiceChoice(id); setVoiceEnabled(true); speak('Olá! Esta é a voz dos avisos do EcoTire.'); setVoiceEnabled(soundMode === 'voice'); }}
                  className={`flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left text-sm hover:bg-white/10 ${voice === id ? 'text-eco' : 'text-white'}`}>
                  <span>{name}<span className="block text-[11px] text-mist">{hint}</span></span>
                  {voice === id && <Volume2 className="h-4 w-4" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" onClick={() => setTourOpen(true)} className="rounded-xl p-2 text-mist hover:bg-white/10 hover:text-white" aria-label="Abrir o tour" title="Como funciona"><CircleHelp className="h-5 w-5" /></button>
        <span className="hidden text-sm text-white/80 lg:block">{user.name}</span>
        <button type="button" onClick={() => void signOut()} className="rounded-xl p-2 text-mist hover:bg-white/10 hover:text-white" aria-label="Sair" title="Sair"><LogOut className="h-5 w-5" /></button>
      </header>

      {user.demo && tab === 'trip' && !live.state.active && (
        <div className="absolute right-4 top-[4.75rem] z-20 hidden max-w-xs rounded-xl border border-amber/40 bg-panel/90 px-3 py-2 text-xs text-amber lg:block">
          Testando sem conta: os dados ficam só neste navegador. Crie uma conta para salvar viagens e ranking na nuvem.
        </div>
      )}

      {tab === 'trip' && !live.state.active && !isDesktop && (
        <div className="absolute right-3 top-[4.6rem] z-20 flex flex-col items-end gap-1.5">
          <button type="button" onClick={() => setHeatOn(!heatOn)} aria-pressed={heatOn} className={`glass flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${heatOn ? 'border-eco text-eco' : 'border-line text-white'}`}>
            <Flame className="h-3.5 w-3.5" /> Calor
          </button>
          {heatOn && (
            <button type="button" onClick={() => setHeatSim(!heatSim)} aria-pressed={heatSim} className={`glass rounded-full border px-3 py-1.5 text-xs font-medium ${heatSim ? 'border-amber text-amber' : 'border-line text-white'}`}>
              {heatSim ? 'Exemplo ligado' : 'Simular comunidade'}
            </button>
          )}
        </div>
      )}

      {heatOn && heatSim && tab === 'trip' && (
        <div className="pointer-events-none absolute bottom-24 left-1/2 z-10 -translate-x-1/2 rounded-full border border-amber/40 bg-panel/85 px-3 py-1 text-[11px] text-amber lg:bottom-16">
          Mapa de calor de exemplo: simulação de cerca de 500 motoristas, não são dados reais
        </div>
      )}

      {tab === 'trip' && !live.state.active && isDesktop && (
        <ul className="glass enter-top absolute bottom-4 left-[432px] z-10 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl px-3 py-2 text-xs text-mist" aria-label="Legenda das zonas de risco">
          <li>
            <button type="button" onClick={() => setHeatOn(!heatOn)} aria-pressed={heatOn} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium transition ${heatOn ? 'border-eco bg-eco/15 text-eco' : 'border-line text-white hover:bg-white/10'}`}>
              <Flame className="h-3.5 w-3.5" /> Mapa de calor
            </button>
          </li>
          {heatOn && (
            <li>
              <button type="button" onClick={() => setHeatSim(!heatSim)} aria-pressed={heatSim} className={`rounded-full border px-2.5 py-1 font-medium transition ${heatSim ? 'border-amber bg-amber/15 text-amber' : 'border-line text-white hover:bg-white/10'}`}>
                {heatSim ? 'Exemplo ligado (simulação)' : 'Simular comunidade'}
              </button>
            </li>
          )}
          {(Object.keys(RISK_META) as RiskType[]).map((t) => (
            <li key={t} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: RISK_META[t].color }} />{RISK_META[t].label}</li>
          ))}
        </ul>
      )}

      {toast && (
        <div role="status" className="pop-in absolute bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-full border border-line bg-panel/95 px-4 py-2 text-sm shadow-xl lg:bottom-8">{toast}</div>
      )}

      {topAlert && (
        <div className="absolute left-1/2 top-[4.5rem] z-20 w-[min(94vw,540px)] -translate-x-1/2 lg:left-[calc(50%+215px)] lg:top-24">
          <div key={`${topAlert.zone.id}-${topAlert.stage}`} className="drop-in"><AlertBanner alert={topAlert} /></div>
        </div>
      )}

      {tab === 'trip' ? (
        <aside ref={panelRef} className={`glass enter-panel scroll-thin absolute inset-x-0 bottom-0 z-10 overflow-y-auto rounded-t-3xl px-5 pb-6 pt-2 transition-[max-height] duration-300 lg:inset-x-auto lg:bottom-4 lg:left-4 lg:top-[5.5rem] lg:w-[400px] lg:max-h-none lg:rounded-3xl lg:pt-5 ${collapsed ? 'max-h-[6.5rem]' : 'max-h-[58vh]'}`}>
          <button type="button" onClick={() => setCollapsed(!collapsed)} className="mx-auto mb-2 flex items-center gap-1 rounded-full px-3 py-1 text-xs text-mist lg:hidden" aria-expanded={!collapsed}>
            {collapsed ? <><ChevronUp className="h-4 w-4" /> Abrir painel</> : <><ChevronDown className="h-4 w-4" /> Ver o mapa</>}
          </button>
          <div key={view} className="view-in">
          {report ? (
            <ReportZoneForm point={report.point} onCancel={() => { setReport(null); setCollapsed(false); }} onSave={saveZone} />
          ) : live.state.active ? (
            <DriveHud live={live.state} street={street} onStop={finish} saving={saving} onQuickReport={(t) => void quickReport(t)} votePrompt={votePrompt} onVote={vote}
              sensor={{ supported: motionSupported() && isTouch, on: bumpOn, count: bumpCount, onToggle: () => void toggleBump(), onSimulate: () => void handleBump(1.2 + Math.random() * 0.6, true) }} />
          ) : summary ? (
            <SummaryCard summary={summary} saveError={saveError} onClose={() => setSummary(null)} />
          ) : (
            <>
              <h2 className="mb-4 hidden font-display text-xl font-semibold lg:block">Planejar viagem</h2>
              <PlannerPanel
                config={config} onConfig={setConfig}
                vehicles={vehicles} vehicle={vehicle} onVehicle={setVehicleId} grossKg={grossKg}
                ranking={ranking} routeLoading={routeLoading} routeFailed={routeFailed} selected={selected} onSelect={setPicked}
                aggression={aggression} onAggression={setAggression} model={model}
                zonesLoading={zonesLoading} zonesError={zonesError} routeChargers={routeChargers.length}
                passenger={passenger} onPassenger={setPassenger} careDue={careDue}
                saving={saving} onStartGps={startGps} onStartSim={startSim} onSavePlan={savePlan}
                onReport={() => { setCollapsed(true); setReport({ point: null }); }}
              />
              {saveError && <p role="alert" className="mt-3 text-sm text-danger">Não foi possível salvar: {saveError}</p>}
            </>
          )}
          </div>
        </aside>
      ) : (
        <main className="glass scroll-thin bg-ink/60 absolute inset-x-2 bottom-2 top-[4.5rem] z-10 overflow-y-auto rounded-3xl p-5 lg:inset-x-[5%] lg:bottom-4 lg:top-[5.5rem] lg:p-7">
          <div key={tab} className="view-in">
          <Suspense fallback={<div className="flex h-40 items-center justify-center text-mist"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando…</div>}>
          {tab === 'dash' ? (
            <DashboardPanel
              user={user}
              onUsage={(u) => void setUsage(u)}
              maintenance={maintenance} onMaintenance={setMaintenance}
              tire={tire} onTire={setTire}
              trips={trips} loading={tripsLoading} error={tripsError}
              onDelete={(id) => void db.deleteTrip(user.id, id).then(loadTrips).catch((e) => setTripsError((e as Error).message))}
              onReplan={(t) => {
                setConfig((c) => ({
                  ...c,
                  origin: { name: t.origin_name ?? 'Partida', lat: Number(t.origin_lat), lng: Number(t.origin_lng) },
                  destination: { name: t.destination_name ?? 'Destino', lat: Number(t.destination_lat), lng: Number(t.destination_lng) },
                }));
                setSummary(null);
                setTab('trip');
              }}
            />
          ) : (
            <GaragePanel
              vehicles={vehicles} vehicleId={vehicle.id} onSelect={setVehicleId}
              onAdd={async (v) => {
                try {
                  const saved = await db.insertVehicle(user.id, v);
                  setCustomVehicles((list) => [...list, saved]);
                  setVehicleId(saved.id);
                  return null;
                } catch (e) {
                  return (e as Error).message;
                }
              }}
              onDelete={(id) => void db.deleteVehicle(user.id, id).then(() => setCustomVehicles((list) => list.filter((v) => v.id !== id))).catch(() => undefined)}
              myZones={community.filter((z) => z.userId === user.id)}
              onDeleteZone={(id) => void db.deleteRiskZone(id).then(() => setCommunity((c) => c.filter((z) => z.id !== id))).catch(() => undefined)}
            />
          )}
          </Suspense>
          </div>
        </main>
      )}
    </div>
  );
}
