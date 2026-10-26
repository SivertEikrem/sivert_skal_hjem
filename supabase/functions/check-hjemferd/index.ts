// check-hjemferd
// Leser den åpne lista på hjemferd.no og sender et kort Telegram-tips til
// brukere som følger en by som dukker opp i en NY annonse. Vi gjengir ingen
// detaljer om annonsen, bare retning og by, og lenker til hjemferd.no.
// Kalles av pg_cron med headeren x-cron-secret.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

const LIST_URL = "https://www.hjemferd.no/finn-bil";
const ALERT_AFTER = 3; // varsle admin etter så mange feil på rad (= 1,5 time)

// Samme aliaser som i check-trips, så «Oslo» også treffer «Gardermoen»
const CITY_ALIASES: Record<string, string> = {
  "GARDERMOEN": "OSLO",
  "BLOMSTERDALEN": "BERGEN",
  "KOKSTAD": "BERGEN",
  "STJØRDAL": "TRONDHEIM",
  "VÆRNES": "TRONDHEIM",
  "FLESLAND": "BERGEN",
  "SOLA": "STAVANGER",
  "KJEVIK": "KRISTIANSAND",
  "VIGRA": "ÅLESUND",
  "LIERSTRANDA": "DRAMMEN",
  "AVALDSNES": "HAUGESUND",
  "BYGSTAD": "FØRDE",
  "HESSENG": "KIRKENES",
  "SKONSENG": "MO I RANA",
  "SANDNESSNJØEN": "SANDNESSJØEN",
};

const SMAA_ORD = new Set(["i", "og", "på", "ved"]);

type Listing = { id: string; from_text: string; to_text: string };
type Watch = { user_id: string; city: string };
type Profile = { id: string; telegram_chat_id: number; quiet_from: number | null; quiet_to: number | null };

// ---------------------------------------------------------------- hjelpere

function osloHour(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", hour: "numeric", hourCycle: "h23" }).format(d));
}

function inQuiet(hour: number, from: number | null, to: number | null): boolean {
  if (from == null || to == null || from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

function pen(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i > 0 && SMAA_ORD.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    aring: "å", Aring: "Å", oslash: "ø", Oslash: "Ø", aelig: "æ", AElig: "Æ",
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n] ?? m);
}

// Gjør om teksten til ord med store bokstaver, så byer kan sammenlignes
function normalize(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^\p{L}]+/gu, " ")
    .trim();
}

function mentionsCity(text: string, city: string): boolean {
  const padded = ` ${normalize(text)} `;
  if (padded.includes(` ${city} `)) return true;
  for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
    if (canonical === city && padded.includes(` ${alias} `)) return true;
  }
  return false;
}

// Plukker annonsene ut av HTML-en. Hver annonse slutter med en «Bestill»-lenke
// som inneholder book=<id>. De to tekstlinjene rett før «Ledig fra» er fra og til.
function parseListings(html: string): Listing[] {
  const marked = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<a\b[^>]*(?:[?&]|&amp;)book=(\d+)[^>]*>[\s\S]*?<\/a>/gi, "\n@@BOOK:$1@@\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "\n");

  const lines = marked
    .split("\n")
    .map((l) => decodeEntities(l).replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const listings: Listing[] = [];
  let buffer: string[] = [];
  for (const line of lines) {
    const m = line.match(/^@@BOOK:(\d+)@@$/);
    if (!m) {
      buffer.push(line);
      continue;
    }
    const idx = buffer.findIndex((l) => /^ledig fra\b/i.test(l));
    if (idx > 0) {
      const before = buffer
        .slice(0, idx)
        .filter((l) => /\p{L}{2,}/u.test(l) && !/^(bestill|mer info|send forespørsel|avbryt|andre kostnader|inkludert i turen)$/i.test(l));
      const to = before.pop() ?? "";
      const from = before.pop() ?? "";
      if (from || to) listings.push({ id: m[1], from_text: from.slice(0, 80), to_text: to.slice(0, 80) });
    }
    buffer = [];
  }
  return listings;
}

async function selectAll<T>(db: any, table: string, columns: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(columns);
    if (filter) q = filter(q);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

async function sendTelegram(token: string, chatId: number, text: string): Promise<"ok" | "blocked" | "error"> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
  });
  if (res.ok) return "ok";
  if (res.status === 403) return "blocked";
  console.error(`Telegram-feil for ${chatId}: ${res.status}`);
  return "error";
}

function tipMessage(hits: { city: string; dir: "fra" | "til" }[]): string {
  const url = LIST_URL;
  if (hits.length === 1) {
    return `🔎 Ny bil ${hits[0].dir} ${pen(hits[0].city)} på hjemferd.no. Verdt å sjekke!\n\n${url}`;
  }
  const lines = hits.map((h) => `• ${h.dir} ${pen(h.city)}`);
  return `🔎 ${hits.length} nye biler på hjemferd.no:\n${lines.join("\n")}\n\nVerdt å sjekke!\n${url}`;
}

// ---------------------------------------------------------------- hovedløp

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET")?.trim();
  if (!secret || req.headers.get("x-cron-secret")?.trim() !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!token || !url || !key) return new Response("Mangler hemmeligheter", { status: 500 });

  const db = createClient(url, key, { auth: { persistSession: false } });
  const now = new Date().toISOString();
  const stats = { annonser: 0, nye: 0, tips: 0, holdt_igjen: 0, feil: 0 };

  const { data: status } = await db
    .from("app_status")
    .select("hjemferd_failures, admin_chat_id")
    .eq("id", 1)
    .maybeSingle();

  try {
    // 1. Hent og tolk lista
    const res = await fetch(LIST_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15 sivertskalhjem.no",
        "Accept": "text/html",
        "Accept-Language": "nb-NO,nb;q=0.9",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`hjemferd.no svarte ${res.status}`);
    const html = await res.text();

    const listings = parseListings(html);
    stats.annonser = listings.length;

    // Sier siden at det finnes biler, men vi fant ingen? Da har siden endret seg.
    const countMatch = html.replace(/<[^>]+>/g, " ").match(/(\d+)\s+biler\b/i);
    const expected = countMatch ? parseInt(countMatch[1], 10) : null;
    if (listings.length === 0 && expected && expected > 0) {
      throw new Error(`Fant ${expected} biler på siden, men klarte ikke å lese dem. Siden har trolig endret utseende.`);
    }

    // 2. Hvilke er nye?
    const known = await selectAll<{ id: string }>(db, "hjemferd_listings", "id");
    const knownIds = new Set(known.map((k) => k.id));
    const fresh = listings.filter((l) => !knownIds.has(l.id));
    stats.nye = fresh.length;

    if (listings.length) {
      const rows = listings.map((l) => ({ ...l, last_seen_at: now }));
      const { error } = await db.from("hjemferd_listings").upsert(rows, { onConflict: "id", ignoreDuplicates: false });
      if (error) throw new Error(`hjemferd_listings: ${error.message}`);
    }

    // 3. Tips til brukerne. Vi ser på alle annonser brukeren ikke har fått tips om,
    // ikke bare de som er nye siden sist, så tips som ble holdt igjen i stille timer
    // (eller en by som nettopp ble lagt til) også kommer med.
    const hour = osloHour(new Date());
    if (listings.length) {
      const watches = await selectAll<Watch>(db, "tip_cities", "user_id, city");
      const profiles = await selectAll<Profile>(
        db,
        "profiles",
        "id, telegram_chat_id, quiet_from, quiet_to",
        (q: any) => q.not("telegram_chat_id", "is", null).eq("notifications_enabled", true),
      );
      const sent = await selectAll<{ user_id: string; listing_id: string }>(db, "hjemferd_sent", "user_id, listing_id");
      const sentSet = new Set(sent.map((s) => `${s.user_id}|${s.listing_id}`));

      const watchesByUser = new Map<string, string[]>();
      for (const w of watches) {
        if (!watchesByUser.has(w.user_id)) watchesByUser.set(w.user_id, []);
        watchesByUser.get(w.user_id)!.push(w.city.toUpperCase());
      }

      for (const p of profiles) {
        const cities = watchesByUser.get(p.id);
        if (!cities?.length) continue;

        const hits: { city: string; dir: "fra" | "til" }[] = [];
        const listingIds: string[] = [];
        for (const l of listings) {
          if (sentSet.has(`${p.id}|${l.id}`)) continue;
          const city = cities.find((c) => mentionsCity(l.from_text, c) || mentionsCity(l.to_text, c));
          if (!city) continue;
          hits.push({ city, dir: mentionsCity(l.from_text, city) ? "fra" : "til" });
          listingIds.push(l.id);
        }
        if (!hits.length) continue;
        if (inQuiet(hour, p.quiet_from, p.quiet_to)) {
          stats.holdt_igjen += hits.length;
          continue;
        }

        const result = await sendTelegram(token, p.telegram_chat_id, tipMessage(hits));
        if (result === "ok") {
          await db.from("hjemferd_sent").upsert(
            listingIds.map((id) => ({ user_id: p.id, listing_id: id })),
            { onConflict: "user_id,listing_id" },
          );
          stats.tips += hits.length;
        } else if (result === "blocked") {
          await db.from("profiles").update({ telegram_chat_id: null, telegram_username: null }).eq("id", p.id);
        } else {
          stats.feil++;
        }
      }
    }

    // 4. Rydd: annonser vi ikke har sett på 30 dager, og tips eldre enn 60
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    await db.from("hjemferd_listings").delete().lt("last_seen_at", days(30));
    await db.from("hjemferd_sent").delete().lt("sent_at", days(60));

    // 5. Status
    await db
      .from("app_status")
      .update({ hjemferd_last_ok_at: now, hjemferd_failures: 0, hjemferd_last_error: null })
      .eq("id", 1);
    if (status && status.hjemferd_failures >= ALERT_AFTER && status.admin_chat_id) {
      await sendTelegram(token, status.admin_chat_id, "✅ Hjemferd-sjekken virker igjen.");
    }

    console.log(JSON.stringify(stats));
    return new Response(JSON.stringify(stats), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    const failures = (status?.hjemferd_failures ?? 0) + 1;
    await db
      .from("app_status")
      .update({ hjemferd_failures: failures, hjemferd_last_error: String(e).slice(0, 500) })
      .eq("id", 1);
    if (failures === ALERT_AFTER && status?.admin_chat_id) {
      await sendTelegram(
        token,
        status.admin_chat_id,
        `⚠️ Hjemferd-sjekken har feilet ${failures} ganger på rad, så ingen får tips nå.\n\nSiste feil: ${String(e).slice(0, 300)}`,
      );
    }
    return new Response(JSON.stringify({ error: String(e), ...stats }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
