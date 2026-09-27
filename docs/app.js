const $ = (id) => document.getElementById(id);

let user = null;
let profile = null;
let watches = [];
let trips = [];
let cityData = { cities: [], resolve: () => null };
let linkPoll = null;

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
    const [p, w, t, c] = await Promise.all([loadProfile(), loadWatches(), loadTrips(), loadCities()]);
    profile = p;
    watches = w;
    trips = t;
    cityData = c;
  } catch (err) {
    console.error(err);
    document.body.append(el("p", { class: "page notice error" }, "Klarte ikke å hente data. Last siden på nytt."));
    return;
  }

  $("cities").append(...cityData.cities.map((c) => el("option", { value: pen(c) })));
  renderTelegram();
  renderWatches();
  renderSettings();
  $("page").hidden = false;

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
  } catch (err) {
    console.error(err);
  }
}

// ------------------------------------------------------------ Telegram

function renderTelegram() {
  const status = $("tg-status");
  const text = $("tg-text");
  const actions = $("tg-actions");
  actions.replaceChildren();

  if (profile.telegram_chat_id) {
    status.textContent = profile.telegram_username ? `Koblet til som @${profile.telegram_username}` : "Koblet til";
    status.className = "status on";
    text.textContent = "Du får melding i Telegram når det dukker opp en ledig bil på rutene dine.";
    actions.append(
      el(
        "button",
        {
          class: "btn btn-quiet",
          type: "button",
          onclick: async () => {
            const { error } = await sb.rpc("unlink_telegram");
            if (error) return alert("Klarte ikke å koble fra. Prøv igjen.");
            profile = await loadProfile();
            renderTelegram();
            renderWatches();
          },
        },
        "Koble fra Telegram",
      ),
    );
    return;
  }

  status.textContent = "Ikke koblet til";
  status.className = "status";
  text.textContent =
    "Koble til Telegram for å få varsel på mobilen i det en bil blir ledig. Du trenger Telegram-appen.";
  actions.append(el("button", { class: "btn", type: "button", onclick: startLink }, "Koble til Telegram"));
}

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
  return [
    el("span", {}, w.from_city ? pen(w.from_city) : "Hvor som helst"),
    routeLine(),
    el("span", {}, w.to_city ? pen(w.to_city) : "hvor som helst"),
  ];
}

function renderWatches() {
  const box = $("watches");
  const now = Date.now();
  const live = trips.filter((t) => !t.expire_time || new Date(t.expire_time).getTime() > now);

  const p = osloParts(new Date());
  $("routes-updated").textContent = `Oppdatert kl. ${pad(p.hour)}:${pad(p.minute)}`;

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

      const empty = profile.telegram_chat_id
        ? "Ingen ledige biler akkurat nå. Du får melding på Telegram når det dukker opp en."
        : "Ingen ledige biler akkurat nå. Koble til Telegram for å få melding når det dukker opp en.";

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

  const { data, error } = await sb.from("watched_routes").insert({ from_city: from, to_city: to }).select().single();
  if (error) {
    if (error.code === "23505") return showRouteMsg("Du følger allerede denne ruten.");
    console.error(error);
    return showRouteMsg("Klarte ikke å lagre ruten. Prøv igjen.");
  }

  watches.push(data);
  $("from").value = "";
  $("to").value = "";
  renderWatches();
});

async function removeWatch(w) {
  const { error } = await sb.from("watched_routes").delete().eq("id", w.id);
  if (error) return showRouteMsg("Klarte ikke å fjerne ruten. Prøv igjen.");
  watches = watches.filter((x) => x.id !== w.id);
  renderWatches();
}

// ------------------------------------------------------------ innstillinger

function flash(id) {
  const n = $(id);
  n.hidden = false;
  clearTimeout(n._t);
  n._t = setTimeout(() => (n.hidden = true), 1800);
}

function renderSettings() {
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
