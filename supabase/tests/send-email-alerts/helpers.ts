import type { Trip, Watch } from "../../functions/send-email-alerts/logic.ts";

export const NOW = new Date("2026-11-03T10:00:00Z"); // 11:00 norsk tid

export function trip(over: Partial<Trip> = {}): Trip {
  return {
    id: "t1",
    car_model: "Tesla Model 3",
    from_name: "GARDERMOEN",
    from_city: "OSLO",
    to_name: "BLOMSTERDALEN",
    to_city: "BERGEN",
    available_at: "2026-11-04T07:00:00Z", // 4. nov kl. 08:00
    latest_return: "2026-11-08T12:00:00Z",
    expire_time: "2026-11-05T13:00:00Z", // 5. nov kl. 14:00
    last_seen_at: "2026-11-03T09:58:00Z", // to minutter før NOW
    ...over,
  };
}

export function watch(over: Partial<Watch> = {}): Watch {
  return {
    user_id: "u1",
    from_city: "OSLO",
    to_city: "BERGEN",
    date_from: null,
    date_to: null,
    ...over,
  };
}
