import { assert, assertEquals, assertFalse, assertNotEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import {
  activeWatches,
  buildEmail,
  escapeHtml,
  idempotencyKey,
  matchesWatch,
  MAX_TRIPS_PER_EMAIL,
  selectFresh,
  SETTINGS_URL,
  SITE_URL,
  subjectFor,
  freshTrips,
} from "../../functions/send-email-alerts/logic.ts";
import { NOW, trip, watch } from "./helpers.ts";

// ------------------------------------------------------------ matchesWatch

Deno.test("matchesWatch: fra og til må begge stemme", () => {
  assert(matchesWatch(trip(), watch()));
  assertFalse(matchesWatch(trip(), watch({ from_city: "TRONDHEIM" })));
  assertFalse(matchesWatch(trip(), watch({ to_city: "STAVANGER" })));
});

Deno.test("matchesWatch: tom fra eller til betyr hvor som helst", () => {
  assert(matchesWatch(trip(), watch({ from_city: null })));
  assert(matchesWatch(trip(), watch({ to_city: null })));
  assert(matchesWatch(trip(), watch({ from_city: "  ", to_city: "BERGEN" })));
});

Deno.test("matchesWatch: store og små bokstaver og mellomrom spiller ingen rolle på ruta", () => {
  assert(matchesWatch(trip(), watch({ from_city: " oslo ", to_city: "Bergen" })));
});

Deno.test("matchesWatch: periode som overlapper bilens bruksperiode treffer", () => {
  // Bilen kan brukes 4.–8. nov
  assert(matchesWatch(trip(), watch({ date_from: "2026-11-06", date_to: "2026-11-10" })));
  assert(matchesWatch(trip(), watch({ date_from: "2026-11-08", date_to: "2026-11-08" })));
  assert(matchesWatch(trip(), watch({ date_from: "2026-11-04", date_to: "2026-11-04" })));
});

Deno.test("matchesWatch: periode før eller etter bruksperioden treffer ikke", () => {
  assertFalse(matchesWatch(trip(), watch({ date_from: "2026-11-01", date_to: "2026-11-03" })));
  assertFalse(matchesWatch(trip(), watch({ date_from: "2026-11-09", date_to: "2026-11-12" })));
});

Deno.test("matchesWatch: bare én dato er en enkeltdag", () => {
  assert(matchesWatch(trip(), watch({ date_from: "2026-11-05" })));
  assertFalse(matchesWatch(trip(), watch({ date_to: "2026-11-02" })));
});

Deno.test("matchesWatch: uten latest_return brukes expire_time som slutt", () => {
  const t = trip({ latest_return: null }); // utløper 5. nov
  assert(matchesWatch(t, watch({ date_from: "2026-11-05", date_to: "2026-11-06" })));
  assertFalse(matchesWatch(t, watch({ date_from: "2026-11-06", date_to: "2026-11-07" })));
});

Deno.test("matchesWatch: uten sluttid er bilen åpen for alltid", () => {
  const t = trip({ latest_return: null, expire_time: null });
  assert(matchesWatch(t, watch({ date_from: "2030-01-01", date_to: "2030-01-02" })));
});

Deno.test("matchesWatch: dato regnes i norsk tid, ikke UTC", () => {
  // 23:30 UTC 8. nov er 00:30 norsk tid 9. nov, og da er bilen levert for den 8.
  const t = trip({ latest_return: "2026-11-08T23:30:00Z" });
  assert(matchesWatch(t, watch({ date_from: "2026-11-09", date_to: "2026-11-09" })));
});

// ------------------------------------------------------------ activeWatches

Deno.test("activeWatches: fjerner ruter hvis periode er passert, beholder resten", () => {
  const ws = [
    watch({ date_to: "2026-11-02" }), // passert
    watch({ date_to: "2026-11-03" }), // i dag teller fortsatt
    watch({ date_to: "2026-12-01" }),
    watch({ date_to: null }),
  ];
  assertEquals(activeWatches(ws, NOW).length, 3);
});

Deno.test("activeWatches: bruker norsk dato rundt midnatt", () => {
  // 23:30 UTC 3. nov er allerede 4. nov i Norge
  const lateNow = new Date("2026-11-03T23:30:00Z");
  assertEquals(activeWatches([watch({ date_to: "2026-11-03" })], lateNow).length, 0);
});

// ------------------------------------------------------------ selectFresh

Deno.test("selectFresh: tar bare biler som passer og ikke er sendt", () => {
  const trips = [
    trip({ id: "a" }),
    trip({ id: "b", to_city: "STAVANGER" }),
    trip({ id: "c" }),
  ];
  const fresh = selectFresh(trips, [watch()], new Set(["c"]));
  assertEquals(fresh.map((t) => t.id), ["a"]);
});

Deno.test("selectFresh: samme bil tas med én gang selv om flere ruter passer", () => {
  const fresh = selectFresh([trip()], [watch(), watch({ to_city: null }), watch({ from_city: null })], new Set());
  assertEquals(fresh.length, 1);
});

Deno.test("selectFresh: dobbeltoppføring av samme id tas med én gang", () => {
  const fresh = selectFresh([trip({ id: "x" }), trip({ id: "x" })], [watch()], new Set());
  assertEquals(fresh.length, 1);
});

Deno.test("selectFresh: sorterer etter utløp, uten utløp sist", () => {
  const trips = [
    trip({ id: "sen", expire_time: "2026-11-07T10:00:00Z" }),
    trip({ id: "uten", expire_time: null }),
    trip({ id: "tidlig", expire_time: "2026-11-04T10:00:00Z" }),
  ];
  assertEquals(selectFresh(trips, [watch()], new Set()).map((t) => t.id), ["tidlig", "sen", "uten"]);
});

Deno.test("selectFresh: ingen ruter gir ingen biler", () => {
  assertEquals(selectFresh([trip()], [], new Set()), []);
});

Deno.test("selectFresh: endrer ikke input", () => {
  const trips = [trip({ id: "b", expire_time: "2026-11-07T10:00:00Z" }), trip({ id: "a" })];
  const copy = structuredClone(trips);
  selectFresh(trips, [watch()], new Set());
  assertEquals(trips, copy);
});

// ------------------------------------------------------------ freshTrips

Deno.test("freshTrips: tom liste gir tom liste", () => {
  assertEquals(freshTrips([], NOW), []);
});

Deno.test("freshTrips: beholder nylig oppdaterte biler", () => {
  assertEquals(freshTrips([trip()], NOW).length, 1);
});

Deno.test("freshTrips: fjerner gamle rader selv når andre er ferske", () => {
  // check-trips kan ha oppdatert nye biler, men stoppet før den ryddet bort de gamle
  const old = trip({ id: "gammel", last_seen_at: "2026-11-03T05:00:00Z" });
  assertEquals(freshTrips([old, trip({ id: "ny" })], NOW).map((t) => t.id), ["ny"]);
});

Deno.test("freshTrips: grensen er inklusiv", () => {
  const exactly = new Date(NOW.getTime() - 15 * 60_000).toISOString();
  assertEquals(freshTrips([trip({ last_seen_at: exactly })], NOW).length, 1);
  const justOver = new Date(NOW.getTime() - 15 * 60_000 - 1).toISOString();
  assertEquals(freshTrips([trip({ last_seen_at: justOver })], NOW).length, 0);
});

Deno.test("freshTrips: ugyldig tidsstempel regnes som gammelt", () => {
  assertEquals(freshTrips([trip({ last_seen_at: "ikke en dato" })], NOW), []);
  assertEquals(freshTrips([trip({ last_seen_at: "" })], NOW), []);
});

Deno.test("freshTrips: endrer ikke input", () => {
  const trips = [trip({ id: "gammel", last_seen_at: "2026-11-03T05:00:00Z" }), trip({ id: "ny" })];
  const copy = structuredClone(trips);
  freshTrips(trips, NOW);
  assertEquals(trips, copy);
});

// ------------------------------------------------------------ idempotencyKey

Deno.test("idempotencyKey: samme input gir samme nøkkel, uavhengig av rekkefølge", async () => {
  assertEquals(await idempotencyKey("u1", ["a", "b"]), await idempotencyKey("u1", ["b", "a"]));
});

Deno.test("idempotencyKey: ulik bruker eller ulike biler gir ulik nøkkel", async () => {
  const base = await idempotencyKey("u1", ["a", "b"]);
  assertNotEquals(base, await idempotencyKey("u2", ["a", "b"]));
  assertNotEquals(base, await idempotencyKey("u1", ["a", "c"]));
  assertNotEquals(base, await idempotencyKey("u1", ["a"]));
});

Deno.test("idempotencyKey: endrer ikke input og holder seg under Resends grense", async () => {
  const ids = ["b", "a"];
  const key = await idempotencyKey("00000000-0000-0000-0000-000000000000", ids);
  assertEquals(ids, ["b", "a"]);
  assert(key.length <= 256);
});

// ------------------------------------------------------------ escapeHtml

Deno.test("escapeHtml: escaper alle spesialtegn", () => {
  assertEquals(escapeHtml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
});

// ------------------------------------------------------------ buildEmail

Deno.test("subjectFor: én bil nevner ruta, flere nevner antallet", () => {
  assertEquals(subjectFor([trip()]), "🚗 Ny gratis returbil: Gardermoen → Blomsterdalen");
  assertEquals(subjectFor([trip(), trip({ id: "t2" })]), "🚗 2 nye gratis returbiler");
});

Deno.test("buildEmail: tekst har samme innhold som Telegram-meldingen", () => {
  const { text } = buildEmail([trip()]);
  assertStringIncludes(text, "🚗 Gardermoen → Blomsterdalen");
  assertStringIncludes(text, "Bil: Tesla Model 3");
  assertStringIncludes(text, "Tilbudet utløper: 5. nov kl. 14:00");
  assertStringIncludes(text, "Tilgjengelig fra: 4. nov kl. 08:00");
  assertStringIncludes(text, "Se alle på kartet: https://sivertskalhjem.no/oversikt.html");
  assertStringIncludes(text, "Bestill her: https://hertzfreerider.no");
});

Deno.test("buildEmail: lenke til innstillinger står i både tekst og html", () => {
  const { text, html } = buildEmail([trip()]);
  assertStringIncludes(text, SETTINGS_URL);
  assertStringIncludes(html, `href="${SETTINGS_URL}"`);
});

Deno.test("buildEmail: flere biler skilles og får hver sin blokk", () => {
  const { text, html } = buildEmail([trip({ id: "a" }), trip({ id: "b", car_model: "Volvo EX30" })]);
  assertStringIncludes(text, "———");
  assertStringIncludes(text, "Volvo EX30");
  assertEquals(html.split("🚗").length - 1, 2);
});

Deno.test("buildEmail: manglende data får fornuftige standardtekster", () => {
  const { text } = buildEmail([trip({ car_model: null, expire_time: null, available_at: null })]);
  assertStringIncludes(text, "Bil: Ukjent bilmodell");
  assertStringIncludes(text, "Tilbudet utløper: ukjent");
  assertStringIncludes(text, "Tilgjengelig fra: ukjent");
});

Deno.test("buildEmail: html escaper data fra Hertz, så de ikke kan injisere noe", () => {
  const evil = `<script>alert("x")</script>`;
  const { html } = buildEmail([trip({ car_model: evil, from_name: evil, to_name: `"><img src=x>` })]);
  assertFalse(html.includes("<script>"));
  assertFalse(html.includes("<img"));
  assertStringIncludes(html, "&lt;script&gt;");
});

Deno.test("buildEmail: forteller når flere biler venter til neste e-post", () => {
  const { text, html, subject } = buildEmail([trip()], 5);
  assertStringIncludes(text, "… og 4 til. De kommer i neste e-post.");
  assertStringIncludes(html, "… og 4 til.");
  assertEquals(subject, "🚗 5 nye gratis returbiler");
});

Deno.test("buildEmail: sier ikke «og flere» når alt får plass", () => {
  assertFalse(buildEmail([trip()]).text.includes("og 0 til"));
  assertFalse(buildEmail([trip()]).text.includes("De kommer i neste"));
});

Deno.test("buildEmail: nekter tom liste og for mange biler", () => {
  assertThrows(() => buildEmail([]));
  const many = Array.from({ length: MAX_TRIPS_PER_EMAIL + 1 }, (_, i) => trip({ id: `t${i}` }));
  assertThrows(() => buildEmail(many));
  buildEmail(many.slice(0, MAX_TRIPS_PER_EMAIL)); // akkurat grensen går bra
});

Deno.test("buildEmail: html er et komplett dokument med norsk språk", () => {
  const { html } = buildEmail([trip()]);
  assert(html.startsWith("<!doctype html>"));
  assertStringIncludes(html, `<html lang="nb">`);
});

Deno.test("buildEmail: sier tydelig hvem e-posten er fra, i både tekst og html", () => {
  const { text, html } = buildEmail([trip()]);
  assert(text.startsWith("Sivert skal hjem\n"));
  assertStringIncludes(text, "slått på e-postvarsler hos Sivert skal hjem");
  assertStringIncludes(text, "ikke tilknyttet Hertz");
  assertStringIncludes(html, `<a href="${SITE_URL}"`);
  assertStringIncludes(html, ">Sivert skal hjem</a>");
  assertStringIncludes(html, "slått på e-postvarsler hos Sivert skal hjem");
  assertStringIncludes(html, "ikke tilknyttet Hertz");
});
