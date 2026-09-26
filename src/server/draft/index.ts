/**
 * server/draft/index.ts - the `Drafter` service: quotas, the plan check, the async job and the usage record
 * (PLATFORM §7.4 step 1 and step 6; TASKS-v3 §7 WP17).
 *
 * `POST /api/drafts` answers `{draftId, status:"queued"}` in one round trip and the client polls
 * `GET /api/drafts/:id` every 1.5 s, because up to three luna calls take 30-40 s. The work therefore runs OUTSIDE
 * the request:
 *
 *   start()  → plan check (`draftsPerDay`) → the v2 visitor/ipKey buckets → the row → queue.enqueue(draftId)
 *   step()   → the pipeline, writing its step into the row as it goes → the usage record → `ok` | `invalid`
 *
 * `step()` has the exact shape `JobRunner.register` takes, so the moment `JobKind` gains `"draft"` the in-process
 * queue is replaced by one line in WP12's runner (`docs/notes/requests/wp17-to-wp12.md`). Until then the default
 * queue runs it in this process and the row - not memory - carries the state, so a poll on another container still
 * answers correctly.
 *
 * Tenancy (SAAS §10.1): `ws` is the principal's `orgId`, never a body field, and it scopes the row, the relay that
 * is created, the plan check and the usage record.
 */
import "server-only";

import type OpenAI from "openai";

import { BatonError } from "../../core/contracts/errors";
import type { Blueprint, DeskInput, DraftView } from "../../core/contracts/v2";
import type { Drafter } from "../../core/contracts/v2/services";
import { PLANS } from "../../core/contracts/v3/plans";
import { defaultRelayKernel } from "../relays/kernel";
import { getRelaysDeps } from "../relays";
import { getDb } from "../db/client";
import { env } from "../env";
import { getLimitsAuthority, getRateLimiter } from "../limits";
import { log } from "../log";
import { createOpenAI } from "../openai/client";
import { DRAFT_TIMEOUT_MS } from "../openai/draft";
import { getEntitlements, getUsageMeter, resolvePlan } from "../saas/ports";
import { SaasError } from "../saas/errors";
import { enforceRates, type RateSpec } from "../limits/rate-limiter";
import { runDraftPipeline, type DraftPipelineDeps } from "./pipeline";
import { MemoryDraftStore, PgDraftStore, type DraftStore } from "./store";

const draftLog = log.child({ component: "draft" });

/** PLATFORM §10.2: the `draft` bucket. The plan's `draftsPerDay` is checked first and is the real limit. */
export const DRAFT_RATES = {
  visitor: { bucket: "draft", limit: 3, windowSec: 86_400 },
  ip: { bucket: "draft:ip", limit: 6, windowSec: 86_400 },
} as const satisfies Record<string, RateSpec>;

/** What the wizard tells the client to expect while it polls. */
export const DRAFT_ETA_SEC = 40;

export interface DraftWho {
  ws: string;
  visitorId: string;
  ipKey: string;
}

/** Runs a queued draft. The default runs it in this process; WP12's runner replaces it with a job. */
export interface DraftQueue {
  enqueue(draftId: string): Promise<void>;
}

export interface DrafterDeps {
  store: DraftStore;
  queue: DraftQueue;
  kernel: DraftPipelineDeps["kernel"];
  /** Creates the relay in `ws` and returns its id. */
  createRelay(ws: string, bp: Blueprint): Promise<string>;
  llm: DraftPipelineDeps["llm"];
  rateLimiter(): ReturnType<typeof getRateLimiter>;
  today(): string;
}

// ============================================================================================ the service

export class DraftService implements Drafter {
  constructor(private readonly d: DrafterDeps) {}

  /** The plan's daily drafting allowance (SAAS §4.1). Guests get one; Free three; Pro ten. */
  private async assertPlan(ws: string): Promise<void> {
    const { ok, used, limit } = await getEntitlements().checkRate(ws, "draftsPerDay");
    if (ok) return;
    const plan = await resolvePlan(ws);
    throw new SaasError(
      "E_PLAN_LIMIT",
      limit === 0
        ? `Drafting a relay from a description is not included in ${PLANS[plan].name}. Start from a gallery relay instead.`
        : `You have used today's ${limit} ${limit === 1 ? "draft" : "drafts"} on ${PLANS[plan].name}. Start from a gallery relay, or try again tomorrow.`,
      { extra: { limit: { key: "draftsPerDay", used, limit, plan } } },
    );
  }

  async start(input: DeskInput, who: DraftWho): Promise<DraftView> {
    await this.assertPlan(who.ws);
    await enforceRates(this.d.rateLimiter(), [
      { spec: DRAFT_RATES.visitor, key: who.visitorId, message: "You have drafted three relays today. Start from a gallery relay, or try again tomorrow." },
      { spec: DRAFT_RATES.ip, key: who.ipKey, message: "Too many relays drafted from this network today. Start from a gallery relay instead." },
    ]);
    const draftId = await this.d.store.create({ ws: who.ws, input });
    await this.d.queue.enqueue(draftId);
    return { draftId, status: "queued", step: null, relayId: null, notes: [], lint: [], usd: 0, repairs: 0 };
  }

  async get(draftId: string, ws: string): Promise<DraftView | null> {
    return this.d.store.get(draftId, ws);
  }

  /**
   * One queued draft, start to finish. Shaped like a `JobRunner` step (`{ state, next }`), never throws: a failure
   * is written to the row, because the client only ever sees the row.
   */
  async step(draftId: string): Promise<{ state: unknown; next: "done" | "failed" }> {
    const row = await this.d.store.load(draftId);
    if (!row) return { state: null, next: "failed" };
    await this.d.store.patch(draftId, { status: "running", step: "drafting" });
    try {
      const result = await runDraftPipeline(
        {
          llm: this.d.llm,
          kernel: this.d.kernel,
          create: (bp) => this.d.createRelay(row.ws, bp),
          today: this.d.today,
          onStep: (step) => this.d.store.patch(draftId, { step }),
        },
        row.input,
        draftId,
      );
      await this.d.store.patch(draftId, {
        status: result.status,
        step: null,
        notes: result.notes,
        lint: result.lint,
        relayId: result.relayId,
        usd: result.usd,
        repairs: result.repairs,
      });
      // SAAS §4.5: one usage record per finished draft, whatever its lint says. Idempotent on the draft id.
      await getUsageMeter()
        .record({
          orgId: row.ws, kind: "draft", quantity: 1, idempotencyKey: `draft:${draftId}`,
          ...(result.relayId ? { relayId: result.relayId } : {}),
          occurredAt: new Date().toISOString(),
        })
        .catch((err: unknown) => draftLog.warn("usage record failed", { err }));
      return { state: { status: result.status, usd: result.usd }, next: "done" };
    } catch (err) {
      draftLog.error("draft failed", { draftId, err });
      const message = err instanceof BatonError || err instanceof SaasError ? err.message : "The relay could not be drafted. Start from a gallery relay instead.";
      await this.d.store.patch(draftId, { status: "failed", step: null, notes: [message] });
      return { state: { error: message }, next: "failed" };
    }
  }
}

// ============================================================================================ wiring

type Holder = { deps: DrafterDeps | null; service: DraftService | null; openai: OpenAI | null };
const g = globalThis as typeof globalThis & { __changeoverDraft?: Holder };
const holder: Holder = (g.__changeoverDraft ??= { deps: null, service: null, openai: null });

function openai(): OpenAI {
  if (holder.openai) return holder.openai;
  const key = env().OPENAI_API_KEY;
  if (!key) throw new BatonError("E_INTERNAL", "OPENAI_API_KEY is not configured (value never printed)");
  holder.openai = createOpenAI(key, { maxRetries: 0, timeoutMs: DRAFT_TIMEOUT_MS });
  return holder.openai;
}

/**
 * The default queue: the step runs in this process, detached from the request, and every outcome is already in the
 * row. `unhandledRejection` is impossible because `step()` swallows its own failures.
 */
export function inProcessQueue(service: () => DraftService): DraftQueue {
  return {
    async enqueue(draftId) {
      setTimeout(() => {
        void service().step(draftId);
      }, 0);
    },
  };
}

export function buildDrafterDeps(o: Partial<DrafterDeps> = {}): DrafterDeps {
  const store = o.store ?? new PgDraftStore(getDb());
  return {
    store,
    queue: o.queue ?? inProcessQueue(() => getDrafter()),
    kernel: o.kernel ?? defaultRelayKernel,
    createRelay: o.createRelay ?? (async (ws, bp) => {
      // The plan's relay count is checked here and not in the pipeline: a draft that cannot be stored is a plan
      // problem, not a drafting problem, and the message must say so.
      await getEntitlements().assertCount(ws, "relays");
      const detail = await getRelaysDeps().registry.create(ws, { kind: "blueprint", blueprint: bp, origin: "draft" });
      return detail.id;
    }),
    llm: o.llm ?? {
      openai,
      ledger: () => getLimitsAuthority().ledger,
      env: () => env().BATON_DEPLOY_ID,
    },
    rateLimiter: o.rateLimiter ?? (() => getRateLimiter()),
    today: o.today ?? (() => new Date().toISOString().slice(0, 10)),
  };
}

export function getDrafter(): DraftService {
  if (!holder.service) {
    holder.deps ??= buildDrafterDeps();
    holder.service = new DraftService(holder.deps);
  }
  return holder.service;
}

/** Tests and scripts: replace the graph (null = rebuild from the defaults on next use). */
export function setDrafter(o: Partial<DrafterDeps> | null): DraftService | null {
  if (!o) {
    holder.deps = null;
    holder.service = null;
    return null;
  }
  holder.deps = buildDrafterDeps(o);
  holder.service = new DraftService(holder.deps);
  return holder.service;
}

export { MemoryDraftStore, PgDraftStore, type DraftStore } from "./store";
export { runDraftPipeline, evaluateDraft, type DraftPipelineResult } from "./pipeline";
