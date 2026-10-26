-- =====================================================================
-- 008: E-postvarsler, som tillegg ved siden av Telegram
-- Kjøres ÉN gang i Supabase: SQL Editor → lim inn alt → Run
--
-- Bare nye tabeller, en ny funksjon og to nye planlagte jobber. Ingenting
-- eksisterende endres, så Telegram-varslene påvirkes ikke.
--
-- SKRU AV E-POST:
--   Enklest:  sett secreten EMAIL_ALERTS_ENABLED til false (Edge Functions → Secrets).
--   Helt av:  select cron.unschedule('send-email-alerts');
--   Fjerne alt:  se bunnen av filen.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. HVEM VIL HA E-POST — brukeren velger selv på nettsiden. Standard er av.
--    E-postadressen hentes fra innloggingen (auth.users), den lagres ikke her.
-- ---------------------------------------------------------------------
create table if not exists public.email_subscriptions (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  enabled     boolean not null default false,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. HVA ER SENDT PÅ E-POST — egen oversikt, uavhengig av Telegram
-- ---------------------------------------------------------------------
create table if not exists public.email_sent (
  user_id  uuid not null references public.profiles (id) on delete cascade,
  trip_id  text not null,
  sent_at  timestamptz not null default now(),
  primary key (user_id, trip_id)
);

-- ---------------------------------------------------------------------
-- 3. TILGANGSKONTROLL — samme prinsipp som ellers: start fra null
-- ---------------------------------------------------------------------
alter table public.email_subscriptions enable row level security;
alter table public.email_sent          enable row level security;

revoke all on public.email_subscriptions, public.email_sent from anon, authenticated;

-- Brukeren kan se sin egen innstilling. Endring går gjennom set_email_alerts() under.
grant select on public.email_subscriptions to authenticated;

drop policy if exists email_subscriptions_select_own on public.email_subscriptions;
create policy email_subscriptions_select_own on public.email_subscriptions
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- email_sent: ingen tilgang fra nettsiden, bare backenden (service_role)

grant all on public.email_subscriptions, public.email_sent to service_role;

-- ---------------------------------------------------------------------
-- 4. SLÅ E-POST AV OG PÅ — nettsiden kaller denne
-- ---------------------------------------------------------------------
create or replace function public.set_email_alerts(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Ikke innlogget';
  end if;
  if p_enabled is null then
    raise exception 'p_enabled må være true eller false';
  end if;

  insert into public.email_subscriptions (user_id, enabled)
  values (auth.uid(), p_enabled)
  on conflict (user_id) do update
    set enabled = excluded.enabled,
        updated_at = now();
end;
$$;

revoke execute on function public.set_email_alerts(boolean) from public, anon;
grant  execute on function public.set_email_alerts(boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 5. PLANLAGTE JOBBER
--    send-email-alerts: hvert 5. minutt, ett minutt etter check-trips, så nye biler
--                       er lagret før e-postene sendes.
--    cleanup-email-sent: rydder bort gamle rader hver søndag kl. 04:15 (UTC).
--    Jobben gjør ingenting før Edge Function-en er opprettet og EMAIL_ALERTS_ENABLED er true.
-- ---------------------------------------------------------------------
select cron.schedule(
  'send-email-alerts',
  '1-59/5 * * * *',
  $$
  select net.http_post(
    url := 'https://kbyuqkrzpjgnuuqpvhft.supabase.co/functions/v1/send-email-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 60000
  );
  $$
);

select cron.schedule(
  'cleanup-email-sent',
  '15 4 * * 0',
  $$ delete from public.email_sent where sent_at < now() - interval '60 days' $$
);

notify pgrst, 'reload schema';

-- Kontroll: skal vise begge jobbene
select jobname, schedule from cron.job where jobname in ('send-email-alerts', 'cleanup-email-sent') order by jobname;

-- ---------------------------------------------------------------------
-- FJERNE ALT (kjør bare dette hvis e-post skal bort for godt):
--
--   select cron.unschedule('send-email-alerts');
--   select cron.unschedule('cleanup-email-sent');
--   drop function if exists public.set_email_alerts(boolean);
--   drop table if exists public.email_sent;
--   drop table if exists public.email_subscriptions;
-- ---------------------------------------------------------------------
