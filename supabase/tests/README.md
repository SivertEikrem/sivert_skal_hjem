# Tester

Gjelder foreløpig e-postvarslene (`functions/send-email-alerts/`, `008_epost.sql` og `docs/email.js`).
Trenger [Deno](https://deno.com) til TypeScript-testene. SQL- og integrasjonstestene trenger i tillegg Docker og Supabase CLI.

## Enhetstester (ingen nettverk, tar under ett sekund)

```
deno test --allow-read supabase/tests/
```

Dekker utvalg og formatering av e-post, Resend-feilhåndtering, hele kjøringen med falsk database og falsk e-posttjeneste, HTTP-laget (nøkkel, bryter, oppsett) og logikken bak avkrysningen på nettsiden.

`drift_test.ts` sammenligner funksjonene som er kopiert fra `check-trips` med originalene. Feiler den, er `check-trips` endret: oppdater `send-email-alerts/logic.ts` på samme måte.

## SQL- og integrasjonstester (lokal database)

Bruk et eget, tomt Supabase-prosjekt utenfor dette repoet, så ingenting havner her:

```
mkdir ~/lokal-supabase && cd ~/lokal-supabase && supabase init
supabase start -x studio,imgproxy,storage-api,realtime,mailpit,vector,logflare,postgres-meta,supavisor
```

Kjør så SQL-filene i rekkefølge (`003` stopper på `cron.unschedule('check-trips')` fordi den jobben ikke finnes lokalt; det er greit):

```
for f in schema.sql 002_status.sql 003_nye_hemmeligheter.sql 004_slett_konto.sql \
         005_datoer_og_rutegrenser.sql 006_hjemferd_tips.sql 007_forbedringer.sql 008_epost.sql; do
  docker exec -i supabase_db_lokal-supabase psql -U postgres -q < supabase/$f
done
```

Tilgangsregler, `set_email_alerts`, sletting av konto og cron-jobbene:

```
docker exec -i supabase_db_lokal-supabase psql -U postgres -q < supabase/tests/send-email-alerts/008_epost_test.sql
```

Ekte databasekall og ekte brukere (bare Resend er byttet ut). Nøklene får du med `supabase status -o env`. Testen nekter å kjøre mot noe annet enn localhost.

```
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
  deno test --allow-net --allow-env supabase/tests/send-email-alerts/integration_local.ts
```

## Det testene ikke dekker

Selve kallet til Resend med en ekte nøkkel. Sjekk det manuelt første gang, med én testkonto, før e-post slås på for alle.
