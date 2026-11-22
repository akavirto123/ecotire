import { Trophy, Award, BarChart3, CarFront, Check, ChevronDown, CircleDollarSign, Loader2, Camera, Copy, Gauge, Lock, MapPinned, Medal, Plus, RadioTower, Users, Route, ShieldAlert, Trash2, Wind } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Car3D, bodyTypeOf, paintOf } from '@/components/Car3D';
import { useTheme } from '@/lib/theme';
import { RiskIcon, Stat, fmtMg } from '@/components/TripPanels';
import { AnimatedValue } from '@/components/ui';
import * as db from '@/lib/db';
import { RANK_MIN_KM, SAMPLE_RANKING, achievements, driverLevel, sortRanking, tireStats, weeklyScore, type RankEntry, type TireSettings } from '@/lib/insights';
import type { AppUser, Usage } from '@/hooks/useAuth';
import { CALIBRATION_DAYS, ROTATION_KM, fileToAvatar, maintenanceStatus, type Maintenance } from '@/lib/maintenance';
import type { NewVehicle } from '@/lib/db';
import { basePm25PerKm, toTsp } from '@/lib/emissions';
import { RISK_META, type RiskZone } from '@/lib/risk';
import type { Trip } from '@/lib/supabase';
import { VEHICLE_CATEGORIES, grossWeightKg, type Vehicle } from '@/lib/vehicles';

const MODE_LABEL: Record<Trip['mode'], string> = { gps: 'GPS', sim: 'Simulação', plan: 'Estimativa', passenger: 'Passageiro' };
const scoreColor = (s: number) => (s >= 70 ? '#34d399' : s >= 40 ? '#fbbf24' : '#fb7185');
const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------- Painel: resumo enxuto + cartões que expandem ----------

function ScoreRing({ score }: { score: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-36 w-36 shrink-0">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden="true">
        <defs>
          <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--color-eco2)" />
            <stop offset="1" stopColor="var(--color-eco)" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--color-line)" strokeWidth="9" strokeDasharray="4 2.4" />
        <circle cx="60" cy="60" r={r} fill="none" stroke="url(#ring)" strokeWidth="9" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, Math.max(0, score)) / 100)} className="transition-[stroke-dashoffset] duration-1000" />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="font-display text-4xl font-bold tabular-nums"><AnimatedValue value={String(Math.round(score))} /></div>
          <div className="text-xs text-mist">Eco-Score</div>
        </div>
      </div>
    </div>
  );
}

function Expandable({ id, open, onToggle, icon, title, headline, children }: {
  id: string; open: boolean; onToggle: (id: string) => void; icon: ReactNode; title: string; headline: string; children: ReactNode;
}) {
  return (
    <section className={`card overflow-hidden transition-colors ${open ? 'border-eco/60 lg:col-span-2' : ''}`}>
      <button type="button" onClick={() => onToggle(id)} aria-expanded={open} aria-controls={`panel-${id}`} className="flex w-full items-center gap-3 p-4 text-left hover:bg-white/[0.03]">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-eco/15 text-eco">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-mist">{title}</span>
          <span className="block truncate font-display text-xl font-semibold">{headline}</span>
        </span>
        <ChevronDown className={`h-5 w-5 shrink-0 text-mist transition-transform duration-300 ${open ? 'rotate-180' : ''}`} />
      </button>
      <div className="expand" data-open={open} id={`panel-${id}`}>
        <div>{open && <div className="rise border-t border-line p-4">{children}</div>}</div>
      </div>
    </section>
  );
}

export function Avatar({ src, name, size = 32 }: { src?: string | null; name: string; size?: number }) {
  return src ? (
    <img src={src} alt="" width={size} height={size} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <span className="grid shrink-0 place-items-center rounded-full bg-line font-display font-extrabold text-mist" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

// Ranking semanal: Eco-Score médio ponderado pelos km, só viagens com GPS, mínimo de km para entrar.
function LeaderboardCard({ user, trips, open, onToggle }: { user: AppUser; trips: Trip[]; open: boolean; onToggle: (id: string) => void }) {
  const [remote, setRemote] = useState<RankEntry[] | null>(null);
  const [nickname, setNickname] = useState(user.name.slice(0, 24));
  const [show, setShow] = useState(false);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    db.getProfile(user.id)
      .then((p) => {
        if (!p) return;
        setNickname(p.nickname);
        setShow(p.showInRanking);
        setAvatar(p.avatar ?? null);
      })
      .catch(() => undefined);
  }, [user.id]);

  useEffect(() => {
    db.weeklyLeaderboard()
      .then(setRemote)
      .catch((e) => setError((e as Error).message));
  }, [user.id, trips, savedAt]);

  // modo demonstração: não há outros usuários, então mostra um ranking de exemplo com você dentro
  const mine = useMemo(() => weeklyScore(trips, new Date(), user.demo ? ['gps', 'sim'] : ['gps']), [trips, user.demo]);
  const entries = useMemo(() => {
    if (remote) return remote;
    const list = [...SAMPLE_RANKING];
    if (mine && show) list.push({ ...mine, nickname: nickname || 'Você', avatar, isMe: true });
    return sortRanking(list);
  }, [remote, mine, show, nickname, avatar]);
  const myPos = entries.findIndex((e) => e.isMe) + 1;

  const save = async (nextShow: boolean, nextAvatar: string | null = avatar) => {
    const nick = nickname.trim();
    if (nick.length < 2) return setError('O apelido precisa ter pelo menos 2 letras.');
    setBusy(true);
    setError(null);
    try {
      await db.saveProfile(user.id, { nickname: nick, showInRanking: nextShow, avatar: nextAvatar });
      setShow(nextShow);
      setAvatar(nextAvatar);
      setSavedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const headline = myPos > 0 ? `Você está em ${myPos}º lugar` : show ? `Faltam km para entrar (mínimo ${RANK_MIN_KM} km)` : 'Entre no ranking da semana';

  return (
    <Expandable id="rank" open={open} onToggle={onToggle} icon={<Medal className="h-5 w-5" />} title="Ranking da semana" headline={headline}>
      {!remote && <p className="mb-3 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-amber">Ranking de exemplo: no modo demonstração não há outros usuários. Com o banco ligado, aparecem os motoristas reais.</p>}
      <ol className="space-y-1.5">
        {entries.length === 0 && <li className="text-sm text-mist">Ninguém atingiu {RANK_MIN_KM} km com GPS nesta semana ainda. Seja o primeiro.</li>}
        {entries.map((e, i) => (
          <li key={`${e.nickname}-${i}`} className={`stagger flex items-center gap-3 rounded-lg border px-3 py-2 ${e.isMe ? 'border-eco bg-eco/10' : 'border-line bg-white/[0.03]'}`} style={{ ['--i' as string]: i }}>
            <span className={`w-6 shrink-0 text-center font-display text-base font-extrabold tabular-nums ${i < 3 ? 'text-eco' : 'text-mist'}`}>{i + 1}</span>
            <Avatar src={e.avatar} name={e.nickname} size={36} />
            <span className="min-w-0 flex-1 truncate font-medium">{e.nickname}{e.isMe && <span className="ml-2 text-xs text-eco">você</span>}</span>
            <span className="hidden text-xs tabular-nums text-mist sm:block">{e.distanceKm.toFixed(1)} km, {e.zonesRespected} zonas respeitadas</span>
            <span className="font-display text-lg font-extrabold tabular-nums" style={{ color: scoreColor(e.ecoScore) }}>{e.ecoScore.toFixed(1)}</span>
          </li>
        ))}
      </ol>

      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
        <label className="group relative cursor-pointer" title="Trocar foto de perfil">
          <Avatar src={avatar} name={nickname} size={46} />
          <span className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full bg-eco text-ink"><Camera className="h-3 w-3" /></span>
          <input type="file" accept="image/*" className="sr-only" aria-label="Escolher foto de perfil" onChange={async (ev) => {
            const file = ev.target.files?.[0];
            ev.target.value = '';
            if (!file) return;
            try {
              await save(show, await fileToAvatar(file));
            } catch (err) {
              setError((err as Error).message);
            }
          }} />
        </label>
        <div className="min-w-[160px] flex-1">
          <label className="label" htmlFor="nick">Seu apelido no ranking</label>
          <input id="nick" className="field" value={nickname} maxLength={24} onChange={(e) => setNickname(e.target.value)} />
        </div>
        {show ? (
          <>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save(true)}>Salvar apelido</button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save(false)}>Sair do ranking</button>
          </>
        ) : (
          <button type="button" className="btn btn-eco" disabled={busy} onClick={() => void save(true)}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Medal className="h-4 w-4" />} Participar do ranking</button>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <p className="mt-3 text-[11px] leading-relaxed text-mist">
        Vale o Eco-Score médio da semana, ponderado pelos km, só de viagens com GPS e com pelo menos {RANK_MIN_KM} km. Zera toda segunda-feira.
        Os outros veem apenas seu apelido, sua foto e seus números; seus trajetos nunca aparecem.
      </p>
    </Expandable>
  );
}

function MaintenanceCard({ m, onChange, drivenKm, open, onToggle }: { m: Maintenance; onChange: (m: Maintenance) => void; drivenKm: number; open: boolean; onToggle: (id: string) => void }) {
  const st = maintenanceStatus(m, drivenKm);
  const due = Number(st.calibrationDue) + Number(st.rotationDue);
  return (
    <Expandable id="care" open={open} onToggle={onToggle} icon={<Gauge className="h-5 w-5" />} title="Calibragem e rodízio" headline={due ? (st.calibrationDue ? 'Hora de calibrar os pneus' : 'Hora de fazer o rodízio') : 'Tudo em dia'}>
      <ul className="space-y-3">
        <li className="flex flex-wrap items-center gap-3">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${st.calibrationDue ? 'bg-amber' : 'bg-good'}`} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Calibragem</div>
            <div className="text-xs text-mist">{st.daysSinceCalibration == null ? 'Você ainda não registrou nenhuma.' : `Última há ${st.daysSinceCalibration} ${st.daysSinceCalibration === 1 ? 'dia' : 'dias'}.`} Lembrete a cada {CALIBRATION_DAYS} dias.</div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => onChange({ ...m, calibratedAt: new Date().toISOString() })}>Calibrei hoje</button>
        </li>
        <li className="flex flex-wrap items-center gap-3">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${st.rotationDue ? 'bg-amber' : 'bg-good'}`} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Rodízio</div>
            <div className="text-xs text-mist">{st.rotationDue ? `Já são ${Math.round(st.kmSinceRotation)} km desde o último.` : `Faltam ${Math.round(st.kmToRotation)} km monitorados.`} Lembrete a cada {ROTATION_KM.toLocaleString('pt-BR')} km.</div>
            <div className="mt-1.5 h-2 max-w-xs overflow-hidden"><div className="wearbar h-full" style={{ width: `${Math.min(100, (st.kmSinceRotation / ROTATION_KM) * 100)}%` }} /></div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => onChange({ ...m, rotationAtKm: drivenKm })}>Fiz o rodízio</button>
        </li>
      </ul>
      <p className="mt-3 text-[11px] leading-relaxed text-mist">Pneu abaixo da pressão deforma mais e gasta mais rápido, e pneus gastos de forma desigual também. Os intervalos são referências comuns; siga o manual do seu veículo. O app conta só os km que ele monitorou.</p>
    </Expandable>
  );
}

/** Frota (empresa: gestor vê quem está na rua) ou liga de amigos (só o ranking entre vocês). */
function GroupCard({ user, kind, open, onToggle }: { user: AppUser; kind: db.GroupKind; open: boolean; onToggle: (id: string) => void }) {
  const isLeague = kind === 'league';
  const [fleets, setFleets] = useState<db.Fleet[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [members, setMembers] = useState<db.FleetMember[]>([]);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nick = user.name.slice(0, 24) || 'Motorista';

  const reload = async () => {
    try {
      const list = (await db.myFleets()).filter((f) => f.kind === kind);
      setFleets(list);
      setActive((a) => (a && list.some((f) => f.id === a) ? a : list[0]?.id ?? null));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void reload();
  }, [user.id]);

  // atualiza a cada 10 s enquanto o cartão está aberto: é assim que o gestor acompanha quem está na rua
  useEffect(() => {
    if (!open || !active) return;
    let alive = true;
    const load = () => db.fleetOverview(active).then((m) => alive && setMembers(m)).catch(() => undefined);
    void load();
    const t = window.setInterval(load, 10000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [open, active]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const fleet = fleets.find((f) => f.id === active);
  const onRoad = members.filter((m) => m.driving).length;
  const leader = members.find((m) => m.ecoScore != null);
  const headline = !db.fleetsAvailable
    ? 'Disponível com o banco ligado'
    : !fleet
      ? isLeague ? 'Desafie seus amigos' : 'Crie ou entre em uma frota'
      : isLeague
        ? leader ? `${fleet.name}: ${leader.isMe ? 'você lidera' : `${leader.nickname} lidera`}` : `${fleet.name}: ninguém pontuou ainda`
        : `${fleet.name}: ${onRoad} na rua agora`;

  return (
    <Expandable id={kind} open={open} onToggle={onToggle} icon={isLeague ? <Trophy className="h-5 w-5" /> : <Users className="h-5 w-5" />} title={isLeague ? 'Liga de amigos' : 'Frota'} headline={headline}>
      {!db.fleetsAvailable ? (
        <p className="text-sm text-mist">{isLeague ? 'A liga' : 'A frota'} junta motoristas de contas diferentes, então só funciona com o Supabase configurado. No modo demonstração os dados ficam só neste navegador.</p>
      ) : (
        <>
          {fleets.length > 1 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {fleets.map((f) => <button key={f.id} type="button" onClick={() => setActive(f.id)} aria-pressed={f.id === active} className={`rounded-full border px-3 py-1 text-sm ${f.id === active ? 'border-eco text-eco' : 'border-line text-mist'}`}>{f.name}</button>)}
            </div>
          )}
          {fleet && (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-mist">Código para convidar:</span>
                <code className="rounded-md bg-line px-2 py-1 font-display font-extrabold tracking-widest">{fleet.code}</code>
                <button type="button" className="rounded-lg p-1.5 text-mist hover:bg-white/10 hover:text-white" aria-label="Copiar código" title="Copiar código" onClick={() => void navigator.clipboard?.writeText(fleet.code)}><Copy className="h-4 w-4" /></button>
                <button type="button" className="ml-auto text-xs text-mist underline hover:text-danger" disabled={busy} onClick={() => void run(() => db.leaveFleet(fleet.id))}>{fleet.isOwner ? (isLeague ? 'Encerrar liga' : 'Encerrar frota') : isLeague ? 'Sair da liga' : 'Sair da frota'}</button>
              </div>
              <ul className="space-y-1.5">
                {members.map((m, i) => (
                  <li key={`${m.nickname}-${i}`} className={`stagger flex items-center gap-3 rounded-lg border px-3 py-2 ${m.isMe ? 'border-eco bg-eco/10' : 'border-line bg-white/[0.03]'}`} style={{ ['--i' as string]: i }}>
                    <Avatar src={m.avatar} name={m.nickname} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{isLeague && <span className="mr-1.5 font-display font-extrabold text-eco">{i + 1}º</span>}{m.nickname}{m.isOwner && <span className="ml-2 text-xs text-mist">{isLeague ? 'criou a liga' : 'gestor'}</span>}</div>
                      <div className="truncate text-xs tabular-nums text-mist">
                        {isLeague ? null : m.driving ? <span className="text-good"><RadioTower className="mr-1 inline h-3 w-3" />na rua{m.speedKmh != null ? `, ${Math.round(m.speedKmh)} km/h` : ''}{m.level === 'high' ? ', emissão alta' : ''}</span> : 'parado'}
                        {' · '}{m.distanceKm.toFixed(1)} km e {fmtMg(m.pm25Mg)} de PM2.5 na semana
                      </div>
                    </div>
                    {m.lat != null && m.lng != null && m.driving && (
                      <a className="rounded-lg p-1.5 text-mist hover:bg-white/10 hover:text-eco" href={`https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lng}#map=17/${m.lat}/${m.lng}`} target="_blank" rel="noreferrer" title="Ver posição no mapa" aria-label={`Ver posição de ${m.nickname} no mapa`}><MapPinned className="h-4 w-4" /></a>
                    )}
                    <span className="font-display text-lg font-extrabold tabular-nums" style={{ color: m.ecoScore == null ? undefined : scoreColor(m.ecoScore) }}>{m.ecoScore == null ? '–' : m.ecoScore.toFixed(1)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] leading-relaxed text-mist">{isLeague ? 'Vale o Eco-Score da semana com GPS, ponderado pelos km. Zera toda segunda-feira. Ninguém vê sua posição.' : 'Todos da frota veem as notas da semana. Só o gestor vê a posição de quem está em viagem, e ela é apagada quando a viagem termina.'}</p>
            </>
          )}
          <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
            <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => db.createFleet(name.trim(), nick, kind)).then(() => setName('')); }}>
              <div className="flex-1"><label className="label" htmlFor={`${kind}-name`}>{isLeague ? 'Criar liga' : 'Criar frota'}</label><input id={`${kind}-name`} className="field" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={40} required placeholder={isLeague ? 'Ex.: Turma de SCOM' : 'Nome da frota'} /></div>
              <button type="submit" className="btn btn-eco" disabled={busy}>Criar</button>
            </form>
            <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => db.joinFleet(code, nick)).then(() => setCode('')); }}>
              <div className="flex-1"><label className="label" htmlFor={`${kind}-code`}>Entrar com código</label><input id={`${kind}-code`} className="field uppercase" value={code} onChange={(e) => setCode(e.target.value)} minLength={6} maxLength={6} required placeholder="ABC123" /></div>
              <button type="submit" className="btn btn-ghost" disabled={busy}>Entrar</button>
            </form>
          </div>
          {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        </>
      )}
    </Expandable>
  );
}

export function DashboardPanel({ trips, loading, error, onDelete, onReplan, tire, onTire, user, onUsage, maintenance, onMaintenance }: {
  onUsage: (u: Usage) => void;
  maintenance: Maintenance; onMaintenance: (m: Maintenance) => void;
  user: AppUser;
  tire: TireSettings; onTire: (t: TireSettings) => void;
  trips: Trip[]; loading: boolean; error: string | null; onDelete: (id: string) => void; onReplan: (t: Trip) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));

  const totals = useMemo(() => {
    const sum = (f: (t: Trip) => number) => trips.reduce((s, t) => s + Number(f(t) || 0), 0);
    const emitted = sum((t) => t.pm25_emitted_mg);
    const distance = sum((t) => t.distance_km);
    return {
      emitted,
      avoided: sum((t) => t.pm25_avoided_mg),
      pm10: sum((t) => t.pm10_emitted_mg),
      inZones: sum((t) => t.pm25_in_zones_mg),
      distance,
      perKm: distance > 0 ? emitted / distance : 0,
      score: trips.length ? sum((t) => t.smooth_score) / trips.length : 0,
    };
  }, [trips]);
  const tyre = useMemo(() => tireStats(trips, tire), [trips, tire]);
  const medals = useMemo(() => achievements(trips), [trips]);
  const lvl = useMemo(() => driverLevel(trips), [trips]);

  const chart = trips.slice(0, 24).reverse();
  const perKm = (t: Trip) => (Number(t.distance_km) > 0 ? Number(t.pm25_emitted_mg) / Number(t.distance_km) : 0);
  const maxPerKm = Math.max(...chart.map(perKm), 0.001);
  const done = medals.filter((m) => m.done).length;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {error && <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">Erro ao carregar o histórico: {error}</p>}

      {/* resumo: só o essencial */}
      <div className="card relative flex flex-col items-center gap-6 overflow-hidden p-6 sm:flex-row">
        <div className="emboss absolute -right-4 -top-3 text-[7rem] opacity-50" aria-hidden="true">ECOTIRE</div>
        <ScoreRing score={totals.score} />
        <div className="relative min-w-0 flex-1 text-center sm:text-left">
          <div className="text-xs text-mist">Nível {lvl.level}</div>
          <div className="font-display text-3xl font-extrabold">{lvl.title}</div>
          <div className="mx-auto mt-2 h-3 max-w-sm overflow-hidden sm:mx-0"><div className="wearbar h-full transition-[width] duration-700" style={{ width: `${Math.round(lvl.progress * 100)}%` }} /></div>
          <div className="mt-1 text-xs text-mist tabular-nums">{lvl.xp} pontos · faltam {lvl.toNext} para o próximo nível</div>
        </div>
        <dl className="relative grid w-full grid-cols-3 gap-3 text-center sm:w-auto sm:gap-6">
          {[
            { k: 'economizados em pneu', v: brl(tyre.savedBRL) },
            { k: 'de PM2.5 evitados', v: fmtMg(totals.avoided) },
            { k: 'monitorados', v: `${totals.distance.toFixed(1)} km` },
          ].map((x) => (
            <div key={x.k}>
              <dd className="font-display text-xl font-semibold tabular-nums sm:text-2xl">{x.v}</dd>
              <dt className="text-[11px] leading-tight text-mist">{x.k}</dt>
            </div>
          ))}
        </dl>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-mist">
        Perfil:
        {(['personal', 'fleet'] as const).map((u) => (
          <button key={u} type="button" onClick={() => onUsage(u)} aria-pressed={user.usage === u} className={`rounded-full border px-3 py-1 ${user.usage === u ? 'border-eco text-eco' : 'border-line hover:text-white'}`}>
            {u === 'personal' ? 'Uso pessoal' : 'Frota'}
          </button>
        ))}
      </div>

      {trips.length === 0 && !loading && (
        <p className="card p-5 text-center text-sm text-mist">Nenhuma viagem ainda. Na aba Viagem, faça uma viagem, uma simulação ou salve uma estimativa.</p>
      )}

      {/* detalhes: toque num cartão para abrir */}
      <div className="grid items-start gap-3 lg:grid-cols-2">
        {user.usage === 'fleet' ? (
          <>
            <GroupCard user={user} kind="fleet" open={open === 'fleet'} onToggle={toggle} />
            <LeaderboardCard user={user} trips={trips} open={open === 'rank'} onToggle={toggle} />
          </>
        ) : (
          <>
            <GroupCard user={user} kind="league" open={open === 'league'} onToggle={toggle} />
            <LeaderboardCard user={user} trips={trips} open={open === 'rank'} onToggle={toggle} />
          </>
        )}
        <MaintenanceCard m={maintenance} onChange={onMaintenance} drivenKm={tyre.drivenKm} open={open === 'care'} onToggle={toggle} />
        <Expandable id="tyre" open={open === 'tyre'} onToggle={toggle} icon={<CircleDollarSign className="h-5 w-5" />} title="Pneu e economia" headline={`${Math.round(tyre.projectedLifeKm / 1000)} mil km de vida útil projetada`}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Economia dirigindo suave" value={brl(tyre.savedBRL)} color="#34d399" />
            <Stat label="Pneu gasto nas viagens" value={`${tyre.usedPct.toFixed(2)}%`} />
            <Stat label="Custo desse desgaste" value={brl(tyre.costBRL)} />
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-4 text-xs text-mist">
            <label className="flex items-center gap-2">Preço do jogo de pneus (R$)
              <input className="field !w-24 !py-1.5" inputMode="numeric" value={tire.setPriceBRL} onChange={(e) => onTire({ ...tire, setPriceBRL: Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0) })} />
            </label>
            <label className="flex items-center gap-2">Vida útil de fábrica (km)
              <input className="field !w-24 !py-1.5" inputMode="numeric" value={tire.lifeKm} onChange={(e) => onTire({ ...tire, lifeKm: Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0) })} />
            </label>
          </div>
        </Expandable>

        <Expandable id="medals" open={open === 'medals'} onToggle={toggle} icon={<Award className="h-5 w-5" />} title="Conquistas" headline={`${done} de ${medals.length} desbloqueadas`}>
          <div className="grid gap-3 sm:grid-cols-2">
            {medals.map((m) => (
              <div key={m.id} className="flex items-center gap-3">
                <div className={`medal shrink-0 ${m.done ? '' : 'locked'}`}>{m.done ? <Award className="h-5 w-5" /> : <Lock className="h-4 w-4" />}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{m.title}</div>
                  <div className="truncate text-xs text-mist">{m.desc}</div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-eco" style={{ width: `${(m.progress / m.goal) * 100}%` }} /></div>
                    <span className="text-[11px] tabular-nums text-mist">{m.progress}/{m.goal}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Expandable>

        <Expandable id="emissions" open={open === 'emissions'} onToggle={toggle} icon={<Wind className="h-5 w-5" />} title="Emissões" headline={`${fmtMg(totals.emitted)} de PM2.5 emitidos`}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="PM10 emitido" value={fmtMg(totals.pm10)} color="#fbbf24" />
            <Stat label="PM2.5 por km" value={`≈ ${totals.perKm.toFixed(1)} mg`} />
            <Stat label="Em zona sensível" value={`${totals.emitted > 0 ? ((totals.inZones / totals.emitted) * 100).toFixed(0) : 0}%`} color="#60a5fa" icon={<ShieldAlert className="h-3 w-3" />} />
            <Stat label="Borracha total (TSP)" value={fmtMg(toTsp(totals.emitted))} />
          </div>
          {chart.length > 0 && (
            <>
              <h4 className="mb-2 mt-4 flex items-center gap-2 text-xs font-semibold text-mist"><BarChart3 className="h-4 w-4 text-eco" /> PM2.5 por km em cada viagem (cor = Eco-Score)</h4>
              <div className="flex h-32 items-end gap-1.5 overflow-x-auto">
                {chart.map((t) => (
                  <div key={t.id} className="flex h-full min-w-[22px] max-w-[48px] flex-1 flex-col items-center justify-end gap-1" title={`${t.vehicle_model}: ${perKm(t).toFixed(2)} mg/km · Eco-Score ${t.smooth_score}`}>
                    <span className="text-[9px] tabular-nums text-mist">{perKm(t).toFixed(1)}</span>
                    <div className="w-full rounded-t-md" style={{ height: `${Math.max(4, (perKm(t) / maxPerKm) * 80)}%`, background: `linear-gradient(to top, ${scoreColor(t.smooth_score)}55, ${scoreColor(t.smooth_score)})` }} />
                  </div>
                ))}
              </div>
            </>
          )}
          <p className="mt-3 text-[11px] text-mist">Todos os valores de particulado são aproximações de um modelo (base EMEP/EEA 2019). O app não mede partículas: estima a partir de massa, velocidade e aceleração.</p>
        </Expandable>

        <Expandable id="history" open={open === 'history'} onToggle={toggle} icon={<Route className="h-5 w-5" />} title="Histórico" headline={loading ? 'Carregando…' : `${trips.length} ${trips.length === 1 ? 'viagem' : 'viagens'}`}>
          {trips.length === 0 ? (
            <p className="text-sm text-mist">Sem viagens registradas.</p>
          ) : (
            <ul className="scroll-thin max-h-[420px] space-y-2 overflow-y-auto pr-1">
              {trips.map((t) => (
                <li key={t.id} className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.03] px-3 py-2.5">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border-2 font-display text-sm font-bold tabular-nums" style={{ borderColor: scoreColor(t.smooth_score), color: scoreColor(t.smooth_score) }}>{t.smooth_score}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {t.origin_name && t.destination_name ? `${t.origin_name.split(',')[0]} → ${t.destination_name.split(',')[0]}` : t.vehicle_model}
                    </div>
                    <div className="truncate text-xs text-mist tabular-nums">
                      {new Date(t.started_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} · {MODE_LABEL[t.mode] ?? t.mode} · {Number(t.distance_km).toFixed(1)} km · {fmtMg(Number(t.pm25_emitted_mg))} PM2.5 · zonas {t.zones_respected ?? 0}/{t.sensitive_zones_hit}
                    </div>
                  </div>
                  {t.origin_lat != null && t.destination_lat != null && (
                    <button type="button" onClick={() => onReplan(t)} className="rounded-lg p-1.5 text-mist hover:bg-white/10 hover:text-eco" title="Ver rota no mapa" aria-label="Ver rota no mapa"><MapPinned className="h-4 w-4" /></button>
                  )}
                  <button type="button" onClick={() => onDelete(t.id)} className="rounded-lg p-1.5 text-mist hover:bg-white/10 hover:text-danger" title="Excluir viagem" aria-label="Excluir viagem"><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          )}
        </Expandable>
      </div>
    </div>
  );
}

// ---------- Garagem (veículos e zonas reportadas) ----------

export function GaragePanel({ vehicles, vehicleId, onSelect, onAdd, onDelete, myZones, onDeleteZone }: {
  vehicles: Vehicle[]; vehicleId: string; onSelect: (id: string) => void;
  onAdd: (v: NewVehicle) => Promise<string | null>; onDelete: (id: string) => void;
  myZones: RiskZone[]; onDeleteZone: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('BEV');
  const [weight, setWeight] = useState('1600');
  const [trunk, setTrunk] = useState('150');
  const [seats, setSeats] = useState('5');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = vehicles.find((v) => v.id === vehicleId);
  const theme = useTheme();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const w = Number(weight);
    if (!(w >= 400 && w <= 6000)) return setError('Informe um peso entre 400 e 6000 kg.');
    setBusy(true);
    const err = await onAdd({ name: name.trim(), category, curbWeightKg: w, trunkCapacityKg: Math.max(0, Number(trunk) || 0), maxPassengers: Math.min(9, Math.max(1, Number(seats) || 5)) });
    setError(err);
    if (!err) setName('');
    setBusy(false);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header>
        <h2 className="font-display text-2xl font-semibold">Garagem</h2>
        <p className="text-sm text-mist">Escolha uma categoria ou cadastre o seu veículo. A massa é o que mais pesa no desgaste do pneu.</p>
      </header>

      {current && (
        <div className="card relative grid grid-cols-1 items-center gap-2 overflow-hidden p-2 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="emboss pointer-events-none absolute -left-2 top-1 max-w-full overflow-hidden text-[3.5rem] sm:text-[5.5rem]" aria-hidden="true">GARAGEM</div>
          <Car3D paint={paintOf(current)} body={bodyTypeOf(current)} theme={theme} className="h-60 w-full min-w-0 sm:h-80" />
          <div className="relative min-w-0 p-3">
            <div className="text-xs text-mist">Veículo selecionado · arraste para girar</div>
            <div className="font-display text-2xl font-semibold">{current.name}</div>
            <p className="text-sm text-mist">{current.description}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Stat label="Peso" value={`${current.curbWeightKg} kg`} />
              <Stat label="PM2.5 base" value={`${basePm25PerKm(grossWeightKg(current, { passengers: 1, trunkFillPct: 0 })).toFixed(2)} mg/km`} color="#fb7185" />
            </div>
            <p className="mt-2 text-[11px] text-mist">Cada tipo tem o seu modelo 3D (hatch, sedã, SUV ou picape), na cor do veículo. Cada 100 kg a mais aumentam em cerca de {((100 / 1400) * 10.7 * 0.42).toFixed(2)} mg/km o PM2.5 estimado.</p>
          </div>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {vehicles.map((v) => {
          const active = v.id === vehicleId;
          return (
            <div key={v.id} className={`relative rounded-2xl border p-4 transition ${active ? 'border-eco/70 bg-eco/10' : 'border-line bg-white/[0.03] hover:bg-white/[0.07]'}`}>
              <button type="button" onClick={() => onSelect(v.id)} aria-pressed={active} className="block w-full text-left">
                <div className="flex items-center gap-2">
                  <CarFront className={`h-5 w-5 ${active ? 'text-eco' : 'text-cyan'}`} />
                  <span className="font-semibold">{v.name}</span>
                  {active && <Check className="ml-auto h-4 w-4 text-eco" />}
                </div>
                <p className="mt-1 text-xs text-mist">{v.description}</p>
                <div className="mt-3 flex gap-4 text-xs tabular-nums text-white/80">
                  <span>{v.curbWeightKg} kg</span>
                  <span>{basePm25PerKm(grossWeightKg(v, { passengers: 1, trunkFillPct: 0 })).toFixed(2)} mg/km PM2.5</span>
                  <span className="rounded-full bg-white/10 px-2">{v.category}</span>
                </div>
              </button>
              {v.custom && (
                <button type="button" onClick={() => onDelete(v.id)} className="absolute bottom-3 right-3 rounded-lg p-1.5 text-mist hover:bg-white/10 hover:text-danger" aria-label={`Excluir ${v.name}`} title="Excluir veículo"><Trash2 className="h-4 w-4" /></button>
              )}
            </div>
          );
        })}
      </div>

      <form onSubmit={submit} className="card p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Plus className="h-4 w-4 text-eco" /> Cadastrar meu veículo</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="vname">Nome</label>
            <input id="vname" className="field" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} placeholder="Ex.: Meu SUV elétrico" />
          </div>
          <div>
            <label className="label" htmlFor="vcat">Tipo</label>
            <select id="vcat" className="field" value={category} onChange={(e) => setCategory(e.target.value)}>
              {['BEV', 'PHEV', 'HEV', 'Combustão', 'Utilitário'].map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="vweight">Peso em ordem de marcha (kg)</label>
            <input id="vweight" className="field" inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)} required />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label" htmlFor="vtrunk">Carga (kg)</label>
              <input id="vtrunk" className="field" inputMode="numeric" value={trunk} onChange={(e) => setTrunk(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="vseats">Lugares</label>
              <input id="vseats" className="field" inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} />
            </div>
          </div>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        <button type="submit" className="btn btn-eco mt-4" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Adicionar à garagem</button>
      </form>

      <section className="card p-4">
        <h3 className="mb-3 text-sm font-semibold">Zonas de risco que você reportou</h3>
        {myZones.length === 0 ? (
          <p className="text-sm text-mist">Nenhuma ainda. Na aba Viagem, use "Reportar zona de risco no mapa".</p>
        ) : (
          <ul className="space-y-1.5">
            {myZones.map((z) => (
              <li key={z.id} className="flex items-center gap-2 text-sm">
                <RiskIcon type={z.type} className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{z.name} <span className="text-mist">· {RISK_META[z.type].label} · {z.radiusM} m</span></span>
                <button type="button" onClick={() => onDeleteZone(z.id)} className="rounded-lg p-1.5 text-mist hover:bg-white/10 hover:text-danger" aria-label={`Excluir zona ${z.name}`}><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export { VEHICLE_CATEGORIES };
