/**
 * Camada de dados. Com Supabase configurado, grava na nuvem (por usuário, protegido por RLS).
 * Sem Supabase (modo demonstração), grava no localStorage deste navegador.
 */
import type { RankEntry } from '@/lib/insights';
import { DEFAULT_RADIUS_M, type RiskType, type RiskZone } from '@/lib/risk';
import { supabase, type NewTrip, type Trip } from '@/lib/supabase';

/** Quando o visitante escolhe "Testar sem conta", tudo fica no navegador mesmo com o banco ligado. */
let localOnly = false;
export const setLocalOnly = (v: boolean) => {
  localOnly = v;
};
const remote = () => (localOnly ? null : supabase);
import type { Vehicle } from '@/lib/vehicles';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function localGet<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(`ecotire:${key}`) ?? '[]') as T[];
  } catch {
    return [];
  }
}
function localSet<T>(key: string, rows: T[]) {
  try {
    localStorage.setItem(`ecotire:${key}`, JSON.stringify(rows));
  } catch {
    /* armazenamento indisponível: segue só em memória */
  }
}

function fail(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

// ---------- Viagens ----------

export async function listTrips(userId: string): Promise<Trip[]> {
  if (!remote()) return localGet<Trip>(`trips:${userId}`);
  const { data, error } = await remote()!.from('trips').select('*').order('created_at', { ascending: false }).limit(200);
  fail(error);
  return (data ?? []) as Trip[];
}

export async function insertTrip(userId: string, trip: NewTrip): Promise<void> {
  if (!remote()) {
    const rows = localGet<Trip>(`trips:${userId}`);
    localSet(`trips:${userId}`, [{ ...trip, id: uid(), user_id: userId, created_at: new Date().toISOString() }, ...rows]);
    return;
  }
  fail((await remote()!.from('trips').insert(trip)).error);
}

export async function deleteTrip(userId: string, id: string): Promise<void> {
  if (!remote()) {
    localSet(`trips:${userId}`, localGet<Trip>(`trips:${userId}`).filter((t) => t.id !== id));
    return;
  }
  fail((await remote()!.from('trips').delete().eq('id', id)).error);
}

// ---------- Veículos cadastrados pelo usuário ----------

type VehicleRow = { id: string; name: string; category: string; curb_weight_kg: number; trunk_capacity_kg: number; max_passengers: number };

const rowToVehicle = (r: VehicleRow): Vehicle => ({
  id: r.id,
  name: r.name,
  description: 'Veículo cadastrado por você',
  category: r.category,
  curbWeightKg: Number(r.curb_weight_kg),
  trunkCapacityKg: Number(r.trunk_capacity_kg),
  maxPassengers: r.max_passengers,
  custom: true,
});

export type NewVehicle = { name: string; category: string; curbWeightKg: number; trunkCapacityKg: number; maxPassengers: number };

export async function listVehicles(userId: string): Promise<Vehicle[]> {
  if (!remote()) return localGet<VehicleRow>(`vehicles:${userId}`).map(rowToVehicle);
  const { data, error } = await remote()!.from('vehicles').select('*').order('created_at');
  fail(error);
  return ((data ?? []) as VehicleRow[]).map(rowToVehicle);
}

export async function insertVehicle(userId: string, v: NewVehicle): Promise<Vehicle> {
  const row = { name: v.name, category: v.category, curb_weight_kg: v.curbWeightKg, trunk_capacity_kg: v.trunkCapacityKg, max_passengers: v.maxPassengers };
  if (!remote()) {
    const saved: VehicleRow = { ...row, id: uid() };
    localSet(`vehicles:${userId}`, [...localGet<VehicleRow>(`vehicles:${userId}`), saved]);
    return rowToVehicle(saved);
  }
  const { data, error } = await remote()!.from('vehicles').insert(row).select().single();
  fail(error);
  return rowToVehicle(data as VehicleRow);
}

export async function deleteVehicle(userId: string, id: string): Promise<void> {
  if (!remote()) {
    localSet(`vehicles:${userId}`, localGet<VehicleRow>(`vehicles:${userId}`).filter((v) => v.id !== id));
    return;
  }
  fail((await remote()!.from('vehicles').delete().eq('id', id)).error);
}

// ---------- Zonas de risco reportadas ----------

type ZoneRow = { id: string; user_id: string; name: string; type: RiskType; lat: number; lng: number; radius_m: number; note: string | null };

const rowToZone = (r: ZoneRow): RiskZone => ({
  id: r.id,
  name: r.name,
  type: r.type,
  lat: Number(r.lat),
  lng: Number(r.lng),
  radiusM: Number(r.radius_m) || DEFAULT_RADIUS_M[r.type],
  source: 'community',
  note: r.note,
  userId: r.user_id,
});

export type NewZone = { name: string; type: RiskType; lat: number; lng: number; radiusM: number; note?: string };

export async function listRiskZones(): Promise<RiskZone[]> {
  if (!remote()) {
    const votes = localGet<{ id: string; up: boolean }>('zone-votes');
    return localGet<ZoneRow>('zones').filter((z) => !votes.some((v) => v.id === z.id && !v.up)).map(rowToZone);
  }
  const { data, error } = await remote()!.rpc('live_risk_zones');
  fail(error);
  return ((data ?? []) as (ZoneRow & { confirms: number })[]).map((r) => ({ ...rowToZone(r), confirms: Number(r.confirms) || 0 }));
}

/** "Ainda está aí?": confirma ou nega uma zona reportada por outra pessoa. */
export async function voteZone(zoneId: string, stillThere: boolean): Promise<void> {
  if (!remote()) {
    localSet('zone-votes', [...localGet<{ id: string; up: boolean }>('zone-votes').filter((v) => v.id !== zoneId), { id: zoneId, up: stillThere }]);
    return;
  }
  fail((await remote()!.from('zone_votes').upsert({ zone_id: zoneId, still_there: stillThere, voted_at: new Date().toISOString() })).error);
}

export async function insertRiskZone(userId: string, z: NewZone): Promise<RiskZone> {
  const row = { name: z.name, type: z.type, lat: z.lat, lng: z.lng, radius_m: z.radiusM, note: z.note ?? null };
  if (!remote()) {
    const saved: ZoneRow = { ...row, id: uid(), user_id: userId };
    localSet('zones', [...localGet<ZoneRow>('zones'), saved]);
    return rowToZone(saved);
  }
  const { data, error } = await remote()!.from('risk_zones').insert(row).select().single();
  fail(error);
  return rowToZone(data as ZoneRow);
}

export async function deleteRiskZone(id: string): Promise<void> {
  if (!remote()) {
    localSet('zones', localGet<ZoneRow>('zones').filter((z) => z.id !== id));
    return;
  }
  fail((await remote()!.from('risk_zones').delete().eq('id', id)).error);
}

// ---------- Perfil e ranking semanal ----------

export type Profile = { nickname: string; showInRanking: boolean; avatar?: string | null };

export async function getProfile(userId: string): Promise<Profile | null> {
  if (!remote()) return localGet<Profile>(`profile:${userId}`)[0] ?? null;
  const { data, error } = await remote()!.from('profiles').select('nickname, show_in_ranking, avatar').eq('user_id', userId).maybeSingle();
  fail(error);
  return data ? { nickname: data.nickname as string, showInRanking: !!data.show_in_ranking, avatar: (data.avatar as string | null) ?? null } : null;
}

export async function saveProfile(userId: string, p: Profile): Promise<void> {
  if (!remote()) {
    localSet(`profile:${userId}`, [p]);
    return;
  }
  fail((await remote()!.from('profiles').upsert({ user_id: userId, nickname: p.nickname, show_in_ranking: p.showInRanking, avatar: p.avatar ?? null, updated_at: new Date().toISOString() })).error);
}

/** Ranking da semana vindo do banco. null no modo demonstração (não há outros usuários). */
export async function weeklyLeaderboard(): Promise<RankEntry[] | null> {
  if (!remote()) return null;
  const { data, error } = await remote()!.rpc('weekly_leaderboard');
  fail(error);
  return ((data ?? []) as { nickname: string; avatar: string | null; eco_score: number; distance_km: number; zones_respected: number; is_me: boolean }[]).map((r) => ({
    nickname: r.nickname,
    avatar: r.avatar,
    ecoScore: Number(r.eco_score),
    distanceKm: Number(r.distance_km),
    zonesRespected: Number(r.zones_respected),
    isMe: r.is_me,
  }));
}

// ---------- Mapa de calor da comunidade ----------

export type HeatCell = { lat: number; lng: number; mg: number };

export async function addHeat(cells: HeatCell[]): Promise<void> {
  if (!cells.length) return;
  if (!remote()) {
    const all = new Map(localGet<HeatCell>('heat').map((c) => [`${c.lat},${c.lng}`, c]));
    for (const c of cells) {
      const k = `${c.lat},${c.lng}`;
      all.set(k, { ...c, mg: (all.get(k)?.mg ?? 0) + c.mg });
    }
    localSet('heat', [...all.values()].slice(-4000));
    return;
  }
  fail((await remote()!.rpc('add_heat', { cells: cells.slice(0, 800) })).error);
}

export async function listHeat(b: { south: number; west: number; north: number; east: number }): Promise<HeatCell[]> {
  if (!remote()) return localGet<HeatCell>('heat').filter((c) => c.lat >= b.south && c.lat <= b.north && c.lng >= b.west && c.lng <= b.east);
  const { data, error } = await remote()!
    .from('emission_cells')
    .select('cell_lat, cell_lng, mg')
    .gte('cell_lat', b.south).lte('cell_lat', b.north).gte('cell_lng', b.west).lte('cell_lng', b.east)
    .limit(4000);
  fail(error);
  return ((data ?? []) as { cell_lat: number; cell_lng: number; mg: number }[]).map((r) => ({ lat: Number(r.cell_lat), lng: Number(r.cell_lng), mg: Number(r.mg) }));
}

// ---------- Frotas (precisam do banco: juntam dados de várias contas) ----------

export const fleetsAvailable = !!remote();
export type GroupKind = 'fleet' | 'league';
export type Fleet = { id: string; name: string; code: string; isOwner: boolean; members: number; kind: GroupKind };
export type FleetMember = {
  nickname: string; avatar: string | null; isMe: boolean; isOwner: boolean; ecoScore: number | null; distanceKm: number;
  pm25Mg: number; zonesRespected: number; driving: boolean; lat: number | null; lng: number | null; speedKmh: number | null; level: string | null;
};

export async function myFleets(): Promise<Fleet[]> {
  if (!remote()) return [];
  const { data, error } = await remote()!.rpc('my_fleets');
  fail(error);
  return ((data ?? []) as { id: string; name: string; code: string; is_owner: boolean; members: number; kind: GroupKind }[]).map((r) => ({ id: r.id, name: r.name, code: r.code, isOwner: r.is_owner, members: Number(r.members), kind: r.kind ?? 'fleet' }));
}

export async function createFleet(name: string, nickname: string, kind: GroupKind = 'fleet'): Promise<string> {
  if (!remote()) throw new Error('Frotas precisam do banco de dados configurado.');
  const { data, error } = await remote()!.rpc('create_fleet', { p_name: name, p_nickname: nickname, p_kind: kind });
  fail(error);
  return data as string;
}

export async function joinFleet(code: string, nickname: string): Promise<void> {
  if (!remote()) throw new Error('Frotas precisam do banco de dados configurado.');
  fail((await remote()!.rpc('join_fleet', { p_code: code, p_nickname: nickname })).error);
}

export async function leaveFleet(id: string): Promise<void> {
  if (!remote()) return;
  fail((await remote()!.rpc('leave_fleet', { p_fleet: id })).error);
}

export async function fleetOverview(id: string): Promise<FleetMember[]> {
  if (!remote()) return [];
  const { data, error } = await remote()!.rpc('fleet_overview', { p_fleet: id });
  fail(error);
  type Row = { nickname: string; avatar: string | null; is_me: boolean; is_owner: boolean; eco_score: number | null; distance_km: number; pm25_mg: number; zones_respected: number; driving: boolean | null; lat: number | null; lng: number | null; speed_kmh: number | null; level: string | null };
  return ((data ?? []) as Row[]).map((r) => ({
    nickname: r.nickname, avatar: r.avatar, isMe: r.is_me, isOwner: r.is_owner, ecoScore: r.eco_score == null ? null : Number(r.eco_score),
    distanceKm: Number(r.distance_km), pm25Mg: Number(r.pm25_mg), zonesRespected: Number(r.zones_respected), driving: !!r.driving,
    lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng), speedKmh: r.speed_kmh == null ? null : Number(r.speed_kmh), level: r.level,
  }));
}

/** Posição ao vivo durante a viagem (só o gestor da sua frota vê). Falhas são ignoradas: não podem atrapalhar a viagem. */
export async function pushLiveStatus(userId: string, s: { lat: number; lng: number; speedKmh: number; level: string }): Promise<void> {
  if (!remote()) return;
  await remote()!.from('live_status').upsert({ user_id: userId, lat: s.lat, lng: s.lng, speed_kmh: Math.round(s.speedKmh), level: s.level, updated_at: new Date().toISOString() });
}

export async function clearLiveStatus(userId: string): Promise<void> {
  if (!remote()) return;
  await remote()!.from('live_status').delete().eq('user_id', userId);
}
