import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import {
  type Config,
  emailAlertsEnabled,
  type Env,
  handle,
  readConfig,
  safeEqual,
} from "../../functions/send-email-alerts/handler.ts";
import type { Deps } from "../../functions/send-email-alerts/run.ts";
import { trip, watch } from "./helpers.ts";

const FULL_ENV: Record<string, string> = {
  CRON_SECRET: "hemmelig-cron-nokkel",
  EMAIL_ALERTS_ENABLED: "true",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-hemmelighet",
  RESEND_API_KEY: "re_hemmelig_nokkel",
  EMAIL_FROM: "Sivert skal hjem <varsler@sivertskalhjem.no>",
};

const envOf = (vars: Record<string, string | undefined>): Env => (name) => vars[name];
const without = (name: string) => ({ ...FULL_ENV, [name]: undefined });

function request(secret?: string): Request {
  return new Request("https://example.test/send-email-alerts", {
    method: "POST",
    headers: secret === undefined ? {} : { "x-cron-secret": secret },
  });
}

function ctx(vars: Record<string, string | undefined>, deps?: Partial<Deps>) {
  const built: Config[] = [];
  const sends: string[] = [];
  return {
    built,
    sends,
    context: {
      env: envOf(vars),
      buildDeps: (config: Config): Deps => {
        built.push(config);
        return {
          now: () => new Date("2026-11-03T10:00:00Z"),
          sleep: () => Promise.resolve(),
          loadTrips: () => Promise.resolve([trip()]),
          loadSubscribers: () => Promise.resolve(["u1"]),
          loadWatches: () => Promise.resolve([watch()]),
          loadSent: () => Promise.resolve([]),
          loadRejected: () => Promise.resolve([]),
          getEmail: () => Promise.resolve("bruker@example.com"),
          send: (m) => (sends.push(m.to), Promise.resolve({ status: "ok" as const })),
          markSent: () => Promise.resolve(),
          markRejected: () => Promise.resolve(),
          ...deps,
        };
      },
    },
  };
}

// ------------------------------------------------------------ nøkkel

Deno.test("handle: mangler CRON_SECRET i oppsettet gir 500", async () => {
  const { context, built } = ctx(without("CRON_SECRET"));
  const res = await handle(request("noe"), context);
  assertEquals(res.status, 500);
  assertStringIncludes((await res.json()).feil, "CRON_SECRET");
  assertEquals(built.length, 0);
});

Deno.test("handle: mangler header gir 401", async () => {
  const { context, built } = ctx(FULL_ENV);
  assertEquals((await handle(request(), context)).status, 401);
  assertEquals(built.length, 0);
});

Deno.test("handle: feil nøkkel gir 401, uten å avsløre noe om riktig nøkkel", async () => {
  const { context, built } = ctx(FULL_ENV);
  const res = await handle(request("feil"), context);
  assertEquals(res.status, 401);
  const text = JSON.stringify(await res.json());
  assertFalse(text.includes("hemmelig"));
  assertFalse(text.includes(String(FULL_ENV.CRON_SECRET.length)));
  assertEquals(built.length, 0);
});

Deno.test("handle: nøkkel med mellomrom rundt godtas", async () => {
  const { context } = ctx(FULL_ENV);
  assertEquals((await handle(request("  hemmelig-cron-nokkel "), context)).status, 200);
});

Deno.test("safeEqual", () => {
  assert(safeEqual("abc", "abc"));
  assertFalse(safeEqual("abc", "abd"));
  assertFalse(safeEqual("abc", "abcd"));
  assertFalse(safeEqual("", "a"));
  assert(safeEqual("", ""));
  assert(safeEqual("æøå", "æøå"));
});

// ------------------------------------------------------------ bryter

Deno.test("bryter: bare «true» slår på", () => {
  for (const on of ["true", "TRUE", " True ", "true\n"]) {
    assert(emailAlertsEnabled(envOf({ EMAIL_ALERTS_ENABLED: on })), JSON.stringify(on));
  }
  for (const off of [undefined, "", " ", "false", "1", "yes", "on", "truee", "ja"]) {
    assertFalse(emailAlertsEnabled(envOf({ EMAIL_ALERTS_ENABLED: off })), JSON.stringify(off));
  }
});

Deno.test("handle: avslått gir 200, og ingenting leses, bygges eller sendes", async () => {
  for (const off of [undefined, "false", ""]) {
    const { context, built, sends } = ctx({ ...FULL_ENV, EMAIL_ALERTS_ENABLED: off });
    const res = await handle(request(FULL_ENV.CRON_SECRET), context);
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(body.ok);
    assertStringIncludes(body.hoppet_over, "slått av");
    assertEquals(built.length, 0);
    assertEquals(sends.length, 0);
  }
});

Deno.test("handle: avslått krever ikke at resten av oppsettet finnes", async () => {
  const { context } = ctx({ CRON_SECRET: "k", EMAIL_ALERTS_ENABLED: "false" });
  assertEquals((await handle(request("k"), context)).status, 200);
});

// ------------------------------------------------------------ oppsett

Deno.test("handle: manglende oppsett nevner navnene, aldri verdiene, og sender ingenting", async () => {
  for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "EMAIL_FROM"]) {
    const { context, built, sends } = ctx(without(name));
    const res = await handle(request(FULL_ENV.CRON_SECRET), context);
    assertEquals(res.status, 500, name);
    const text = JSON.stringify(await res.json());
    assertStringIncludes(text, name);
    assertFalse(text.includes("re_hemmelig_nokkel"));
    assertFalse(text.includes("service-role-hemmelighet"));
    assertEquals(built.length, 0);
    assertEquals(sends.length, 0);
  }
});

Deno.test("handle: alle manglende navn oppgis samtidig", async () => {
  const { context } = ctx({ CRON_SECRET: "k", EMAIL_ALERTS_ENABLED: "true" });
  const body = await (await handle(request("k"), context)).json();
  for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "EMAIL_FROM"]) {
    assertStringIncludes(body.feil, name);
  }
});

Deno.test("handle: tomme og mellomroms-verdier regnes som manglende", async () => {
  const { context } = ctx({ ...FULL_ENV, RESEND_API_KEY: "   " });
  const res = await handle(request(FULL_ENV.CRON_SECRET), context);
  assertEquals(res.status, 500);
  assertStringIncludes((await res.json()).feil, "RESEND_API_KEY");
});

Deno.test("readConfig: EMAIL_REPLY_TO er valgfri", () => {
  const without = readConfig(envOf(FULL_ENV));
  assert(without.kind === "ready" && !("replyTo" in without.config.resend));
  const withReply = readConfig(envOf({ ...FULL_ENV, EMAIL_REPLY_TO: "hjelp@example.com" }));
  assert(withReply.kind === "ready" && withReply.config.resend.replyTo === "hjelp@example.com");
});

// ------------------------------------------------------------ kjøring

Deno.test("handle: vellykket kjøring gir 200 med oppsummering", async () => {
  const { context, sends } = ctx(FULL_ENV);
  const res = await handle(request(FULL_ENV.CRON_SECRET), context);
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(body.ok);
  assertEquals(body.stats.epostSendt, 1);
  assertEquals(sends, ["bruker@example.com"]);
  assertEquals(res.headers.get("Cache-Control"), "no-store");
});

Deno.test("handle: feil under kjøring gir 500 med forklaring", async () => {
  const { context } = ctx(FULL_ENV, { loadTrips: () => Promise.reject(new Error("db nede")) });
  const res = await handle(request(FULL_ENV.CRON_SECRET), context);
  assertEquals(res.status, 500);
  const body = await res.json();
  assertFalse(body.ok);
  assertStringIncludes(body.avbrutt, "db nede");
});

Deno.test("handle: får buildDeps til å kaste, gir det 500 og ikke en krasj", async () => {
  const context = {
    env: envOf(FULL_ENV),
    buildDeps: (): Deps => {
      throw new Error("kunne ikke koble til");
    },
  };
  const res = await handle(request(FULL_ENV.CRON_SECRET), context);
  assertEquals(res.status, 500);
  assertStringIncludes((await res.json()).feil, "kunne ikke koble til");
});

Deno.test("handle: svaret inneholder aldri nøkler eller adresser", async () => {
  const { context } = ctx(FULL_ENV, {
    send: () => Promise.resolve({ status: "rejected" as const, message: "Resend nektet e-posten (422)" }),
  });
  const res = await handle(request(FULL_ENV.CRON_SECRET), context);
  const text = JSON.stringify(await res.json());
  for (const secret of ["hemmelig-cron-nokkel", "re_hemmelig_nokkel", "service-role-hemmelighet", "bruker@example.com"]) {
    assertFalse(text.includes(secret), secret);
  }
});
