// Tester logikken i docs/email.js (nettsidens avkrysning) uten nettleser.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import "../../../docs/email.js";

// deno-lint-ignore no-explicit-any
const { createController, isNotInstalled } = (globalThis as any).EmailAlerts;

type Event = string;

function fakeView() {
  const events: Event[] = [];
  return {
    events,
    setChecked: (v: boolean) => events.push(`checked:${v}`),
    setBusy: (v: boolean) => events.push(`busy:${v}`),
    clearError: () => events.push("clearError"),
    showError: (t: string) => events.push(`error:${t}`),
    showSaved: () => events.push("saved"),
  };
}

// deno-lint-ignore no-explicit-any
function fakeSb(opts: { row?: any; selectError?: unknown; rpcError?: unknown; rpcThrows?: boolean } = {}) {
  const rpcCalls: { name: string; args: unknown }[] = [];
  const selects: unknown[] = [];
  return {
    rpcCalls,
    selects,
    from(table: string) {
      assertEquals(table, "email_subscriptions");
      return {
        select: (cols: string) => ({
          eq: (col: string, val: string) => {
            selects.push({ cols, col, val });
            return { maybeSingle: () => Promise.resolve({ data: opts.row ?? null, error: opts.selectError ?? null }) };
          },
        }),
      };
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      if (opts.rpcThrows) return Promise.reject(new Error("nettverk"));
      return Promise.resolve({ error: opts.rpcError ?? null });
    },
  };
}

// Stille ned console.error i testene som med vilje feiler
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

Deno.test("email.js: load leser innstillingen for riktig bruker", async () => {
  const sb = fakeSb({ row: { enabled: true } });
  const view = fakeView();
  const c = createController(sb, view);
  assertEquals(await c.load("bruker-1"), true);
  assertEquals(sb.selects, [{ cols: "enabled", col: "user_id", val: "bruker-1" }]);
  assertEquals(view.events, ["checked:true"]);
  assert(c.enabled);
});

Deno.test("email.js: ingen rad betyr av", async () => {
  const c = createController(fakeSb({ row: null }), fakeView());
  assertEquals(await c.load("u"), false);
});

Deno.test("email.js: rad med enabled=false betyr av", async () => {
  const c = createController(fakeSb({ row: { enabled: false } }), fakeView());
  assertEquals(await c.load("u"), false);
});

Deno.test("email.js: feil ved lasting kastes videre så siden kan si fra", async () => {
  const c = createController(fakeSb({ selectError: new Error("rls") }), fakeView());
  await assertRejects(() => c.load("u"));
});

Deno.test("email.js: toggle lagrer via set_email_alerts og viser Lagret", async () => {
  const sb = fakeSb();
  const view = fakeView();
  const c = createController(sb, view);
  await c.toggle(true);
  assertEquals(sb.rpcCalls, [{ name: "set_email_alerts", args: { p_enabled: true } }]);
  assertEquals(view.events, ["busy:true", "clearError", "checked:true", "saved", "busy:false"]);
  assert(c.enabled);
  await c.toggle(false);
  assertEquals(sb.rpcCalls[1], { name: "set_email_alerts", args: { p_enabled: false } });
  assertEquals(c.enabled, false);
});

Deno.test("email.js: feil ved lagring ruller avkrysningen tilbake og sier fra", async () => {
  const sb = fakeSb({ row: { enabled: false }, rpcError: { message: "ikke tillatt" } });
  const view = fakeView();
  const c = createController(sb, view);
  await c.load("u");
  view.events.length = 0;
  await quiet(() => c.toggle(true));
  assertEquals(c.enabled, false); // uendret
  assertEquals(view.events, [
    "busy:true",
    "clearError",
    "checked:false",
    "error:Klarte ikke å lagre valget. Prøv igjen.",
    "busy:false",
  ]);
});

Deno.test("email.js: nettverksfeil håndteres likt, og avkrysningen låses opp igjen", async () => {
  const sb = fakeSb({ row: { enabled: true }, rpcThrows: true });
  const view = fakeView();
  const c = createController(sb, view);
  await c.load("u");
  view.events.length = 0;
  await quiet(() => c.toggle(false));
  assertEquals(c.enabled, true);
  assertEquals(view.events.at(-1), "busy:false");
  assert(view.events.includes("checked:true"));
  assert(view.events.some((e) => e.startsWith("error:")));
  assert(!view.events.includes("saved"));
});

Deno.test("email.js: siden røres ikke utenfor nettleser", () => {
  // Importen over kjørte i Deno uten document. Det skal ikke ha kastet noe.
  assertEquals(typeof (globalThis as { document?: unknown }).document, "undefined");
});

Deno.test("email.js: ikke-kjørt migrering gjenkjennes, slik at seksjonen kan skjules uten feilmelding", () => {
  assert(isNotInstalled({ code: "PGRST205", message: "Could not find the table 'public.email_subscriptions'" }));
  assert(isNotInstalled({ code: "42P01" }));
});

Deno.test("email.js: andre feil regnes ikke som «ikke installert»", () => {
  assertEquals(isNotInstalled({ code: "42501" }), false); // mangler rettighet
  assertEquals(isNotInstalled({ code: "PGRST301" }), false); // utløpt innlogging
  assertEquals(isNotInstalled(new Error("nettverk")), false);
  assertEquals(isNotInstalled(null), false);
  assertEquals(isNotInstalled(undefined), false);
});
