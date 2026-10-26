# Sivert skal hjem

Varsler på Telegram når det dukker opp en gratis returbil på rutene du følger.
Nettsiden ligger på [sivertskalhjem.no](https://sivertskalhjem.no).

Et privat hobbyprosjekt. Ikke tilknyttet noe utleieselskap.

## Hvordan det henger sammen

```
                    hvert 5. min                       hver halvtime
 hertzfreerider.no ─────────────► check-trips   hjemferd.no ─────────► check-hjemferd
   (åpent API)                        │           (åpen liste)              │
                                      ▼                                     ▼
                              ┌──────────────── Supabase ─────────────────────┐
                              │  database: brukere, ruter, biler, historikk   │
                              │  pg_cron: starter sjekkene                    │
                              │  Edge Functions: check-trips, check-hjemferd, │
                              │                  telegram-webhook, health     │
                              └───────┬──────────────────────────▲────────────┘
                                      │ varsler                  │ /start, /ledige …
                                      ▼                          │
                              Telegram-bot @Sivertskalhjem_bot ──┘
                                      ▲
 Nettsiden (GitHub Pages, docs/) ─────┘ innlogging, ruter og kart via Supabase
```

- **Nettsiden** er statiske filer i `docs/`. Den snakker direkte med Supabase via den offentlige nøkkelen i `docs/config.js`. Tilgang styres av databasereglene (RLS), ikke av nøkkelen.
- **check-trips** henter ledige biler, lagrer dem, og sender hver bruker bare treffene på sine egne ruter. Hver bil varsles bare én gang per bruker.
- **check-hjemferd** leser lista på hjemferd.no og sender et kort tips når en by du følger dukker opp. Den gjengir ikke annonsen, bare lenker dit.
- **telegram-webhook** tar imot meldinger til boten: kobler til kontoer og svarer på kommandoer.
- **health** svarer 200 når sjekkene går som de skal, og 503 ellers. Brukes av en ekstern overvåkingstjeneste.
- **E-post** (bekreftelse og nytt passord) sendes av Supabase via Resend, fra `noreply@sivertskalhjem.no`.

## Mappestruktur

```
docs/                      nettsiden (GitHub Pages serverer denne mappen)
  config.js                Supabase-URL og offentlig nøkkel – fylles ut én gang
  common.js                felles kode: tekst, datoer, turkort, tema
  map.js, norway-map.js    Norgeskartet (kystlinje fra Natural Earth, offentlig eiendom)
  index / login / app / oversikt / personvern   sidene
  manifest.webmanifest, *.png                   app-ikon og delingsbilde
  CNAME                    domenet
supabase/
  schema.sql               grunnoppsettet
  002_…sql – 007_…sql      senere endringer, kjøres i rekkefølge
  functions/<navn>/index.ts   én fil per Edge Function
  008_epost.sql            e-postvarsler (valgfritt tillegg)
  functions/send-email-alerts/  e-postvarsler, flere filer (logikken ligger i logic.ts og run.ts)
  tests/                   tester, se tests/README.md
```

## Sette opp fra bunnen

1. **Supabase:** lag et prosjekt i en europeisk region.
2. **Database:** kjør `supabase/schema.sql`, deretter `002` til `007` i rekkefølge, i SQL Editor.
   - `003` lager to hemmeligheter i Vault (`cron_secret`, `telegram_webhook_secret`).
3. **Hemmeligheter** under Edge Functions → Secrets:
   - `TELEGRAM_BOT_TOKEN` – fra BotFather
   - `CRON_SECRET` – verdien av `cron_secret` i Vault
   - `TELEGRAM_WEBHOOK_SECRET` – verdien av `telegram_webhook_secret` i Vault
4. **Funksjoner:** opprett `check-trips`, `check-hjemferd`, `telegram-webhook` og `health` med koden fra `supabase/functions/`. Slå av JWT-verifisering på alle fire; de sjekker selv det de trenger.
5. **Planlagte jobber:** `002`, `003`, `006` og `007` setter dem opp. Sjekk med `select jobname, schedule from cron.job;`
6. **Telegram-webhook:** åpne i nettleseren (bytt ut verdiene):
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<prosjekt-id>.supabase.co/functions/v1/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
   ```
   Kommandomenyen settes hos BotFather med `/setcommands`.
7. **Nettside:** fyll ut `docs/config.js`, slå på GitHub Pages fra `main` / `docs`, og sett domenet.
8. **Innlogging:** Authentication → URL Configuration: Site URL `https://sivertskalhjem.no`, Redirect URL `https://sivertskalhjem.no/**`.
9. **E-post:** Resend-domene med DNS-oppføringene de oppgir, og Custom SMTP i Supabase (`smtp.resend.com`, port 465, bruker `resend`). E-postmalene ligger i Supabase under Authentication → Emails → Templates og lenker til `login.html?token_hash=…`.

Ingen hemmeligheter skal noen gang ligge i dette repoet.

## E-postvarsler (valgfritt)

Brukere kan krysse av for e-post på «Mine ruter», ved siden av eller i stedet for Telegram. Dette er et rent tillegg: `check-trips`, `check-hjemferd` og Telegram-varslene er urørt. `send-email-alerts` leser `trips` som `check-trips` allerede fyller ut, og har sin egen oversikt over hva som er sendt (`email_sent`).

**Slå på:**
1. Kjør `supabase/008_epost.sql`.
2. I Resend: lag en API-nøkkel (bare sending, gjerne begrenset til domenet). Domenet `sivertskalhjem.no` er allerede satt opp for innloggings-e-postene.
3. Edge Functions → Secrets:
   - `RESEND_API_KEY`
   - `EMAIL_FROM`, for eksempel `Sivert skal hjem <varsler@sivertskalhjem.no>`
   - `EMAIL_REPLY_TO` (valgfri)
   - `EMAIL_ALERTS_ENABLED` = `true` (legg denne inn sist)
4. Opprett funksjonen `send-email-alerts` med **alle filene** i `supabase/functions/send-email-alerts/` (ikke bare `index.ts`), og slå av JWT-verifisering. Med CLI: `supabase functions deploy send-email-alerts --no-verify-jwt`.
5. Prøv den: kjør Hertz-sjekken-eksempelet under med `send-email-alerts`, og se svaret med `net._http_response`. Svaret forklarer på norsk hva som skjedde og viser aldri nøkler eller e-postadresser.

**Rekkefølge:** nettsiden går live så snart endringen slås sammen i `main`. Gjør steg 1–5 først. Er `008_epost.sql` ikke kjørt, skjules e-postvalget uten feilmelding. Er SQL-en kjørt, men funksjonen ikke deployet eller bryteren av, kan brukere krysse av uten at det sendes noe.

**Slå av:** sett `EMAIL_ALERTS_ENABLED` til `false` (eller slett den). Da svarer funksjonen 200 og gjør ingenting. Ønsker du den helt av: `select cron.unschedule('send-email-alerts');`. Hvordan alt fjernes står nederst i `008_epost.sql`.

**Hvis noe er galt, gjør den ingenting og sier fra:** manglende secrets, utdatert bil-liste (check-trips har stoppet), feil nøkkel hos Resend eller feil ved lagring gir HTTP 500 med forklaring. En bil regnes som sendt først når Resend har bekreftet.

Bryteren «Send varsel når en ny bil dukker opp» (`profiles.notifications_enabled`) er en hovedbryter som også gjelder e-post. Stille timer og daglig oversikt støttes foreløpig ikke på e-post.

## Nyttig i SQL Editor

Kjør Hertz-sjekken nå:
```sql
select net.http_post(
  url := 'https://<prosjekt-id>.supabase.co/functions/v1/check-trips',
  headers := jsonb_build_object('Content-Type','application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
  timeout_milliseconds := 60000);
```
(Bytt `check-trips` med `check-hjemferd` for Hjemferd.)

Se hva sjekkene svarte:
```sql
select status_code, content, error_msg, created from net._http_response order by created desc limit 5;
```

Status og siste feil:
```sql
select * from app_status;
```

Få alle varsler på nytt (for å vise frem systemet):
```sql
delete from sent_notifications where user_id = (select id from auth.users where email = '<din e-post>');
```

## Ting å vite

- **Byer som heter noe annet:** flyplasser er ofte registrert under kommunen (Gardermoen, Stjørdal, Sola …). Oversettelsen ligger i `CITY_ALIASES` øverst i `check-trips` og `check-hjemferd`.
- **Hjemferd leses fra selve nettsiden.** Endrer de utseendet, kan sjekken slutte å finne annonser. Den feiler da med en forklaring, og du får varsel på Telegram etter tre feil på rad.
- **Feilvarsler:** både Hertz- og Hjemferd-sjekken sender deg en melding på Telegram når de har feilet tre ganger på rad, og en ny når de virker igjen. Stopper hele Supabase-prosjektet, fanger den eksterne overvåkingen av `health` det opp.
- **Gratisnivået i Supabase** kan sette prosjekter på pause ved lav aktivitet. Overvåkingen og de planlagte jobbene gir jevnlig aktivitet, men sjekk dashbordet hvis varslene stopper.
