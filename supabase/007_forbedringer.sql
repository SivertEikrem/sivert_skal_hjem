-- =====================================================================
-- 007: Stille timer, historikk per rute og helsesjekk
-- Kjøres ÉN gang i Supabase: SQL Editor → lim inn alt → Run
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. STILLE TIMER — på som standard fra 23 til 07 (norsk tid)
-- ---------------------------------------------------------------------
alter table public.profiles
  add column quiet_from smallint default 23,
  add column quiet_to   smallint default 7,
  add constraint quiet_hours_valid check (
    (quiet_from is null and quiet_to is null)
    or (quiet_from between 0 and 23 and quiet_to between 0 and 23)
  );

-- Brukeren får lov til å endre sine egne stille timer
grant update (notifications_enabled, digest_hours, quiet_from, quiet_to) on public.profiles to authenticated;


-- ---------------------------------------------------------------------
-- 2. HISTORIKK — hver bil som har vært ledig, også etter at den er borte
-- ---------------------------------------------------------------------
create table public.trip_history (
  id             text primary key,   -- Hertz sin id
  car_model      text,
  from_name      text not null,
  from_city      text not null,
  to_name        text not null,
  to_city        text not null,
  available_at   timestamptz,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);

create index trip_history_cities_idx on public.trip_history (from_city, to_city);
create index trip_history_seen_idx on public.trip_history (first_seen_at);

-- Ta med bilene som er ledige akkurat nå, så historikken starter i dag
insert into public.trip_history (id, car_model, from_name, from_city, to_name, to_city, available_at, first_seen_at, last_seen_at)
select id, car_model, from_name, from_city, to_name, to_city, available_at, first_seen_at, last_seen_at
  from public.trips
on conflict (id) do nothing;

alter table public.trip_history enable row level security;
revoke all on public.trip_history from anon, authenticated;
grant all on public.trip_history to service_role;
-- Nettsiden leser historikken bare gjennom route_stats() under


-- Statistikk for én rute (tomt felt = hvor som helst)
create or replace function public.route_stats(p_from text, p_to text)
returns table (
  biler_30_dager  int,
  biler_90_dager  int,
  vanligste_dag   int,          -- 1 = mandag … 7 = søndag, norsk tid
  snitt_timer     numeric,      -- hvor lenge en bil typisk ligger ute
  sist_sett       timestamptz,
  historikk_fra   timestamptz   -- når vi begynte å samle
)
language sql
stable
security definer
set search_path = ''
as $$
  with r as (
    select *
      from public.trip_history
     where (p_from is null or from_city = p_from)
       and (p_to   is null or to_city   = p_to)
       and first_seen_at > now() - interval '90 days'
  ),
  dag as (
    select extract(isodow from first_seen_at at time zone 'Europe/Oslo')::int as d, count(*) as n
      from r
     group by 1
     order by n desc, d
     limit 1
  )
  select
    (select count(*) from r where first_seen_at > now() - interval '30 days')::int,
    (select count(*) from r)::int,
    (select d from dag),
    (select round(avg(extract(epoch from (last_seen_at - first_seen_at)) / 3600)::numeric, 1)
       from r where last_seen_at < now() - interval '15 minutes'),   -- bare biler som er borte
    (select max(first_seen_at) from r),
    (select min(first_seen_at) from public.trip_history);
$$;

revoke execute on function public.route_stats(text, text) from public;
grant execute on function public.route_stats(text, text) to anon, authenticated;


-- Rydd: historikk eldre enn ett år
select cron.schedule(
  'cleanup-trip-history',
  '15 4 * * 0',
  $$ delete from public.trip_history where last_seen_at < now() - interval '365 days' $$
);


-- ---------------------------------------------------------------------
-- 3. HELSESJEKK — health-funksjonen får lese Hjemferd-statusen
-- ---------------------------------------------------------------------
-- (health bruker service_role, så ingen ekstra tilgang trengs her)


notify pgrst, 'reload schema';

-- Kontroll: skal vise 23, 7 og et tall større enn 0
select
  (select quiet_from from public.profiles limit 1) as stille_fra,
  (select quiet_to   from public.profiles limit 1) as stille_til,
  (select count(*)   from public.trip_history)     as biler_i_historikken;
