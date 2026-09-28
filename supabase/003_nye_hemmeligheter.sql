-- =====================================================================
-- 003: Nye hemmeligheter, lagret i Supabase Vault
-- Kjøres ÉN gang i Supabase: SQL Editor → lim inn alt → Run
-- =====================================================================

-- To nye, tilfeldige nøkler: én for den planlagte jobben, én for Telegram
select vault.create_secret(gen_random_uuid()::text, 'cron_secret', 'x-cron-secret for check-trips');
select vault.create_secret(gen_random_uuid()::text, 'telegram_webhook_secret', 'secret_token for telegram-webhook');

-- Den planlagte jobben henter nøkkelen fra Vault i stedet for å ha den skrevet inn
select cron.unschedule('check-trips');
select cron.schedule(
  'check-trips',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://kbyuqkrzpjgnuuqpvhft.supabase.co/functions/v1/check-trips',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 60000
  );
  $$
);

-- Vis de nye nøklene (kopier dem til Edge Functions → Secrets)
select name, decrypted_secret
  from vault.decrypted_secrets
 where name in ('cron_secret', 'telegram_webhook_secret')
 order by name;
