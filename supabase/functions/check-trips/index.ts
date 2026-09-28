// check-trips
// Henter ledige Freerider-turer fra Hertz, oppdaterer databasen og sender
// Telegram-varsler til hver bruker basert på deres egne ruter.
// Kalles av pg_cron med headeren x-cron-secret.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

const ROUTES_URL = "https://hertzfreerider.no/api/transport-routes/?country=NORWAY";
const LOCATIONS_URL = "https://hertzfreerider.no/api/locations/";

// Stasjoner Hertz har registrert under stedet de ligger i, ikke byen folk mener.
// Evenes (LILAND) står bevisst utenfor: den betjener både Harstad og Narvik.
const CITY_ALIASES: Record<string, string> = {
  "GARDERMOEN": "OSLO",
  "BLOMSTERDALEN": "BERGEN",
  "KOKSTAD": "BERGEN",
  "STJØRDAL": "TRONDHEIM",
  "SOLA": "STAVANGER",
  "KJEVIK": "KRISTIANSAND",
  "VIGRA": "ÅLESUND",
  "LIERSTRANDA": "DRAMMEN",
  "AVALDSNES": "HAUGESUND",
  "BYGSTAD": "FØRDE",
  "HESSENG": "KIRKENES",
  "SKONSENG": "MO I RANA",
  "SANDNESSNJØEN": "SANDNESSJØEN", // skrivefeil i Hertz sine data
};

const MAANEDER = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];
const UKEDAGER = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
const SMAA_ORD = new Set(["i", "og", "på", "ved"]);
const MAX_MELDING = 3800; // Telegram tillater 4096 tegn
const ALERT_AFTER = 3; // varsle admin etter så mange feil på rad (= 15 min)

type Trip = {
  id: string;
  car_model: string | null;
  from_name: string;
  from_city: string;
  to_name: string;
  to_city: string;
  available_at: string | null;
  latest_return: string | null;
  expire_time: string | null;
  last_seen_at: string;
};

type Watch = {
  user_id: string;
  from_city: string | null;
  to_city: string | null;
  date_from: string | null; // YYYY-MM-DD, norsk dato
  date_to: string | null;
};
type Profile = { id: string; telegram_chat_id: number; digest_hours: number[] | null };

// ---------------------------------------------------------------- hjelpere

function canonicalCity(raw: string): string {
  const c = raw.trim().toUpperCase();
  return CITY_ALIASES[c] ?? c;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function osloParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function osloOffsetMs(d: Date): number {
  const p = osloParts(d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

// Hertz oppgir norsk lokaltid uten tidssone. Gjør om til ekte UTC-tidspunkt.
function hertzTimeToIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  if (/([zZ]|[+-]\d\d:?\d\d)$/.test(v)) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const naive = new Date(v + "Z");
  if (isNaN(naive.getTime())) return null;
  const first = new Date(naive.getTime() - osloOffsetMs(naive));
  const exact = new Date(naive.getTime() - osloOffsetMs(first));
  return exact.toISOString();
}

function formatDato(iso: string | null): string {
  if (!iso) return "ukjent";
  const p = osloParts(new Date(iso));
  return `${p.day}. ${MAANEDER[p.month - 1]} kl. ${pad(p.hour)}:${pad(p.minute)}`;
}

function pen(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i > 0 && SMAA_ORD.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return isFinite(n) ? n : null;
}

function osloDate(iso: string): string {
  const p = osloParts(new Date(iso));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function matchesWatch(t: Trip, w: Watch): boolean {
  const from = w.from_city?.trim().toUpperCase() || null;
  const to = w.to_city?.trim().toUpperCase() || null;
  if (from && from !== t.from_city) return false;
  if (to && to !== t.to_city) return false;

  // Periode: bilen må kunne brukes (fra henting til siste retur) innenfor datoene
  if (w.date_from || w.date_to) {
    const periodFrom = (w.date_from ?? w.date_to)!;
    const periodTo = (w.date_to ?? w.date_from)!;
    const start = osloDate(t.available_at ?? new Date().toISOString());
    const endIso = t.latest_return ?? t.expire_time;
    const end = endIso ? osloDate(endIso) : "9999-12-31";
    if (end < periodFrom || start > periodTo) return false;
  }
  return true;
}

function formatPeriod(from: string | null, to: string | null): string {
  if (!from && !to) return "";
  const a = (from ?? to)!.split("-").map(Number);
  const b = (to ?? from)!.split("-").map(Number);
  if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return `${a[2]}. ${MAANEDER[a[1] - 1]}`;
  if (a[0] === b[0] && a[1] === b[1]) return `${a[2]}.–${b[2]}. ${MAANEDER[a[1] - 1]}`;
  return `${a[2]}. ${MAANEDER[a[1] - 1]} – ${b[2]}. ${MAANEDER[b[1] - 1]}`;
}

function watchLabel(w: Watch): string {
  const from = w.from_city ? pen(w.from_city) : "Hvor som helst";
  const to = w.to_city ? pen(w.to_city) : "hvor som helst";
  const period = formatPeriod(w.date_from, w.date_to);
  return `${from} → ${to}${period ? ` (${period})` : ""}`;
}

// Lenker nederst i hver melding
const FOOTER = "\n\nSe alle på kartet: https://sivertskalhjem.no/oversikt.html\nBestill hos Hertz: https://hertzfreerider.no";

function withFooter(messages: string[]): string[] {
  if (!messages.length) return messages;
  const out = [...messages];
  out[out.length - 1] += FOOTER;
  return out;
}

function byExpiry(a: Trip, b: Trip): number {
  return (a.expire_time ?? "9999").localeCompare(b.expire_time ?? "9999");
}

// Deler opp i flere meldinger hvis teksten blir for lang for Telegram
function chunk(blocks: string[], sep: string, header = ""): string[] {
  const out: string[] = [];
  let current = header;
  for (const b of blocks) {
    const candidate = current ? current + sep + b : b;
    if (candidate.length > MAX_MELDING && current && current !== header) {
      out.push(current);
      current = b;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url} svarte ${res.status}`);
  return res.json();
}

async function selectAll<T>(
  db: any,
  table: string,
  columns: string,
  orderBy: string[],
  filter?: (q: any) => any,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(columns);
    if (filter) q = filter(q);
    for (const col of orderBy) q = q.order(col);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

async function readStatus(db: any): Promise<{ consecutive_failures: number; admin_chat_id: number | null } | null> {
  const { data, error } = await db.from("app_status").select("consecutive_failures, admin_chat_id").eq("id", 1).maybeSingle();
  if (error) {
    console.error(`app_status: ${error.message}`);
    return null;
  }
  return data;
}

type SendResult = "ok" | "blocked" | "error";

async function sendTelegram(token: string, chatId: number, text: string, retry = true): Promise<SendResult> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
  });
  if (res.ok) return "ok";
  const body: any = await res.json().catch(() => ({}));
  if (res.status === 403) return "blocked";
  if (res.status === 429 && retry) {
    await sleep(((body?.parameters?.retry_after ?? 1) + 1) * 1000);
    return sendTelegram(token, chatId, text, false);
  }
  console.error(`Telegram-feil for ${chatId}: ${res.status} ${body?.description ?? ""}`);
  return "error";
}

async function sendAll(token: string, chatId: number, messages: string[]): Promise<SendResult> {
  for (const m of messages) {
    const r = await sendTelegram(token, chatId, m);
    if (r !== "ok") return r;
    await sleep(50);
  }
  return "ok";
}

// ---------------------------------------------------------------- meldinger

function tripBlock(t: Trip): string {
  return [
    `🚗 ${pen(t.from_name)} → ${pen(t.to_name)}`,
    `Bil: ${t.car_model ?? "Ukjent bilmodell"}`,
    `Tilbudet utløper: ${formatDato(t.expire_time)}`,
    `Tilgjengelig fra: ${formatDato(t.available_at)}`,
  ].join("\n");
}

function digestMessages(watches: Watch[], trips: Trip[], now: Date): string[] {
  const p = osloParts(now);
  const weekday = UKEDAGER[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
  const header = `📋 Daglig oversikt – ${weekday} ${p.day}. ${MAANEDER[p.month - 1]}`;

  const sections = watches.map((w) => {
    const matches = trips.filter((t) => matchesWatch(t, w)).sort(byExpiry);
    if (!matches.length) return `${watchLabel(w)}\nIngen ledige biler akkurat nå.`;
    const lines = [`${watchLabel(w)} (${matches.length} stk)`];
    for (const t of matches) {
      lines.push(
        `• ${pen(t.from_name)} → ${pen(t.to_name)}\n` +
          `  ${t.car_model ?? "Ukjent bilmodell"}, book innen ${formatDato(t.expire_time)}`,
      );
    }
    return lines.join("\n");
  });

  return chunk(sections, "\n\n", header);
}

// ---------------------------------------------------------------- hovedløp

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET")?.trim();
  const given = req.headers.get("x-cron-secret")?.trim();
  if (!secret) {
    return new Response("CRON_SECRET finnes ikke i Edge Functions → Secrets", { status: 500 });
  }
  if (!given) {
    return new Response("Kallet mangler headeren x-cron-secret", { status: 401 });
  }
  if (given !== secret) {
    return new Response(
      `Feil nøkkel: fikk ${given.length} tegn som starter med «${given.slice(0, 4)}», ` +
        `CRON_SECRET har ${secret.length} tegn som starter med «${secret.slice(0, 4)}»`,
      { status: 401 },
    );
  }

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!token || !url || !key) {
    return new Response("Mangler TELEGRAM_BOT_TOKEN, SUPABASE_URL eller SUPABASE_SERVICE_ROLE_KEY", {
      status: 500,
    });
  }

  const db = createClient(url, key, { auth: { persistSession: false } });
  const now = new Date();
  const runStart = now.toISOString();
  const stats = { trips: 0, stations: 0, varsler: 0, oppsummeringer: 0, frakoblet: 0, feil: 0 };

  try {
    // 1. Hent fra Hertz
    const groups = await getJson(ROUTES_URL);
    if (!Array.isArray(groups)) throw new Error("Uventet svar fra Hertz (transport-routes)");

    let locations: any[] = [];
    try {
      const l = await getJson(LOCATIONS_URL);
      if (Array.isArray(l)) locations = l;
    } catch (e) {
      console.warn(`Kunne ikke hente stasjonslisten: ${e}`);
    }

    // 2. Stasjoner
    const stations = new Map<string, any>();
    const addStation = (loc: any, requireNorway: boolean) => {
      const name = String(loc?.name ?? "").trim();
      if (!name) return;
      if (requireNorway && String(loc?.country ?? "").toLowerCase() !== "no") return;
      const cityRaw = String(loc?.city ?? "").trim().toUpperCase();
      stations.set(name, {
        name,
        code: loc?.tracCode ?? null,
        city: canonicalCity(cityRaw || name),
        city_raw: cityRaw || null,
        lat: num(loc?.geoLat),
        lon: num(loc?.geoLon),
        updated_at: runStart,
      });
    };
    for (const loc of locations) addStation(loc, true);

    // 3. Turer
    const trips = new Map<string, Trip>();
    for (const group of groups) {
      for (const r of group?.routes ?? []) {
        const p = r?.pickupLocation ?? {};
        const ret = r?.returnLocation ?? {};
        const fromName = String(p.name ?? group.pickupLocationName ?? "").trim();
        const toName = String(ret.name ?? group.returnLocationName ?? "").trim();
        if (r?.id == null || !fromName || !toName) continue;

        if (!stations.has(fromName)) addStation({ ...p, name: fromName }, false);
        if (!stations.has(toName)) addStation({ ...ret, name: toName }, false);

        trips.set(String(r.id), {
          id: String(r.id),
          car_model: r.carModel ?? null,
          from_name: fromName,
          from_city: canonicalCity(String(p.city ?? "") || fromName),
          to_name: toName,
          to_city: canonicalCity(String(ret.city ?? "") || toName),
          available_at: hertzTimeToIso(r.availableAt),
          latest_return: hertzTimeToIso(r.latestReturn),
          expire_time: hertzTimeToIso(r.expireTime),
          last_seen_at: runStart,
        });
      }
    }
    const tripList = [...trips.values()];
    stats.trips = tripList.length;
    stats.stations = stations.size;

    // 4. Lagre i databasen
    if (stations.size) {
      const { error } = await db.from("stations").upsert([...stations.values()], { onConflict: "name" });
      if (error) throw new Error(`stations: ${error.message}`);
    }
    if (tripList.length) {
      const { error } = await db.from("trips").upsert(tripList, { onConflict: "id" });
      if (error) throw new Error(`trips: ${error.message}`);
    }
    {
      const { error } = await db.from("trips").delete().lt("last_seen_at", runStart);
      if (error) throw new Error(`trips (opprydding): ${error.message}`);
    }

    // 5. Brukere, ruter og hva de allerede har fått
    const profiles = await selectAll<Profile>(
      db,
      "profiles",
      "id, telegram_chat_id, digest_hours",
      ["id"],
      (q) => q.not("telegram_chat_id", "is", null).eq("notifications_enabled", true),
    );
    const allWatches = await selectAll<Watch>(db, "watched_routes", "user_id, from_city, to_city, date_from, date_to", ["id"]);
    const sent = await selectAll<{ user_id: string; trip_id: string }>(
      db,
      "sent_notifications",
      "user_id, trip_id",
      ["user_id", "trip_id"],
    );

    const oslo = osloParts(now);
    const today = `${oslo.year}-${pad(oslo.month)}-${pad(oslo.day)}`;
    const digestsDone = await selectAll<{ user_id: string }>(
      db,
      "sent_digests",
      "user_id",
      ["user_id"],
      (q) => q.eq("digest_date", today).eq("digest_hour", oslo.hour),
    );

    // Ruter med en periode som er passert, telles ikke med
    const watches = allWatches.filter((w) => !w.date_to || w.date_to >= today);
    const watchesByUser = new Map<string, Watch[]>();
    for (const w of watches) {
      if (!watchesByUser.has(w.user_id)) watchesByUser.set(w.user_id, []);
      watchesByUser.get(w.user_id)!.push(w);
    }
    const sentByUser = new Map<string, Set<string>>();
    for (const s of sent) {
      if (!sentByUser.has(s.user_id)) sentByUser.set(s.user_id, new Set());
      sentByUser.get(s.user_id)!.add(s.trip_id);
    }
    const digestDoneSet = new Set(digestsDone.map((d) => d.user_id));

    // 6. Én bruker om gangen
    for (const profile of profiles) {
      const userWatches = watchesByUser.get(profile.id) ?? [];
      if (!userWatches.length) continue;
      const chatId = profile.telegram_chat_id;

      // 6a. Nye treff
      const already = sentByUser.get(profile.id) ?? new Set<string>();
      const fresh = tripList
        .filter((t) => !already.has(t.id) && userWatches.some((w) => matchesWatch(t, w)))
        .sort(byExpiry);

      let blocked = false;
      if (fresh.length) {
        const result = await sendAll(token, chatId, withFooter(chunk(fresh.map(tripBlock), "\n\n———\n\n")));
        if (result === "ok") {
          const rows = fresh.map((t) => ({ user_id: profile.id, trip_id: t.id }));
          const { error } = await db.from("sent_notifications").upsert(rows, { onConflict: "user_id,trip_id" });
          if (error) console.error(`sent_notifications: ${error.message}`);
          stats.varsler += fresh.length;
        } else if (result === "blocked") {
          blocked = true;
        } else {
          stats.feil++;
        }
      }

      // 6b. Daglig oppsummering
      const hours = profile.digest_hours ?? [];
      if (!blocked && hours.includes(oslo.hour) && !digestDoneSet.has(profile.id)) {
        const result = await sendAll(token, chatId, withFooter(digestMessages(userWatches, tripList, now)));
        if (result === "ok") {
          const { error } = await db
            .from("sent_digests")
            .upsert(
              { user_id: profile.id, digest_date: today, digest_hour: oslo.hour },
              { onConflict: "user_id,digest_date,digest_hour" },
            );
          if (error) console.error(`sent_digests: ${error.message}`);
          stats.oppsummeringer++;
        } else if (result === "blocked") {
          blocked = true;
        } else {
          stats.feil++;
        }
      }

      // Brukeren har blokkert boten: koble fra, så vi slutter å prøve
      if (blocked) {
        await db
          .from("profiles")
          .update({ telegram_chat_id: null, telegram_username: null })
          .eq("id", profile.id);
        stats.frakoblet++;
      }
    }

    // 7. Rydd bort gammel historikk
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
    await db.from("sent_notifications").delete().lt("sent_at", days(60));
    await db.from("sent_digests").delete().lt("sent_at", days(30));
    await db.from("watched_routes").delete().lt("date_to", today); // perioden er passert

    // 8. Status: sjekken virker
    const status = await readStatus(db);
    await db
      .from("app_status")
      .update({ last_check_at: runStart, last_ok_at: runStart, consecutive_failures: 0, last_error: null })
      .eq("id", 1);
    if (status && status.consecutive_failures >= ALERT_AFTER && status.admin_chat_id) {
      await sendTelegram(token, status.admin_chat_id, "✅ Hertz-sjekken virker igjen.");
    }

    console.log(JSON.stringify(stats));
    return new Response(JSON.stringify(stats), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    try {
      const status = await readStatus(db);
      const failures = (status?.consecutive_failures ?? 0) + 1;
      await db
        .from("app_status")
        .update({ last_check_at: runStart, consecutive_failures: failures, last_error: String(e).slice(0, 500) })
        .eq("id", 1);
      if (failures === ALERT_AFTER && status?.admin_chat_id) {
        await sendTelegram(
          token,
          status.admin_chat_id,
          `⚠️ Hertz-sjekken har feilet ${failures} ganger på rad, så ingen får varsler nå.\n\nSiste feil: ${String(e).slice(0, 300)}`,
        );
      }
    } catch (statusErr) {
      console.error("Klarte ikke å oppdatere status:", statusErr);
    }
    return new Response(JSON.stringify({ error: String(e), ...stats }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
