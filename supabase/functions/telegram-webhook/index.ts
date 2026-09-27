// telegram-webhook
// Telegram sender hver melding til boten hit. Brukes til å koble en
// Telegram-konto til en brukerkonto via /start <kode>, og til /stopp.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

const SITE = "sivertskalhjem.no";

function reply(chatId: number, text: string): Response {
  // Telegram godtar svaret direkte i responsen, så vi trenger ikke et eget kall
  return new Response(JSON.stringify({ method: "sendMessage", chat_id: chatId, text }), {
    headers: { "Content-Type": "application/json" },
  });
}

const ok = () => new Response("ok");

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET")?.trim();
  const given = req.headers.get("x-telegram-bot-api-secret-token")?.trim();
  if (!secret || given !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response("Mangler SUPABASE_URL eller SUPABASE_SERVICE_ROLE_KEY", { status: 500 });

  let update: any;
  try {
    update = await req.json();
  } catch {
    return ok();
  }

  const msg = update?.message;
  const chatId: number | undefined = msg?.chat?.id;
  const text: string = (msg?.text ?? "").trim();
  if (!chatId || msg?.chat?.type !== "private" || !text) return ok();

  const db = createClient(url, key, { auth: { persistSession: false } });
  const [command, ...args] = text.split(/\s+/);
  const cmd = command.toLowerCase().split("@")[0];

  try {
    // /start <kode> — kobler Telegram til kontoen som laget koden
    if (cmd === "/start") {
      const code = args[0];
      if (!code) {
        return reply(
          chatId,
          `Hei! 👋\n\nFor å få varsler om ledige Freerider-biler logger du inn på ${SITE} og trykker «Koble til Telegram».`,
        );
      }

      const { data: profile, error } = await db
        .from("profiles")
        .select("id")
        .eq("telegram_link_code", code)
        .gt("telegram_link_expires_at", new Date().toISOString())
        .maybeSingle();
      if (error) throw error;

      if (!profile) {
        return reply(
          chatId,
          `Koden er utløpt eller ugyldig. Gå til ${SITE} og trykk «Koble til Telegram» på nytt.`,
        );
      }

      // Samme Telegram-konto kan bare være koblet til én brukerkonto
      await db
        .from("profiles")
        .update({ telegram_chat_id: null, telegram_username: null })
        .eq("telegram_chat_id", chatId)
        .neq("id", profile.id);

      const { error: updErr } = await db
        .from("profiles")
        .update({
          telegram_chat_id: chatId,
          telegram_username: msg?.from?.username ?? null,
          telegram_link_code: null,
          telegram_link_expires_at: null,
        })
        .eq("id", profile.id);
      if (updErr) throw updErr;

      return reply(
        chatId,
        "✅ Koblet til!\n\nDu får nå varsel her når det dukker opp ledige biler på rutene dine. " +
          `Rutene velger du på ${SITE}.\n\nSkriv /stopp hvis du vil slutte å få varsler.`,
      );
    }

    // /stopp — kobler fra
    if (cmd === "/stopp" || cmd === "/stop") {
      await db
        .from("profiles")
        .update({ telegram_chat_id: null, telegram_username: null })
        .eq("telegram_chat_id", chatId);
      return reply(chatId, `Du får ikke lenger varsler her. Du kan koble til igjen når som helst på ${SITE}.`);
    }

    return reply(
      chatId,
      `Denne boten sender bare varsler. Rutene dine styrer du på ${SITE}.\n\nSkriv /stopp for å slutte å få varsler.`,
    );
  } catch (e) {
    console.error(e);
    return reply(chatId, "Noe gikk galt hos oss. Prøv igjen om litt.");
  }
});
