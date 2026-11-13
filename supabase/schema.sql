-- EcoTire: esquema do banco (rode UMA vez no Supabase > SQL Editor)
-- Cada usuário só enxerga e altera os próprios dados (RLS).

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  category text not null default 'custom',
  curb_weight_kg numeric not null check (curb_weight_kg between 400 and 6000),
  trunk_capacity_kg numeric not null default 150,
  max_passengers integer not null default 5,
  created_at timestamptz not null default now()
);

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode text not null default 'gps' check (mode in ('gps', 'sim', 'plan')),
  vehicle_model text not null,
  gross_weight_kg numeric not null default 0,
  distance_km numeric not null default 0,
  duration_s integer not null default 0,
  avg_speed_kmh numeric not null default 0,
  max_speed_kmh numeric not null default 0,
  peak_accel_g numeric not null default 0,
  pm25_emitted_mg numeric not null default 0,
  pm25_avoided_mg numeric not null default 0,
  pm10_emitted_mg numeric not null default 0,
  pm10_avoided_mg numeric not null default 0,
  pm25_in_zones_mg numeric not null default 0,
  smooth_score integer not null default 0,
  sensitive_zones_hit integer not null default 0,
  zones_respected integer not null default 0,
  origin_name text,
  origin_lat numeric,
  origin_lng numeric,
  destination_name text,
  destination_lat numeric,
  destination_lng numeric,
  passengers integer,
  trunk_fill_pct integer,
  started_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.risk_zones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  type text not null check (type in ('school', 'hospital', 'pavement', 'works', 'other')),
  lat numeric not null,
  lng numeric not null,
  radius_m integer not null default 120 check (radius_m between 30 and 1000),
  note text,
  created_at timestamptz not null default now()
);

-- se você já tinha criado a tabela com uma versão anterior deste arquivo
alter table public.trips add column if not exists zones_respected integer not null default 0;

create index if not exists trips_user_idx on public.trips (user_id, created_at desc);
create index if not exists vehicles_user_idx on public.vehicles (user_id);

alter table public.vehicles enable row level security;
alter table public.trips enable row level security;
alter table public.risk_zones enable row level security;

drop policy if exists "vehicles_own" on public.vehicles;
create policy "vehicles_own" on public.vehicles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "trips_own" on public.trips;
create policy "trips_own" on public.trips for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Zonas de risco reportadas: todos os usuários logados veem, só o autor altera/apaga.
drop policy if exists "risk_zones_read" on public.risk_zones;
create policy "risk_zones_read" on public.risk_zones for select to authenticated using (true);

drop policy if exists "risk_zones_insert" on public.risk_zones;
create policy "risk_zones_insert" on public.risk_zones for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "risk_zones_update" on public.risk_zones;
create policy "risk_zones_update" on public.risk_zones for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "risk_zones_delete" on public.risk_zones;
create policy "risk_zones_delete" on public.risk_zones for delete to authenticated
  using (user_id = auth.uid());

-- ---------- Ranking semanal ----------
-- Perfil público mínimo: só apelido e a escolha de aparecer no ranking.
create table if not exists public.profiles (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  nickname text not null check (char_length(nickname) between 2 and 24),
  show_in_ranking boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_own" on public.profiles;
create policy "profiles_own" on public.profiles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- Foto de perfil no ranking ----------
alter table public.profiles add column if not exists avatar text check (avatar is null or char_length(avatar) <= 40000);

-- Ranking: devolve só apelido, foto e números agregados de quem escolheu aparecer. Nunca expõe trajetos.
-- Vale a semana atual (segunda a domingo, horário de Brasília), só viagens com GPS, mínimo de 5 km.
drop function if exists public.weekly_leaderboard();
create function public.weekly_leaderboard()
returns table (nickname text, avatar text, eco_score numeric, distance_km numeric, zones_respected bigint, is_me boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.nickname, p.avatar,
         round(sum(t.smooth_score * t.distance_km) / nullif(sum(t.distance_km), 0), 1) as eco_score,
         round(sum(t.distance_km), 1) as distance_km,
         sum(t.zones_respected)::bigint as zones_respected,
         p.user_id = auth.uid() as is_me
  from public.trips t
  join public.profiles p on p.user_id = t.user_id
  where p.show_in_ranking
    and t.mode = 'gps'
    and t.started_at >= (date_trunc('week', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')
  group by p.user_id, p.nickname, p.avatar
  having sum(t.distance_km) >= 5
  order by eco_score desc, distance_km desc
  limit 50;
$$;
revoke all on function public.weekly_leaderboard() from public, anon;
grant execute on function public.weekly_leaderboard() to authenticated;

-- ---------- Modo passageiro ----------
alter table public.trips drop constraint if exists trips_mode_check;
alter table public.trips add constraint trips_mode_check check (mode in ('gps', 'sim', 'plan', 'passenger'));

-- ---------- Mapa de calor da comunidade ----------
-- Células de ~110 m com a soma do PM2.5 emitido. Não guarda quem emitiu nem quando.
create table if not exists public.emission_cells (
  cell_lat numeric(7, 3) not null,
  cell_lng numeric(7, 3) not null,
  mg numeric not null default 0,
  samples integer not null default 0,
  primary key (cell_lat, cell_lng)
);
alter table public.emission_cells enable row level security;
drop policy if exists "cells_read" on public.emission_cells;
create policy "cells_read" on public.emission_cells for select to authenticated using (true);

create or replace function public.add_heat(cells jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or jsonb_typeof(cells) <> 'array' or jsonb_array_length(cells) > 800 then
    raise exception 'pedido inválido';
  end if;
  insert into emission_cells (cell_lat, cell_lng, mg, samples)
  select round((c->>'lat')::numeric, 3), round((c->>'lng')::numeric, 3), sum(least(greatest((c->>'mg')::numeric, 0), 50)), count(*)::int
  from jsonb_array_elements(cells) c
  where (c->>'lat')::numeric between -90 and 90 and (c->>'lng')::numeric between -180 and 180
  group by 1, 2
  on conflict (cell_lat, cell_lng) do update set mg = emission_cells.mg + excluded.mg, samples = emission_cells.samples + excluded.samples;
end;
$$;
revoke all on function public.add_heat(jsonb) from public, anon;
grant execute on function public.add_heat(jsonb) to authenticated;

-- ---------- Frotas ----------
create table if not exists public.fleets (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 40),
  code text not null unique,
  owner_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.fleet_members (
  fleet_id uuid not null references public.fleets (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  nickname text not null check (char_length(nickname) between 2 and 24),
  joined_at timestamptz not null default now(),
  primary key (fleet_id, user_id)
);
-- posição ao vivo de quem está em viagem (apagada ao terminar)
create table if not exists public.live_status (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  lat numeric not null,
  lng numeric not null,
  speed_kmh numeric not null default 0,
  level text not null default 'low',
  updated_at timestamptz not null default now()
);
alter table public.fleets enable row level security;
alter table public.fleet_members enable row level security;
alter table public.live_status enable row level security;
-- frotas e membros só são lidos pelas funções abaixo; a posição ao vivo é gravada pelo próprio usuário
drop policy if exists "live_own" on public.live_status;
create policy "live_own" on public.live_status for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.create_fleet(p_name text, p_nickname text)
returns text language plpgsql security definer set search_path = public as $$
declare v_code text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'entre na sua conta'; end if;
  loop
    v_code := upper(substr(translate(md5(random()::text || clock_timestamp()::text), '01', 'XZ'), 1, 6));
    exit when not exists (select 1 from fleets where code = v_code);
  end loop;
  insert into fleets (name, code, owner_id) values (trim(p_name), v_code, auth.uid()) returning id into v_id;
  insert into fleet_members (fleet_id, user_id, nickname) values (v_id, auth.uid(), trim(p_nickname));
  return v_code;
end; $$;

create or replace function public.join_fleet(p_code text, p_nickname text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'entre na sua conta'; end if;
  select id into v_id from fleets where code = upper(trim(p_code));
  if v_id is null then raise exception 'Código de frota não encontrado.'; end if;
  insert into fleet_members (fleet_id, user_id, nickname) values (v_id, auth.uid(), trim(p_nickname))
  on conflict (fleet_id, user_id) do update set nickname = excluded.nickname;
  return v_id;
end; $$;

create or replace function public.leave_fleet(p_fleet uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from fleets where id = p_fleet and owner_id = auth.uid()) then
    delete from fleets where id = p_fleet; -- o dono encerra a frota
  else
    delete from fleet_members where fleet_id = p_fleet and user_id = auth.uid();
  end if;
end; $$;

drop function if exists public.my_fleets();
create function public.my_fleets()
returns table (id uuid, name text, code text, is_owner boolean, members bigint)
language sql stable security definer set search_path = public as $$
  select f.id, f.name, f.code, f.owner_id = auth.uid(), (select count(*) from fleet_members x where x.fleet_id = f.id)
  from fleets f join fleet_members m on m.fleet_id = f.id and m.user_id = auth.uid()
  order by f.created_at;
$$;

-- Visão da frota: todos os membros veem as notas da semana; só o gestor (dono) vê a posição ao vivo dos outros.
create or replace function public.fleet_overview(p_fleet uuid)
returns table (nickname text, avatar text, is_me boolean, is_owner boolean, eco_score numeric, distance_km numeric,
               pm25_mg numeric, zones_respected bigint, driving boolean, lat numeric, lng numeric, speed_kmh numeric, level text)
language sql stable security definer set search_path = public as $$
  with me as (
    select exists (select 1 from fleet_members where fleet_id = p_fleet and user_id = auth.uid()) as member,
           exists (select 1 from fleets where id = p_fleet and owner_id = auth.uid()) as owner
  ), wk as (
    select t.user_id,
           round(sum(t.smooth_score * t.distance_km) / nullif(sum(t.distance_km), 0), 1) as eco_score,
           round(sum(t.distance_km), 1) as distance_km,
           round(sum(t.pm25_emitted_mg), 1) as pm25_mg,
           sum(t.zones_respected)::bigint as zones_respected
    from trips t
    where t.mode = 'gps'
      and t.started_at >= (date_trunc('week', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')
    group by t.user_id
  )
  select m.nickname, p.avatar, m.user_id = auth.uid(), f.owner_id = m.user_id,
         wk.eco_score, coalesce(wk.distance_km, 0), coalesce(wk.pm25_mg, 0), coalesce(wk.zones_respected, 0),
         (l.updated_at > now() - interval '45 seconds'),
         case when me.owner or m.user_id = auth.uid() then l.lat end,
         case when me.owner or m.user_id = auth.uid() then l.lng end,
         l.speed_kmh, l.level
  from fleet_members m
  join fleets f on f.id = m.fleet_id
  cross join me
  left join profiles p on p.user_id = m.user_id
  left join wk on wk.user_id = m.user_id
  left join live_status l on l.user_id = m.user_id
  where m.fleet_id = p_fleet and me.member
  order by wk.eco_score desc nulls last, m.nickname;
$$;

revoke all on function public.create_fleet(text, text), public.join_fleet(text, text), public.leave_fleet(uuid), public.my_fleets(), public.fleet_overview(uuid) from public, anon;
grant execute on function public.create_fleet(text, text), public.join_fleet(text, text), public.leave_fleet(uuid), public.my_fleets(), public.fleet_overview(uuid) to authenticated;

-- ---------- Ligas de amigos (mesma estrutura das frotas, sem posição ao vivo) ----------
alter table public.fleets add column if not exists kind text not null default 'fleet' check (kind in ('fleet', 'league'));

drop function if exists public.create_fleet(text, text);
create or replace function public.create_fleet(p_name text, p_nickname text, p_kind text default 'fleet')
returns text language plpgsql security definer set search_path = public as $$
declare v_code text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'entre na sua conta'; end if;
  loop
    v_code := upper(substr(translate(md5(random()::text || clock_timestamp()::text), '01', 'XZ'), 1, 6));
    exit when not exists (select 1 from fleets where code = v_code);
  end loop;
  insert into fleets (name, code, owner_id, kind) values (trim(p_name), v_code, auth.uid(), case when p_kind = 'league' then 'league' else 'fleet' end) returning id into v_id;
  insert into fleet_members (fleet_id, user_id, nickname) values (v_id, auth.uid(), trim(p_nickname));
  return v_code;
end; $$;

drop function if exists public.my_fleets();
create function public.my_fleets()
returns table (id uuid, name text, code text, is_owner boolean, members bigint, kind text)
language sql stable security definer set search_path = public as $$
  select f.id, f.name, f.code, f.owner_id = auth.uid(), (select count(*) from fleet_members x where x.fleet_id = f.id), f.kind
  from fleets f join fleet_members m on m.fleet_id = f.id and m.user_id = auth.uid()
  order by f.created_at;
$$;

create or replace function public.fleet_overview(p_fleet uuid)
returns table (nickname text, avatar text, is_me boolean, is_owner boolean, eco_score numeric, distance_km numeric,
               pm25_mg numeric, zones_respected bigint, driving boolean, lat numeric, lng numeric, speed_kmh numeric, level text)
language sql stable security definer set search_path = public as $$
  with me as (
    select exists (select 1 from fleet_members where fleet_id = p_fleet and user_id = auth.uid()) as member,
           exists (select 1 from fleets where id = p_fleet and owner_id = auth.uid() and kind = 'fleet') as sees_live
  ), wk as (
    select t.user_id,
           round(sum(t.smooth_score * t.distance_km) / nullif(sum(t.distance_km), 0), 1) as eco_score,
           round(sum(t.distance_km), 1) as distance_km,
           round(sum(t.pm25_emitted_mg), 1) as pm25_mg,
           sum(t.zones_respected)::bigint as zones_respected
    from trips t
    where t.mode = 'gps'
      and t.started_at >= (date_trunc('week', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')
    group by t.user_id
  )
  select m.nickname, p.avatar, m.user_id = auth.uid(), f.owner_id = m.user_id,
         wk.eco_score, coalesce(wk.distance_km, 0), coalesce(wk.pm25_mg, 0), coalesce(wk.zones_respected, 0),
         case when f.kind = 'fleet' then (l.updated_at > now() - interval '45 seconds') end,
         case when me.sees_live or (m.user_id = auth.uid() and f.kind = 'fleet') then l.lat end,
         case when me.sees_live or (m.user_id = auth.uid() and f.kind = 'fleet') then l.lng end,
         case when f.kind = 'fleet' then l.speed_kmh end, case when f.kind = 'fleet' then l.level end
  from fleet_members m
  join fleets f on f.id = m.fleet_id
  cross join me
  left join profiles p on p.user_id = m.user_id
  left join wk on wk.user_id = m.user_id
  left join live_status l on l.user_id = m.user_id
  where m.fleet_id = p_fleet and me.member
  order by wk.eco_score desc nulls last, m.nickname;
$$;

revoke all on function public.create_fleet(text, text, text), public.my_fleets() from public, anon;
grant execute on function public.create_fleet(text, text, text), public.my_fleets() to authenticated;

-- ---------- Alertas da comunidade: confirmar ou negar (estilo "ainda está aí?") ----------
create table if not exists public.zone_votes (
  zone_id uuid not null references public.risk_zones (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  still_there boolean not null,
  voted_at timestamptz not null default now(),
  primary key (zone_id, user_id)
);
alter table public.zone_votes enable row level security;
drop policy if exists "votes_own" on public.zone_votes;
create policy "votes_own" on public.zone_votes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Zonas válidas: somem quando há mais "não está mais" do que "ainda está", ou quando um aviso de
-- buraco/obra passa de 21 dias sem nenhuma confirmação.
create or replace function public.live_risk_zones()
returns table (id uuid, user_id uuid, name text, type text, lat numeric, lng numeric, radius_m integer, note text, confirms bigint, denies bigint, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select z.id, z.user_id, z.name, z.type, z.lat, z.lng, z.radius_m, z.note,
         count(v.*) filter (where v.still_there), count(v.*) filter (where not v.still_there), z.created_at
  from risk_zones z left join zone_votes v on v.zone_id = z.id
  group by z.id
  having count(v.*) filter (where not v.still_there) <= count(v.*) filter (where v.still_there)
     and (z.type not in ('pavement', 'works') or z.created_at > now() - interval '21 days' or max(v.voted_at) filter (where v.still_there) > now() - interval '21 days')
  limit 2000;
$$;
revoke all on function public.live_risk_zones() from public, anon;
grant execute on function public.live_risk_zones() to authenticated;
