-- =====================================================================
-- 002: Status for Hertz-sjekken, varsel til admin og opprydding
-- Kjøres ÉN gang i Supabase: SQL Editor → lim inn alt → Run
-- =====================================================================

-- Én rad som holder styr på hvordan det går med sjekken
create table public.app_status (
  id                    smallint primary key default 1 check (id = 1),
  last_check_at         timestamptz,
  last_ok_at            timestamptz,
  consecutive_failures  int not null default 0,
  last_error            text,
  admin_chat_id         bigint
);

insert into public.app_status (id) values (1);

alter table public.app_status enable row level security;
revoke all on public.app_status from anon, authenticated;

-- Nettsiden får bare se når Hertz sist ble sjekket, ingenting annet
grant select (last_ok_at) on public.app_status to anon, authenticated;
create policy app_status_read on public.app_status for select to anon, authenticated using (true);
grant all on public.app_status to service_role;

-- Du får varsel på Telegram hvis sjekken feiler flere ganger på rad
update public.app_status
   set admin_chat_id = (
     select p.telegram_chat_id
       from public.profiles p
       join auth.users u on u.id = p.id
      where u.email = 'trevis.eikrem@gmail.com'
   );

-- Rydd loggen over planlagte kjøringer hver søndag kl. 04 (UTC)
select cron.schedule(
  'cleanup-cron-log',
  '0 4 * * 0',
  $$ delete from cron.job_run_details where end_time < now() - interval '7 days' $$
);

notify pgrst, 'reload schema';

-- Kontroll: skal vise true
select admin_chat_id is not null as admin_varsel_klart from public.app_status;
