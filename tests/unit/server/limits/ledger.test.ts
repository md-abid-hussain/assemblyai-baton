/**
 * WP2 acceptance 3: ledger epoch semantics, the dynamic daily cap (DESIGN §7.2) with a fake clock, over-cap →
 * E_BUDGET + replay_only (budget_daily) restored after 00:00 UTC, budget_total, and the operator balance guard.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DbFlagStore } from "@/server/flags";
import { runBudgetGuard } from "@/server/jobs/budget-guard";
import { defaultLimitsConfig, type LedgerConfig } from "@/server/limits/config";
import { DbLimitsAuthority } from "@/server/limits/db-authority";
import { dynamicDailyCap } from "@/server/limits/ledger";
import { createTestDb, fakeClock, HAS_DB, type TestDb } from "./helpers/test-db";

const EPOCH = "2026-09-30T02:30:00.000Z";
const ledgerCfg = (over: Partial<LedgerConfig> = {}): LedgerConfig => ({ ...defaultLimitsConfig().ledger, epochMs: Date.parse(EPOCH), ...over });

describe("dynamicDailyCap (pure, DESIGN §7.2)", () => {
  it("≈ $3/day on the first 3 judging days with $31 over 21 days", () => {
    const cfg = ledgerCfg({ judgingBudgetUsd: 31 });
    // Sep 30 (day 0): 31 / 21 × 2 = 2.952…
    expect(dynamicDailyCap(cfg, Date.parse("2026-09-30T12:00:00Z"), 0)).toBeCloseTo(2.95238, 4);
    // Oct 2 (day 2), $6 spent before today: 25 / 19 × 2 = 2.63
    expect(dynamicDailyCap(cfg, Date.parse("2026-10-02T12:00:00Z"), 6)).toBeCloseTo(2.63158, 4);
  });
  it("then ≈ $1.2–1.5/day without the boost", () => {
    const cfg = ledgerCfg({ judgingBudgetUsd: 31 });
    // Oct 4 (day 4), $9 spent: 22 / 17 = 1.294
    expect(dynamicDailyCap(cfg, Date.parse("2026-10-04T08:00:00Z"), 9)).toBeCloseTo(1.29412, 4);
  });
  it("clamps to [0.75, AAI_DAILY_CAP_MAX_USD] and never divides by zero after the end date", () => {
    const cfg = ledgerCfg({ judgingBudgetUsd: 100 });
    expect(dynamicDailyCap(cfg, Date.parse("2026-09-30T12:00:00Z"), 0)).toBe(3);
    const low = ledgerCfg({ judgingBudgetUsd: 31 });
    expect(dynamicDailyCap(low, Date.parse("2026-10-10T12:00:00Z"), 30)).toBe(0.75);
    expect(dynamicDailyCap(low, Date.parse("2026-10-25T12:00:00Z"), 10)).toBe(3); // daysLeft clamps to 1
  });
});

describe.skipIf(!HAS_DB)("DbSpendLedger (real Postgres, fake clock)", () => {
  let t: TestDb;
  let clock: ReturnType<typeof fakeClock>;
  let a: DbLimitsAuthority;
  let flags: DbFlagStore;

  beforeAll(async () => {
    t = await createTestDb("ledger");
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.execute(sql`truncate live_sessions, stream_queue, spend_ledger, rate_events`);
    clock = fakeClock("2026-09-29T10:00:00.000Z");
    flags = new DbFlagStore(t.db, clock.now);
    await flags.set({ mode: "live", aaiBalanceUsd: null }, "test");
    a = new DbLimitsAuthority({
      db: t.db,
      config: defaultLimitsConfig({ ledger: { epochMs: Date.parse(EPOCH), judgingBudgetUsd: 31 } }),
      now: clock.now,
      flags,
    });
  });

  const reserve = (estUsd: number, env = "zp-prod", provider: "aai_stt" | "aai_va" | "openai" = "aai_va") =>
    a.ledger.reserveDetailed({ provider, action: "test", refId: `r-${Math.random()}`, estUsd, env });

  it("pre-epoch spend is recorded but never counts against the judging budget", async () => {
    const r1 = await reserve(2.0, "dev-wp9", "aai_stt");
    expect(r1.ok).toBe(true);
    if (r1.ok) await a.ledger.settle(r1.id, 1.9);
    clock.set("2026-10-01T09:00:00.000Z");
    const s = await a.ledger.summary();
    expect(s.sinceEpochUsd).toBe(0);
    expect(s.byEnv["dev-wp9"]).toBeCloseTo(1.9, 5);
    // The full day-1 cap is available (31/20 × 2 = 3.1 → clamped to 3).
    expect(s.dailyCapUsd).toBe(3);
    expect((await reserve(2.9)).ok).toBe(true);
  });

  it("pre-epoch dev guard: $3 per UTC day for all dev-* envs together; never flips the mode", async () => {
    expect((await reserve(2.5, "dev-wp4", "aai_stt")).ok).toBe(true);
    expect(await reserve(0.6, "dev-wp5b")).toMatchObject({ ok: false, code: "E_BUDGET", reason: "dev_daily" });
    expect((await a.flags()).mode).toBe("live");
    expect((await reserve(0.6, "zp-prod")).ok).toBe(true); // another env family
    clock.set("2026-09-29T23:59:59.000Z");
    expect((await reserve(0.6, "dev-wp5b")).ok).toBe(false);
    clock.set("2026-09-30T00:00:01.000Z"); // new UTC day, still before the 02:30 epoch
    expect((await reserve(0.6, "dev-wp5b")).ok).toBe(true);
  });

  it("over today's dynamic cap → E_BUDGET and replay_only (budget_daily); restored by F8 after 00:00 UTC", async () => {
    clock.set("2026-10-01T09:00:00.000Z"); // day 1 of judging; cap = min(3, 31/20 × 2) = 3
    expect((await reserve(2.6)).ok).toBe(true);
    const r = await reserve(0.53);
    expect(r).toMatchObject({ ok: false, code: "E_BUDGET", reason: "budget_daily" });
    expect(await a.flags()).toMatchObject({ mode: "replay_only", reason: "budget_daily" });
    // Any env counts after the epoch (the account is shared).
    expect((await reserve(0.53, "dev-wp2")).ok).toBe(false);

    clock.set("2026-10-01T23:59:00.000Z");
    expect((await runBudgetGuard(a)).cleared).toBeNull();
    expect((await a.flags()).mode).toBe("replay_only");
    clock.set("2026-10-02T00:00:30.000Z");
    const g = await runBudgetGuard(a);
    expect(g.cleared).toBe("budget_daily");
    expect(await a.flags()).toMatchObject({ mode: "live", reason: null });
    // Oct 2 (day 2): spent 2.6 before today → 28.4 / 19 × 2 = 2.99
    expect(g.dailyCapUsd).toBeCloseTo(2.98947, 4);
    expect((await reserve(0.53)).ok).toBe(true);
  });

  it("released reservations free budget; settled ones count at their actual amount", async () => {
    clock.set("2026-10-05T09:00:00.000Z"); // day 5: 31/16 = 1.94
    const r1 = await reserve(1.5);
    if (!r1.ok) throw new Error("expected ok");
    expect((await reserve(0.53)).ok).toBe(false);
    await flags.set({ mode: "live" }, "test");
    await a.ledger.release(r1.id);
    const r2 = await reserve(1.5);
    if (!r2.ok) throw new Error("expected ok");
    await a.ledger.settle(r2.id, 0.2);
    expect((await reserve(1.0)).ok).toBe(true);
    const s = await a.ledger.summary();
    expect(s.sinceEpochUsd).toBeCloseTo(1.2, 5);
    expect(s.pctToday).toBeCloseTo(61.9, 0);
  });

  it("over the whole judging budget → E_BUDGET and replay_only (budget_total), which F8 never auto-clears", async () => {
    const small = new DbLimitsAuthority({
      db: t.db,
      config: defaultLimitsConfig({ ledger: { epochMs: Date.parse(EPOCH), judgingBudgetUsd: 1.0, dailyCapMaxUsd: 3, dailyCapMinUsd: 3 } }),
      now: clock.now,
      flags,
    });
    clock.set("2026-10-06T09:00:00.000Z");
    expect((await small.ledger.reserveDetailed({ provider: "aai_va", action: "x", refId: "a", estUsd: 0.8, env: "zp-prod" })).ok).toBe(true);
    const r = await small.ledger.reserveDetailed({ provider: "aai_va", action: "x", refId: "b", estUsd: 0.3, env: "zp-prod" });
    expect(r).toMatchObject({ ok: false, reason: "budget_total" });
    expect(await small.flags()).toMatchObject({ mode: "replay_only", reason: "budget_total" });
    clock.set("2026-10-07T00:10:00.000Z");
    await runBudgetGuard(small);
    expect(await small.flags()).toMatchObject({ mode: "replay_only", reason: "budget_total" });
  });

  it("operator balance below AAI_RESERVE_USD → replay_only (aai_balance); a weaker reason never overwrites it", async () => {
    clock.set("2026-10-03T08:00:00.000Z");
    await flags.set({ aaiBalanceUsd: 4.2 }, "operator");
    const g = await runBudgetGuard(a);
    expect(g.tripped).toBe("aai_balance");
    expect(await a.flags()).toMatchObject({ mode: "replay_only", reason: "aai_balance" });
    expect(await flags.tripReplayOnly("budget_daily")).toBe(false);
    expect((await a.flags()).reason).toBe("aai_balance");
    clock.set("2026-10-04T00:30:00.000Z");
    await runBudgetGuard(a);
    expect((await a.flags()).reason).toBe("aai_balance"); // only the operator clears it
  });

  it("OpenAI has its own daily cap and never flips the mode; Polar is always accepted", async () => {
    clock.set("2026-10-03T08:00:00.000Z");
    expect((await reserve(2.9, "zp-prod", "openai")).ok).toBe(true);
    expect(await reserve(0.2, "zp-prod", "openai")).toMatchObject({ ok: false, reason: "openai_daily" });
    expect((await a.flags()).mode).toBe("live");
    expect((await a.ledger.reserveDetailed({ provider: "polar", action: "checkout", refId: "p", estUsd: 0, env: "zp-prod" })).ok).toBe(true);
  });
});
