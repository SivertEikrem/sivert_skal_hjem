// Felles for alle sider. Krever at config.js og supabase-js er lastet først.

const sb = window.supabase.createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_KEY);
const BOT_USERNAME = "Sivertskalhjem_bot";

const MAANEDER = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];
const SMAA_ORD = new Set(["i", "og", "på", "ved"]);
const BILMERKER_STORE = new Set(["BMW", "BYD", "MG", "VW", "DS"]);

// ------------------------------------------------------------ tekst og tid

function pen(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i > 0 && SMAA_ORD.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function carName(s) {
  if (!s) return "Ukjent bilmodell";
  return s
    .trim()
    .split(/\s+/)
    .map((w) => {
      const up = w.toUpperCase();
      if (/\d/.test(w) || up.length <= 2 || BILMERKER_STORE.has(up)) return up;
      return up.charAt(0) + up.slice(1).toLowerCase();
    })
    .join(" ");
}

function osloParts(d) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

const pad = (n) => String(n).padStart(2, "0");

function formatDato(iso) {
  if (!iso) return "ukjent";
  const p = osloParts(new Date(iso));
  return `${p.day}. ${MAANEDER[p.month - 1]} kl. ${pad(p.hour)}:${pad(p.minute)}`;
}

function formatIgjen(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  const t = Math.floor(min / 60);
  const m = min % 60;
  if (t === 0) return `om ${m} min`;
  return `om ${t} t ${m} min`;
}

// ------------------------------------------------------------ DOM

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function routeLine() {
  return el("span", { class: "route-line", "aria-hidden": "true" });
}

// Én tur som rad i avgangstavla
function tripRow(t) {
  const expires = t.expire_time ? new Date(t.expire_time) : null;
  const left = expires ? expires.getTime() - Date.now() : Infinity;
  const urgent = left < 24 * 3600 * 1000;

  const meta = [carName(t.car_model)];
  if (t.available_at) meta.push(`hentes fra ${formatDato(t.available_at)}`);

  return el(
    "li",
    { class: urgent ? "trip urgent" : "trip" },
    el("div", { class: "trip-route" }, el("span", {}, pen(t.from_name)), routeLine(), el("span", {}, pen(t.to_name))),
    el("div", { class: "trip-meta" }, meta.join(", ")),
    el(
      "div",
      { class: "trip-when" },
      "Utløper",
      el("strong", {}, urgent ? formatIgjen(left) : formatDato(t.expire_time)),
    ),
  );
}

// ------------------------------------------------------------ tema

function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const ICON_SUN =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const ICON_MOON =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function initThemeButtons() {
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    const paint = () => {
      const dark = currentTheme() === "dark";
      btn.innerHTML = dark ? ICON_SUN : ICON_MOON;
      btn.setAttribute("aria-label", dark ? "Bytt til lyst tema" : "Bytt til mørkt tema");
    };
    paint();
    btn.addEventListener("click", () => {
      const next = currentTheme() === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("tema", next);
      } catch (_) {}
      document.querySelectorAll("[data-theme-toggle]").forEach((b) => b.dispatchEvent(new Event("repaint")));
    });
    btn.addEventListener("repaint", paint);
  });
}

// ------------------------------------------------------------ data

// Byer brukeren kan velge, og oppslag fra det brukeren skriver til by i databasen.
// Stasjonsnavn og kommunenavn virker også («Gardermoen» → OSLO).
async function loadCities() {
  const { data, error } = await sb.from("stations").select("name, city, city_raw");
  if (error) throw error;
  const lookup = new Map();
  const cities = new Set();
  for (const s of data) {
    cities.add(s.city);
    lookup.set(s.city.toLowerCase(), s.city);
    if (s.city_raw) lookup.set(s.city_raw.toLowerCase(), s.city);
    lookup.set(s.name.toLowerCase(), s.city);
  }
  const sorted = [...cities].sort((a, b) => a.localeCompare(b, "nb"));
  return { cities: sorted, resolve: (text) => lookup.get(text.trim().toLowerCase()) ?? null };
}

async function loadTrips() {
  const { data, error } = await sb.from("trips").select("*").order("expire_time", { ascending: true });
  if (error) throw error;
  return data;
}

// Når Hertz sist ble sjekket med hell
async function loadLastCheck() {
  const { data, error } = await sb.from("app_status").select("last_ok_at").eq("id", 1).maybeSingle();
  if (error) {
    console.error(error);
    return null;
  }
  return data?.last_ok_at ?? null;
}

// Skriver «Sjekket hos Hertz kl. 18:25», eller en advarsel hvis det er lenge siden
function renderFreshness(node, lastOk) {
  if (!lastOk) {
    node.textContent = "";
    node.classList.remove("stale");
    return;
  }
  const then = new Date(lastOk);
  const a = osloParts(then);
  const b = osloParts(new Date());
  const sameDay = a.year === b.year && a.month === b.month && a.day === b.day;
  const when = sameDay ? `kl. ${pad(a.hour)}:${pad(a.minute)}` : formatDato(lastOk);
  const stale = Date.now() - then.getTime() > 20 * 60 * 1000;
  node.textContent = stale
    ? `Siste sjekk hos Hertz var ${when}. Bilene kan være utdatert.`
    : `Sjekket hos Hertz ${when}`;
  node.classList.toggle("stale", stale);
}

function osloDate(iso) {
  const p = osloParts(new Date(iso));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function todayOslo() {
  return osloDate(new Date().toISOString());
}

// Samme regel som i check-trips: by må stemme, og bilen må kunne brukes i perioden
function matchesWatch(t, w) {
  if (w.from_city && w.from_city !== t.from_city) return false;
  if (w.to_city && w.to_city !== t.to_city) return false;
  if (w.date_from || w.date_to) {
    const periodFrom = w.date_from ?? w.date_to;
    const periodTo = w.date_to ?? w.date_from;
    const start = osloDate(t.available_at ?? new Date().toISOString());
    const endIso = t.latest_return ?? t.expire_time;
    const end = endIso ? osloDate(endIso) : "9999-12-31";
    if (end < periodFrom || start > periodTo) return false;
  }
  return true;
}

function formatPeriod(from, to) {
  if (!from && !to) return "";
  const a = (from ?? to).split("-").map(Number);
  const b = (to ?? from).split("-").map(Number);
  if (a.join() === b.join()) return `${a[2]}. ${MAANEDER[a[1] - 1]}`;
  if (a[0] === b[0] && a[1] === b[1]) return `${a[2]}.–${b[2]}. ${MAANEDER[a[1] - 1]}`;
  return `${a[2]}. ${MAANEDER[a[1] - 1]} – ${b[2]}. ${MAANEDER[b[1] - 1]}`;
}

document.addEventListener("DOMContentLoaded", initThemeButtons);
