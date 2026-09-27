const $ = (id) => document.getElementById(id);

let trips = [];
let selectedCity = null;
const map = createRouteMap($("map-fig"), { onCityClick: (city) => selectCity(city) });

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
    await refresh();
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

let lastOk = null;

async function refresh() {
  const [all, ok] = await Promise.all([loadTrips(), loadLastCheck()]);
  lastOk = ok;
  const now = Date.now();
  trips = all.filter((t) => !t.expire_time || new Date(t.expire_time).getTime() > now);
}

function render() {
  const n = trips.length;
  $("count").textContent = n === 1 ? "1 ledig bil" : `${n} ledige biler`;
  document.title = `(${n}) Alle ledige biler – Sivert skal hjem`;
  renderFreshness($("updated"), lastOk);
  map.setData({ trips, selected: selectedCity });
  renderList();
}

function selectCity(city) {
  selectedCity = selectedCity === city ? null : city;
  map.setData({ selected: selectedCity });
  renderList();
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
