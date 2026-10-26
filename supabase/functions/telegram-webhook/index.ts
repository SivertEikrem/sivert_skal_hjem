// telegram-webhook
// Telegram sender hver melding til boten hit.
//   /start <kode>  kobler en Telegram-konto til en brukerkonto
//   /ledige        viser bilene som passer rutene dine akkurat nå
//   /ruter         viser rutene og byene du følger
//   /stopp         slår av varslene
//   /hjelp         forklarer kommandoene

// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

const SITE = "sivertskalhjem.no";
const MAX_MELDING = 3900; // Telegram tillater 4096 tegn
const MAANEDER = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];
const SMAA_ORD = new Set(["i", "og", "på", "ved"]);

const HJELP =
  "Dette kan du skrive til meg:\n\n" +
  "/ledige – bilene som passer rutene dine akkurat nå\n" +
  "/ruter – rutene og byene du følger\n" +
  "/stopp – slutt å få varsler\n" +
  "/hjelp – denne lista\n\n" +
  `Rutene legger du til og fjerner på ${SITE}.`;

type Watch = { from_city: string | null; to_city: string | null; date_from: string | null; date_to: string | null };
type Trip = {
  from_name: string;
  from_city: string;
  to_name: string;
  to_city: string;
  car_model: string | null;
  available_at: string | null;
  latest_return: string | null;
  expire_time: string | null;
};

// ---------------------------------------------------------------- hjelpere

function reply(chatId: number, text: string): Response {
  // Telegram godtar svaret direkte i responsen, så vi trenger ikke et eget kall
  const body = text.length > MAX_MELDING ? text.slice(0, MAX_MELDING - 60) + `\n\n… og flere. Se alle på ${SITE}` : text;
  return new Response(
    JSON.stringify({ method: "sendMessage", chat_id: chatId, text: body, link_preview_options: { is_disabled: true } }),
    { headers: { "Content-Type": "application/json" } },
  );
}

const ok = () => new Response("ok");

function pen(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i > 0 && SMAA_ORD.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
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
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

const pad = (n: number) => String(n).padStart(2, "0");

function osloDate(iso: string): string {
  const p = osloParts(new Date(iso));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function formatDato(iso: string | null): string {
  if (!iso) return "ukjent";
  const p = osloParts(new Date(iso));
  return `${p.day}. ${MAANEDER[p.month - 1]} kl. ${pad(p.hour)}:${pad(p.minute)}`;
}

function formatPeriod(from: string | null, to: string | null): string {
  if (!from && !to) return "";
  const a = (from ?? to)!.split("-").map(Number);
  const b = (to ?? from)!.split("-").map(Number);
  if (a.join() === b.join()) return `${a[2]}. ${MAANEDER[a[1] - 1]}`;
  if (a[0] === b[0] && a[1] === b[1]) return `${a[2]}.–${b[2]}. ${MAANEDER[a[1] - 1]}`;
  return `${a[2]}. ${MAANEDER[a[1] - 1]} – ${b[2]}. ${MAANEDER[b[1] - 1]}`;
}

function watchLabel(w: Watch): string {
  const from = w.from_city ? pen(w.from_city) : "Hvor som helst";
  const to = w.to_city ? pen(w.to_city) : "hvor som helst";
  const period = formatPeriod(w.date_from, w.date_to);
  return `${from} → ${to}${period ? ` (${period})` : ""}`;
}

// Samme regel som i check-trips og på nettsiden
function matchesWatch(t: Trip, w: Watch): boolean {
  if (w.from_city && w.from_city !== t.from_city) return false;
  if (w.to_city && w.to_city !== t.to_city) return false;
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

// ---------------------------------------------------------------- kommandoer

async function ledige(db: any, userId: string): Promise<string> {
  const { data: watches, error: wErr } = await db
    .from("watched_routes")
    .select("from_city, to_city, date_from, date_to")
    .eq("user_id", userId)
    .order("id");
  if (wErr) throw wErr;
  if (!watches?.length) return `Du følger ingen ruter ennå. Legg dem til på ${SITE}.`;

  const { data: trips, error: tErr } = await db
    .from("trips")
    .select("from_name, from_city, to_name, to_city, car_model, available_at, latest_return, expire_time")
    .order("expire_time", { ascending: true });
  if (tErr) throw tErr;

  const now = Date.now();
  const live: Trip[] = (trips ?? []).filter((t: Trip) => !t.expire_time || new Date(t.expire_time).getTime() > now);

  let total = 0;
  const sections = (watches as Watch[]).map((w) => {
    const matches = live.filter((t) => matchesWatch(t, w));
    total += matches.length;
    if (!matches.length) return `${watchLabel(w)}\nIngen ledige akkurat nå.`;
    const lines = matches.map(
      (t) =>
        `• ${pen(t.from_name)} → ${pen(t.to_name)}\n  ${t.car_model ?? "Ukjent bilmodell"}, book innen ${formatDato(t.expire_time)}`,
    );
    return `${watchLabel(w)} (${matches.length} stk)\n${lines.join("\n")}`;
  });

  const head = total ? `🚗 ${total} ${total === 1 ? "ledig bil" : "ledige biler"} på rutene dine` : "Ingen ledige biler på rutene dine akkurat nå.";
  return `${head}\n\n${sections.join("\n\n")}\n\nBestill her: https://hertzfreerider.no`;
}

async function ruter(db: any, userId: string): Promise<string> {
  const [{ data: watches }, { data: cities }] = await Promise.all([
    db.from("watched_routes").select("from_city, to_city, date_from, date_to").eq("user_id", userId).order("id"),
    db.from("tip_cities").select("city").eq("user_id", userId).order("created_at"),
  ]);
  const parts: string[] = [];
  parts.push(
    watches?.length
      ? `Rutene du følger:\n${(watches as Watch[]).map((w) => `• ${watchLabel(w)}`).join("\n")}`
      : "Du følger ingen ruter ennå.",
  );
  if (cities?.length) {
    parts.push(`Tips fra hjemferd.no for:\n${cities.map((c: any) => `• ${pen(c.city)}`).join("\n")}`);
  }
  parts.push(`Endre dem på ${SITE}.`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------- hovedløp

Deno.serve(async (req) => {
  const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")?.trim();
  const given = req.headers.get("x-telegram-bot-api-secret-token")?.trim();
  if (!secret || given !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response("Mangler SUPABASE_URL eller SUPABASE_SERVICE_ROLE_KEY", { status: 500 });

  let update: any;
  try {
    update = await req.json();
  } catch {
    return ok();
  }

  const msg = update?.message;
  const chatId: number | undefined = msg?.chat?.id;
  const text: string = (msg?.text ?? "").trim();
  if (!chatId || msg?.chat?.type !== "private" || !text) return ok();

  const db = createClient(url, key, { auth: { persistSession: false } });
  const [command, ...args] = text.split(/\s+/);
  const cmd = command.toLowerCase().split("@")[0];

  try {
    // /start <kode> — kobler Telegram til kontoen som laget koden
    if (cmd === "/start") {
      const code = args[0];
      if (!code) {
        return reply(
          chatId,
          `Hei! 👋\n\nFor å få varsler om ledige returbiler logger du inn på ${SITE} og trykker «Koble til Telegram».`,
        );
      }

      const { data: profile, error } = await db
        .from("profiles")
        .select("id")
        .eq("telegram_link_code", code)
        .gt("telegram_link_expires_at", new Date().toISOString())
        .maybeSingle();
      if (error) throw error;

      if (!profile) {
        return reply(chatId, `Koden er utløpt eller ugyldig. Gå til ${SITE} og trykk «Koble til Telegram» på nytt.`);
      }

      // Samme Telegram-konto kan bare være koblet til én brukerkonto
      await db
        .from("profiles")
        .update({ telegram_chat_id: null, telegram_username: null })
        .eq("telegram_chat_id", chatId)
        .neq("id", profile.id);

      const { error: updErr } = await db
        .from("profiles")
        .update({
          telegram_chat_id: chatId,
          telegram_username: msg?.from?.username ?? null,
          telegram_link_code: null,
          telegram_link_expires_at: null,
        })
        .eq("id", profile.id);
      if (updErr) throw updErr;

      return reply(
        chatId,
        "✅ Koblet til!\n\nDu får nå varsel her når det dukker opp ledige biler på rutene dine. " +
          `Rutene velger du på ${SITE}.\n\n${HJELP}`,
      );
    }

    if (cmd === "/hjelp" || cmd === "/help") return reply(chatId, HJELP);

    // Resten krever at Telegram-kontoen er koblet til en brukerkonto
    const { data: me, error: meErr } = await db.from("profiles").select("id").eq("telegram_chat_id", chatId).maybeSingle();
    if (meErr) throw meErr;
    if (!me) {
      return reply(chatId, `Denne Telegram-kontoen er ikke koblet til noen konto. Logg inn på ${SITE} og trykk «Koble til Telegram».`);
    }

    if (cmd === "/ledige") return reply(chatId, await ledige(db, me.id));
    if (cmd === "/ruter") return reply(chatId, await ruter(db, me.id));

    // /stopp — kobler fra
    if (cmd === "/stopp" || cmd === "/stop") {
      await db.from("profiles").update({ telegram_chat_id: null, telegram_username: null }).eq("id", me.id);
      return reply(chatId, `Du får ikke lenger varsler her. Du kan koble til igjen når som helst på ${SITE}.`);
    }

    return reply(chatId, `Den kommandoen kjenner jeg ikke.\n\n${HJELP}`);
  } catch (e) {
    console.error(e);
    return reply(chatId, "Noe gikk galt hos oss. Prøv igjen om litt.");
  }
});
