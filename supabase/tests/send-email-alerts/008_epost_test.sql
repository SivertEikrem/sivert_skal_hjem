-- Test av 008_epost.sql. Kjøres mot en LOKAL database der schema.sql og 002–008 er kjørt
-- (se supabase/tests/README.md). Alt skjer i én transaksjon som rulles tilbake, og testen
-- stopper med en feilmelding ved første avvik.
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');

do $$ begin
  assert (select count(*) from public.profiles where id in
    ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b')) = 2,
    'profiler skal opprettes automatisk';
end $$;

-- ---------------------------------------------------------------- bruker A
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
set local role authenticated;

select public.set_email_alerts(true);

-- ---------------------------------------------------------------- bruker B
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;

select public.set_email_alerts(false);

-- Sett et gammelt tidsstempel, siden now() er det samme gjennom hele denne transaksjonen
reset role;
update public.email_subscriptions set updated_at = '2000-01-01' where user_id = '00000000-0000-0000-0000-00000000000a';

-- ---------------------------------------------------------------- tilbake som A
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_before timestamptz;
  v_after  timestamptz;
begin
  assert (select count(*) from public.email_subscriptions) = 1, 'A skal bare se sin egen rad';
  assert (select enabled from public.email_subscriptions) = true, 'A sin innstilling skal være på';

  -- Kan kalles flere ganger uten å lage flere rader
  select updated_at into v_before from public.email_subscriptions;
  assert v_before = '2000-01-01', 'testoppsett: gammelt tidsstempel';
  perform public.set_email_alerts(false);
  perform public.set_email_alerts(true);
  perform public.set_email_alerts(false);
  select updated_at into v_after from public.email_subscriptions;
  assert (select count(*) from public.email_subscriptions) = 1, 'fortsatt bare én rad';
  assert (select enabled from public.email_subscriptions) = false, 'siste kall vinner';
  assert v_after > v_before, 'updated_at skal oppdateres';
  perform public.set_email_alerts(true);
end $$;

-- A kan ikke endre tabellene direkte, bare gjennom funksjonen
do $$ begin
  begin
    insert into public.email_subscriptions (user_id, enabled) values ('00000000-0000-0000-0000-00000000000b', true);
    raise exception 'FEIL: A kunne sette inn rad direkte';
  exception when insufficient_privilege then null; end;

  begin
    update public.email_subscriptions set enabled = false;
    raise exception 'FEIL: A kunne oppdatere direkte';
  exception when insufficient_privilege then null; end;

  begin
    delete from public.email_subscriptions;
    raise exception 'FEIL: A kunne slette direkte';
  exception when insufficient_privilege then null; end;

  begin
    perform 1 from public.email_sent;
    raise exception 'FEIL: A kunne lese email_sent';
  exception when insufficient_privilege then null; end;

  begin
    insert into public.email_sent (user_id, trip_id) values ('00000000-0000-0000-0000-00000000000a', 'x');
    raise exception 'FEIL: A kunne skrive til email_sent';
  exception when insufficient_privilege then null; end;
end $$;

-- Ugyldig verdi avvises og endrer ingenting
do $$ begin
  begin
    perform public.set_email_alerts(null);
    raise exception 'FEIL: null ble godtatt';
  exception when others then
    if sqlerrm like 'FEIL:%' then raise; end if;
  end;
  assert (select enabled from public.email_subscriptions) = true, 'verdien skal være uendret etter avvist kall';
end $$;

-- ---------------------------------------------------------------- innlogget uten bruker-id
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
set local role authenticated;

do $$ begin
  begin
    perform public.set_email_alerts(true);
    raise exception 'FEIL: kall uten bruker-id ble godtatt';
  exception when others then
    if sqlerrm not like '%Ikke innlogget%' then raise; end if;
  end;
end $$;

-- ---------------------------------------------------------------- anonym
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

do $$
declare
  v_reached boolean := false;
begin
  -- Anonym skal stoppes før funksjonen kjører (manglende rettighet), ikke inni den
  begin
    perform public.set_email_alerts(true);
    v_reached := true;
  exception
    when insufficient_privilege then null;
    when others then v_reached := true;
  end;
  assert not v_reached, 'FEIL: anonym nådde set_email_alerts';

  begin
    perform 1 from public.email_subscriptions;
    raise exception 'FEIL: anonym kunne lese email_subscriptions';
  exception when insufficient_privilege then null; end;

  begin
    perform 1 from public.email_sent;
    raise exception 'FEIL: anonym kunne lese email_sent';
  exception when insufficient_privilege then null; end;
end $$;

-- ---------------------------------------------------------------- backenden (service_role)
reset role;
set local role service_role;

do $$ begin
  assert (select count(*) from public.email_subscriptions where user_id in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b')) = 2, 'service_role ser alle';
  insert into public.email_sent (user_id, trip_id) values ('00000000-0000-0000-0000-00000000000a', 'trip-1');
  -- upsert slik funksjonen gjør det: samme rad to ganger er greit
  insert into public.email_sent (user_id, trip_id) values ('00000000-0000-0000-0000-00000000000a', 'trip-1')
    on conflict (user_id, trip_id) do nothing;
  assert (select count(*) from public.email_sent where user_id = '00000000-0000-0000-0000-00000000000a') = 1, 'ingen duplikater i email_sent';

  -- Samme spørring som funksjonen bruker for å finne abonnenter
  assert (select count(*) from public.email_subscriptions s
            join public.profiles p on p.id = s.user_id
           where s.enabled and p.notifications_enabled and s.user_id in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b')) = 1,
    'bare A (på) skal være abonnent';
  update public.profiles set notifications_enabled = false where id = '00000000-0000-0000-0000-00000000000a';
  assert (select count(*) from public.email_subscriptions s
            join public.profiles p on p.id = s.user_id
           where s.enabled and p.notifications_enabled and s.user_id in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b')) = 0,
    'pauset varsling skal gi ingen abonnenter';
end $$;

-- Standardverdi for en ny rad er av
do $$ begin
  insert into public.email_subscriptions (user_id) values ('00000000-0000-0000-0000-00000000000b')
    on conflict (user_id) do nothing;
  assert (select enabled from public.email_subscriptions where user_id = '00000000-0000-0000-0000-00000000000b') = false,
    'standard skal være av';
end $$;

-- ---------------------------------------------------------------- sletting av konto
reset role;

do $$ begin
  delete from auth.users where id = '00000000-0000-0000-0000-00000000000a';
  assert (select count(*) from public.email_subscriptions where user_id = '00000000-0000-0000-0000-00000000000a') = 0,
    'abonnement skal slettes sammen med kontoen';
  assert (select count(*) from public.email_sent where user_id = '00000000-0000-0000-0000-00000000000a') = 0,
    'email_sent skal slettes sammen med kontoen';
  assert (select count(*) from public.email_subscriptions where user_id = '00000000-0000-0000-0000-00000000000b') = 1,
    'andre brukere skal ikke påvirkes';
end $$;

-- ---------------------------------------------------------------- opprydding
-- Kjører selve kommandoen fra cron-jobben. Gamle rader for biler som ikke finnes skal bort,
-- men ikke gamle rader for biler som fortsatt er ledige, og ikke nye rader.
insert into public.trips (id, from_name, from_city, to_name, to_city)
  values ('cleanup-aktiv', 'X', 'OSLO', 'Y', 'BERGEN');

insert into public.email_sent (user_id, trip_id, sent_at) values
  ('00000000-0000-0000-0000-00000000000b', 'cleanup-gammel-borte', now() - interval '90 days'),
  ('00000000-0000-0000-0000-00000000000b', 'cleanup-gammel-aktiv',  now() - interval '90 days'),
  ('00000000-0000-0000-0000-00000000000b', 'cleanup-ny-borte',      now() - interval '1 day');
update public.trips set id = 'cleanup-gammel-aktiv' where id = 'cleanup-aktiv';

do $$ begin
  execute (select command from cron.job where jobname = 'cleanup-email-sent');
  assert not exists (select 1 from public.email_sent where trip_id = 'cleanup-gammel-borte'),
    'gammel rad for en bil som ikke finnes skal slettes';
  assert exists (select 1 from public.email_sent where trip_id = 'cleanup-gammel-aktiv'),
    'gammel rad for en bil som fortsatt er ledig skal beholdes';
  assert exists (select 1 from public.email_sent where trip_id = 'cleanup-ny-borte'),
    'ny rad skal beholdes';
end $$;

-- ---------------------------------------------------------------- planlagte jobber
do $$ begin
  assert (select schedule from cron.job where jobname = 'send-email-alerts') = '1-59/5 * * * *', 'send-email-alerts er planlagt';
  assert (select command from cron.job where jobname = 'send-email-alerts') like '%/functions/v1/send-email-alerts%', 'riktig URL';
  assert (select command from cron.job where jobname = 'send-email-alerts') like '%x-cron-secret%', 'sender med nøkkel';
  assert (select schedule from cron.job where jobname = 'cleanup-email-sent') is not null, 'opprydding er planlagt';
  -- Siverts egne jobber er urørt
  assert (select count(*) from cron.job where jobname in ('check-hjemferd', 'cleanup-cron-log')) = 2, 'eksisterende jobber er urørt';
end $$;

rollback;
\echo 'OK: alle tester i 008_epost_test.sql besto'
