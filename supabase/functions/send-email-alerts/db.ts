// Koblingen til Supabase og Resend. Holdt så tynn som mulig: all beslutningslogikk ligger i
// run.ts og logic.ts. Denne filen testes mot en lokal Supabase (supabase start), ikke med enhetstester.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";
import type { Config } from "./handler.ts";
import type { Deps, RejectedRow, SentRow } from "./run.ts";
import type { Trip, Watch } from "./logic.ts";
import { sendViaResend } from "./resend.ts";

const TRIP_COLUMNS =
  "id, car_model, from_name, from_city, to_name, to_city, available_at, latest_return, expire_time, last_seen_at";

async function selectAll<T>(
  db: any,
  table: string,
  columns: string,
  orderBy: string[],
  filter?: (q: any) => any,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0;; from += 1000) {
    let q = db.from(table).select(columns);
    if (filter) q = filter(q);
    for (const col of orderBy) q = q.order(col);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

export function buildDeps(config: Config): Deps {
  const db = createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false } });

  return {
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

    loadTrips: () => selectAll<Trip>(db, "trips", TRIP_COLUMNS, ["id"]),

    async loadSubscribers() {
      // Paginert: PostgREST gir ellers bare de første 1000 radene, uten feilmelding
      const rows = await selectAll<{ user_id: string }>(
        db,
        "email_subscriptions",
        "user_id, profiles!inner(notifications_enabled)",
        ["user_id"],
        (q) => q.eq("enabled", true).eq("profiles.notifications_enabled", true),
      );
      return rows.map((r) => r.user_id);
    },

    loadWatches: () =>
      selectAll<Watch>(db, "watched_routes", "user_id, from_city, to_city, date_from, date_to", ["id"]),

    loadSent: () => selectAll<SentRow>(db, "email_sent", "user_id, trip_id", ["user_id", "trip_id"]),

    loadRejected: () => selectAll<RejectedRow>(db, "email_rejected", "user_id, rejected_at", ["user_id"]),

    async getEmail(userId) {
      const { data, error } = await db.auth.admin.getUserById(userId);
      if (error) throw new Error(`auth: ${error.message}`);
      const user = data?.user;
      if (!user?.email || !user.email_confirmed_at) return null;
      return user.email;
    },

    send: (mail) => sendViaResend(config.resend, mail),

    async markSent(userId, tripIds) {
      const rows = tripIds.map((trip_id) => ({ user_id: userId, trip_id }));
      const { error } = await db.from("email_sent").upsert(rows, { onConflict: "user_id,trip_id" });
      if (error) throw new Error(error.message);
    },

    async markRejected(userId, reason) {
      const { error } = await db
        .from("email_rejected")
        .upsert(
          { user_id: userId, rejected_at: new Date().toISOString(), reason: reason.slice(0, 200) },
          { onConflict: "user_id" },
        );
      if (error) throw new Error(error.message);
    },
  };
}
