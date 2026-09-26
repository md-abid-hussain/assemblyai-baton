/**
 * The `Drafter` service (PLATFORM §7.4 step 1 and step 6; TASKS-v3 §7 WP17): the plan check, the v2 buckets, the
 * async job, the usage record and the org scope. Memory store, fake upstream, fake ledger: $0.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { RateLimiter } from "@/core/contracts/services";
import { PLANS } from "@/core/contracts/v3/plans";
import { DRAFT_RATES, DraftService, MemoryDraftStore, type DrafterDeps } from "@/server/draft";
import {
  createMemoryUsageMeter, resetSaasPorts, setPlanResolver, setUsageMeter, type MemoryUsageMeter,
} from "@/server/saas/ports";
import { DESK_INPUT, draftFixture } from "../../core/relay-draft/helpers";
import { fakeLedger } from "../sim/helpers";
import { fakeLlm, kernel, type Reply } from "./helpers";

const WS = "ws_visitor1";

/** A rate limiter that counts, so the bucket tests are about the buckets and not about Postgres. */
function memoryLimiter(): RateLimiter & { hits: Record<string, number> } {
  const hits: Record<string, number> = {};
  return {
    hits,
    async hit(bucket: string, key: string, limit: number) {
      const k = `${bucket}|${key}`;
      hits[k] = (hits[k] ?? 0) + 1;
      return { ok: hits[k]! <= limit, retryAfterSec: 60 };
    },
    async check(bucket: string, key: string, limit: number) {
      const k = `${bucket}|${key}`;
      return { ok: (hits[k] ?? 0) < limit, retryAfterSec: 60 };
    },
  } as RateLimiter & { hits: Record<string, number> };
}

interface Harness {
  service: DraftService;
  store: MemoryDraftStore;
  usage: MemoryUsageMeter;
  created: { ws: string; slug: string }[];
  limiter: ReturnType<typeof memoryLimiter>;
  queued: string[];
}

function harness(replies: Reply[], o: { autorun?: boolean; create?: DrafterDeps["createRelay"] } = {}): Harness {
  const store = new MemoryDraftStore();
  const usage = createMemoryUsageMeter();
  setUsageMeter(usage);
  const created: { ws: string; slug: string }[] = [];
  const limiter = memoryLimiter();
  const queued: string[] = [];
  const deps: DrafterDeps = {
    store,
    queue: { async enqueue(id) { queued.push(id); if (o.autorun !== false) await service.step(id); } },
    kernel,
    createRelay: o.create ?? (async (ws, bp) => {
      created.push({ ws, slug: bp.meta.slug });
      return `rl_${created.length}`;
    }),
    llm: fakeLlm(replies, fakeLedger()),
    rateLimiter: () => limiter,
    today: () => "2026-09-25",
  };
  const service = new DraftService(deps);
  return { service, store, usage, created, limiter, queued };
}

beforeEach(() => {
  resetSaasPorts();
});

describe("DraftService.start: the plan comes first", () => {
  it("answers queued at once and never blocks on the work", async () => {
    const h = harness([draftFixture()], { autorun: false });
    const view = await h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" });
    expect(view.status).toBe("queued");
    expect(view.step).toBeNull();
    expect(view.relayId).toBeNull();
    expect(h.queued).toEqual([view.draftId]);
    expect(await h.service.get(view.draftId, WS)).toMatchObject({ status: "queued" });
  });

  it("refuses a second draft on the guest plan, which includes one a day", async () => {
    const h = harness([draftFixture(), draftFixture()]);
    setPlanResolver(() => "guest");
    expect(PLANS.guest.limits.draftsPerDay).toBe(1);
    await h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" });
    await expect(h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" }))
      .rejects.toMatchObject({ code: "E_PLAN_LIMIT" });
  });

  it("names the plan and points somewhere useful when the allowance is gone", async () => {
    const h = harness([draftFixture()]);
    setPlanResolver(() => "guest");
    await h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" });
    await h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" }).catch((e: Error) => {
      expect(e.message).toContain("Guest");
      expect(e.message).toContain("gallery relay");
    });
    expect.assertions(2);
  });

  it("counts drafts per org, not per device", async () => {
    const h = harness([draftFixture(), draftFixture()]);
    setPlanResolver(() => "guest");
    await h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" });
    // A different org on the same device still has its own allowance.
    await expect(h.service.start(DESK_INPUT, { ws: "ws_other", visitorId: "v1", ipKey: "ip1" })).resolves.toMatchObject({ status: "queued" });
  });

  it("still applies the per-visitor and per-ipKey buckets", async () => {
    const h = harness(Array.from({ length: 8 }, () => draftFixture()), { autorun: false });
    setPlanResolver(() => "pro");
    for (let i = 0; i < DRAFT_RATES.visitor.limit; i++) {
      await h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" });
    }
    await expect(h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" }))
      .rejects.toMatchObject({ code: "E_RATE_LIMITED" });
    expect(h.limiter.hits[`draft|v1`]).toBe(DRAFT_RATES.visitor.limit);
  });
});

describe("DraftService.step: the job", () => {
  it("runs the pipeline, writes the row and records the usage", async () => {
    const h = harness([draftFixture()]);
    const { draftId } = await h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" });
    const view = await h.service.get(draftId, WS);
    expect(view).toMatchObject({ status: "ok", step: null, relayId: "rl_1", repairs: 0 });
    expect(view!.usd).toBeGreaterThan(0);
    expect(view!.notes.join(" ")).toContain("I assumed the deposit");
    expect(view!.lint.filter((i) => i.severity === "error")).toEqual([]);
    expect(h.created).toEqual([{ ws: WS, slug: "riverbend-deposit" }]);
    expect(h.usage.records).toMatchObject([{ orgId: WS, kind: "draft", quantity: 1, relayId: "rl_1", idempotencyKey: `draft:${draftId}` }]);
  });

  it("records the draft once, however often the step is retried", async () => {
    const h = harness([draftFixture(), draftFixture()]);
    const { draftId } = await h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" });
    await h.service.step(draftId);
    expect(h.usage.records).toHaveLength(1);
  });

  it("writes a failure onto the row instead of throwing at the queue", async () => {
    const h = harness([new Error("upstream down")]);
    const { draftId } = await h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" });
    const view = await h.service.get(draftId, WS);
    expect(view).toMatchObject({ status: "failed", step: null });
    expect(view!.notes.join(" ")).toContain("gallery relay");
    expect(h.usage.records).toEqual([]);
  });

  it("carries the plan message through when the relay cannot be stored", async () => {
    const h = harness([draftFixture()], {
      create: async () => { throw new (await import("@/server/saas/errors")).SaasError("E_PLAN_LIMIT", "The Free plan includes 5 relays."); },
    });
    const { draftId } = await h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" });
    expect((await h.service.get(draftId, WS))!.notes.join(" ")).toContain("includes 5 relays");
  });

  it("reports a draft that never linted clean as invalid, with the relay and its errors", async () => {
    const broken = draftFixture({ fields: draftFixture().fields.map((f) => (f.id === "procedure" ? { ...f, enumValues: [] } : f)) });
    const h = harness([broken, broken, broken]);
    const { draftId } = await h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" });
    const view = await h.service.get(draftId, WS);
    expect(view).toMatchObject({ status: "invalid", relayId: "rl_1", repairs: 2 });
    expect(view!.lint.some((i) => i.severity === "error" && i.code === "L2")).toBe(true);
    expect(h.usage.records).toHaveLength(1);   // it happened, and it cost money, so it is metered
  });

  it("fails cleanly when the row is gone", async () => {
    const h = harness([]);
    expect(await h.service.step("drf_missing")).toEqual({ state: null, next: "failed" });
  });
});

describe("DraftService.get: the org scope", () => {
  it("does not exist for another org (SAAS §10.1 rule 2)", async () => {
    const h = harness([draftFixture()]);
    const { draftId } = await h.service.start(DESK_INPUT, { ws: WS, visitorId: "v1", ipKey: "ip1" });
    expect(await h.service.get(draftId, WS)).not.toBeNull();
    expect(await h.service.get(draftId, "ws_someone_else")).toBeNull();
  });

  it("is null for an id that was never issued", async () => {
    const h = harness([]);
    expect(await h.service.get("drf_nope", WS)).toBeNull();
  });
});
