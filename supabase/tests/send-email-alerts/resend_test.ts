import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import { RESEND_URL, sendViaResend } from "../../functions/send-email-alerts/resend.ts";
import { buildEmail } from "../../functions/send-email-alerts/logic.ts";
import { trip } from "./helpers.ts";

const CONFIG = { apiKey: "re_hemmelig_nokkel", from: "Sivert skal hjem <varsler@sivertskalhjem.no>" };
const MAIL = { to: "bruker@example.com", email: buildEmail([trip()]), idempotencyKey: "nokkel-1" };

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.test("resend: sender riktig forespørsel", async () => {
  const { fn, calls } = fakeFetch(() => reply(200, { id: "x" }));
  const res = await sendViaResend(CONFIG, MAIL, fn);
  assertEquals(res, { status: "ok" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, RESEND_URL);
  const headers = calls[0].init.headers as Record<string, string>;
  assertEquals(headers.Authorization, "Bearer re_hemmelig_nokkel");
  assertEquals(headers["Idempotency-Key"], "nokkel-1");
  assertEquals(calls[0].init.method, "POST");
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.from, CONFIG.from);
  assertEquals(body.to, ["bruker@example.com"]);
  assertEquals(body.subject, MAIL.email.subject);
  assertEquals(body.html, MAIL.email.html);
  assertEquals(body.text, MAIL.email.text);
  assertFalse("reply_to" in body);
});

Deno.test("resend: reply_to tas med når den er satt", async () => {
  const { fn, calls } = fakeFetch(() => reply(200));
  await sendViaResend({ ...CONFIG, replyTo: "hjelp@example.com" }, MAIL, fn);
  assertEquals(JSON.parse(calls[0].init.body as string).reply_to, "hjelp@example.com");
});

Deno.test("resend: 401 og 403 er fatale (feil nøkkel eller avsender)", async () => {
  for (const status of [401, 403]) {
    const { fn } = fakeFetch(() => reply(status, { message: "API key is invalid" }));
    const res = await sendViaResend(CONFIG, MAIL, fn);
    assertEquals(res.status, "fatal");
    assert(res.status === "fatal" && res.message.includes("RESEND_API_KEY"));
  }
});

Deno.test("resend: 429 og 5xx kan prøves igjen", async () => {
  for (const status of [429, 500, 502, 503]) {
    const { fn } = fakeFetch(() => reply(status));
    assertEquals((await sendViaResend(CONFIG, MAIL, fn)).status, "retry");
  }
});

Deno.test("resend: øvrige 4xx gjelder bare denne e-posten", async () => {
  for (const status of [400, 404, 409, 422]) {
    const { fn } = fakeFetch(() => reply(status, { message: "invalid `to` field" }));
    assertEquals((await sendViaResend(CONFIG, MAIL, fn)).status, "rejected");
  }
});

Deno.test("resend: nettverksfeil og timeout kan prøves igjen", async () => {
  const boom = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
  const res = await sendViaResend(CONFIG, MAIL, boom);
  assertEquals(res.status, "retry");
  const timeout = (() => Promise.reject(new DOMException("tid ute", "TimeoutError"))) as unknown as typeof fetch;
  assertEquals((await sendViaResend(CONFIG, MAIL, timeout)).status, "retry");
});

Deno.test("resend: svar som ikke er JSON ødelegger ikke feilhåndteringen", async () => {
  const { fn } = fakeFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
  const res = await sendViaResend(CONFIG, MAIL, fn);
  assertEquals(res.status, "retry");
});

Deno.test("resend: feilmeldinger inneholder aldri nøkkel eller adresse", async () => {
  const statuses = [401, 403, 422, 429, 500];
  for (const status of statuses) {
    const { fn } = fakeFetch(() => reply(status, { message: "noe gikk galt" }));
    const res = await sendViaResend(CONFIG, MAIL, fn);
    const text = JSON.stringify(res);
    assertFalse(text.includes("re_hemmelig_nokkel"), `status ${status}`);
    assertFalse(text.includes("bruker@example.com"), `status ${status}`);
  }
  const boom = (() => Promise.reject(new TypeError("fetch failed: re_hemmelig_nokkel"))) as unknown as typeof fetch;
  assertFalse(JSON.stringify(await sendViaResend(CONFIG, MAIL, boom)).includes("re_hemmelig_nokkel"));
});

Deno.test("resend: lange feilmeldinger kortes ned", async () => {
  const { fn } = fakeFetch(() => reply(422, { message: "x".repeat(5000) }));
  const res = await sendViaResend(CONFIG, MAIL, fn);
  assert(res.status === "rejected" && res.message.length < 400);
  assertStringIncludes(res.status === "rejected" ? res.message : "", "422");
});
