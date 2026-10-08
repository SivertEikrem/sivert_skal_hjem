const $ = (id) => document.getElementById(id);

// Trykk på en by i kartet åpner Alle biler med den byen valgt
const map = createRouteMap($("map-fig"), {
  onCityClick: (city) => (location.href = `oversikt.html?by=${encodeURIComponent(city)}`),
});

(async () => {
  // Innlogget? Da peker knappene til Mine ruter i stedet
  const { data } = await sb.auth.getUser();
  if (data?.user) {
    $("nav-mine").hidden = false;
    $("nav-login").hidden = true;
    $("cta-main").textContent = "Gå til Mine ruter";
    $("cta-main").href = "app.html";
  }

  try {
    const [all, lastOk] = await Promise.all([loadTrips(), loadLastCheck()]);
    const now = Date.now();
    const live = all.filter((t) => !t.expire_time || new Date(t.expire_time).getTime() > now);

    const count = $("live-count");
    count.querySelector("span:last-child").textContent =
      live.length === 1 ? "1 ledig bil akkurat nå" : `${live.length} ledige biler akkurat nå`;
    count.hidden = false;

    map.setData({ trips: live });
    $("board").replaceChildren(...live.slice(0, 4).map(tripRow));
    renderFreshness($("updated"), lastOk);
  } catch (err) {
    console.error(err);
  }
})();
