import {
  AlertTriangle, Construction, Crosshair, Flag, Gauge, GraduationCap, HeartPulse, Leaf, Loader2, LocateFixed,
  MapPin, MapPinPlus, Navigation, Play, Route as RouteIcon, Save, Sparkles, Square, Timer, TriangleAlert, Wind, Zap,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Tire3D } from '@/components/Tire3D';
import { AnimatedValue, Tilt } from '@/components/ui';
import { useTheme } from '@/lib/theme';
import type { LiveState, TripSummary } from '@/hooks/useLiveTrip';
import { EMISSION_COLORS, EMISSION_LABELS, simulateTrip, toPm10 } from '@/lib/emissions';
import type { Pt } from '@/lib/geo';
import { DEFAULT_RADIUS_M, RISK_META, type RiskAlert, type RiskType, type RiskZone } from '@/lib/risk';
import { reverseGeocode, searchAddress, type RouteScore, type SearchResult } from '@/lib/routing';
import type { GeoPlace, TripConfig, Vehicle } from '@/lib/vehicles';
import { describeModel, predictPm25, type DriverModel } from '@/lib/ai';
import { PAVEMENT_FACTOR } from '@/lib/emissions';

export function RiskIcon({ type, className }: { type: RiskType; className?: string }) {
  const Icon = type === 'school' ? GraduationCap : type === 'hospital' ? HeartPulse : type === 'works' ? Construction : type === 'pavement' ? TriangleAlert : AlertTriangle;
  return <Icon className={className} style={{ color: RISK_META[type].color }} />;
}

function RiskIconPlain({ type, className }: { type: RiskType; className?: string }) {
  const Icon = type === 'school' ? GraduationCap : type === 'hospital' ? HeartPulse : type === 'works' ? Construction : type === 'pavement' ? TriangleAlert : AlertTriangle;
  return <Icon className={className} />;
}

/** Valores de particulado são estimativas de modelo, nunca medição: sempre com "≈" e precisão modesta. */
export const fmtMg = (mg: number) => (mg >= 1000 ? `≈ ${(mg / 1000).toFixed(1)} g` : mg >= 10 ? `≈ ${Math.round(mg)} mg` : `≈ ${mg.toFixed(1)} mg`);
export const fmtDuration = (s: number) => {
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

// ---------- Campo de endereço com busca ----------

function LocationInput(props: {
  id: string; label: string; placeholder: string; value: GeoPlace | null;
  onChange: (p: GeoPlace | null) => void; allowGps?: boolean;
}) {
  const [query, setQuery] = useState(props.value?.name ?? '');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const picked = useRef(props.value?.name ?? '');

  useEffect(() => {
    setQuery(props.value?.name ?? '');
    picked.current = props.value?.name ?? '';
  }, [props.value]);

  useEffect(() => {
    if (query.trim().length < 4 || query === picked.current) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const data = await searchAddress(query, ctrl.signal);
      if (!ctrl.signal.aborted) {
        setResults(data);
        setOpen(true);
      }
    }, 500);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  const choose = (r: SearchResult) => {
    picked.current = r.name;
    setQuery(r.name);
    setResults([]);
    setOpen(false);
    props.onChange({ name: r.name, lat: r.lat, lng: r.lng });
  };

  const useGps = () => {
    if (!('geolocation' in navigator)) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const street = await reverseGeocode(p);
        props.onChange({ name: street ? `${street} (minha localização)` : 'Minha localização', ...p });
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 12000 },
    );
  };

  return (
    <div className="relative">
      <label className="label" htmlFor={props.id}>{props.label}</label>
      <div className="flex gap-2">
        <input
          id={props.id}
          className="field"
          placeholder={props.placeholder}
          value={query}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            if (props.value && e.target.value !== picked.current) {
              picked.current = '';
              props.onChange(null);
            }
          }}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 180)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results.length > 0) {
              e.preventDefault();
              choose(results[0]);
            }
          }}
        />
        {props.allowGps && (
          <button type="button" onClick={useGps} className="btn btn-ghost px-3" title="Usar minha localização" aria-label="Usar minha localização">
            {locating ? <Loader2 className="h-4 w-4 animate-spin" /> : <LocateFixed className="h-4 w-4" />}
          </button>
        )}
      </div>
      {open && results.length > 0 && (
        <ul className="glass scroll-thin absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-xl">
          {results.map((r) => (
            <li key={r.id}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); choose(r); }} className="w-full border-b border-line/60 px-3 py-2.5 text-left text-sm text-white/85 last:border-0 hover:bg-white/10">
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- Planejamento ----------

export type Ranking = { scores: RouteScore[]; cleanest: number; fastest: number };

export function PlannerPanel(props: {
  config: TripConfig; onConfig: (c: TripConfig) => void;
  vehicles: Vehicle[]; vehicle: Vehicle; onVehicle: (id: string) => void; grossKg: number;
  ranking: Ranking | null; routeLoading: boolean; routeFailed: boolean; selected: number; onSelect: (i: number) => void;
  aggression: number; onAggression: (n: number) => void; model: DriverModel;
  zonesLoading: boolean; zonesError: boolean; routeChargers: number;
  passenger: boolean; onPassenger: (v: boolean) => void; careDue: string | null;
  saving: boolean; onStartGps: () => void; onStartSim: () => void; onSavePlan: () => void; onReport: () => void;
}) {
  const { config, ranking } = props;
  const score = ranking?.scores[props.selected] ?? null;
  const est = score ? simulateTrip(props.grossKg, score.route.distanceKm, score.avgSpeedKmh, props.aggression, score.roughKm) : null;
  const best = ranking && ranking.scores.length > 1 ? ranking.scores[ranking.cleanest] : null;

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <LocationInput id="origin" label="Partida" placeholder="De onde você sai?" value={config.origin} onChange={(origin) => props.onConfig({ ...config, origin })} allowGps />
        <LocationInput id="destination" label="Destino" placeholder="Para onde vamos?" value={config.destination} onChange={(destination) => props.onConfig({ ...config, destination })} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label" htmlFor="vehicle">Veículo</label>
          <select id="vehicle" className="field" value={props.vehicle.id} onChange={(e) => props.onVehicle(e.target.value)}>
            {props.vehicles.map((v) => (
              <option key={v.id} value={v.id}>{v.name} · {v.curbWeightKg} kg{v.custom ? ' (meu)' : ''}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="passengers">Ocupantes</label>
          <select id="passengers" className="field" value={config.passengers} onChange={(e) => props.onConfig({ ...config, passengers: Number(e.target.value) })}>
            {Array.from({ length: props.vehicle.maxPassengers }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n} {n === 1 ? 'pessoa' : 'pessoas'}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="trunk">Porta-malas</label>
          <select id="trunk" className="field" value={config.trunkFillPct} onChange={(e) => props.onConfig({ ...config, trunkFillPct: Number(e.target.value) })}>
            {[0, 25, 50, 75, 100].map((n) => <option key={n} value={n}>{n === 0 ? 'Vazio' : n === 100 ? 'Cheio' : `${n}%`}</option>)}
          </select>
        </div>
        <p className="col-span-2 -mt-1 text-xs text-mist">Massa total estimada: <strong className="text-white">{Math.round(props.grossKg)} kg</strong>. Mais massa, mais desgaste de pneu.</p>
      </div>

      {props.routeLoading && <Notice icon={<Loader2 className="h-4 w-4 animate-spin text-cyan" />}>Calculando rotas…</Notice>}
      {props.routeFailed && !props.routeLoading && <Notice tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>Não foi possível calcular a rota agora. Verifique a conexão e os endereços.</Notice>}

      {ranking && ranking.scores.length > 0 && (
        <section aria-label="Rotas">
          <div className="label">Rotas comparadas por impacto de particulado</div>
          <div className="space-y-2">
            {ranking.scores.map((s, i) => {
              const active = i === props.selected;
              const clean = i === ranking.cleanest;
              return (
                <button key={i} type="button" onClick={() => props.onSelect(i)} aria-pressed={active}
                  className={`w-full rounded-2xl border p-3 text-left transition ${active ? (clean ? 'border-eco/70 bg-eco/10' : 'border-cyan/70 bg-cyan/10') : 'border-line bg-white/[0.03] hover:bg-white/[0.07]'}`}>
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <RouteIcon className={`h-4 w-4 ${clean ? 'text-eco' : 'text-cyan'}`} />
                    Rota {i + 1}
                    {clean && ranking.scores.length > 1 && <Tag color="#34d399">Menor impacto</Tag>}
                    {i === ranking.fastest && ranking.scores.length > 1 && <Tag color="#60a5fa">Mais rápida</Tag>}
                    <span className="ml-auto font-display tabular-nums">{fmtMg(s.pm25Mg)}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mist tabular-nums">
                    <span>{s.route.distanceKm.toFixed(1)} km</span>
                    <span>~{Math.round(s.route.durationMin)} min</span>
                    <span>{s.sensitiveHits} {s.sensitiveHits === 1 ? 'zona sensível' : 'zonas sensíveis'}</span>
                    {s.roughKm > 0 && <span>{s.roughKm.toFixed(1)} km de piso irregular</span>}
                  </div>
                </button>
              );
            })}
          </div>
          {ranking.scores.length > 1 && (
            <p className="mt-2 text-xs text-mist">
              Impacto = PM2.5 total + o dobro do que é emitido junto a escolas e hospitais. O número à direita é o PM2.5 total da rota.
            </p>
          )}
          {best && props.selected !== ranking.cleanest && score && (
            <p className="mt-1 text-xs text-amber">
              A rota {ranking.cleanest + 1} tem menor impacto: {fmtMg(best.exposureMg)} de exposição sensível contra {fmtMg(score.exposureMg)} desta.
            </p>
          )}
          {props.zonesLoading && <p className="mt-2 text-xs text-mist">Buscando zonas de risco ao longo da rota…</p>}
          {props.zonesError && <p className="mt-2 text-xs text-amber">O serviço público de mapas não respondeu; as zonas automáticas podem estar incompletas.</p>}
        </section>
      )}

      {score && score.hits.length > 0 && (
        <section aria-label="Zonas de risco na rota" className="rounded-2xl border border-amber/30 bg-amber/[0.07] p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber">
            <AlertTriangle className="h-4 w-4" /> {score.hits.length} {score.hits.length === 1 ? 'zona de risco' : 'zonas de risco'} nesta rota
          </div>
          <ul className="scroll-thin max-h-36 space-y-1.5 overflow-y-auto pr-1">
            {score.hits.map(({ zone, alongKm }) => (
              <li key={zone.id} className="flex items-center gap-2 text-sm text-white/85">
                <RiskIcon type={zone.type} className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{zone.name}</span>
                <span className="text-xs tabular-nums text-mist">km {alongKm.toFixed(1)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <label className="label" htmlFor="aggr">Estilo de condução (para a estimativa e a simulação)</label>
        <input id="aggr" type="range" min={0} max={100} value={props.aggression} onChange={(e) => props.onAggression(Number(e.target.value))} />
        <div className="flex justify-between text-xs text-mist"><span>Suave</span><span className="font-semibold text-white tabular-nums">{props.aggression}%</span><span>Agressiva</span></div>
      </section>

      {est && score && (
        <div className="grid grid-cols-2 gap-2">
          <Stat label="PM2.5 estimado" value={fmtMg(est.pm25EmittedMg)} color="#fb7185" />
          <Stat label="PM10 estimado" value={fmtMg(est.pm10EmittedMg)} color="#fbbf24" />
          <Stat label="Evitado vs. agressiva" value={fmtMg(est.pm25AvoidedMg)} color="#34d399" />
          <Stat label="Exposição sensível" value={fmtMg(score.exposureMg)} color="#60a5fa" />
        </div>
      )}

      <section aria-label="Previsão da IA" className="rounded-2xl border border-violet/30 bg-violet/[0.06] p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-violet"><Sparkles className="h-4 w-4" /> IA local: previsão para o seu jeito de dirigir</div>
        {score && (
          <div className="mt-1 font-display text-2xl font-semibold tabular-nums">
            {fmtMg(predictPm25(props.model, props.grossKg, score.avgSpeedKmh, score.route.distanceKm - score.roughKm + score.roughKm * PAVEMENT_FACTOR))}
            <span className="ml-1 text-xs font-medium text-mist">de PM2.5 nesta rota</span>
          </div>
        )}
        <p className="mt-1 text-xs text-mist">{describeModel(props.model)} Roda no seu aparelho, sem custo e sem enviar dados.</p>
      </section>

      {score && props.routeChargers > 0 && (
        <p className="flex items-center gap-2 text-xs text-mist"><Zap className="h-3.5 w-3.5 text-cyan" /> {props.routeChargers} {props.routeChargers === 1 ? 'ponto de recarga' : 'pontos de recarga'} perto desta rota (pontos azuis no mapa).</p>
      )}

      {props.careDue && <Notice tone="warn" icon={<Gauge className="h-4 w-4" />}>{props.careDue}</Notice>}

      <div className="space-y-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-mist">
          <input type="checkbox" className="h-4 w-4 accent-[var(--color-eco)]" checked={props.passenger} onChange={(e) => props.onPassenger(e.target.checked)} />
          Estou de passageiro (a viagem não conta para minha nota nem para o ranking)
        </label>
        <button type="button" className="btn btn-eco w-full py-3.5 text-base" onClick={props.onStartGps}>
          <Play className="h-5 w-5 fill-current" /> {props.passenger ? 'Acompanhar viagem como passageiro' : 'Iniciar viagem com GPS'}
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="btn btn-ghost" disabled={!score} onClick={props.onStartSim} title={score ? '' : 'Defina partida e destino'}>
            <Zap className="h-4 w-4 text-cyan" /> Simular percurso
          </button>
          <button type="button" className="btn btn-ghost" disabled={!score || props.saving} onClick={props.onSavePlan}>
            {props.saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salvar estimativa
          </button>
        </div>
        <button type="button" className="btn btn-ghost w-full" onClick={props.onReport}>
          <MapPinPlus className="h-4 w-4 text-amber" /> Reportar zona de risco no mapa
        </button>
      </div>
    </div>
  );
}

function Tag({ color, children }: { color: string; children: ReactNode }) {
  return <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: `${color}22`, color }}>{children}</span>;
}

function Notice({ icon, children, tone }: { icon: ReactNode; children: ReactNode; tone?: 'warn' }) {
  return <div className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm ${tone === 'warn' ? 'border-amber/40 bg-amber/10 text-amber' : 'border-line bg-white/5 text-white/80'}`}>{icon}{children}</div>;
}

export function Stat({ label, value, color, icon }: { label: string; value: string; color?: string; icon?: ReactNode }) {
  return (
    <Tilt className="card px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-mist">{icon}{label}</div>
      <div className="font-display text-lg font-semibold tabular-nums" style={{ color: color ?? undefined }}><AnimatedValue value={value} /></div>
    </Tilt>
  );
}

// ---------- Alerta de zona de risco ----------

export function AlertBanner({ alert }: { alert: RiskAlert }) {
  const meta = RISK_META[alert.zone.type];
  const inside = alert.stage === 'inside';
  return (
    <div role="alert" className="alert-pulse flex items-center gap-3 px-4 py-3 text-[#140700] [clip-path:polygon(0_0,100%_0,100%_100%,16px_100%,0_calc(100%-16px))]" style={{ ['--alert' as string]: meta.color, background: meta.color }}>
      <RiskIconPlain type={alert.zone.type} className="h-8 w-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-lg font-extrabold leading-tight">{inside ? `Você está em ${meta.label.toLowerCase()}` : `${meta.label} a ${Math.round(alert.distanceM)} m`}</div>
        <div className="truncate text-sm font-medium">{alert.zone.name}</div>
        <div className="text-xs">{inside ? 'Conduza suave: evite frear e acelerar forte.' : `Alivie o acelerador${alert.etaS != null ? `: você chega em ${Math.round(alert.etaS)} s` : ''}.`}</div>
      </div>
      <div className="text-right font-display font-extrabold leading-none">
        <div className="text-4xl tabular-nums">{alert.advisedKmh}</div>
        <div className="text-xs">km/h</div>
      </div>
    </div>
  );
}

// ---------- Painel durante a viagem ----------

export function DriveHud({ live, street, onStop, saving, onQuickReport, votePrompt, onVote }: {
  live: LiveState; street: string | null; onStop: () => void; saving: boolean;
  onQuickReport: (t: RiskType) => void; votePrompt: RiskZone | null; onVote: (zoneId: string, stillThere: boolean) => void;
}) {
  const color = EMISSION_COLORS[live.level];
  const intensity = live.level === 'high' ? 1 : live.level === 'moderate' ? 0.55 : Math.min(0.3, live.speedKmh / 200);
  const zoneShare = live.pm25Mg > 0 ? (live.pm25InZonesMg / live.pm25Mg) * 100 : 0;
  const theme = useTheme();
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-mist">
        <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-eco opacity-70" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-eco" /></span>
        {live.mode === 'sim' ? 'Simulação em andamento' : 'Viagem em andamento'}
        {street && <span className="ml-auto flex min-w-0 items-center gap-1 text-white/80"><MapPin className="h-3.5 w-3.5 shrink-0 text-cyan" /><span className="truncate">{street}</span></span>}
      </div>

      <div className="grid grid-cols-[auto_1fr] items-center gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-xs text-mist"><Gauge className="h-3.5 w-3.5" /> Velocidade</div>
          <div className="font-display text-6xl font-bold leading-none tabular-nums">{Math.round(live.speedKmh)}<span className="ml-1 text-base font-medium text-mist">km/h</span></div>
          <div className="mt-3 inline-flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-sm font-semibold" style={{ background: `${color}22`, color }}>
            <Wind className="h-4 w-4" /> Emissão {EMISSION_LABELS[live.level].toLowerCase()}
          </div>
        </div>
        <Tire3D intensity={intensity} speedKmh={live.speedKmh} theme={theme} className="h-40 w-full" />
      </div>

      <p className="text-sm text-white/80">
        {live.level === 'low' && 'Condução suave: menor desgaste de pneu.'}
        {live.level === 'moderate' && 'Reduza acelerações e frenagens fortes.'}
        {live.level === 'high' && 'Alta emissão de particulado agora. Suavize a condução.'}
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="PM2.5 estimado" value={fmtMg(live.pm25Mg)} color="#fb7185" />
        <Stat label="PM10 estimado" value={fmtMg(toPm10(live.pm25Mg))} color="#fbbf24" />
        <Stat label="Em zona sensível" value={`${zoneShare.toFixed(0)}%`} color="#60a5fa" />
        <Stat label="Distância" value={`${live.distanceKm.toFixed(2)} km`} icon={<Flag className="h-3 w-3" />} />
        <Stat label="Tempo" value={fmtDuration(live.elapsedS)} icon={<Timer className="h-3 w-3" />} />
        <Stat label="Aceleração" value={`${live.accelG.toFixed(2)} g`} />
      </div>

      {live.coachTip && (
        <div role="status" className="rise flex items-start gap-2 rounded-xl border border-cyan/40 bg-cyan/10 px-3 py-2.5 text-sm">
          <Zap className="mt-0.5 h-4 w-4 shrink-0 text-cyan" /> <span><strong>Treinador:</strong> {live.coachTip}</span>
        </div>
      )}

      {live.geoError && <Notice tone="warn" icon={<Crosshair className="h-4 w-4" />}>{live.geoError}</Notice>}
      {live.mode === 'gps' && !live.pos && !live.geoError && <Notice icon={<Loader2 className="h-4 w-4 animate-spin text-cyan" />}>Aguardando sinal de GPS…</Notice>}

      {votePrompt && (
        <div className="pop-in rounded-xl border border-amber/50 bg-amber/10 p-3">
          <div className="text-sm font-semibold">Ainda tem {RISK_META[votePrompt.type].label.toLowerCase()} aqui?</div>
          <div className="text-xs text-mist">Outro motorista avisou{votePrompt.confirms ? ` e ${votePrompt.confirms} confirmaram` : ''}. Sua resposta mantém o mapa atualizado.</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-eco" onClick={() => onVote(votePrompt.id, true)}>Sim, ainda está</button>
            <button type="button" className="btn btn-ghost" onClick={() => onVote(votePrompt.id, false)}>Não está mais</button>
          </div>
        </div>
      )}

      {live.pos && (
        <div>
          <div className="mb-1.5 text-xs text-mist">Avisar outros motoristas (1 toque)</div>
          <div className="grid grid-cols-3 gap-2">
            {(['pavement', 'works', 'other'] as RiskType[]).map((t) => (
              <button key={t} type="button" onClick={() => onQuickReport(t)} className="flex flex-col items-center gap-1 rounded-xl border border-line bg-white/[0.04] py-2.5 text-xs font-medium hover:bg-white/10 active:scale-95">
                <RiskIcon type={t} className="h-5 w-5" />
                {t === 'pavement' ? 'Buraco' : t === 'works' ? 'Obra' : 'Perigo'}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-mist">Valores de PM2.5 e PM10 são aproximações calculadas pelo modelo, não medição.</p>

      <button type="button" className="btn btn-danger w-full py-3.5 text-base" onClick={onStop} disabled={saving}>
        {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Square className="h-5 w-5 fill-current" />} Finalizar e salvar
      </button>
    </div>
  );
}

// ---------- Resumo da viagem ----------

export function SummaryCard({ summary, saveError, onClose }: { summary: TripSummary; saveError: string | null; onClose: () => void }) {
  const share = summary.pm25EmittedMg > 0 ? (summary.pm25InZonesMg / summary.pm25EmittedMg) * 100 : 0;
  const scoreColor = summary.smoothScore >= 70 ? '#34d399' : summary.smoothScore >= 40 ? '#fbbf24' : '#fb7185';
  return (
    <div className="rise space-y-4">
      <div className="flex items-center gap-2 font-display text-lg font-semibold"><Leaf className="h-5 w-5 text-eco" /> Resumo da {summary.mode === 'sim' ? 'simulação' : 'viagem'}</div>
      <div className="flex items-center gap-4 rounded-2xl border border-line bg-white/[0.04] p-4">
        <div className="grid h-20 w-20 shrink-0 place-items-center rounded-full border-4 font-display text-3xl font-bold tabular-nums" style={{ borderColor: scoreColor, color: scoreColor }}>{summary.smoothScore}</div>
        <div>
          <div className="font-semibold">Eco-Score</div>
          <p className="text-sm text-mist">{summary.smoothScore >= 70 ? 'Condução preventiva: ótimo trabalho.' : summary.smoothScore >= 40 ? 'Dá para suavizar mais as acelerações.' : 'Muitas acelerações e frenagens fortes.'}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="PM2.5 estimado" value={fmtMg(summary.pm25EmittedMg)} color="#fb7185" />
        <Stat label="PM10 estimado" value={fmtMg(summary.pm10EmittedMg)} color="#fbbf24" />
        <Stat label="PM2.5 evitado" value={fmtMg(summary.pm25AvoidedMg)} color="#34d399" />
        <Stat label="Em zona sensível" value={`${share.toFixed(0)}%`} color="#60a5fa" />
        <Stat label="Distância" value={`${summary.distanceKm.toFixed(2)} km`} />
        <Stat label="Zonas respeitadas" value={`${summary.zonesRespected} de ${summary.zonesHit}`} color="#34d399" />
      </div>
      <p className="rounded-xl border border-line bg-white/[0.03] px-3 py-2 text-xs text-mist">
        <strong className="text-white">Replay 3D no mapa:</strong> cada coluna é um trecho do percurso. Quanto mais alta, mais PM2.5 por km; verde é suave, laranja moderado e vermelho alto.
      </p>
      {saveError ? <Notice tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>Não foi possível salvar: {saveError}</Notice> : <p className="text-xs text-mist">Viagem salva no seu histórico.</p>}
      <button type="button" className="btn btn-eco w-full" onClick={onClose}><Navigation className="h-4 w-4" /> Nova viagem</button>
    </div>
  );
}

// ---------- Reportar zona de risco ----------

export function ReportZoneForm({ point, onCancel, onSave }: {
  point: Pt | null; onCancel: () => void;
  onSave: (z: { name: string; type: RiskType; radiusM: number; note: string }) => Promise<string | null>;
}) {
  const [type, setType] = useState<RiskType>('pavement');
  const [name, setName] = useState('');
  const [radius, setRadius] = useState(DEFAULT_RADIUS_M.pavement);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!point) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 font-display text-lg font-semibold"><MapPinPlus className="h-5 w-5 text-amber" /> Reportar zona de risco</div>
        <Notice icon={<Crosshair className="h-4 w-4 text-amber" />}>Toque no mapa no ponto exato da zona.</Notice>
        <button type="button" className="btn btn-ghost w-full" onClick={onCancel}>Cancelar</button>
      </div>
    );
  }
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(await onSave({ name: name.trim() || RISK_META[type].label, type, radiusM: radius, note: note.trim() }));
      setBusy(false);
    }}>
      <div className="flex items-center gap-2 font-display text-lg font-semibold"><MapPinPlus className="h-5 w-5 text-amber" /> Nova zona de risco</div>
      <p className="text-xs text-mist tabular-nums">Ponto: {point.lat.toFixed(5)}, {point.lng.toFixed(5)}</p>
      <div>
        <label className="label" htmlFor="ztype">Tipo</label>
        <select id="ztype" className="field" value={type} onChange={(e) => { const t = e.target.value as RiskType; setType(t); setRadius(DEFAULT_RADIUS_M[t]); }}>
          {(Object.keys(RISK_META) as RiskType[]).map((t) => <option key={t} value={t}>{RISK_META[t].label}</option>)}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="zname">Nome</label>
        <input id="zname" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Buracos na Av. Brasil" maxLength={80} />
      </div>
      <div>
        <label className="label" htmlFor="zradius">Raio: {radius} m</label>
        <input id="zradius" type="range" min={30} max={500} step={10} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
      </div>
      <div>
        <label className="label" htmlFor="znote">Observação (opcional)</label>
        <input id="znote" className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} />
      </div>
      {error && <Notice tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>{error}</Notice>}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancelar</button>
        <button type="submit" className="btn btn-eco" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salvar zona</button>
      </div>
    </form>
  );
}
