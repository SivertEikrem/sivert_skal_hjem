// Sending via Resend. Gjør alle feil om til ett av fire utfall, slik at run.ts kan avgjøre
// hva som skjer videre uten å kjenne til HTTP:
//   ok        sendt
//   fatal     oppsettet er galt (ugyldig nøkkel, avsender ikke godkjent): stopp hele kjøringen
//   rejected  Resend nekter akkurat denne e-posten (ugyldig adresse e.l.): hopp over mottakeren
//   retry     midlertidig feil (nettverk, 429, 5xx): prøv igjen senere

import type { Email } from "./logic.ts";

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

/** Et kort utdrag av feilmeldingen fra Resend. Aldri nøkkelen, aldri adressen. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const msg = typeof body?.message === "string" ? body.message : "";
    return msg.slice(0, 200);
  } catch {
    return "";
  }
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

  const detail = await errorDetail(res);
  const suffix = detail ? `: ${detail}` : "";

  if (res.status === 401 || res.status === 403) {
    return {
      status: "fatal",
      message: `Resend avviste nøkkelen eller avsenderen (${res.status})${suffix}. Sjekk RESEND_API_KEY og EMAIL_FROM.`,
    };
  }
  if (res.status === 429 || res.status >= 500) {
    return { status: "retry", message: `Resend svarte ${res.status}${suffix}` };
  }
  // Øvrige 4xx: noe er galt med akkurat denne e-posten (400, 409, 422 …)
  return { status: "rejected", message: `Resend nektet e-posten (${res.status})${suffix}` };
}
