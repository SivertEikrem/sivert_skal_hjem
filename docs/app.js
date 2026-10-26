const $ = (id) => document.getElementById(id);

let user = null;
let profile = null;
let watches = [];
let trips = [];
let tipCities = [];
let cityData = { cities: [], resolve: () => null };
let linkPoll = null;
let selectedCity = null;
const map = createRouteMap($("map-fig"), {
  onCityClick: (city) => {
    selectedCity = selectedCity === city ? null : city;
    map.setData({ selected: selectedCity });
  },
});

// ------------------------------------------------------------ oppstart

(async () => {
  // Sjekk mot serveren, ikke bare lokalt lagret økt
  const { data, error } = await sb.auth.getUser();
  if (error || !data?.user) {
    await sb.auth.signOut().catch(() => {});
    location.replace("login.html");
    return;
  }
  user = data.user;

  try {
    const [p, w, t, c, tc] = await Promise.all([loadProfile(), loadWatches(), loadTrips(), loadCities(), loadTipCities()]);
    profile = p;
    watches = w;
    trips = t;
    cityData = c;
    tipCities = tc;
  } catch (err) {
    console.error(err);
    document.body.append(el("p", { class: "page notice error" }, "Klarte ikke å hente data. Last siden på nytt."));
    return;
  }

  $("cities").append(...cityData.cities.map((c) => el("option", { value: pen(c) })));
  $("date-from").min = todayOslo();
  $("date-to").min = todayOslo();
  renderTelegram();
  renderWatches();
  renderTips();
  renderSettings();
  $("account-email").textContent = user.email ?? "";
  $("page").hidden = false;
  renderFreshness($("routes-updated"), await loadLastCheck());

  // Hold turene oppdatert
  setInterval(refreshTrips, 3 * 60 * 1000);
})();

$("logout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.replace("login.html");
});

async function loadProfile() {
  const { data, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
  if (error) throw error;
  return data;
}

async function loadWatches() {
  const { data, error } = await sb.from("watched_routes").select("*").order("created_at");
  if (error) throw error;
  return data;
}

async function refreshTrips() {
  try {
    trips = await loadTrips();
    renderWatches();
    renderFreshness($("routes-updated"), await loadLastCheck());
  } catch (err) {
    console.error(err);
  }
}

// ------------------------------------------------------------ Telegram

function renderTelegram() {
  const connected = !!profile.telegram_chat_id;
  $("tg-section").hidden = connected;
  $("tg-small").hidden = !connected;

  if (connected) {
    $("tg-small-status").textContent = profile.telegram_username
      ? `Koblet til Telegram som @${profile.telegram_username}`
      : "Koblet til Telegram";
    return;
  }

  $("tg-status").textContent = "Ikke koblet til";
  $("tg-status").className = "status";
  $("tg-text").textContent =
    "Koble til Telegram for å få varsel på mobilen i det en bil blir ledig. Du trenger Telegram-appen.";
  $("tg-actions").replaceChildren(el("button", { class: "btn", type: "button", onclick: startLink }, "Koble til Telegram"));
}

$("tg-unlink").addEventListener("click", async () => {
  const { error } = await sb.rpc("unlink_telegram");
  if (error) return alert("Klarte ikke å koble fra. Prøv igjen.");
  profile = await loadProfile();
  renderTelegram();
  renderWatches();
});

async function startLink(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  const { data: code, error } = await sb.rpc("create_telegram_link_code");
  btn.disabled = false;
  if (error || !code) {
    $("tg-text").textContent = "Klarte ikke å lage en koblingslenke. Prøv igjen.";
    return;
  }

  const link = `https://t.me/${BOT_USERNAME}?start=${code}`;
  $("tg-text").textContent =
    "Åpne Telegram og trykk Start. Siden oppdaterer seg selv når koblingen er klar. Lenken virker i 15 minutter.";
  $("tg-actions").replaceChildren(
    el("a", { class: "btn", href: link, target: "_blank", rel: "noopener" }, "Åpne Telegram"),
    el("span", { class: "muted" }, "Venter på Telegram …"),
  );

  // Se etter at koblingen er gjort
  clearInterval(linkPoll);
  const started = Date.now();
  linkPoll = setInterval(async () => {
    if (Date.now() - started > 15 * 60 * 1000) {
      clearInterval(linkPoll);
      renderTelegram();
      return;
    }
    try {
      const p = await loadProfile();
      if (p.telegram_chat_id) {
        clearInterval(linkPoll);
        profile = p;
        renderTelegram();
        renderWatches();
      }
    } catch (_) {}
  }, 3000);
}

// ------------------------------------------------------------ ruter

function watchTitle(w) {
  const period = formatPeriod(w.date_from, w.date_to);
  return [
    el("span", {}, w.from_city ? pen(w.from_city) : "Hvor som helst"),
    routeLine(),
    el("span", {}, w.to_city ? pen(w.to_city) : "hvor som helst"),
    period ? el("span", { class: "watch-dates" }, period) : null,
  ];
}

// ------------------------------------------------------------ mønstre per rute

const UKEDAGER_FLERTALL = ["mandager", "tirsdager", "onsdager", "torsdager", "fredager", "lørdager", "søndager"];
const statsCache = new Map(); // "FRA|TIL" -> Promise<stats | null>

function loadRouteStats(w) {
  const key = `${w.from_city ?? ""}|${w.to_city ?? ""}`;
  if (!statsCache.has(key)) {
    statsCache.set(
      key,
      sb
        .rpc("route_stats", { p_from: w.from_city, p_to: w.to_city })
        .then(({ data, error }) => (error ? (console.error(error), null) : (data?.[0] ?? null)))
        .catch(() => null),
    );
  }
  return statsCache.get(key);
}

function statsText(st) {
  if (!st || !st.historikk_fra) return null;
  const startDays = (Date.now() - new Date(st.historikk_fra).getTime()) / 86_400_000;
  const since = formatDato(st.historikk_fra).replace(/ kl\..*$/, "");

  if (!st.biler_90_dager) {
    return `Ingen biler på denne ruten siden vi begynte å følge med ${since}.`;
  }
  const n = st.biler_30_dager;
  const parts = [];
  parts.push(
    startDays < 30
      ? `${st.biler_90_dager} ${st.biler_90_dager === 1 ? "bil" : "biler"} siden ${since}`
      : `${n} ${n === 1 ? "bil" : "biler"} de siste 30 dagene`,
  );
  if (st.biler_90_dager >= 3 && st.vanligste_dag) parts.push(`oftest på ${UKEDAGER_FLERTALL[st.vanligste_dag - 1]}`);
  let text = parts.join(", ") + ".";
  if (st.snitt_timer != null) {
    const t = Number(st.snitt_timer);
    text += t < 1 ? " Bilene forsvinner som regel i løpet av en time." : ` En bil ligger ute i snitt ${Math.round(t)} timer.`;
  }
  return text;
}

function statsLine(w) {
  const p = el("p", { class: "watch-stats muted" });
  p.hidden = true;
  loadRouteStats(w).then((st) => {
    const text = statsText(st);
    if (text) {
      p.textContent = text;
      p.hidden = false;
    }
  });
  return p;
}

function renderWatches() {
  const box = $("watches");
  const now = Date.now();
  const live = trips.filter((t) => !t.expire_time || new Date(t.expire_time).getTime() > now);


  // Kartet viser bilene som passer rutene dine, og rutene du følger
  const mine = live.filter((t) => watches.some((w) => matchesWatch(t, w)));
  $("map-fig").hidden = !watches.length;
  map.setData({ trips: mine, planned: watches.map((w) => ({ from: w.from_city, to: w.to_city })) });

  if (!watches.length) {
    box.replaceChildren(
      el(
        "p",
        { class: "watch-empty" },
        "Du følger ingen ruter ennå. Velg hvor du vil reise fra og til over. La ett av feltene stå tomt for å følge alt fra eller til en by.",
      ),
    );
    return;
  }

  box.replaceChildren(
    ...watches.map((w) => {
      const matches = live.filter((t) => matchesWatch(t, w));
      const count = matches.length === 1 ? "1 ledig" : `${matches.length} ledige`;

      const when = w.date_from || w.date_to ? "i denne perioden" : "akkurat nå";
      const empty = profile.telegram_chat_id
        ? `Ingen ledige biler ${when}. Du får melding på Telegram når det dukker opp en.`
        : `Ingen ledige biler ${when}. Koble til Telegram for å få melding når det dukker opp en.`;

      return el(
        "article",
        { class: "watch" },
        el(
          "div",
          { class: "watch-head" },
          el("h3", {}, ...watchTitle(w), el("span", { class: "watch-count" }, count)),
          el(
            "button",
            { class: "link-btn subtle", type: "button", onclick: () => removeWatch(w) },
            "Slutt å følge",
          ),
        ),
        statsLine(w),
        matches.length ? el("ul", { class: "board" }, matches.map(tripRow)) : el("p", { class: "watch-empty" }, empty),
      );
    }),
  );
}

function showRouteMsg(text, kind = "error") {
  const m = $("route-msg");
  m.textContent = text;
  m.className = "notice " + kind;
  m.hidden = !text;
}

$("add-route").addEventListener("submit", async (e) => {
  e.preventDefault();
  showRouteMsg("");
  const fromText = $("from").value.trim();
  const toText = $("to").value.trim();

  if (!fromText && !toText) return showRouteMsg("Fyll inn minst ett av feltene, fra eller til.");

  const from = fromText ? cityData.resolve(fromText) : null;
  const to = toText ? cityData.resolve(toText) : null;
  if (fromText && !from) return showRouteMsg(`Finner ikke «${fromText}». Velg en by fra listen.`);
  if (toText && !to) return showRouteMsg(`Finner ikke «${toText}». Velg en by fra listen.`);
  if (from && to && from === to) return showRouteMsg("Fra og til kan ikke være samme by.");

  // Valgfri periode. Er bare én dato fylt inn, gjelder ruten den ene dagen.
  let dateFrom = $("date-from").value || null;
  let dateTo = $("date-to").value || null;
  if (dateFrom && !dateTo) dateTo = dateFrom;
  if (dateTo && !dateFrom) dateFrom = dateTo;
  if (dateFrom && dateTo < dateFrom) return showRouteMsg("Til-datoen kan ikke være før fra-datoen.");
  if (dateTo && dateTo < todayOslo()) return showRouteMsg("Perioden er allerede passert. Velg datoer fra i dag og fremover.");

  const { data, error } = await sb
    .from("watched_routes")
    .insert({ from_city: from, to_city: to, date_from: dateFrom, date_to: dateTo })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") return showRouteMsg("Du følger allerede denne ruten for de samme datoene.");
    if (error.message === "route_limit") return showRouteMsg("Du kan følge maks 20 ruter. Fjern en rute før du legger til en ny.");
    console.error(error);
    return showRouteMsg("Klarte ikke å lagre ruten. Prøv igjen.");
  }

  watches.push(data);
  $("from").value = "";
  $("to").value = "";
  $("date-from").value = "";
  $("date-to").value = "";
  $("dates").open = false;
  renderWatches();
});

async function removeWatch(w) {
  const { error } = await sb.from("watched_routes").delete().eq("id", w.id);
  if (error) return showRouteMsg("Klarte ikke å fjerne ruten. Prøv igjen.");
  watches = watches.filter((x) => x.id !== w.id);
  renderWatches();
}

// ------------------------------------------------------------ tips fra hjemferd.no

async function loadTipCities() {
  const { data, error } = await sb.from("tip_cities").select("*").order("created_at");
  if (error) throw error;
  return data;
}

function showTipMsg(text, kind = "error") {
  const m = $("tip-msg");
  m.textContent = text;
  m.className = "notice " + kind;
  m.hidden = !text;
}

function renderTips() {
  const list = $("tip-list");
  if (!tipCities.length) {
    list.replaceChildren(el("li", { class: "chips-empty muted" }, "Du følger ingen byer ennå."));
    return;
  }
  list.replaceChildren(
    ...tipCities.map((t) =>
      el(
        "li",
        { class: "chip" },
        pen(t.city),
        el(
          "button",
          {
            type: "button",
            class: "chip-remove",
            "aria-label": `Slutt å følge ${pen(t.city)}`,
            onclick: async () => {
              const { error } = await sb.from("tip_cities").delete().eq("id", t.id);
              if (error) return showTipMsg("Klarte ikke å fjerne byen. Prøv igjen.");
              tipCities = tipCities.filter((x) => x.id !== t.id);
              renderTips();
            },
          },
          "×",
        ),
      ),
    ),
  );
}

$("add-tip").addEventListener("submit", async (e) => {
  e.preventDefault();
  showTipMsg("");
  const raw = $("tip-city").value.trim();
  if (raw.length < 2) return showTipMsg("Skriv inn navnet på en by.");
  // Bruk den kjente byen hvis den finnes, ellers teksten slik den er skrevet
  const city = cityData.resolve(raw) ?? raw.toUpperCase().replace(/\s+/g, " ");
  if (tipCities.some((t) => t.city === city)) return showTipMsg("Du følger allerede denne byen.");

  const { data, error } = await sb.from("tip_cities").insert({ city }).select().single();
  if (error) {
    if (error.code === "23505") return showTipMsg("Du følger allerede denne byen.");
    if (error.message === "tip_limit") return showTipMsg("Du kan følge maks 10 byer. Fjern en før du legger til en ny.");
    console.error(error);
    return showTipMsg("Klarte ikke å lagre byen. Prøv igjen.");
  }
  tipCities.push(data);
  $("tip-city").value = "";
  renderTips();
});

// ------------------------------------------------------------ innstillinger

function flash(id) {
  const n = $(id);
  n.hidden = false;
  clearTimeout(n._t);
  n._t = setTimeout(() => (n.hidden = true), 1800);
}

function renderQuiet() {
  const toggle = $("quiet-toggle");
  const fromSel = $("quiet-from");
  const toSel = $("quiet-to");
  const on = profile.quiet_from != null && profile.quiet_to != null;

  if (!fromSel.options.length) {
    for (let h = 0; h < 24; h++) {
      fromSel.append(el("option", { value: String(h) }, `${pad(h)}:00`));
      toSel.append(el("option", { value: String(h) }, `${pad(h)}:00`));
    }
  }
  toggle.checked = on;
  fromSel.value = String(on ? profile.quiet_from : 23);
  toSel.value = String(on ? profile.quiet_to : 7);
  $("quiet-row").hidden = !on;
  $("quiet-help").hidden = !on;

  const save = async () => {
    const enabled = toggle.checked;
    let from = enabled ? Number(fromSel.value) : null;
    let to = enabled ? Number(toSel.value) : null;
    if (enabled && from === to) {
      toSel.value = String((from + 8) % 24);
      to = Number(toSel.value);
    }
    const { error } = await sb.from("profiles").update({ quiet_from: from, quiet_to: to }).eq("id", user.id);
    if (error) {
      console.error(error);
      return alert("Klarte ikke å lagre. Prøv igjen.");
    }
    profile.quiet_from = from;
    profile.quiet_to = to;
    $("quiet-row").hidden = !enabled;
    $("quiet-help").hidden = !enabled;
    flash("quiet-saved");
  };
  toggle.onchange = save;
  fromSel.onchange = save;
  toSel.onchange = save;
}

function renderSettings() {
  renderQuiet();
  const toggle = $("notify-toggle");
  toggle.checked = profile.notifications_enabled;
  toggle.onchange = async () => {
    const value = toggle.checked;
    const { error } = await sb.from("profiles").update({ notifications_enabled: value }).eq("id", user.id);
    if (error) {
      toggle.checked = !value;
      return alert("Klarte ikke å lagre. Prøv igjen.");
    }
    profile.notifications_enabled = value;
    flash("notify-saved");
  };

  const hoursBox = $("hours");
  const selected = new Set(profile.digest_hours ?? []);
  hoursBox.replaceChildren(
    ...Array.from({ length: 24 }, (_, h) =>
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(selected.has(h)),
          "aria-label": `Klokka ${pad(h)}`,
          onclick: async (e) => {
            const btn = e.currentTarget;
            const next = new Set(profile.digest_hours ?? []);
            next.has(h) ? next.delete(h) : next.add(h);
            const arr = [...next].sort((a, b) => a - b);
            btn.setAttribute("aria-pressed", String(next.has(h)));
            const { error } = await sb.from("profiles").update({ digest_hours: arr }).eq("id", user.id);
            if (error) {
              btn.setAttribute("aria-pressed", String(!next.has(h)));
              return alert("Klarte ikke å lagre. Prøv igjen.");
            }
            profile.digest_hours = arr;
            flash("hours-saved");
          },
        },
        pad(h),
      ),
    ),
  );
}

// ------------------------------------------------------------ konto

$("delete-start").addEventListener("click", () => {
  $("delete-confirm").hidden = false;
  $("delete-start").hidden = true;
  $("delete-no").focus();
});

$("delete-no").addEventListener("click", () => {
  $("delete-confirm").hidden = true;
  $("delete-start").hidden = false;
  $("delete-msg").hidden = true;
});

$("delete-yes").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const { error } = await sb.rpc("delete_my_account");
  if (error) {
    console.error(error);
    btn.disabled = false;
    $("delete-msg").textContent = "Klarte ikke å slette kontoen. Prøv igjen om litt.";
    $("delete-msg").hidden = false;
    return;
  }
  await sb.auth.signOut().catch(() => {});
  location.replace("login.html?slettet=1");
});
