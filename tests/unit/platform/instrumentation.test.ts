/**
 * The boot hook must install the things the routes only reach through a registry: WP9's call manifest lookup
 * ([WIRE-CALLS], wired at G2). Without it `getCallEntry` returns null for every call and routes #5/#5a fall back to
 * the 5-minute default, which silently drops the Express start and the handoff line.
 *
 * And WP14b's v3 relay ports ([WIRE-RELAY-SAAS], wired at G3). `/api/guest/start` reads `getGuestSeeder()` from
 * WP19's registry and never touches the relay graph, so if `register()` stops calling `installRelaySaasPorts()`
 * a cold container's first guest start gets the no-op seeder and an empty workspace — no Dental copy, no error.
 */
import { afterEach, beforeEach, expect, test } from "vitest";

const g = globalThis as typeof globalThis & { __batonCallLookup?: unknown };

let runtime: string | undefined;
let worker: string | undefined;

beforeEach(() => {
  runtime = process.env.NEXT_RUNTIME;
  worker = process.env.ENABLE_INPROC_WORKER;
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.ENABLE_INPROC_WORKER; // no job ticker in a unit test
  delete g.__batonCallLookup;
});

afterEach(() => {
  if (runtime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = runtime;
  if (worker === undefined) delete process.env.ENABLE_INPROC_WORKER;
  else process.env.ENABLE_INPROC_WORKER = worker;
  delete g.__batonCallLookup;
});

test("register() wires the call-manifest lookup", async () => {
  const { register } = await import("@/instrumentation");
  await register();
  expect(typeof g.__batonCallLookup).toBe("function");

  const { getCallEntry } = await import("@/server/runs");
  // An unknown id resolves through the data source and comes back null rather than throwing.
  await expect(getCallEntry("no-such-call")).resolves.toBeNull();
});

test("register() wires WP14b's relay SaaS ports, so a cold guest start gets the real seeder", async () => {
  const { createMemoryAuditWriter, getRelaySourceStore, resetSaasPorts, setAuditWriter } =
    await import("@/server/saas/ports");
  const { PgRelaySourceStore } = await import("@/server/relays/source-store");

  // A cleared registry answers with WP19's empty defaults: what a cold container would hold before boot ran.
  resetSaasPorts();
  expect(getRelaySourceStore()).not.toBeInstanceOf(PgRelaySourceStore);

  // Building the relay graph reads DATABASE_URL (`getDb()` throws without it) but never connects — the `pg`
  // Pool is lazy — so a syntactically valid dummy is enough and no query is issued.
  const { resetEnvCache } = await import("@/server/env");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:1/none";
  resetEnvCache();
  try {
    const { register } = await import("@/instrumentation");
    await register();
    expect(getRelaySourceStore()).toBeInstanceOf(PgRelaySourceStore);
  } finally {
    if (dbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = dbUrl;
    resetEnvCache();
    setAuditWriter(createMemoryAuditWriter()); // resetSaasPorts cleared it; leave the suite a writer
  }
});
