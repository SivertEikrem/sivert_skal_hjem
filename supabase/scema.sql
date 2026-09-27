-- =====================================================================
-- sivert_skal_hjem — hele databasen
-- Kjøres ÉN gang i Supabase: SQL Editor → lim inn alt → Run
-- =====================================================================

-- Utvidelser som trengs senere (planlagte jobber og HTTP-kall fra databasen)
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;


-- ---------------------------------------------------------------------
-- 1. PROFILER — én rad per bruker, opprettes automatisk ved registrering
-- ---------------------------------------------------------------------
create table public.profiles (
  id                        uuid primary key references auth.users (id) on delete cascade,
  telegram_chat_id          bigint unique,
  telegram_username         text,
  telegram_link_code        text unique,
  telegram_link_expires_at  timestamptz,
  notifications_enabled     boolean not null default true,
  -- Klokkeslett (norsk tid, 0–23) for daglig oppsummering. Tom liste = av.
  digest_hours              smallint[] not null default '{}',
  created_at                timestamptz not null default now(),
  constraint digest_hours_valid check (
    digest_hours <@ array[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]::smallint[]
  )
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------
-- 2. RUTER BRUKEREN FØLGER
--    Tom from_city = «fra hvor som helst», tom to_city = «til hvor som helst»
-- ---------------------------------------------------------------------
create table public.watched_routes (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  from_city   text,
  to_city     text,
  created_at  timestamptz not null default now(),
  constraint route_not_empty check (from_city is not null or to_city is not null)
);

create unique index watched_routes_unique
  on public.watched_routes (user_id, coalesce(from_city, ''), coalesce(to_city, ''));
create index watched_routes_user_idx on public.watched_routes (user_id);


-- ---------------------------------------------------------------------
-- 3. STASJONER — speiling av Hertz sin stasjonsliste, med normalisert by
-- ---------------------------------------------------------------------
create table public.stations (
  name        text primary key,
  code        text,
  city        text not null,   -- normalisert (GARDERMOEN → OSLO osv.)
  city_raw    text,            -- slik Hertz har registrert den
  lat         double precision,
  lon         double precision,
  updated_at  timestamptz not null default now()
);

create index stations_city_idx on public.stations (city);


-- ---------------------------------------------------------------------
-- 4. LEDIGE TURER — øyeblikksbilde av Hertz, oppdateres ved hver sjekk
-- ---------------------------------------------------------------------
create table public.trips (
  id              text primary key,   -- Hertz sin id
  car_model       text,
  from_name       text not null,
  from_city       text not null,
  to_name         text not null,
  to_city         text not null,
  available_at    timestamptz,
  latest_return   timestamptz,
  expire_time     timestamptz,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);

create index trips_cities_idx on public.trips (from_city, to_city);


-- ---------------------------------------------------------------------
-- 5. HVEM HAR FÅTT VARSEL OM HVA — per bruker, ikke globalt
-- ---------------------------------------------------------------------
create table public.sent_notifications (
  user_id  uuid not null references public.profiles (id) on delete cascade,
  trip_id  text not null,
  sent_at  timestamptz not null default now(),
  primary key (user_id, trip_id)
);

create table public.sent_digests (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  digest_date  date not null,
  digest_hour  smallint not null,
  sent_at      timestamptz not null default now(),
  primary key (user_id, digest_date, digest_hour)
);


-- ---------------------------------------------------------------------
-- 6. TELEGRAM-KOBLING — nettsiden ber om en engangskode (gyldig 15 min)
-- ---------------------------------------------------------------------
create or replace function public.create_telegram_link_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Ikke innlogget';
  end if;

  v_code := replace(gen_random_uuid()::text, '-', '');

  update public.profiles
     set telegram_link_code = v_code,
         telegram_link_expires_at = now() + interval '15 minutes'
   where id = auth.uid();

  return v_code;
end;
$$;

create or replace function public.unlink_telegram()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Ikke innlogget';
  end if;

  update public.profiles
     set telegram_chat_id = null,
         telegram_username = null,
         telegram_link_code = null,
         telegram_link_expires_at = null
   where id = auth.uid();
end;
$$;

revoke execute on function public.create_telegram_link_code() from public, anon;
revoke execute on function public.unlink_telegram()           from public, anon;
grant  execute on function public.create_telegram_link_code() to authenticated;
grant  execute on function public.unlink_telegram()           to authenticated;


-- ---------------------------------------------------------------------
-- 7. TILGANGSKONTROLL
-- ---------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.watched_routes     enable row level security;
alter table public.stations           enable row level security;
alter table public.trips              enable row level security;
alter table public.sent_notifications enable row level security;
alter table public.sent_digests       enable row level security;

-- Start fra null, og gi bare det som trengs
revoke all on public.profiles, public.watched_routes, public.stations,
              public.trips, public.sent_notifications, public.sent_digests
  from anon, authenticated;

-- Profiler: se egen, og endre bare varselinnstillingene sine
grant select on public.profiles to authenticated;
grant update (notifications_enabled, digest_hours) on public.profiles to authenticated;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Ruter: se, legge til og slette egne
grant select, insert, delete on public.watched_routes to authenticated;

create policy routes_select_own on public.watched_routes
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy routes_insert_own on public.watched_routes
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy routes_delete_own on public.watched_routes
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Stasjoner og turer: offentlig lesbare (det er Hertz sine åpne data)
grant select on public.stations, public.trips to anon, authenticated;

create policy stations_read_all on public.stations for select to anon, authenticated using (true);
create policy trips_read_all    on public.trips    for select to anon, authenticated using (true);

-- sent_notifications / sent_digests: ingen tilgang fra nettsiden,
-- bare backenden (service_role) bruker dem.

-- Backenden skal ha full tilgang til alt
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;


-- Ferdig: be API-et lese inn de nye tabellene med én gang
notify pgrst, 'reload schema';
