// Vakt mot at kopien i logic.ts og check-trips/index.ts glir fra hverandre.
// Feiler denne, har noen endret hvordan check-trips matcher eller formaterer. Oppdater da
// logic.ts på samme måte (eller flytt logikken til en felles fil, om dere heller vil det).
import { assertEquals, assert } from "jsr:@std/assert@1";

const CHECK_TRIPS = await Deno.readTextFile(new URL("../../functions/check-trips/index.ts", import.meta.url));
const LOGIC = await Deno.readTextFile(new URL("../../functions/send-email-alerts/logic.ts", import.meta.url));

const norm = (s: string) => s.replace(/^export\s+/, "").replace(/\s+/g, " ").trim();

function fn(source: string, name: string): string {
  const start = source.search(new RegExp(`(^|\\n)(export )?function ${name}\\(`));
  assert(start >= 0, `fant ikke function ${name}`);
  const end = source.indexOf("\n}\n", start + 1);
  assert(end > start, `fant ikke slutten på function ${name}`);
  return norm(source.slice(start, end + 2));
}

function constant(source: string, name: string): string {
  const m = source.match(new RegExp(`const ${name} = [^\\n]*;`));
  assert(m, `fant ikke const ${name}`);
  return norm(m[0]);
}

function type(source: string, name: string): string {
  const m = source.match(new RegExp(`(?:export )?type ${name} = \\{[\\s\\S]*?\\n\\};`));
  assert(m, `fant ikke type ${name}`);
  return norm(m[0]);
}

for (const name of ["pad", "osloParts", "formatDato", "pen", "osloDate", "matchesWatch", "byExpiry"]) {
  Deno.test(`drift: function ${name} er lik i check-trips og send-email-alerts`, () => {
    assertEquals(fn(LOGIC, name), fn(CHECK_TRIPS, name));
  });
}

for (const name of ["MAANEDER", "SMAA_ORD"]) {
  Deno.test(`drift: const ${name} er lik`, () => {
    assertEquals(constant(LOGIC, name), constant(CHECK_TRIPS, name));
  });
}

for (const name of ["Trip", "Watch"]) {
  Deno.test(`drift: type ${name} er lik`, () => {
    assertEquals(type(LOGIC, name), type(CHECK_TRIPS, name));
  });
}
