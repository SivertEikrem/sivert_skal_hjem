-- =====================================================================
-- 005: Datoer på ruter, og maks 20 ruter per bruker
-- Kjøres ÉN gang i Supabase: SQL Editor → lim inn alt → Run
-- =====================================================================

-- Valgfri periode på en rute (norske datoer). Tom = gjelder alltid.
alter table public.watched_routes
  add column date_from date,
  add column date_to   date,
  add constraint route_dates_valid
    check (date_from is null or date_to is null or date_to >= date_from);

-- Samme rute kan nå følges for flere ulike perioder
drop index public.watched_routes_unique;
create unique index watched_routes_unique on public.watched_routes (
  user_id,
  coalesce(from_city, ''),
  coalesce(to_city, ''),
  coalesce(date_from, '-infinity'::date),
  coalesce(date_to, 'infinity'::date)
);

-- Maks 20 ruter per bruker
create or replace function public.enforce_route_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.watched_routes where user_id = new.user_id) >= 20 then
    raise exception 'route_limit' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger watched_routes_limit
  before insert on public.watched_routes
  for each row execute function public.enforce_route_limit();

notify pgrst, 'reload schema';
