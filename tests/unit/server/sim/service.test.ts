/**
 * `SimCallService` (PLATFORM §7.5, §7.5.2; TASKS-v3 §7 WP17): the plan check, the v2 buckets, the async generation,
 * the row it writes and the usage it records. Memory store, fake upstream: $0.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { RateLimiter } from "@/core/contracts/services";
import type { CompiledRelay } from "@/core/contracts/v2";
import { SimScriptSchema, type SimScript } from "@/core/contracts/v2/api";
import { PLANS } from "@/core/contracts/v3/plans";
import { compileRelay } from "@/core/relay/compile";
import { applyComplianceFixes } from "@/core/relay/draft/compliance";
import { expandDraft } from "@/core/relay/draft/expand";
import {
  createMemoryUsageMeter, resetSaasPorts, setPlanResolver, setUsageMeter, type MemoryUsageMeter,
} from "@/server/saas/ports";
import { AUDIO_ETA_SEC, SIM_RATES, SimCallServiceImpl, buildSimServiceDeps, type SimServiceDeps } from "@/server/sim/service";
import { DRY_RUN_ETA_SEC } from "@/server/sim/dry-run";
import { MemorySimCallStore } from "@/server/sim/store";
import { MemoryTtsCache } from "@/server/sim/tts-cache";
import { draftFixture } from "../../core/relay-draft/helpers";
import { fakeLedger } from "./helpers";

const WS = "ws_visitor1";
const blueprint = applyComplianceFixes(expandDraft(draftFixture(), { callDate: "2026-09-25" }).blueprint).blueprint;
const compiled: CompiledRelay = compileRelay(blueprint, { versionId: "rv_1", relayId: "rl_1", hash: "h_1", flagship: false });

const script: SimScript = SimScriptSchema.parse({
  turns: [
    { speaker: "rep", text: "Riverbend Dental, this is Dana.", tag: "greet" },
    { speaker: "customer", text: "Hi, I'd like to book a cleaning.", tag: "other" },
    { speaker: "rep", text: "Can I take your full name?", tag: "ask" },
    { speaker: "customer", text: "Maya Ortiz.", tag: "answer" },
    { speaker: "rep", text: "Which day suits you?", tag: "ask" },
    { speaker: "customer", text: "Tuesday the sixth.", tag: "answer" },
    { speaker: "rep", text: "Tuesday the sixth. Is that right?", tag: "readback" },
    { speaker: "customer", text: "Yes, that's right.", tag: "confirm" },
    { speaker: "rep", text: blueprint.handoff.repLine, tag: "handoff" },
    { speaker: "customer", text: "Sure, go ahead.", tag: "accept" },
  ],
  left_for_ai: ["insurance_carrier"],
  ai_half_answers: [{ field: "insurance_carrier", spoken: "It's Riverbend Plus." }],
  consent_phrase: "Yes, please text me the link.",
  closing_phrase: "No, that's everything, thanks.",
});

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
      return { ok: (hits[`${bucket}|${key}`] ?? 0) < limit, retryAfterSec: 60 };
    },
  } as RateLimiter & { hits: Record<string, number> };
}

interface Harness {
  service: SimCallServiceImpl;
  store: MemorySimCallStore;
  usage: MemoryUsageMeter;
  limiter: ReturnType<typeof memoryLimiter>;
  scripts: number;
  done: (() => Promise<void>)[];
}

function harness(o: { scriptFails?: boolean; dryRunFails?: boolean; day?: string } = {}): Harness {
  const store = new MemorySimCallStore({ tts: new MemoryTtsCache() });
  const usage = createMemoryUsageMeter();
  setUsageMeter(usage);
  const limiter = memoryLimiter();
  const done: (() => Promise<void>)[] = [];
  const h = { store, usage, limiter, scripts: 0, done } as Harness;
  const deps: Partial<SimServiceDeps> = {
    store,
    run: {
      registry: {
        resolveRun: async () => ({ versionId: "rv_1", relayId: "rl_1", relaySlug: blueprint.meta.slug, version: 1, hash: "h_1", blueprint, flagship: false, gallery: false, origin: "draft", preset: null }),
        moderateForRun: async () => ({ flagged: false, categories: [], checked: true }),
        canSeeVersion: async () => true,
      },
      engine: { forVersion: async () => compiled },
      catalog: { resolve: async () => null },
      binding: () => ({ compile: compileRelay }),
      ensureSeeded: async () => null,
    } as unknown as SimServiceDeps["run"],
    script: {
      openai: () => {
        h.scripts++;
        if (o.scriptFails) throw new Error("upstream down");
        return {
          responses: {
            create: async () => ({
              status: "completed", output: [], output_text: JSON.stringify(script),
              usage: { input_tokens: 900, output_tokens: 400, output_tokens_details: { reasoning_tokens: 100 }, input_tokens_details: { cached_tokens: 0 } },
            }),
          },
        } as never;
      },
      ledger: () => fakeLedger(),
      env: () => "test",
    },
    dryRun: {
      openai: () => { throw new Error("no upstream in tests"); },
      ledger: () => null,
      env: () => "test",
      extract: async () => {
        if (o.dryRunFails) throw new Error("extractor down");
        return { events: [], usd: 0.0005 };
      },
    },
    rateLimiter: () => limiter,
    daySalt: () => o.day ?? "2026-09-25",
    detach: (work) => void done.push(work),
  };
  h.service = new SimCallServiceImpl(buildSimServiceDeps(deps));
  return h;
}

const who = { ws: WS, visitorId: "v1", ipKey: "ip1" };
/** Run the detached work the service queued. Until this is called, every sim is still "generating". */
const settle = async (h: Harness) => {
  const queued = h.done.splice(0);
  for (const w of queued) await w();
};

beforeEach(() => {
  resetSaasPorts();
  setPlanResolver(() => "pro");
});

describe("plan checks come first", () => {
  it("refuses a voiced sim on the plans that do not include one, and points at the dry run", async () => {
    for (const plan of ["guest", "free"] as const) {
      setPlanResolver(() => plan);
      expect(PLANS[plan].limits.voicedSimsPerDay).toBe(0);
      const h = harness();
      await h.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "audio", ...who }).then(
        () => expect.fail("a voiced sim must not be allowed here"),
        (e: Error & { code?: string }) => {
          expect(e.code).toBe("E_PLAN_LIMIT");
          expect(e.message).toContain("text dry run");
        },
      );
      expect(h.limiter.hits).toEqual({});     // the plan refusal never spends a bucket
    }
  });

  it("allows a dry run on the guest plan, three a day", async () => {
    setPlanResolver(() => "guest");
    expect(PLANS.guest.limits.dryRunsPerDay).toBe(3);
    const h = harness();
    await expect(h.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "text_dry_run", ...who })).resolves.toMatchObject({ status: "generating" });
    await settle(h);
    // Three dry runs already today: the fourth is refused by the plan, before any relay is even resolved.
    for (let i = 0; i < 3; i++) {
      await h.usage.record({ orgId: WS, kind: "dry_run", quantity: 1, idempotencyKey: `seed_${i}`, occurredAt: new Date().toISOString() });
    }
    await expect(h.service.request({ relayId: "rl_1", sampleIndex: 1, kind: "text_dry_run", ...who }))
      .rejects.toMatchObject({ code: "E_PLAN_LIMIT" });
  });

  it("still applies the per-visitor bucket under a generous plan", async () => {
    setPlanResolver(() => "business");
    const h = harness();
    for (let i = 0; i < SIM_RATES.dryRunVisitor.limit; i++) {
      await h.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "text_dry_run", ...who });
      await settle(h);
      h.store.rows.clear();                    // pretend each one was a different relay version
    }
    await expect(h.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "text_dry_run", ...who }))
      .rejects.toMatchObject({ code: "E_RATE_LIMITED" });
  });

  it("refuses a sample the relay does not have", async () => {
    const h = harness();
    await expect(h.service.request({ relayId: "rl_1", sampleIndex: 4, kind: "text_dry_run", ...who }))
      .rejects.toMatchObject({ code: "E_BAD_REQUEST" });
  });
});

describe("text dry run", () => {
  it("answers generating at once, then polls to ready with the result on the row", async () => {
    const h = harness();
    const out = await h.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "text_dry_run", ...who });
    expect(out).toMatchObject({ status: "generating", etaSec: DRY_RUN_ETA_SEC });
    expect(await h.service.get(out.simCallId)).toMatchObject({ status: "generating", kind: "text_dry_run", relayId: "rl_1" });

    await settle(h);
    const view = (await h.service.get(out.simCallId))!;
    expect(view.status).toBe("ready");
    expect(view.callId).toBeNull();            // no audio, so it is not a playable call
    expect(view.durationMs).toBeNull();
    expect(view.handoff).toBeNull();
    expect(view.script!.turns).toHaveLength(script.turns.length);
    expect(view.dryRun!.fields.length).toBe(blueprint.fields.length);
    expect(view.dryRun!.greeting.text).toContain("AI assistant");
    expect(view.dryRun!.steps.map((s) => s.stage)).toEqual(["confirm", "disclose", "pay", "close"]);
    expect(view.usd).toBeGreaterThan(0);
  });

  it("records one dry run, labelled as such, so it is never blended with recorded minutes", async () => {
    const h = harness();
    const out = await h.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "text_dry_run", ...who });
    await settle(h);
    expect(h.usage.records).toMatchObject([{ orgId: WS, kind: "dry_run", quantity: 1, relayId: "rl_1", source: "text_dry_run", idempotencyKey: `dry_run:${out.simCallId}` }]);
    const summary = await h.usage.summary(WS);
    expect(summary.today.dryRuns).toBe(1);
    expect(summary.aiMinutes.recorded).toBe(0);
  });

  it("asking again for the same relay version and sample is ready and free", async () => {
    const h = harness();
    const first = await h.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "text_dry_run", ...who });
    await settle(h);
    const again = await h.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "text_dry_run", ...who });
    expect(again).toEqual({ simCallId: first.simCallId, status: "ready", etaSec: 0 });
    expect(h.scripts).toBe(1);                                  // no second luna call
    expect(h.limiter.hits[`sim:dryrun|v1`]).toBe(1);            // and no second bucket hit
    expect(h.usage.records).toHaveLength(1);
  });

  it("a second poll while it is still running does not start it twice", async () => {
    const h = harness();
    const first = await h.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "text_dry_run", ...who });
    const second = await h.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "text_dry_run", ...who });
    expect(second.simCallId).toBe(first.simCallId);
    expect(second.status).toBe("generating");
    await settle(h);
    expect(h.scripts).toBe(1);
  });

  it("reports a failure on the poll instead of hanging on generating", async () => {
    const h = harness({ dryRunFails: true });
    const out = await h.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "text_dry_run", ...who });
    await settle(h);
    const view = (await h.service.get(out.simCallId))!;
    expect(view.status).toBe("failed");
    expect(view.error).toContain("pre-generated call");
    expect(h.usage.records).toEqual([]);
    expect(h.store.rows.size).toBe(0);
  });

  it("is null for an id nobody asked for", async () => {
    expect(await harness().service.get("sim_deadbeefdeadbeef")).toBeNull();
  });
});

describe("ids", () => {
  it("a voiced sim gets a fresh id on a later day, so no browser serves a stale immutable asset", async () => {
    setPlanResolver(() => "pro");
    const monday = harness({ day: "2026-09-25" });
    const tuesday = harness({ day: "2026-09-26" });
    const a = await monday.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "audio", ...who });
    const b = await tuesday.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "audio", ...who });
    expect(a.simCallId).not.toBe(b.simCallId);
    expect(a.etaSec).toBe(AUDIO_ETA_SEC);
  });

  it("a dry run and a voiced sim of the same version are different sims", async () => {
    const h = harness();
    const dry = await h.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "text_dry_run", ...who });
    const audio = await h.service.request({ relayId: "rl_1", sampleIndex: 0, kind: "audio", ...who });
    expect(dry.simCallId).not.toBe(audio.simCallId);
  });
});
