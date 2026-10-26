// HTTP-laget: sjekker nøkkel og oppsett, og kjører så `run`. Miljø og databasetilgang kommer
// inn utenfra, så alle grener kan testes.
//
// Svarkoder:
//   200  alt gikk bra, eller e-postvarsler er slått av (EMAIL_ALERTS_ENABLED er ikke «true»)
//   401  mangler eller feil x-cron-secret
//   500  oppsettet mangler noe, eller kjøringen feilet helt eller delvis
// Kroppen er JSON med forklaring på norsk. Den inneholder aldri nøkler eller e-postadresser.

import { type Deps, run } from "./run.ts";
import type { ResendConfig } from "./resend.ts";

export type Env = (name: string) => string | undefined;

export type Config = {
  supabaseUrl: string;
  serviceRoleKey: string;
  resend: ResendConfig;
};

export type ConfigResult =
  | { kind: "disabled" }
  | { kind: "misconfigured"; missing: string[] }
  | { kind: "ready"; config: Config };

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "EMAIL_FROM"] as const;

function value(env: Env, name: string): string | undefined {
  const v = env(name)?.trim();
  return v ? v : undefined;
}

/** Bryteren: bare nøyaktig «true» (store/små bokstaver og mellomrom spiller ingen rolle) slår på. */
export function emailAlertsEnabled(env: Env): boolean {
  return value(env, "EMAIL_ALERTS_ENABLED")?.toLowerCase() === "true";
}

export function readConfig(env: Env): ConfigResult {
  if (!emailAlertsEnabled(env)) return { kind: "disabled" };
  const missing = REQUIRED.filter((name) => !value(env, name));
  if (missing.length) return { kind: "misconfigured", missing };
  const replyTo = value(env, "EMAIL_REPLY_TO");
  return {
    kind: "ready",
    config: {
      supabaseUrl: value(env, "SUPABASE_URL")!,
      serviceRoleKey: value(env, "SUPABASE_SERVICE_ROLE_KEY")!,
      resend: {
        apiKey: value(env, "RESEND_API_KEY")!,
        from: value(env, "EMAIL_FROM")!,
        ...(replyTo ? { replyTo } : {}),
      },
    },
  };
}

/** Sammenligner uten å lekke hvor mange tegn som stemte. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export type Context = {
  env: Env;
  buildDeps(config: Config): Deps;
};

export async function handle(req: Request, ctx: Context): Promise<Response> {
  const secret = value(ctx.env, "CRON_SECRET");
  const given = req.headers.get("x-cron-secret")?.trim();
  if (!secret) {
    return json({ ok: false, feil: "CRON_SECRET finnes ikke i Edge Functions → Secrets" }, 500);
  }
  if (!given) return json({ ok: false, feil: "Kallet mangler headeren x-cron-secret" }, 401);
  if (!safeEqual(given, secret)) return json({ ok: false, feil: "Feil x-cron-secret" }, 401);

  const cfg = readConfig(ctx.env);
  if (cfg.kind === "disabled") {
    return json({ ok: true, hoppet_over: "E-postvarsler er slått av (EMAIL_ALERTS_ENABLED er ikke «true»)" }, 200);
  }
  if (cfg.kind === "misconfigured") {
    return json({ ok: false, feil: `Mangler i Edge Functions → Secrets: ${cfg.missing.join(", ")}` }, 500);
  }

  let result;
  try {
    result = await run(ctx.buildDeps(cfg.config));
  } catch (e) {
    // run() fanger det meste selv. Dette er siste skanse.
    console.error("send-email-alerts: uventet feil", e);
    return json({ ok: false, feil: `Uventet feil: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
  if (!result.ok) console.error("send-email-alerts:", JSON.stringify(result));
  return json(result, result.ok ? 200 : 500);
}
