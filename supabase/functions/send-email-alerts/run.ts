// Selve kjøringen. Databasen og e-posttjenesten kommer inn som avhengigheter (`Deps`),
// så hele flyten kan testes uten nettverk.
//
// Grunnregler:
//   - En bil regnes som sendt først etter at Resend har bekreftet. Feiler noe, får brukeren
//     den i neste kjøring, og vi mister aldri et varsel.
//   - Feiler vi med å lagre at noe er sendt, stopper vi hele kjøringen i stedet for å risikere
//     at samme e-post sendes hver 5. minutt. Idempotency-nøkkelen i Resend hindrer duplikat
//     når neste forsøk har nøyaktig samme biler. Har det kommet en ny bil i mellomtiden, kan
//     brukeren få de første bilene to ganger. Vi velger heller det enn å miste et varsel.
//   - Noe som er uklart eller utdatert fører til at vi ikke sender noe, med en tydelig melding.

import {
  activeWatches,
  buildEmail,
  type Email,
  idempotencyKey,
  MAX_TRIPS_PER_EMAIL,
  selectFresh,
  type Trip,
  tripsAreFresh,
  type Watch,
} from "./logic.ts";
import type { OutgoingMail, SendResult } from "./resend.ts";

export const MAX_RETRYABLE_FAILURES = 3;
// Så mange avvisninger på rad uten en eneste vellykket sending tyder på feil oppsett
// (for eksempel EMAIL_FROM eller domenet), ikke på tre brukere med dårlige adresser.
export const MAX_REJECTED_IN_A_ROW = 3;
export const PAUSE_BETWEEN_SENDS_MS = 600;
// Holder én kjøring godt innenfor tidsgrensen for Edge Functions. Resten tas i neste kjøring.
export const MAX_EMAILS_PER_RUN = 100;

export type SentRow = { user_id: string; trip_id: string };

export type Deps = {
  now(): Date;
  /** Pause mellom utsendelser, så vi holder oss under Resends grense for kall per sekund. */
  sleep(ms: number): Promise<void>;
  loadTrips(): Promise<Trip[]>;
  /** Brukere som har slått på e-post og ikke har pauset alle varsler. */
  loadSubscribers(): Promise<string[]>;
  loadWatches(): Promise<Watch[]>;
  loadSent(): Promise<SentRow[]>;
  /** Bekreftet e-postadresse, eller null hvis brukeren ikke har en. */
  getEmail(userId: string): Promise<string | null>;
  send(mail: OutgoingMail): Promise<SendResult>;
  /** Kaster hvis det ikke ble lagret. */
  markSent(userId: string, tripIds: string[]): Promise<void>;
};

export type RunStats = {
  abonnenter: number;
  epostSendt: number;
  biler: number;
  hoppetOver: number;
  feil: number;
};

export type RunResult = {
  ok: boolean;
  /** Satt hvis kjøringen ble avbrutt. Forklarer hvorfor, på norsk. */
  avbrutt?: string;
  stats: RunStats;
  /** Én linje per feil. Inneholder aldri e-postadresser. */
  feil: string[];
};

/** Kort, ikke-sensitiv id til feilmeldinger. */
function who(userId: string): string {
  return `bruker ${userId.slice(0, 8)}`;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function run(deps: Deps): Promise<RunResult> {
  const stats: RunStats = { abonnenter: 0, epostSendt: 0, biler: 0, hoppetOver: 0, feil: 0 };
  const feil: string[] = [];
  const result = (avbrutt?: string): RunResult => ({
    ok: !avbrutt && feil.length === 0,
    ...(avbrutt ? { avbrutt } : {}),
    stats,
    feil,
  });

  let trips: Trip[];
  let subscribers: string[];
  let watches: Watch[];
  let sent: SentRow[];
  const now = deps.now();
  try {
    trips = await deps.loadTrips();
    if (!tripsAreFresh(trips, now)) {
      return result(
        "Bil-listen er utdatert, så check-trips har trolig stoppet. Sender ingenting før den virker igjen.",
      );
    }
    subscribers = await deps.loadSubscribers();
    stats.abonnenter = subscribers.length;
    if (!trips.length || !subscribers.length) return result();
    [watches, sent] = await Promise.all([deps.loadWatches(), deps.loadSent()]);
  } catch (e) {
    return result(`Kunne ikke lese fra databasen: ${messageOf(e)}`);
  }

  const watchesByUser = new Map<string, Watch[]>();
  for (const w of activeWatches(watches, now)) {
    const list = watchesByUser.get(w.user_id) ?? [];
    list.push(w);
    watchesByUser.set(w.user_id, list);
  }
  const sentByUser = new Map<string, Set<string>>();
  for (const s of sent) {
    const set = sentByUser.get(s.user_id) ?? new Set<string>();
    set.add(s.trip_id);
    sentByUser.set(s.user_id, set);
  }

  let retryableFailures = 0; // på rad, nullstilles av en vellykket sending
  let rejectedInARow = 0;
  let attempted = 0;

  for (const userId of subscribers) {
    if (stats.epostSendt >= MAX_EMAILS_PER_RUN) break; // resten tas i neste kjøring
    try {
      const fresh = selectFresh(trips, watchesByUser.get(userId) ?? [], sentByUser.get(userId) ?? new Set());
      if (!fresh.length) continue;
      const batch = fresh.slice(0, MAX_TRIPS_PER_EMAIL);

      const to = await deps.getEmail(userId);
      if (!to) {
        stats.hoppetOver++;
        feil.push(`${who(userId)}: har ikke en bekreftet e-postadresse`);
        continue;
      }

      const email: Email = buildEmail(batch, fresh.length);
      const tripIds = batch.map((t) => t.id);
      if (attempted++ > 0) await deps.sleep(PAUSE_BETWEEN_SENDS_MS);
      const res = await deps.send({
        to,
        email,
        idempotencyKey: await idempotencyKey(userId, tripIds),
      });

      if (res.status === "fatal") {
        feil.push(res.message);
        return result(`Avbrutt: ${res.message}`);
      }
      if (res.status === "rejected") {
        stats.feil++;
        feil.push(`${who(userId)}: ${res.message}`);
        if (++rejectedInARow >= MAX_REJECTED_IN_A_ROW && stats.epostSendt === 0) {
          return result(
            `Avbrutt etter ${MAX_REJECTED_IN_A_ROW} avvisninger på rad uten en eneste vellykket sending. ` +
              `Sjekk EMAIL_FROM og at avsenderdomenet er verifisert hos Resend.`,
          );
        }
        continue;
      }
      if (res.status === "retry") {
        stats.feil++;
        feil.push(`${who(userId)}: ${res.message}`);
        if (++retryableFailures >= MAX_RETRYABLE_FAILURES) {
          return result(`Avbrutt etter ${MAX_RETRYABLE_FAILURES} midlertidige feil på rad mot Resend`);
        }
        continue;
      }

      // Sendt. Lagre det før vi går videre.
      retryableFailures = 0;
      rejectedInARow = 0;
      stats.epostSendt++;
      stats.biler += batch.length;
      try {
        await deps.markSent(userId, tripIds);
      } catch (e) {
        const msg = `${who(userId)}: e-posten ble sendt, men kunne ikke lagres som sendt (${messageOf(e)})`;
        feil.push(msg);
        return result(`Avbrutt: ${msg}`);
      }
    } catch (e) {
      // Uventet feil for én bruker skal ikke stoppe de andre
      stats.feil++;
      feil.push(`${who(userId)}: uventet feil (${messageOf(e)})`);
    }
  }

  return result();
}
