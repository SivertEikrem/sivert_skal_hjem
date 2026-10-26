import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import {
  type Deps,
  MAX_ATTEMPTS_PER_RUN,
  MAX_REJECTED_IN_A_ROW,
  MAX_RUN_MS,
  MAX_RETRYABLE_FAILURES,
  PAUSE_BETWEEN_SENDS_MS,
  type RejectedRow,
  REJECT_COOLDOWN_MS,
  run,
  type SentRow,
} from "../../functions/send-email-alerts/run.ts";
import type { OutgoingMail, SendResult } from "../../functions/send-email-alerts/resend.ts";
import { idempotencyKey, MAX_TRIPS_PER_EMAIL, type Trip, type Watch } from "../../functions/send-email-alerts/logic.ts";
import { NOW, trip, watch } from "./helpers.ts";

type World = {
  trips?: Trip[];
  subscribers?: string[];
  watches?: Watch[];
  sent?: SentRow[];
  rejected?: RejectedRow[];
  markRejected?: (userId: string, reason: string) => Promise<void>;
  emails?: Record<string, string | null>;
  sendResult?: (mail: OutgoingMail, n: number) => SendResult | Promise<SendResult>;
  markSent?: (userId: string, tripIds: string[]) => Promise<void>;
  overrides?: Partial<Deps>;
};

/** Bygger et Deps-objekt av falske data og tar opp alt som blir gjort. */
function setup(w: World = {}) {
  const sends: OutgoingMail[] = [];
  const marks: { userId: string; tripIds: string[] }[] = [];
  const rejects: { userId: string; reason: string }[] = [];
  const calls: string[] = [];
  const sleeps: number[] = [];
  const subscribers = w.subscribers ?? ["u1"];
  const deps: Deps = {
    now: () => NOW,
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
    loadTrips: () => (calls.push("loadTrips"), Promise.resolve(w.trips ?? [trip()])),
    loadSubscribers: () => (calls.push("loadSubscribers"), Promise.resolve(subscribers)),
    loadWatches: () =>
      (calls.push("loadWatches"),
        Promise.resolve(w.watches ?? subscribers.map((user_id) => watch({ user_id })))),
    loadSent: () => (calls.push("loadSent"), Promise.resolve(w.sent ?? [])),
    loadRejected: () => (calls.push("loadRejected"), Promise.resolve(w.rejected ?? [])),
    getEmail: (id) =>
      Promise.resolve(w.emails && id in w.emails ? w.emails[id] : `${id}@example.com`),
    send: async (mail) => {
      sends.push(mail);
      return w.sendResult ? await w.sendResult(mail, sends.length) : { status: "ok" };
    },
    markSent: async (userId, tripIds) => {
      if (w.markSent) await w.markSent(userId, tripIds);
      marks.push({ userId, tripIds });
    },
    markRejected: async (userId, reason) => {
      if (w.markRejected) await w.markRejected(userId, reason);
      rejects.push({ userId, reason });
    },
    ...w.overrides,
  };
  return { deps, sends, marks, calls, sleeps, rejects };
}

Deno.test("run: sender én e-post og lagrer at den er sendt", async () => {
  const { deps, sends, marks } = setup();
  const res = await run(deps);
  assert(res.ok);
  assertEquals(res.feil, []);
  assertEquals(res.stats, { abonnenter: 1, epostSendt: 1, biler: 1, hoppetOver: 0, utsatt: 0, feil: 0 });
  assertEquals(sends.length, 1);
  assertEquals(sends[0].to, "u1@example.com");
  assertStringIncludes(sends[0].email.text, "Gardermoen");
  assertEquals(marks, [{ userId: "u1", tripIds: ["t1"] }]);
});

Deno.test("run: idempotency-nøkkelen følger bruker og biler", async () => {
  const { deps, sends } = setup({ trips: [trip({ id: "a" }), trip({ id: "b" })] });
  await run(deps);
  assertEquals(sends[0].idempotencyKey, await idempotencyKey("u1", ["a", "b"]));
});

Deno.test("run: sender ikke biler brukeren allerede har fått", async () => {
  const { deps, sends, marks } = setup({ sent: [{ user_id: "u1", trip_id: "t1" }] });
  const res = await run(deps);
  assert(res.ok);
  assertEquals(sends.length, 0);
  assertEquals(marks.length, 0);
});

Deno.test("run: en bil sendt til én bruker blir fortsatt sendt til en annen", async () => {
  const { deps, sends } = setup({
    subscribers: ["u1", "u2"],
    sent: [{ user_id: "u1", trip_id: "t1" }],
  });
  await run(deps);
  assertEquals(sends.map((s) => s.to), ["u2@example.com"]);
});

Deno.test("run: bruker uten ruter, eller med passerte ruter, får ingenting", async () => {
  const { deps, sends } = setup({
    subscribers: ["u1", "u2"],
    watches: [watch({ user_id: "u2", date_to: "2026-11-01" })],
  });
  const res = await run(deps);
  assert(res.ok);
  assertEquals(sends.length, 0);
});

Deno.test("run: ruter tilhører riktig bruker", async () => {
  const { deps, sends } = setup({
    subscribers: ["u1", "u2"],
    trips: [trip({ id: "oslo-bergen" }), trip({ id: "trh", from_city: "TRONDHEIM", from_name: "STJØRDAL" })],
    watches: [watch({ user_id: "u1", from_city: "TRONDHEIM" }), watch({ user_id: "u2" })],
  });
  await run(deps);
  const byUser = Object.fromEntries(sends.map((s) => [s.to, s.email.text]));
  assertStringIncludes(byUser["u1@example.com"], "Stjørdal");
  assertFalse(byUser["u1@example.com"].includes("Gardermoen"));
  assertStringIncludes(byUser["u2@example.com"], "Gardermoen");
});

Deno.test("run: ingen abonnenter gir ingen utsending og ingen feil", async () => {
  const { deps, sends, calls } = setup({ subscribers: [] });
  const res = await run(deps);
  assert(res.ok);
  assertEquals(sends.length, 0);
  assertFalse(calls.includes("loadWatches"));
});

Deno.test("run: ingen biler gir ingen utsending og ingen feil", async () => {
  const { deps, sends } = setup({ trips: [] });
  const res = await run(deps);
  assert(res.ok);
  assertEquals(sends.length, 0);
});

Deno.test("run: utdatert bil-liste stopper alt med tydelig melding", async () => {
  const { deps, sends, marks, calls } = setup({
    trips: [trip({ last_seen_at: "2026-11-03T08:00:00Z" })],
  });
  const res = await run(deps);
  assertFalse(res.ok);
  assertStringIncludes(res.avbrutt ?? "", "utdatert");
  assertStringIncludes(res.avbrutt ?? "", "check-trips");
  assertEquals(sends.length, 0);
  assertEquals(marks.length, 0);
  assertFalse(calls.includes("loadSubscribers"));
});

Deno.test("run: databasefeil stopper alt og forklarer", async () => {
  for (const failing of ["loadTrips", "loadSubscribers", "loadWatches", "loadSent"] as const) {
    const { deps, sends } = setup({
      overrides: { [failing]: () => Promise.reject(new Error("db nede")) } as Partial<Deps>,
    });
    const res = await run(deps);
    assertFalse(res.ok, failing);
    assertStringIncludes(res.avbrutt ?? "", "db nede");
    assertEquals(sends.length, 0, failing);
  }
});

Deno.test("run: bruker uten bekreftet e-post hoppes over uten å gjøre kjøringen rød", async () => {
  const { deps, sends, marks } = setup({
    subscribers: ["u1", "u2"],
    emails: { u1: null },
  });
  const res = await run(deps);
  assert(res.ok, JSON.stringify(res)); // én slik bruker skal ikke holde hver kjøring rød
  assertEquals(res.stats.hoppetOver, 1);
  assertEquals(sends.map((s) => s.to), ["u2@example.com"]);
  assertEquals(marks.map((m) => m.userId), ["u2"]);
});

Deno.test("run: avvist e-post gir feil for den brukeren, men markeres ikke som sendt", async () => {
  const { deps, sends, marks } = setup({
    subscribers: ["u1", "u2"],
    sendResult: (m) => (m.to.startsWith("u1") ? { status: "rejected", message: "Resend nektet (422)" } : { status: "ok" }),
  });
  const res = await run(deps);
  assertFalse(res.ok);
  assertEquals(res.stats.feil, 1);
  assertEquals(sends.length, 2);
  assertEquals(marks.map((m) => m.userId), ["u2"]);
});

Deno.test("run: fatal feil fra Resend avbryter med en gang og lagrer ingenting", async () => {
  const { deps, sends, marks } = setup({
    subscribers: ["u1", "u2", "u3"],
    sendResult: () => ({ status: "fatal", message: "Nøkkelen er avvist" }),
  });
  const res = await run(deps);
  assertFalse(res.ok);
  assertStringIncludes(res.avbrutt ?? "", "Nøkkelen er avvist");
  assertEquals(sends.length, 1);
  assertEquals(marks.length, 0);
});

Deno.test("run: midlertidige feil gir nytt forsøk neste kjøring, og avbryter etter for mange", async () => {
  const subs = Array.from({ length: 6 }, (_, i) => `u${i + 1}`);
  const { deps, sends, marks } = setup({
    subscribers: subs,
    sendResult: () => ({ status: "retry", message: "Resend svarte 503" }),
  });
  const res = await run(deps);
  assertFalse(res.ok);
  assertStringIncludes(res.avbrutt ?? "", `${MAX_RETRYABLE_FAILURES} midlertidige`);
  assertEquals(sends.length, MAX_RETRYABLE_FAILURES);
  assertEquals(marks.length, 0);
});

Deno.test("run: enkeltstående midlertidige feil stopper ikke de andre", async () => {
  const { deps, sends, marks } = setup({
    subscribers: ["u1", "u2", "u3"],
    sendResult: (_m, n) => (n === 1 ? { status: "retry", message: "Resend svarte 503" } : { status: "ok" }),
  });
  const res = await run(deps);
  assertFalse(res.ok);
  assertFalse(res.avbrutt);
  assertEquals(sends.length, 3);
  assertEquals(marks.map((m) => m.userId), ["u2", "u3"]);
});

Deno.test("run: får ikke lagret at e-post er sendt, stopper vi i stedet for å sende på nytt og på nytt", async () => {
  const { deps, sends, marks } = setup({
    subscribers: ["u1", "u2", "u3"],
    markSent: () => Promise.reject(new Error("skriving feilet")),
  });
  const res = await run(deps);
  assertFalse(res.ok);
  assertStringIncludes(res.avbrutt ?? "", "kunne ikke lagres som sendt");
  assertEquals(sends.length, 1); // u2 og u3 fikk ikke noe
  assertEquals(marks.length, 0);
});

Deno.test("run: uventet feil for én bruker stopper ikke de andre", async () => {
  const { deps, sends } = setup({
    subscribers: ["u1", "u2"],
    overrides: {
      getEmail: (id) => (id === "u1" ? Promise.reject(new Error("auth nede")) : Promise.resolve("u2@example.com")),
    },
  });
  const res = await run(deps);
  assertFalse(res.ok);
  assertEquals(res.stats.feil, 1);
  assertEquals(sends.map((s) => s.to), ["u2@example.com"]);
});

Deno.test("run: maks antall biler per e-post, resten venter", async () => {
  const many = Array.from({ length: MAX_TRIPS_PER_EMAIL + 5 }, (_, i) =>
    trip({ id: `t${String(i).padStart(3, "0")}`, expire_time: `2026-11-05T${String(i % 24).padStart(2, "0")}:00:00Z` })
  );
  const { deps, sends, marks } = setup({ trips: many });
  const res = await run(deps);
  assert(res.ok);
  assertEquals(sends.length, 1);
  assertEquals(marks[0].tripIds.length, MAX_TRIPS_PER_EMAIL);
  assertEquals(res.stats.biler, MAX_TRIPS_PER_EMAIL);
  assertStringIncludes(sends[0].email.text, "… og 5 til");
  assertStringIncludes(sends[0].email.subject, `${MAX_TRIPS_PER_EMAIL + 5} nye`);
});

Deno.test("run: neste kjøring tar resten, uten å gjenta de første", async () => {
  const many = Array.from({ length: MAX_TRIPS_PER_EMAIL + 5 }, (_, i) =>
    trip({ id: `t${String(i).padStart(3, "0")}`, expire_time: `2026-11-05T${String(i % 24).padStart(2, "0")}:00:00Z` })
  );
  const first = setup({ trips: many });
  await run(first.deps);
  const sentRows = first.marks[0].tripIds.map((trip_id) => ({ user_id: "u1", trip_id }));

  const second = setup({ trips: many, sent: sentRows });
  await run(second.deps);
  assertEquals(second.marks[0].tripIds.length, 5);
  const overlap = second.marks[0].tripIds.filter((id) => first.marks[0].tripIds.includes(id));
  assertEquals(overlap, []);
});

Deno.test("run: feilmeldinger inneholder aldri e-postadresser", async () => {
  const { deps } = setup({
    subscribers: ["u1", "u2", "u3"],
    emails: { u1: null },
    sendResult: (m) => (m.to.startsWith("u2") ? { status: "rejected", message: "Resend nektet e-posten (422)" } : { status: "ok" }),
  });
  const res = await run(deps);
  assertFalse(JSON.stringify(res).includes("@"));
});

Deno.test("run: avbrutt kjøring sender aldri mer enn det som er bekreftet lagret", async () => {
  // u1 lykkes, u2 gir fatal feil. Bare u1 skal være markert.
  const { deps, marks } = setup({
    subscribers: ["u1", "u2"],
    sendResult: (m) => (m.to.startsWith("u2") ? { status: "fatal", message: "avvist" } : { status: "ok" }),
  });
  await run(deps);
  assertEquals(marks.map((m) => m.userId), ["u1"]);
});

// ------------------------------------------------------------ rettelser etter review

Deno.test("run: midlertidige feil må komme på rad. En vellykket sending nullstiller telleren", async () => {
  // feil, ok, feil, ok, feil, ok: aldri tre på rad
  const { deps, sends, marks } = setup({
    subscribers: ["u1", "u2", "u3", "u4", "u5", "u6"],
    sendResult: (_m, n) => (n % 2 === 1 ? { status: "retry", message: "Resend svarte 503" } : { status: "ok" }),
  });
  const res = await run(deps);
  assertFalse(res.ok); // feilene rapporteres
  assertFalse(res.avbrutt, "skal ikke avbryte");
  assertEquals(sends.length, 6);
  assertEquals(marks.map((m) => m.userId), ["u2", "u4", "u6"]);
});

Deno.test("run: avvisninger på rad uten én eneste vellykket sending tyder på feil oppsett", async () => {
  const subs = Array.from({ length: MAX_REJECTED_IN_A_ROW + 5 }, (_, i) => `u${i + 1}`);
  const { deps, sends, marks } = setup({
    subscribers: subs,
    sendResult: () => ({ status: "rejected", message: "Resend nektet e-posten (422)" }),
  });
  const res = await run(deps);
  assertFalse(res.ok);
  assertStringIncludes(res.avbrutt ?? "", "EMAIL_FROM");
  assertEquals(sends.length, MAX_REJECTED_IN_A_ROW);
  assertEquals(marks.length, 0);
});

Deno.test("run: avvisninger etter at noe har gått bra er enkeltstående, og stopper ikke kjøringen", async () => {
  const { deps, sends, marks } = setup({
    subscribers: ["u1", "u2", "u3", "u4", "u5", "u6"],
    sendResult: (_m, n) => (n === 1 ? { status: "ok" } : { status: "rejected", message: "Resend nektet e-posten (422)" }),
  });
  const res = await run(deps);
  assertFalse(res.ok);
  assertFalse(res.avbrutt);
  assertEquals(sends.length, 6);
  assertEquals(marks.map((m) => m.userId), ["u1"]);
});

Deno.test("run: pauser mellom utsendelser, men ikke før den første", async () => {
  const { deps, sleeps } = setup({ subscribers: ["u1", "u2", "u3"] });
  await run(deps);
  assertEquals(sleeps, [PAUSE_BETWEEN_SENDS_MS, PAUSE_BETWEEN_SENDS_MS]);
});

Deno.test("run: ingen pause når det ikke er noe å sende", async () => {
  const { deps, sleeps } = setup({ subscribers: ["u1", "u2"], sent: [{ user_id: "u1", trip_id: "t1" }, { user_id: "u2", trip_id: "t1" }] });
  await run(deps);
  assertEquals(sleeps, []);
});

Deno.test("run: maks antall e-poster per kjøring, resten tas neste gang", async () => {
  const subs = Array.from({ length: MAX_ATTEMPTS_PER_RUN + 7 }, (_, i) => `u${i}`);
  const first = setup({ subscribers: subs });
  const res = await run(first.deps);
  assert(res.ok);
  assertEquals(first.sends.length, MAX_ATTEMPTS_PER_RUN);

  // Neste kjøring: de som fikk e-post er lagret som sendt, så de syv siste er igjen
  const sentRows = first.marks.map((m) => ({ user_id: m.userId, trip_id: "t1" }));
  const second = setup({ subscribers: subs, sent: sentRows });
  await run(second.deps);
  assertEquals(second.sends.length, 7);
  const overlap = second.sends.filter((s) => first.sends.some((f) => f.to === s.to));
  assertEquals(overlap, []);
});

Deno.test("run: gamle rader i trips sendes aldri, selv om andre er ferske", async () => {
  const { deps, sends, marks } = setup({
    trips: [
      trip({ id: "gammel", car_model: "Utgått bil", last_seen_at: "2026-11-03T05:00:00Z" }),
      trip({ id: "ny", car_model: "Fersk bil" }),
    ],
  });
  const res = await run(deps);
  assert(res.ok);
  assertEquals(marks[0].tripIds, ["ny"]);
  assertFalse(sends[0].email.text.includes("Utgått bil"));
  assertStringIncludes(sends[0].email.text, "Fersk bil");
});

Deno.test("run: taket gjelder forsøk, også avviste, så en kjøring aldri går på ubestemt tid", async () => {
  const subs = Array.from({ length: MAX_ATTEMPTS_PER_RUN + 50 }, (_, i) => `u${i}`);
  const { deps, sends } = setup({
    subscribers: subs,
    // første lykkes, alle andre avvises (så terskelen for avvisninger aldri utløses)
    sendResult: (_m, n) => (n === 1 ? { status: "ok" } : { status: "rejected", message: "Resend nektet e-posten (422)" }),
  });
  const res = await run(deps);
  assertFalse(res.ok);
  assertEquals(sends.length, MAX_ATTEMPTS_PER_RUN);
});

Deno.test("run: noen få dårlige adresser først stopper ikke de gyldige etterpå", async () => {
  const { deps, sends, marks } = setup({
    subscribers: ["u1", "u2", "u3", "u4", "u5"],
    sendResult: (m) => (["u1@", "u2@", "u3@"].some((p) => m.to.startsWith(p)) ? { status: "rejected", message: "Resend nektet e-posten (422)" } : { status: "ok" }),
  });
  const res = await run(deps);
  assertFalse(res.avbrutt);
  assertEquals(sends.length, 5);
  assertEquals(marks.map((m) => m.userId), ["u4", "u5"]);
});

// ------------------------------------------------------------ husker avviste brukere

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const bad = (m: OutgoingMail) => m.to.startsWith("bad");
const rejectBad = (m: OutgoingMail): SendResult =>
  bad(m) ? { status: "rejected", message: "Resend nektet e-posten (422)" } : { status: "ok" };

Deno.test("run: en avvist bruker huskes, med årsak, og de andre får sin e-post", async () => {
  const { deps, marks, rejects } = setup({
    subscribers: ["bad1", "u2"],
    sendResult: rejectBad,
  });
  const res = await run(deps);
  assertFalse(res.ok);
  assertEquals(rejects, [{ userId: "bad1", reason: "Resend nektet e-posten (422)" }]);
  assertEquals(marks.map((m) => m.userId), ["u2"]);
});

Deno.test("run: en bruker som er avvist for under et døgn siden hoppes over, uten feil", async () => {
  const { deps, sends, rejects } = setup({
    subscribers: ["bad1", "u2"],
    rejected: [{ user_id: "bad1", rejected_at: hoursAgo(2) }],
    sendResult: rejectBad,
  });
  const res = await run(deps);
  assert(res.ok, JSON.stringify(res));
  assertEquals(res.stats.utsatt, 1);
  assertEquals(sends.map((s) => s.to), ["u2@example.com"]);
  assertEquals(rejects, []);
});

Deno.test("run: etter et døgn prøves brukeren igjen", async () => {
  const justBefore = new Date(NOW.getTime() - REJECT_COOLDOWN_MS + 1).toISOString();
  const justAfter = new Date(NOW.getTime() - REJECT_COOLDOWN_MS).toISOString();
  const before = setup({ subscribers: ["u1"], rejected: [{ user_id: "u1", rejected_at: justBefore }] });
  await run(before.deps);
  assertEquals(before.sends.length, 0);
  const after = setup({ subscribers: ["u1"], rejected: [{ user_id: "u1", rejected_at: justAfter }] });
  await run(after.deps);
  assertEquals(after.sends.length, 1);
});

Deno.test("run: ugyldig tidsstempel på en avvisning betyr at vi prøver, ikke at brukeren glemmes for alltid", async () => {
  const { deps, sends } = setup({ subscribers: ["u1"], rejected: [{ user_id: "u1", rejected_at: "ikke en dato" }] });
  await run(deps);
  assertEquals(sends.length, 1);
});

Deno.test("run: utsatte brukere teller verken som forsøk eller som avvisning", async () => {
  const cooling = Array.from({ length: MAX_ATTEMPTS_PER_RUN + 20 }, (_, i) => `bad${i}`);
  const { deps, sends, sleeps } = setup({
    subscribers: [...cooling, "u1"],
    rejected: cooling.map((user_id) => ({ user_id, rejected_at: hoursAgo(1) })),
    sendResult: rejectBad,
  });
  const res = await run(deps);
  assert(res.ok);
  assertEquals(sends.map((s) => s.to), ["u1@example.com"]);
  assertEquals(res.stats.utsatt, cooling.length);
  assertEquals(sleeps, []); // ingen pause før den første
});

Deno.test("run: utsatt bruker uten nye biler regnes ikke som utsatt", async () => {
  const { deps, sends } = setup({
    subscribers: ["u1"],
    sent: [{ user_id: "u1", trip_id: "t1" }],
    rejected: [{ user_id: "u1", rejected_at: hoursAgo(1) }],
  });
  const res = await run(deps);
  assertEquals(res.stats.utsatt, 0);
  assertEquals(sends.length, 0);
});

Deno.test("run: får vi ikke lagret avvisningen, sier vi fra men fortsetter", async () => {
  const { deps, marks } = setup({
    subscribers: ["bad1", "u2"],
    sendResult: rejectBad,
    markRejected: () => Promise.reject(new Error("skriving feilet")),
  });
  const res = await run(deps);
  assertFalse(res.ok);
  assertFalse(res.avbrutt);
  assertStringIncludes(res.feil.join("\n"), "kunne ikke lagre avvisningen");
  assertEquals(marks.map((m) => m.userId), ["u2"]);
});

Deno.test("run: mange dårlige adresser først blokkerer ikke de gyldige. Køen går fremover for hver kjøring", async () => {
  // 25 permanent dårlige adresser står først, deretter tre gyldige.
  const subs = [...Array.from({ length: 25 }, (_, i) => `bad${String(i).padStart(2, "0")}`), "u1", "u2", "u3"];
  let rejected: RejectedRow[] = [];
  const delivered: string[] = [];
  for (let kjøring = 1; kjøring <= 4 && delivered.length < 3; kjøring++) {
    const { deps, sends, rejects } = setup({ subscribers: subs, rejected, sendResult: rejectBad });
    await run(deps);
    delivered.push(...sends.filter((s) => !bad(s)).map((s) => s.to));
    rejected = [...rejected, ...rejects.map((r) => ({ user_id: r.userId, rejected_at: NOW.toISOString() }))];
  }
  assertEquals(delivered.sort(), ["u1@example.com", "u2@example.com", "u3@example.com"]);
});

Deno.test("run: slutter å sende når kjøringen har tatt for lang tid, uten å regne det som feil", async () => {
  let t = NOW.getTime();
  let first = true;
  const subs = Array.from({ length: 40 }, (_, i) => `u${i}`);
  const { deps, sends } = setup({
    subscribers: subs,
    overrides: {
      // første kall er start av kjøringen. Deretter går det 10 sekunder for hvert kall
      now: () => {
        if (first) {
          first = false;
          return new Date(t);
        }
        t += 10_000;
        return new Date(t);
      },
    },
  });
  const res = await run(deps);
  assert(res.ok, JSON.stringify(res));
  assertFalse(res.avbrutt);
  assert(sends.length > 0 && sends.length < subs.length, `sendte ${sends.length}`);
  assert(sends.length <= Math.floor(MAX_RUN_MS / 10_000) + 1);
});
