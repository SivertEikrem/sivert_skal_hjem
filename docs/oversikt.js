const $ = (id) => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";

let trips = [];
let cityPos = new Map(); // CITY -> [x, y]
let selectedCity = null;

// ------------------------------------------------------------ oppstart

(async () => {
  // Menyen avhenger av om man er logget inn
  const { data } = await sb.auth.getUser();
  if (data?.user) {
    $("nav-mine").hidden = false;
    $("nav-login").hidden = true;
    $("nav-logout").hidden = false;
  }

  try {
    await Promise.all([loadCityPositions(), refresh()]);
  } catch (err) {
    console.error(err);
    $("empty").textContent = "Klarte ikke å hente bilene. Last siden på nytt.";
    $("empty").hidden = false;
    return;
  }
  render();
  setInterval(async () => {
    await refresh().catch(console.error);
    render();
  }, 3 * 60 * 1000);
})();

$("nav-logout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.replace("login.html");
});

$("search").addEventListener("input", renderList);
$("sort").addEventListener("change", renderList);
$("clear-city").addEventListener("click", () => selectCity(null));

async function refresh() {
  const all = await loadTrips();
  const now = Date.now();
  trips = all.filter((t) => !t.expire_time || new Date(t.expire_time).getTime() > now);
}

// Byens plassering = snittet av stasjonene i byen
async function loadCityPositions() {
  const { data, error } = await sb.from("stations").select("city, lat, lon");
  if (error) throw error;
  const acc = new Map();
  for (const s of data) {
    if (s.lat == null || s.lon == null) continue;
    if (s.lat < 57 || s.lat > 72 || s.lon < 3 || s.lon > 32) continue;
    const a = acc.get(s.city) ?? { lat: 0, lon: 0, n: 0 };
    a.lat += s.lat;
    a.lon += s.lon;
    a.n++;
    acc.set(s.city, a);
  }
  for (const [city, a] of acc) cityPos.set(city, NORWAY_MAP.project(a.lon / a.n, a.lat / a.n));
}

function render() {
  const n = trips.length;
  $("count").textContent = n === 1 ? "1 ledig bil" : `${n} ledige biler`;
  document.title = `(${n}) Alle ledige biler – Sivert skal hjem`;
  const p = osloParts(new Date());
  $("updated").textContent = `Oppdatert kl. ${pad(p.hour)}:${pad(p.minute)}`;
  renderMap();
  renderList();
}

function selectCity(city) {
  selectedCity = selectedCity === city ? null : city;
  renderMap();
  renderList();
}

// ------------------------------------------------------------ kart

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function renderMap() {
  const map = $("map");
  const W = NORWAY_MAP.width;

  // Byer med biler, og ruter slått sammen per bypar
  const counts = new Map();
  const pairs = new Map();
  for (const t of trips) {
    if (!cityPos.has(t.from_city) || !cityPos.has(t.to_city) || t.from_city === t.to_city) continue;
    counts.set(t.from_city, (counts.get(t.from_city) ?? 0) + 1);
    counts.set(t.to_city, (counts.get(t.to_city) ?? 0) + 1);
    const [a, b] = [t.from_city, t.to_city].sort();
    const key = a + "|" + b;
    const pair = pairs.get(key) ?? { a, b, ab: 0, ba: 0 };
    t.from_city === a ? pair.ab++ : pair.ba++;
    pairs.set(key, pair);
  }

  // Zoom inn på området som har biler (med litt luft rundt)
  const pts = [...counts.keys()].map((c) => cityPos.get(c));
  let vb = [0, 0, W, NORWAY_MAP.height];
  if (pts.length) {
    const pad = 50;
    let x0 = Math.min(...pts.map((p) => p[0])) - pad;
    let x1 = Math.max(...pts.map((p) => p[0])) + pad + 50; // plass til bynavn
    let y0 = Math.min(...pts.map((p) => p[1])) - pad;
    let y1 = Math.max(...pts.map((p) => p[1])) + pad;
    const minW = 220;
    const minH = 260;
    if (x1 - x0 < minW) { const m = (x0 + x1) / 2; x0 = m - minW / 2; x1 = m + minW / 2; }
    if (y1 - y0 < minH) { const m = (y0 + y1) / 2; y0 = m - minH / 2; y1 = m + minH / 2; }
    vb = [x0, y0, x1 - x0, y1 - y0];
  }
  map.setAttribute("viewBox", vb.map((v) => v.toFixed(0)).join(" "));
  map.setAttribute("preserveAspectRatio", "xMidYMid meet");
  // Tekststørrelse som følger zoomen, så navnene er like store på skjermen
  const k = vb[2] / W;
  map.style.setProperty("--map-scale", String(k));

  const defs = svg(
    "defs",
    {},
    svg(
      "marker",
      { id: "arrow", viewBox: "0 0 10 10", refX: "8", refY: "5", markerWidth: String(8 * k), markerHeight: String(8 * k), markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" },
      svg("path", { d: "M0 0L10 5L0 10z", class: "map-arrow" }),
    ),
  );

  const routes = svg("g", {});
  for (const p of pairs.values()) {
    const [x1, y1] = cityPos.get(p.a);
    const [x2, y2] = cityPos.get(p.b);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    // Bue til siden, så linjene ikke legger seg oppå hverandre
    const cx = (x1 + x2) / 2 - (dy / len) * len * 0.18;
    const cy = (y1 + y2) / 2 + (dx / len) * len * 0.18;
    const pull = (x, y) => {
      const d = Math.hypot(cx - x, cy - y) || 1;
      return [x + ((cx - x) / d) * 7 * k, y + ((cy - y) / d) * 7 * k];
    };
    const [sx, sy] = pull(x1, y1);
    const [ex, ey] = pull(x2, y2);

    const total = p.ab + p.ba;
    const touches = !selectedCity || p.a === selectedCity || p.b === selectedCity;
    const title =
      (p.ab ? `${pen(p.a)} → ${pen(p.b)}: ${p.ab} ${p.ab === 1 ? "bil" : "biler"}` : "") +
      (p.ab && p.ba ? "\n" : "") +
      (p.ba ? `${pen(p.b)} → ${pen(p.a)}: ${p.ba} ${p.ba === 1 ? "bil" : "biler"}` : "");

    routes.append(
      svg(
        "path",
        {
          d: `M${sx.toFixed(1)} ${sy.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`,
          class: touches ? "map-route" : "map-route dim",
          "stroke-width": String(Math.min(1.4 + total * 0.35, 3.4)),
          "marker-end": p.ab ? "url(#arrow)" : null,
          "marker-start": p.ba ? "url(#arrow)" : null,
        },
        svg("title", {}, title),
      ),
    );
  }

  // Bynavn: de travleste byene først, og hopp over navn som ville kollidert
  const cities = svg("g", {});
  const labels = svg("g", {});
  const placed = [];
  const order = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [city, n] of order) {
    const [x, y] = cityPos.get(city);
    const active = city === selectedCity;
    const node = svg(
      "g",
      {
        class: active ? "map-city active" : "map-city",
        tabindex: "0",
        role: "button",
        "aria-label": `${pen(city)}, ${n} ${n === 1 ? "bil" : "biler"}`,
        onclick: () => selectCity(city),
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectCity(city);
          }
        },
      },
      svg("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: String(12 * k), class: "map-hit" }),
      svg("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: String((active ? 5.5 : 4.5) * k), class: "map-dot" }),
      svg("title", {}, `${pen(city)}: ${n} ${n === 1 ? "bil" : "biler"}`),
    );
    cities.append(node);

    const lx = x + 8 * k;
    const ly = y + 4 * k;
    const clash = placed.some(([px, py]) => Math.abs(py - ly) < 13 * k && Math.abs(px - lx) < 70 * k);
    if (!clash || active) {
      placed.push([lx, ly]);
      labels.append(svg("text", { x: lx.toFixed(1), y: ly.toFixed(1), class: active ? "map-label active" : "map-label" }, pen(city)));
    }
  }

  map.replaceChildren(
    defs,
    svg("path", { d: NORWAY_MAP.neighbours, class: "map-neighbour" }),
    svg("path", { d: NORWAY_MAP.land, class: "map-land" }),
    routes,
    labels,
    cities,
  );
}

// ------------------------------------------------------------ liste

function renderList() {
  const q = $("search").value.trim().toLowerCase();
  const sort = $("sort").value;

  let list = trips.filter((t) => !selectedCity || t.from_city === selectedCity || t.to_city === selectedCity);
  if (q) {
    list = list.filter((t) =>
      [t.from_name, t.to_name, t.from_city, t.to_city, t.car_model].some((v) => (v ?? "").toLowerCase().includes(q)),
    );
  }

  const byText = (key) => (a, b) => (a[key] ?? "").localeCompare(b[key] ?? "", "nb");
  const sorters = {
    expire: (a, b) => (a.expire_time ?? "9").localeCompare(b.expire_time ?? "9"),
    new: (a, b) => (b.first_seen_at ?? "").localeCompare(a.first_seen_at ?? ""),
    from: byText("from_name"),
    to: byText("to_name"),
  };
  list.sort(sorters[sort]);

  const note = $("filter-note");
  note.hidden = !selectedCity;
  if (selectedCity) note.querySelector("span").textContent = `Viser biler til og fra ${pen(selectedCity)}.`;

  $("list").replaceChildren(...list.map(tripRow));
  const empty = $("empty");
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.textContent = trips.length
      ? "Ingen biler passer søket. Prøv et annet ord, eller vis alle byer."
      : "Ingen ledige biler akkurat nå. Listen oppdaterer seg selv.";
  }
}
