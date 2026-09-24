/**
 * WP2 acceptance 7 (RUN_LIVE=1 only; `npm run test:int -- tests/integration/tokens.test.ts`).
 *
 *  - Token mints against the real AssemblyAI endpoints ($0: no connect).
 *  - Synthetic `light` against the real APIs (AssemblyAI mints, OpenAI 16-token luna call, Polar sandbox list).
 *  - Synthetic `full` once (≈ $0.01): 1 STT session streaming the "481529" fixture + 1 VA greeting-only session.
 *
 * Every open goes through the shared laptop limits guard (scripts/lib/local-open-guard.ts: 4 STT opens/min, 1 VA
 * session for ALL agents on this laptop), so the VA probe waits for the slot. Check results land in a throwaway DB.
 * Measured numbers are printed as one JSON line (copied into docs/notes/wp2.md).
 */
import { appendFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetEnvCache } from "@/server/env";
import { DbFlagStore } from "@/server/flags";
import { runFullCheck, runLightCheck } from "@/server/health/synthetic";
import { probeFullVa, probeMintStt, probeMintVa, type ProbeResult } from "@/server/limits/probes";
import { loadEnv } from "../../scripts/lib/load-env";
import { getLocalOpenGuard } from "../../scripts/lib/local-open-guard";
import { createTestDb, HAS_DB, type TestDb } from "../unit/server/limits/helpers/test-db";

const LIVE = process.env.RUN_LIVE === "1";
/** Vitest hides console output of passing tests: set WP2_LIVE_OUT=<file> to keep the measured numbers. */
const record = (line: Record<string, unknown>): void => {
  const s = JSON.stringify(line);
  console.log(s);
  if (process.env.WP2_LIVE_OUT) appendFileSync(process.env.WP2_LIVE_OUT, `${s}\n`);
};

describe.skipIf(!LIVE || !HAS_DB)("tokens and synthetic checks (live, RUN_LIVE=1)", () => {
  let t: TestDb;
  const deployId = () => process.env.BATON_DEPLOY_ID || "dev-wp2";

  beforeAll(async () => {
    loadEnv();
    resetEnvCache();
    t = await createTestDb("live");
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  it("mints an STT and a VA temporary token (no connect, $0)", async () => {
    const stt = await probeMintStt();
    const va = await probeMintVa();
    record({ probe: "mint", stt, va });
    expect(stt.ok).toBe(true);
    expect(va.ok).toBe(true);
  }, 30_000);

  it("synthetic light passes against the real APIs", async () => {
    const r = await runLightCheck({ db: t.db, authority: getLocalOpenGuard(), flags: null, deployId: deployId() });
    record({ probe: "light", ok: r.ok, details: r.details });
    expect(r.details.mintStt?.ok).toBe(true);
    expect(r.details.mintVa?.ok).toBe(true);
    expect(r.details.openai?.ok).toBe(true);
    expect(r.details.polar?.ok).toBe(true);
    expect(r.ok).toBe(true);
  }, 60_000);

  it("synthetic full passes once (1 STT + 1 VA session through the laptop guard, ≈ $0.01)", async () => {
    const guard = getLocalOpenGuard();
    // The laptop guard allows ONE VA session for every agent: wait for it instead of failing on E_VA_CAPACITY.
    const fullVa = async (): Promise<ProbeResult> => {
      for (let i = 0; i < 18; i++) {
        const r = await probeFullVa(guard, { deployId: deployId(), voice: process.env.VA_VOICE || "alba" });
        if (r.code !== "E_VA_CAPACITY") return r;
        await new Promise((res) => setTimeout(res, 10_000));
      }
      return { ok: false, ms: 0, code: "E_VA_CAPACITY", detail: "laptop VA slot busy for 3 min" };
    };
    const r = await runFullCheck({ db: t.db, authority: guard, flags: new DbFlagStore(t.db), deployId: deployId(), probes: { fullVa } });
    record({ probe: "full", ok: r.ok, details: r.details });
    expect(r.details.stt?.ok).toBe(true);
    expect(r.details.va?.ok).toBe(true);
    expect(r.ok).toBe(true);
  }, 300_000);
});
