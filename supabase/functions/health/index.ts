// health
// Offentlig helsesjekk for en ekstern overvåkingstjeneste (for eksempel UptimeRobot).
// Svarer 200 når alt er i orden og 503 når noe har stoppet opp:
//   - Hertz-sjekken skal ha lykkes de siste 20 minuttene (den går hvert 5. minutt)
//   - Hjemferd-sjekken skal ha lykkes de siste 2 timene (den går hver halvtime)
// Svarer den ikke i det hele tatt, er hele Supabase-prosjektet nede eller satt på pause.
// Viser ingen hemmeligheter eller brukerdata, bare tidspunkter.

import { createClient } from "npm:@supabase/supabase-js@2";

const HERTZ_MAX_MIN = 20;
const HJEMFERD_MAX_MIN = 120;

Deno.serve(async () => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  if (!url || !key) return json({ ok: false, feil: "mangler oppsett" }, 503);

  try {
    const db = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await db
      .from("app_status")
      .select("last_ok_at, hjemferd_last_ok_at")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw error;

    const minutesSince = (iso: string | null) =>
      iso ? Math.round((Date.now() - new Date(iso).getTime()) / 60000) : null;

    const hertz = minutesSince(data?.last_ok_at ?? null);
    const hjemferd = minutesSince(data?.hjemferd_last_ok_at ?? null);
    const hertzOk = hertz != null && hertz <= HERTZ_MAX_MIN;
    // Hjemferd teller ikke før den har kjørt første gang
    const hjemferdOk = hjemferd == null || hjemferd <= HJEMFERD_MAX_MIN;

    return json(
      {
        ok: hertzOk && hjemferdOk,
        hertz: { ok: hertzOk, minutter_siden: hertz },
        hjemferd: { ok: hjemferdOk, minutter_siden: hjemferd },
      },
      hertzOk && hjemferdOk ? 200 : 503,
    );
  } catch (e) {
    console.error(e);
    return json({ ok: false, feil: "databasen svarer ikke" }, 503);
  }
});
