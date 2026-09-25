/**
 * The boot hook must install the things the routes only reach through a registry: WP9's call manifest lookup
 * ([WIRE-CALLS], wired at G2). Without it `getCallEntry` returns null for every call and routes #5/#5a fall back to
 * the 5-minute default, which silently drops the Express start and the handoff line.
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
