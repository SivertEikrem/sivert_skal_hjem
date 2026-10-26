// Ren logikk for e-postvarsler: ingen nettverk, ingen database, ingen Deno-API-er
// (bortsett fra Web Crypto og Intl, som finnes overalt). Alt her testes i
// supabase/tests/send-email-alerts/.
//
// MERK: Funksjonene fra og med «osloParts» til og med «byExpiry» er kopiert ordrett fra
// check-trips/index.ts, slik at e-post matcher ruter på nøyaktig samme måte som Telegram.
// Testen drift_test.ts feiler hvis check-trips endres uten at kopien her følger med.

export const SITE_URL = "https://sivertskalhjem.no";
export const MAP_URL = `${SITE_URL}/oversikt.html`;
export const SETTINGS_URL = `${SITE_URL}/app.html#epost`;
export const BOOKING_URL = "https://hertzfreerider.no";
export const BRAND = "Sivert skal hjem";
export const DISCLAIMER = "Sivert skal hjem er et privat hobbyprosjekt og er ikke tilknyttet Hertz.";

// Så mange biler i én e-post. Resten blir stående som usendt og kommer i neste e-post.
export const MAX_TRIPS_PER_EMAIL = 30;
// check-trips kjører hvert 5. minutt. Er trips eldre enn dette, har den stoppet,
// og tabellen kan inneholde biler som ikke finnes lenger.
export const TRIPS_MAX_AGE_MS = 15 * 60_000;

const MAANEDER = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];
const SMAA_ORD = new Set(["i", "og", "på", "ved"]);

export type Trip = {
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

export type Watch = {
  user_id: string;
  from_city: string | null;
  to_city: string | null;
  date_from: string | null; // YYYY-MM-DD, norsk dato
  date_to: string | null;
};

export type Email = { subject: string; text: string; html: string };

// ------------------------------------------------- kopiert fra check-trips

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

function byExpiry(a: Trip, b: Trip): number {
  return (a.expire_time ?? "9999").localeCompare(b.expire_time ?? "9999");
}

// ------------------------------------------------------------ utvalg

export { byExpiry, formatDato, matchesWatch, osloDate, osloParts, pen };

/** Norsk dato (YYYY-MM-DD) akkurat nå. */
export function osloToday(now: Date): string {
  return osloDate(now.toISOString());
}

/** Ruter hvis periode ikke er passert. */
export function activeWatches(watches: readonly Watch[], now: Date): Watch[] {
  const today = osloToday(now);
  return watches.filter((w) => !w.date_to || w.date_to >= today);
}

/**
 * Biler brukeren ikke har fått, som passer minst én av rutene hans.
 * Hver bil tas med én gang, sortert etter når tilbudet utløper.
 */
export function selectFresh(
  trips: readonly Trip[],
  watches: readonly Watch[],
  alreadySent: ReadonlySet<string>,
): Trip[] {
  if (!watches.length) return [];
  const taken = new Set<string>();
  const out: Trip[] = [];
  for (const t of trips) {
    if (alreadySent.has(t.id) || taken.has(t.id)) continue;
    if (!watches.some((w) => matchesWatch(t, w))) continue;
    taken.add(t.id);
    out.push(t);
  }
  return out.sort(byExpiry);
}

/**
 * Er trips-tabellen ferskt oppdatert? Tom tabell er greit (da finnes det ingenting å sende).
 * Ugyldige tidsstempler regnes som utdatert: i tvil sender vi ingenting.
 */
export function tripsAreFresh(trips: readonly Trip[], now: Date, maxAgeMs = TRIPS_MAX_AGE_MS): boolean {
  if (!trips.length) return true;
  let newest = -Infinity;
  for (const t of trips) {
    const ms = Date.parse(t.last_seen_at);
    if (Number.isFinite(ms) && ms > newest) newest = ms;
  }
  if (!Number.isFinite(newest)) return false;
  return now.getTime() - newest <= maxAgeMs;
}

/**
 * Nøkkel som gjør at Resend ikke sender samme e-post to ganger hvis vi må prøve igjen
 * (for eksempel fordi vi ikke fikk lagret at den ble sendt). Samme bruker og samme biler gir
 * samme nøkkel, uavhengig av rekkefølge.
 */
export async function idempotencyKey(userId: string, tripIds: readonly string[]): Promise<string> {
  const data = new TextEncoder().encode([...tripIds].sort().join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `varsel-${userId}-${hex.slice(0, 32)}`;
}

// ------------------------------------------------------------ e-post

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type TripFacts = { title: string; car: string; expires: string; available: string };

function facts(t: Trip): TripFacts {
  return {
    title: `${pen(t.from_name)} → ${pen(t.to_name)}`,
    car: t.car_model ?? "Ukjent bilmodell",
    expires: formatDato(t.expire_time),
    available: formatDato(t.available_at),
  };
}

export function subjectFor(trips: readonly Trip[], total = trips.length): string {
  if (total === 1 && trips.length === 1) {
    const f = facts(trips[0]);
    return `🚗 Ny gratis returbil: ${f.title}`;
  }
  return `🚗 ${total} nye gratis returbiler`;
}

/**
 * Bygger e-posten. `total` er hvor mange nye biler brukeren har til sammen, også de som ikke
 * får plass i denne e-posten. Kaller må ikke sende inn flere enn MAX_TRIPS_PER_EMAIL.
 */
export function buildEmail(trips: readonly Trip[], total = trips.length): Email {
  if (!trips.length) throw new Error("buildEmail trenger minst én bil");
  if (trips.length > MAX_TRIPS_PER_EMAIL) {
    throw new Error(`buildEmail: ${trips.length} biler er mer enn ${MAX_TRIPS_PER_EMAIL}`);
  }
  const rest = Math.max(0, total - trips.length);

  const textBlocks = trips.map((t) => {
    const f = facts(t);
    return [
      `🚗 ${f.title}`,
      `Bil: ${f.car}`,
      `Tilbudet utløper: ${f.expires}`,
      `Tilgjengelig fra: ${f.available}`,
    ].join("\n");
  });
  const text = [
    BRAND,
    textBlocks.join("\n\n———\n\n"),
    rest ? `… og ${rest} til. De kommer i neste e-post.` : "",
    `Se alle på kartet: ${MAP_URL}\nBestill her: ${BOOKING_URL}`,
    `Du får denne e-posten fordi du har slått på e-postvarsler hos ${BRAND}. Endre eller slå av her: ${SETTINGS_URL}\n${DISCLAIMER}`,
  ].filter(Boolean).join("\n\n") + "\n";

  const htmlBlocks = trips.map((t) => {
    const f = facts(t);
    return `<div style="margin:0 0 16px;padding:14px 16px;border:1px solid #d9d9d9;border-radius:8px;">
<div style="font-size:17px;font-weight:600;margin:0 0 6px;">🚗 ${escapeHtml(f.title)}</div>
<div>Bil: ${escapeHtml(f.car)}</div>
<div>Tilbudet utløper: ${escapeHtml(f.expires)}</div>
<div>Tilgjengelig fra: ${escapeHtml(f.available)}</div>
</div>`;
  });
  const html = `<!doctype html>
<html lang="nb">
<body style="margin:0;padding:16px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.45;color:#1a1a1a;">
<div style="max-width:560px;margin:0 auto;">
<div style="font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin:0 0 12px;"><a href="${SITE_URL}" style="color:#d83f00;text-decoration:none;">${BRAND}</a></div>
${htmlBlocks.join("\n")}
${rest ? `<p>… og ${rest} til. De kommer i neste e-post.</p>` : ""}
<p><a href="${MAP_URL}">Se alle på kartet</a> · <a href="${BOOKING_URL}">Bestill her</a></p>
<p style="font-size:13px;color:#666;">Du får denne e-posten fordi du har slått på e-postvarsler hos ${BRAND}. <a href="${SETTINGS_URL}">Endre eller slå av her</a>.<br>${DISCLAIMER}</p>
</div>
</body>
</html>
`;

  return { subject: subjectFor(trips, total), text, html };
}
