const APP_URL = new URL("app.html", location.href).href;
const LOGIN_URL = new URL("login.html", location.href).href;

let mode = "login"; // eller "signup"
let recovering = false;

const $ = (id) => document.getElementById(id);

function show(msgEl, text, kind = "") {
  msgEl.textContent = text;
  msgEl.className = "notice" + (kind ? " " + kind : "");
  msgEl.hidden = !text;
}

function norskFeil(error) {
  const m = (error?.message || "").toLowerCase();
  if (m.includes("invalid login credentials")) return "Feil e-post eller passord.";
  if (m.includes("already registered") || m.includes("already been registered"))
    return "Det finnes allerede en konto med denne e-posten. Logg inn i stedet.";
  if (m.includes("email not confirmed")) return "Du må bekrefte e-posten din først. Se etter en e-post fra oss i innboksen.";
  if (m.includes("password") && m.includes("6")) return "Passordet må ha minst 6 tegn.";
  if (m.includes("rate limit")) return "Det er sendt for mange e-poster på kort tid. Vent litt og prøv igjen.";
  if (m.includes("invalid") && m.includes("email")) return "E-postadressen ser ikke riktig ut.";
  return error?.message || "Noe gikk galt. Prøv igjen.";
}

function setMode(next) {
  mode = next;
  $("tab-login").setAttribute("aria-pressed", String(mode === "login"));
  $("tab-signup").setAttribute("aria-pressed", String(mode === "signup"));
  $("auth-submit").textContent = mode === "login" ? "Logg inn" : "Lag konto";
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("forgot").parentElement.hidden = mode !== "login";
  show($("auth-msg"), "");
}

$("tab-login").addEventListener("click", () => setMode("login"));
$("tab-signup").addEventListener("click", () => setMode("signup"));

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  const msg = $("auth-msg");
  const btn = $("auth-submit");

  if (!email || !password) return show(msg, "Fyll inn både e-post og passord.", "error");
  if (password.length < 6) return show(msg, "Passordet må ha minst 6 tegn.", "error");

  btn.disabled = true;
  show(msg, "");
  try {
    if (mode === "login") {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      location.replace(APP_URL);
    } else {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: APP_URL } });
      if (error) throw error;
      if (data.session) {
        location.replace(APP_URL);
      } else {
        show(msg, `Nesten ferdig. Vi har sendt en e-post til ${email}. Trykk på knappen i den for å bekrefte kontoen. Finner du den ikke, sjekk søppelposten.`, "ok");
      }
    }
  } catch (err) {
    show(msg, norskFeil(err), "error");
  } finally {
    btn.disabled = false;
  }
});

$("forgot").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const msg = $("auth-msg");
  if (!email) return show(msg, "Skriv inn e-posten din først, så sender vi en lenke for å lage nytt passord.", "error");
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: LOGIN_URL });
  if (error) return show(msg, norskFeil(error), "error");
  show(msg, `Vi har sendt en e-post til ${email}. Trykk på knappen i den for å velge nytt passord. Finner du den ikke, sjekk søppelposten.`, "ok");
});

// Når brukeren kommer fra «nytt passord»-lenken
sb.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") showRecoveryForm();
});

$("view-reset").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("new-password").value;
  const msg = $("reset-msg");
  if (password.length < 6) return show(msg, "Passordet må ha minst 6 tegn.", "error");
  const { error } = await sb.auth.updateUser({ password });
  if (error) return show(msg, norskFeil(error), "error");
  show(msg, "Passordet er lagret. Du sendes videre …", "ok");
  setTimeout(() => location.replace(APP_URL), 1200);
});

function showRecoveryForm() {
  recovering = true;
  $("view-auth").hidden = true;
  $("view-reset").hidden = false;
  $("new-password").focus();
}

(async () => {
  // Kommer brukeren fra en lenke i en e-post fra oss?
  // (…/login.html?token_hash=…&type=email eller type=recovery)
  const params = new URLSearchParams(location.search);
  const tokenHash = params.get("token_hash");
  const type = params.get("type");

  if (params.has("ny")) {
    setMode("signup");
    history.replaceState(null, "", location.pathname);
  }

  if (params.has("slettet")) {
    history.replaceState(null, "", location.pathname);
    show($("auth-msg"), "Kontoen din og alt som hørte til den er slettet.", "ok");
    return;
  }

  if (tokenHash && (type === "email" || type === "recovery")) {
    history.replaceState(null, "", location.pathname); // fjern koden fra adressefeltet
    const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) {
      show(
        $("auth-msg"),
        type === "recovery"
          ? "Lenken er utløpt eller allerede brukt. Skriv inn e-posten din og trykk «Glemt passordet?» for å få en ny."
          : "Lenken er utløpt eller allerede brukt. Prøv å logge inn. Virker ikke det, lager du konto på nytt med samme e-post, så får du en ny lenke.",
        "error",
      );
      return;
    }
    if (type === "recovery") return showRecoveryForm();
    location.replace(APP_URL); // e-posten er bekreftet, og brukeren er logget inn
    return;
  }

  // Allerede innlogget? Rett til appen (sjekkes mot serveren, ikke bare lokalt)
  const { data } = await sb.auth.getUser();
  if (data?.user && !recovering) location.replace(APP_URL);
})();

// Live-tavla: de første ledige bilene akkurat nå
(async () => {
  try {
    const trips = await loadTrips();
    const now = Date.now();
    const live = trips.filter((t) => !t.expire_time || new Date(t.expire_time).getTime() > now);
    const count = $("live-count");
    count.querySelector("span:last-child").textContent =
      live.length === 1 ? "1 ledig bil akkurat nå" : `${live.length} ledige biler akkurat nå`;
    count.hidden = false;
    $("live-board").append(...live.slice(0, 3).map(tripRow));
  } catch (err) {
    console.error(err);
  }
})();
