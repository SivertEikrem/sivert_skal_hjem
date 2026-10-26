// Sending via Resend. Gjør alle feil om til ett av fire utfall, slik at run.ts kan avgjøre
// hva som skjer videre uten å kjenne til HTTP:
//   ok        sendt
//   fatal     oppsettet er galt (ugyldig nøkkel, avsender ikke godkjent): stopp hele kjøringen
//   rejected  Resend nekter akkurat denne e-posten (ugyldig adresse e.l.): hopp over mottakeren
//   retry     midlertidig feil (nettverk, 429, 5xx): prøv igjen senere

import { type Email, SETTINGS_URL } from "./logic.ts";

export const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 15_000;

export type SendResult =
  | { status: "ok" }
  | { status: "fatal"; message: string }
  | { status: "rejected"; message: string }
  | { status: "retry"; message: string };

export type ResendConfig = {
  apiKey: string;
  from: string; // «Navn <adresse@domene>» eller bare adressen
  replyTo?: string;
};

export type OutgoingMail = {
  to: string;
  email: Email;
  idempotencyKey: string;
};

type FetchFn = typeof fetch;

/** Fjerner alt som ligner en e-postadresse. Resend kan sitere adressen i feilmeldingen sin. */
export function redactAddresses(text: string): string {
  return text.replace(/[^\s<>"'`,;()@]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?/g, "[adresse]");
}

/** Feilmeldingen fra Resend slik den er. Brukes bare til å avgjøre hva slags feil det er. */
async function rawErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return typeof body?.message === "string" ? body.message.slice(0, 300) : "";
  } catch {
    return "";
  }
}

/** Gjelder feilen avsenderen (EMAIL_FROM, domenet) og ikke mottakeren? Da vil den ramme alle. */
function concernsSender(message: string): boolean {
  // Bevisst smalt: løse ord som «domain» eller «sender» kan stå i feil som gjelder mottakeren,
  // og da ville én dårlig adresse stoppet alle.
  return /`from`|\bfrom\b.{0,20}\bfield|not verified/i.test(message);
}

export async function sendViaResend(
  config: ResendConfig,
  mail: OutgoingMail,
  fetchFn: FetchFn = fetch,
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchFn(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": mail.idempotencyKey,
      },
      body: JSON.stringify({
        from: config.from,
        to: [mail.to],
        subject: mail.email.subject,
        html: mail.email.html,
        text: mail.email.text,
        // Lar e-postklienter vise «Avslutt abonnement», så færre trykker «Meld som spam»
        headers: { "List-Unsubscribe": `<${SETTINGS_URL}>` },
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "feil";
    return { status: "retry", message: `Fikk ikke kontakt med Resend (${name})` };
  }

  if (res.ok) {
    await res.body?.cancel();
    return { status: "ok" };
  }

  const raw = await rawErrorMessage(res);
  const detail = redactAddresses(raw).slice(0, 200);
  const suffix = detail ? `: ${detail}` : "";

  if (res.status === 401 || res.status === 403) {
    return {
      status: "fatal",
      message: `Resend avviste nøkkelen eller avsenderen (${res.status})${suffix}. Sjekk RESEND_API_KEY og EMAIL_FROM.`,
    };
  }
  // 409 gjelder idempotency-nøkkelen (for eksempel to kjøringer samtidig). Det sier ingenting om
  // mottakeren, og må ikke gi et døgns utsettelse. Prøv igjen neste kjøring.
  if (res.status === 429 || res.status === 409 || res.status >= 500) {
    return { status: "retry", message: `Resend svarte ${res.status}${suffix}` };
  }
  // Gjelder feilen avsenderen, rammer den alle, så vi stopper i stedet for å avvise hver bruker
  if (concernsSender(raw)) {
    return {
      status: "fatal",
      message: `Resend nektet på grunn av avsenderen (${res.status})${suffix}. Sjekk EMAIL_FROM og at domenet er verifisert.`,
    };
  }
  // Øvrige 4xx: noe er galt med akkurat denne e-posten (400, 409, 422 …)
  return { status: "rejected", message: `Resend nektet e-posten (${res.status})${suffix}` };
}
