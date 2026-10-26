-- =====================================================================
-- 006: Tips om returbiler på hjemferd.no
-- Kjøres ÉN gang i Supabase: SQL Editor → lim inn alt → Run
-- =====================================================================

-- Byer brukeren vil ha tips om (maks 10 per bruker)
create table public.tip_cities (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  city        text not null,
  created_at  timestamptz not null default now(),
  constraint tip_city_valid check (length(trim(city)) between 2 and 40)
);

create unique index tip_cities_unique on public.tip_cities (user_id, city);
create index tip_cities_user_idx on public.tip_cities (user_id);

create or replace function public.enforce_tip_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.tip_cities where user_id = new.user_id) >= 10 then
    raise exception 'tip_limit' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger tip_cities_limit
  before insert on public.tip_cities
  for each row execute function public.enforce_tip_limit();

-- Annonser vi har sett (bare id og rutetekst, for å kjenne igjen nye)
create table public.hjemferd_listings (
  id             text primary key,
  from_text      text,
  to_text        text,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);

-- Hvem har fått tips om hvilken annonse
create table public.hjemferd_sent (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  listing_id  text not null,
  sent_at     timestamptz not null default now(),
  primary key (user_id, listing_id)
);

-- Status for Hjemferd-sjekken (egen fra Hertz-sjekken)
alter table public.app_status
  add column hjemferd_last_ok_at  timestamptz,
  add column hjemferd_failures    int not null default 0,
  add column hjemferd_last_error  text;

-- Tilgang
alter table public.tip_cities  enable row level security;
alter table public.hjemferd_listings enable row level security;
alter table public.hjemferd_sent     enable row level security;

revoke all on public.tip_cities, public.hjemferd_listings, public.hjemferd_sent
  from anon, authenticated;

grant select, insert, delete on public.tip_cities to authenticated;

create policy tip_cities_select_own on public.tip_cities
  for select to authenticated using ((select auth.uid()) = user_id);
create policy tip_cities_insert_own on public.tip_cities
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy tip_cities_delete_own on public.tip_cities
  for delete to authenticated using ((select auth.uid()) = user_id);

grant all on public.tip_cities, public.hjemferd_listings, public.hjemferd_sent to service_role;
grant all on all sequences in schema public to service_role;

-- Sjekk hjemferd.no hver halvtime
select cron.schedule(
  'check-hjemferd',
  '7,37 * * * *',
  $$
  select net.http_post(
    url := 'https://kbyuqkrzpjgnuuqpvhft.supabase.co/functions/v1/check-hjemferd',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 60000
  );
  $$
);

notify pgrst, 'reload schema';
