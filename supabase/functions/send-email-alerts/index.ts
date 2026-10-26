// send-email-alerts
// Sender e-post til brukere som har slått på e-postvarsler, om nye biler på rutene deres.
// Går ved siden av check-trips og endrer ingenting der: leser bare trips-tabellen som
// check-trips fyller ut, og holder sin egen oversikt over hva som er sendt (email_sent).
// Kalles av pg_cron med headeren x-cron-secret.
//
// Av/på: secreten EMAIL_ALERTS_ENABLED. Alt annet enn «true» betyr av.
// Secrets: CRON_SECRET, RESEND_API_KEY, EMAIL_FROM, EMAIL_ALERTS_ENABLED, og eventuelt EMAIL_REPLY_TO.

import { buildDeps } from "./db.ts";
import { handle } from "./handler.ts";

Deno.serve((req) => handle(req, { env: (name) => Deno.env.get(name), buildDeps }));
