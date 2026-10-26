// E-postvarsler: avkrysningen i seksjonen «Varsler på e-post» på Mine ruter.
// Frittstående: leser email_subscriptions og skriver bare via set_email_alerts(), og rører
// ingenting annet på siden. Feiler noe her, fungerer resten av siden som før.
// For å fjerne e-postvalget fra nettsiden: ta bort <script src="email.js"> og seksjonen #email-section i app.html.

(function () {
  // Logikken er skilt fra siden (`view`), så den kan testes uten nettleser.
  function createController(sb, view) {
    let enabled = false;
    return {
      get enabled() {
        return enabled;
      },
      async load(userId) {
        const { data, error } = await sb
          .from("email_subscriptions")
          .select("enabled")
          .eq("user_id", userId)
          .maybeSingle();
        if (error) throw error;
        enabled = !!data?.enabled;
        view.setChecked(enabled);
        return enabled;
      },
      async toggle(want) {
        view.setBusy(true);
        view.clearError();
        try {
          const { error } = await sb.rpc("set_email_alerts", { p_enabled: want });
          if (error) throw error;
          enabled = want;
          view.setChecked(enabled);
          view.showSaved();
        } catch (err) {
          console.error(err);
          view.setChecked(enabled); // tilbake til det som faktisk er lagret
          view.showError("Klarte ikke å lagre valget. Prøv igjen.");
        } finally {
          view.setBusy(false);
        }
      },
    };
  }

  // 008_epost.sql er ikke kjørt ennå: da skal brukeren ikke se en feilmelding, bare ingenting
  function isNotInstalled(err) {
    return !!err && (err.code === "PGRST205" || err.code === "42P01");
  }

  globalThis.EmailAlerts = { createController, isNotInstalled };

  if (typeof document === "undefined" || !document.getElementById("email-section")) return;
  if (globalThis.APP_CONFIG && globalThis.APP_CONFIG.EMAIL_ALERTS === false) return;

  const section = document.getElementById("email-section");
  const toggle = document.getElementById("email-toggle");
  const saved = document.getElementById("email-saved");
  const msg = document.getElementById("email-msg");
  const address = document.getElementById("email-address");
  let savedTimer = null;

  const view = {
    setChecked: (v) => (toggle.checked = v),
    setBusy: (v) => (toggle.disabled = v),
    clearError() {
      msg.hidden = true;
      msg.textContent = "";
    },
    showError(text) {
      msg.textContent = text;
      msg.hidden = false;
    },
    showSaved() {
      saved.hidden = false;
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => (saved.hidden = true), 2000);
    },
  };

  // Lenken i e-posten går til #epost. Siden er skjult til resten har lastet, så vi venter på den.
  function scrollWhenVisible() {
    if (location.hash !== "#epost") return;
    let tries = 0;
    const timer = setInterval(() => {
      const page = document.getElementById("page");
      if ((page && !page.hidden) || ++tries > 50) {
        clearInterval(timer);
        section.scrollIntoView({ block: "start" });
      }
    }, 200);
  }

  (async () => {
    try {
      const { data, error } = await sb.auth.getUser();
      if (error || !data?.user) return; // app.js sender uinnloggede til innlogging
      const controller = createController(sb, view);
      await controller.load(data.user.id);
      address.textContent = data.user.email ?? "";
      toggle.addEventListener("change", () => controller.toggle(toggle.checked));
      section.hidden = false;
      scrollWhenVisible();
    } catch (err) {
      console.error(err);
      if (isNotInstalled(err)) return; // seksjonen forblir skjult
      view.showError("Klarte ikke å hente e-postinnstillingen. Last siden på nytt.");
      toggle.disabled = true;
      section.hidden = false;
    }
  })();
})();
