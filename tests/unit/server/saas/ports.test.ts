/**
 * WP19·1: the port registry and its C3 defaults (SAAS §14).
 *
 * The defaults matter because five WPs branch from C3 and none of them can register anything yet: count limits must
 * already work from `PLANS`, the audit/event/usage writers must already accept writes, and the ports WP14b/WP16 own
 * must be safe no-ops rather than crashes.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { PLANS } from "@/core/contracts/v3/plans";
import { isSaasError, SaasError } from "@/server/saas/errors";
import {
  countOrg, createMemoryAuditWriter, createMemoryDomainEvents, createMemoryUsageMeter, defaultPlanResolver,
  getAuditWriter, getBillingProvider, getConnectorHostPolicy, getDomainEvents, getEntitlements, getGuestSeeder,
  getRelaySourceStore, getSecretRebinder, getUsageMeter, resetSaasPorts, resolvePlan, setAuditWriter,
  setOrgCounter, setPlanResolver, setUsageMeter,
} from "@/server/saas/ports";

beforeEach(() => {
  resetSaasPorts();
  delete process.env.CONNECTOR_HOST_ALLOWLIST;
});

const caught = async (fn: () => unknown): Promise<SaasError> => {
  try {
    await fn();
  } catch (e) {
    if (isSaasError(e)) return e;
    throw e;
  }
  throw new Error("expected a SaasError");
};

describe("the registry", () => {
  it("returns the same default instance until it is replaced or reset", () => {
    const first = getAuditWriter();
    expect(getAuditWriter()).toBe(first);
    const mine = createMemoryAuditWriter();
    setAuditWriter(mine);
    expect(getAuditWriter()).toBe(mine);
    resetSaasPorts();
    expect(getAuditWriter()).not.toBe(mine);
  });

  it("every port has a default, so nothing throws merely for being unregistered", () => {
    for (const get of [getAuditWriter, getDomainEvents, getUsageMeter, getEntitlements, getBillingProvider,
      getGuestSeeder, getSecretRebinder, getRelaySourceStore, getConnectorHostPolicy]) {
      expect(get()).toBeTruthy();
    }
  });
});

describe("the in-memory writers", () => {
  it("audit rows are kept in order", async () => {
    const w = createMemoryAuditWriter();
    await w.write({ orgId: "org_1", actor: { type: "system", id: null, label: "cron" }, action: "org.created" });
    await w.write({ orgId: "org_1", actor: { type: "system", id: null, label: "cron" }, action: "org.renamed" });
    expect(w.entries.map((e) => e.action)).toEqual(["org.created", "org.renamed"]);
  });

  it("domain events dedupe on dedupeKey, so a retried emit does not double-deliver", async () => {
    const ev = createMemoryDomainEvents();
    const a = await ev.emit({ orgId: "o", type: "run.completed", data: {}, dedupeKey: "run.completed:tk_1" });
    const b = await ev.emit({ orgId: "o", type: "run.completed", data: {}, dedupeKey: "run.completed:tk_1" });
    expect([a.created, b.created]).toEqual([true, false]);
    expect(b.eventId).toBe(a.eventId);
    expect(ev.events).toHaveLength(1);
    const c = await ev.emit({ orgId: "o", type: "run.completed", data: {} });
    expect(c.created).toBe(true);
  });

  it("usage is idempotent on idempotencyKey and keeps the sources apart", async () => {
    const m = createMemoryUsageMeter();
    const rec = { orgId: "org_1", kind: "ai_minutes" as const, quantity: 4, idempotencyKey: "ai_minutes:tk_1" };
    await m.record({ ...rec, source: "recorded" });
    await m.record({ ...rec, source: "recorded" });
    await m.record({ orgId: "org_1", kind: "ai_minutes", quantity: 9, source: "simulated", idempotencyKey: "ai_minutes:sim_1" });
    await m.record({ orgId: "org_1", kind: "live_run", quantity: 1, idempotencyKey: "live_run:tk_1" });
    const s = await m.summary("org_1");
    expect(s.aiMinutes.recorded).toBe(4);
    expect(s.aiMinutes.simulated).toBe(9);
    expect(s.today.liveRuns).toBe(1);
    expect(m.records).toHaveLength(3);
  });

  it("a replay is a countable run with zero billable minutes", async () => {
    const m = createMemoryUsageMeter();
    await m.record({ orgId: "o", kind: "live_run", quantity: 1, source: "replay", idempotencyKey: "live_run:r1" });
    await m.record({ orgId: "o", kind: "ai_minutes", quantity: 0, source: "replay", idempotencyKey: "ai_minutes:r1" });
    const s = await m.summary("o");
    expect(s.today.liveRuns).toBe(1);
    expect(s.aiMinutes.recorded + s.aiMinutes.published).toBe(0);
  });

  it("one org never sees another's usage", async () => {
    const m = createMemoryUsageMeter();
    await m.record({ orgId: "org_a", kind: "live_run", quantity: 1, idempotencyKey: "live_run:a" });
    expect((await m.summary("org_b")).today.liveRuns).toBe(0);
  });
});

describe("the default Entitlements (SAAS §4.1–§4.2)", () => {
  it("a legacy ws_ workspace is on the guest plan; anything else is on free", async () => {
    expect(defaultPlanResolver("ws_abc")).toBe("guest");
    expect(defaultPlanResolver("org_abc")).toBe("free");
    expect((await getEntitlements().get("ws_abc")).limits).toEqual(PLANS.guest.limits);
    expect(await resolvePlan("org_abc")).toBe("free");
  });

  it("reports the source and status honestly before WP21 exists", async () => {
    const e = await getEntitlements().get("org_1");
    expect(e).toMatchObject({ orgId: "org_1", plan: "free", source: "default", status: "active", cancelAtPeriodEnd: false, syncedAt: null });
  });

  it("count limits work from PLANS plus the counters owners register", async () => {
    setPlanResolver(() => "free");
    let relays = 4;
    setOrgCounter("relays", () => relays);
    expect(await countOrg("org_1", "relays")).toBe(4);
    await expect(getEntitlements().assertCount("org_1", "relays")).resolves.toBeUndefined();
    relays = 5; // the Free plan's limit
    const e = await caught(() => getEntitlements().assertCount("org_1", "relays"));
    expect([e.code, e.status]).toEqual(["E_PLAN_LIMIT", 402]);
    expect(e.message).toContain("Free");
    expect(e.extra).toEqual({ limit: { key: "relays", used: 5, limit: 5, plan: "free" } });
  });

  it("an unregistered counter reads as 0, so no WP is blocked by another's absence", async () => {
    expect(await countOrg("org_1", "webhookEndpoints")).toBe(0);
    await expect(getEntitlements().assertCount("org_1", "secrets")).resolves.toBeUndefined();
  });

  it("rate limits read the registered meter and count only billable minutes", async () => {
    setPlanResolver(() => "free");
    const m = createMemoryUsageMeter();
    setUsageMeter(m);
    for (let i = 0; i < 4; i++) {
      await m.record({ orgId: "org_1", kind: "dry_run", quantity: 1, idempotencyKey: `dry_run:${i}` });
    }
    expect(await getEntitlements().checkRate("org_1", "dryRunsPerDay")).toEqual({ ok: true, used: 4, limit: 5 });
    await m.record({ orgId: "org_1", kind: "dry_run", quantity: 1, idempotencyKey: "dry_run:4" });
    expect(await getEntitlements().checkRate("org_1", "dryRunsPerDay")).toEqual({ ok: false, used: 5, limit: 5 });

    await m.record({ orgId: "org_1", kind: "ai_minutes", quantity: 40, source: "simulated", idempotencyKey: "ai:sim" });
    expect(await getEntitlements().checkRate("org_1", "aiMinutesPerMonth", 0)).toMatchObject({ used: 0, limit: 15 });
    await m.record({ orgId: "org_1", kind: "ai_minutes", quantity: 12, source: "recorded", idempotencyKey: "ai:rec" });
    expect(await getEntitlements().checkRate("org_1", "aiMinutesPerMonth", 4)).toMatchObject({ ok: false, used: 12 });
  });
});

describe("the ports other WPs fill in", () => {
  it("billing is simulated and refuses checkout with E_BILLING_UNAVAILABLE (SAAS §4.7)", async () => {
    expect(getBillingProvider().mode).toBe("simulated");
    const e = await caught(() =>
      getBillingProvider().startCheckout({ orgId: "o", userId: "u", plan: "pro", headers: new Headers() }),
    );
    expect([e.code, e.status]).toEqual(["E_BILLING_UNAVAILABLE", 503]);
    await expect(getBillingProvider().syncOrg("org_1")).resolves.toMatchObject({ plan: "free", source: "default" });
  });

  it("the guest seeder and the secret rebinder are no-ops, not failures", async () => {
    await expect(getGuestSeeder().seed("org_1")).resolves.toEqual({ relayIds: [] });
    await expect(getSecretRebinder().rebind("ws_a", "org_1")).resolves.toBe(0);
  });

  it("the source store is read-only and empty until WP14b·4 registers the real one", async () => {
    await expect(getRelaySourceStore().get("rl_1", "org_1")).resolves.toBeNull();
    const e = await caught(() =>
      getRelaySourceStore().save("rl_1", "org_1", { format: "yaml", text: "x" }, 1, "studio"),
    );
    expect([e.code, e.status]).toEqual(["E_UNPROCESSABLE", 422]);
  });

  it("the host policy is the env allowlist only, case-insensitively, and never per-org", async () => {
    const policy = getConnectorHostPolicy();
    expect(await policy.list("org_1")).toEqual([]);
    expect(await policy.isAllowed("org_1", "api.partner.test")).toBe(false);
    process.env.CONNECTOR_HOST_ALLOWLIST = "api.partner.test, Echo.Example.Test";
    expect(await policy.list("org_1")).toEqual(["api.partner.test", "echo.example.test"]);
    expect(await policy.isAllowed("org_1", "API.Partner.Test")).toBe(true);
    expect(await policy.isAllowed("org_other", "api.partner.test")).toBe(true);
    expect(await policy.isAllowed("org_1", "evil.test")).toBe(false);
  });
});
