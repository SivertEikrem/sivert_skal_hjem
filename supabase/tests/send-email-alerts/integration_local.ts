// Integrasjonstest mot en LOKAL Supabase (supabase start). Kjører ekte databasekall, ekte
// brukere og den ekte nettside-veien (set_email_alerts). Bare selve Resend-kallet er byttet ut.
// Kjøres ikke av `deno test supabase/tests/` fordi filen ikke heter *_test.ts. Se supabase/tests/README.md.
//
//   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
//     deno test --allow-net --allow-env supabase/tests/send-email-alerts/integration_local.ts

import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildDeps } from "../../functions/send-email-alerts/db.ts";
import { run } from "../../functions/send-email-alerts/run.ts";
import type { OutgoingMail } from "../../functions/send-email-alerts/resend.ts";

const URL_ = Deno.env.get("SUPABASE_URL");
const ANON = Deno.env.get("SUPABASE_ANON_KEY");
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!URL_ || !ANON || !SERVICE) throw new Error("Sett SUPABASE_URL, SUPABASE_ANON_KEY og SUPABASE_SERVICE_ROLE_KEY");
if (!/127\.0\.0\.1|localhost/.test(URL_)) throw new Error("Nekter å kjøre mot noe annet enn en lokal database: " + URL_);

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const tag = `itest${Date.now()}`;
// Egne bynavn, så testen aldri treffer data som allerede ligger i databasen
const CITY_FROM = `FRABY${tag}`.toUpperCase();
const CITY_TO = `TILBY${tag}`.toUpperCase();
const PASSWORD = "test-passord-123456";

async function createUser(name: string, confirmed = true) {
  const email = `${tag}-${name}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: confirmed });
  if (error) throw error;
  return { id: data.user.id, email };
}

async function subscribeViaWebsite(email: string) {
  // Som nettsiden: logg inn som brukeren og kall set_email_alerts
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInErr) throw signInErr;
  const { error } = await client.rpc("set_email_alerts", { p_enabled: true });
  if (error) throw error;
  return client;
}

const sent: OutgoingMail[] = [];
function deps() {
  const real = buildDeps({
    supabaseUrl: URL_!,
    serviceRoleKey: SERVICE!,
    resend: { apiKey: "ubrukt", from: "test@example.com" },
  });
  return { ...real, send: (m: OutgoingMail) => (sent.push(m), Promise.resolve({ status: "ok" as const })) };
}

Deno.test("integrasjon: ekte database, ekte brukere", async (t) => {
  const created: string[] = [];
  const tripIds = [`${tag}-t1`, `${tag}-t2`];
  try {
    const a = await createUser("a"); // abonnent, bekreftet
    const b = await createUser("b", false); // abonnent, ubekreftet e-post
    const c = await createUser("c"); // abonnent, men har pauset alle varsler
    const d = await createUser("d"); // ikke abonnent
    created.push(a.id, b.id, c.id, d.id);

    const aClient = await subscribeViaWebsite(a.email);
    for (const u of [b, c]) {
      const { error } = await admin.from("email_subscriptions").insert({ user_id: u.id, enabled: true });
      if (error) throw error;
    }
    {
      const { error } = await admin.from("profiles").update({ notifications_enabled: false }).eq("id", c.id);
      if (error) throw error;
    }
    for (const u of [a, b, c, d]) {
      const { error } = await admin.from("watched_routes").insert({ user_id: u.id, from_city: CITY_FROM, to_city: CITY_TO });
      if (error) throw error;
    }
    const now = new Date();
    const soon = new Date(now.getTime() + 2 * 86_400_000).toISOString();
    const { error: tripErr } = await admin.from("trips").insert(
      tripIds.map((id) => ({
        id, car_model: "Testbil", from_name: "GARDERMOEN", from_city: CITY_FROM, to_name: "BLOMSTERDALEN", to_city: CITY_TO,
        available_at: now.toISOString(), latest_return: soon, expire_time: soon, last_seen_at: now.toISOString(),
      })),
    );
    if (tripErr) throw tripErr;

    await t.step("nettsiden: brukeren ser egen innstilling, men ikke andres", async () => {
      const { data, error } = await aClient.from("email_subscriptions").select("user_id, enabled");
      assertEquals(error, null);
      assertEquals(data, [{ user_id: a.id, enabled: true }]);
    });

    await t.step("første kjøring: bare A får e-post, B hoppes over, C og D får ingenting", async () => {
      const res = await run(deps());
      const mine = sent.filter((m) => m.to.startsWith(tag));
      assertEquals(mine.map((m) => m.to), [a.email]);
      assertStringIncludes(mine[0].email.text, "Testbil");
      assertEquals(res.stats.hoppetOver, 1); // B
      assertFalse(JSON.stringify(res).includes("@"), "ingen adresser i resultatet");
      const { data } = await admin.from("email_sent").select("trip_id").eq("user_id", a.id);
      assertEquals((data ?? []).map((r) => r.trip_id).sort(), tripIds);
      const none = await admin.from("email_sent").select("user_id").in("user_id", [b.id, c.id, d.id]);
      assertEquals(none.data, []);
    });

    await t.step("andre kjøring: ingenting sendes på nytt", async () => {
      const before = sent.length;
      await run(deps());
      assertEquals(sent.length, before);
    });

    await t.step("ny bil kommer: bare den nye sendes", async () => {
      const id = `${tag}-t3`;
      tripIds.push(id);
      const soon = new Date(Date.now() + 86_400_000).toISOString();
      const { error } = await admin.from("trips").insert({
        id, car_model: "Nyere bil", from_name: "GARDERMOEN", from_city: CITY_FROM, to_name: "BLOMSTERDALEN", to_city: CITY_TO,
        available_at: new Date().toISOString(), latest_return: soon, expire_time: soon, last_seen_at: new Date().toISOString(),
      });
      if (error) throw error;
      const before = sent.length;
      await run(deps());
      const mine = sent.slice(before).filter((m) => m.to.startsWith(tag));
      assertEquals(mine.length, 1);
      assertStringIncludes(mine[0].email.text, "Nyere bil");
      assertFalse(mine[0].email.text.includes("Testbil"));
    });

    await t.step("avslått i nettsiden: A får ikke mer", async () => {
      const { error } = await aClient.rpc("set_email_alerts", { p_enabled: false });
      assertEquals(error, null);
      const id = `${tag}-t4`;
      tripIds.push(id);
      const soon = new Date(Date.now() + 86_400_000).toISOString();
      await admin.from("trips").insert({
        id, car_model: "Fjerde bil", from_name: "GARDERMOEN", from_city: CITY_FROM, to_name: "BLOMSTERDALEN", to_city: CITY_TO,
        available_at: new Date().toISOString(), latest_return: soon, expire_time: soon, last_seen_at: new Date().toISOString(),
      });
      const before = sent.length;
      await run(deps());
      assertEquals(sent.slice(before).filter((m) => m.to.startsWith(tag)).length, 0);
    });

    await t.step("sletter vi kontoen, forsvinner e-postdataene", async () => {
      const { error } = await admin.auth.admin.deleteUser(a.id);
      assertEquals(error, null);
      created.splice(created.indexOf(a.id), 1);
      const subs = await admin.from("email_subscriptions").select("user_id").eq("user_id", a.id);
      const rows = await admin.from("email_sent").select("user_id").eq("user_id", a.id);
      assertEquals(subs.data, []);
      assertEquals(rows.data, []);
    });
  } finally {
    await admin.from("trips").delete().in("id", tripIds);
    for (const id of created) await admin.auth.admin.deleteUser(id);
  }
  assert(true);
});
