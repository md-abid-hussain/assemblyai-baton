/**
 * server/sim/service.ts - `SimCallService`: on-demand simulated calls and TEXT DRY RUNs (PLATFORM §7.5, §7.5.2;
 * TASKS-v3 §7 WP17).
 *
 *   POST /api/sim-calls {relayId, sampleIndex, kind}  → {simCallId, status, etaSec}, in one round trip
 *   GET  /api/sim-calls/:id                            → SimCallView, polled to `ready`
 *
 * Both kinds share one shape: resolve the relay version the caller may run, check the PLAN first and the v2
 * visitor/ipKey buckets second, then either answer `ready` (the row already exists - a repeat costs $0) or start
 * the work off-request and answer `generating`.
 *
 *   text_dry_run  script (luna) → the relay's own extractor over the script's turns → the row (no audio, ≈ $0.01)
 *   audio         script (luna) → TTS every line → assemble → the row with both channels (≈ $0.02)
 *
 * Plans (SAAS §4.1): `dryRunsPerDay` and `voicedSimsPerDay`. Guest and Free have **no** voiced sims, so the refusal
 * is a plan message that points at the dry run and the pre-generated gallery call - never a bare 429.
 *
 * Ids are content-addressed and stable for a (version, sample, day), so asking twice in a day returns the same sim
 * for free while a sim regenerated on a later day can never collide with assets a browser cached as immutable.
 */
import "server-only";

import type OpenAI from "openai";

import { BatonError } from "../../core/contracts/errors";
import type { SimCallStore } from "../../core/contracts/ext/wp17-sim";
import type { CreateSimCallResponse, SimCallKind, SimCallView } from "../../core/contracts/v2";
import { SimScriptSchema } from "../../core/contracts/v2/api";
import { PLANS } from "../../core/contracts/v3/plans";
import { getDb } from "../db/client";
import { env } from "../env";
import { getKernelBinding } from "../engine/kernel-binding";
import { prepareRelayRun, type RelayRunDeps } from "../engine/run";
import { getLimitsAuthority, getRateLimiter } from "../limits";
import { enforceRates, type RateSpec } from "../limits/rate-limiter";
import { log } from "../log";
import { createOpenAI } from "../openai/client";
import { generateSimScript, type SimScriptDeps } from "../openai/sim-script";
import { getRelaysDeps } from "../relays";
import { SaasError } from "../saas/errors";
import { getEntitlements, getUsageMeter, resolvePlan } from "../saas/ports";
import { getSimCallStore, getTtsService } from "./defaults";
import { DRY_RUN_ETA_SEC, runTextDryRun, type DryRunDeps } from "./dry-run";
import { simCallIdFor, voiceSimCall } from "./generate";

const simLog = log.child({ component: "sim-service" });

/** PLATFORM §10.2. The plan limit is checked first and is the real one; these share fairly among honest visitors. */
export const SIM_RATES = {
  dryRunVisitor: { bucket: "sim:dryrun", limit: 5, windowSec: 86_400 },
  dryRunIp: { bucket: "sim:dryrun:ip", limit: 10, windowSec: 86_400 },
  audioVisitor: { bucket: "sim:generate", limit: 1, windowSec: 86_400 },
  audioIp: { bucket: "sim:generate:ip", limit: 2, windowSec: 86_400 },
} as const satisfies Record<string, RateSpec>;

/** §7.5: script ≈ 10 s, then ≈ 17 TTS clips and the assembly. */
export const AUDIO_ETA_SEC = 45;

export interface SimRequest {
  relayId: string;
  sampleIndex: number;
  kind: SimCallKind;
  ws: string;
  visitorId: string;
  ipKey: string;
}

/** An in-flight sim, until its row exists. */
interface Pending {
  kind: SimCallKind;
  relayId: string;
  relayVersionId: string;
  sampleIndex: number;
  startedAt: number;
  error: string | null;
}

export interface SimServiceDeps {
  store: SimCallStore;
  run: RelayRunDeps;
  script: SimScriptDeps;
  dryRun: DryRunDeps;
  tts: () => ReturnType<typeof getTtsService>;
  rateLimiter(): ReturnType<typeof getRateLimiter>;
  /** The salt that makes an id stable for one day (§7.5 step 4: the id is content-addressed and immutable). */
  daySalt(): string;
  /** Runs the work off-request. The default detaches it; a test awaits it. */
  detach(work: () => Promise<void>): void;
}

export class SimCallServiceImpl {
  /** `simCallId` → in-flight state. A finished sim lives in the store, not here. */
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly d: SimServiceDeps) {}

  private async assertPlan(ws: string, kind: SimCallKind): Promise<void> {
    const key = kind === "audio" ? "voicedSimsPerDay" : "dryRunsPerDay";
    const { ok, used, limit } = await getEntitlements().checkRate(ws, key);
    if (ok) return;
    const plan = await resolvePlan(ws);
    const message = kind === "audio"
      ? limit === 0
        ? `Voiced simulated calls are not included in ${PLANS[plan].name}. Run a text dry run, or play the pre-generated call in the gallery.`
        : `You have used today's ${limit} voiced ${limit === 1 ? "simulation" : "simulations"}. Run a text dry run instead.`
      : `You have used today's ${limit} dry ${limit === 1 ? "run" : "runs"} on ${PLANS[plan].name}. The compiled preview still works.`;
    throw new SaasError("E_PLAN_LIMIT", message, { extra: { limit: { key, used, limit, plan } } });
  }

  private async enforceBuckets(i: SimRequest): Promise<void> {
    const specs = i.kind === "audio"
      ? [
        { spec: SIM_RATES.audioVisitor, key: i.visitorId, message: "You have generated a voiced simulated call today. Use a text dry run or a pre-generated call." },
        { spec: SIM_RATES.audioIp, key: i.ipKey, message: "Too many voiced simulated calls from this network today. Use a text dry run instead." },
      ]
      : [
        { spec: SIM_RATES.dryRunVisitor, key: i.visitorId, message: "You have run five dry runs today. The compiled preview still works." },
        { spec: SIM_RATES.dryRunIp, key: i.ipKey, message: "Too many dry runs from this network today. The compiled preview still works." },
      ];
    await enforceRates(this.d.rateLimiter(), specs);
  }

  async request(i: SimRequest): Promise<CreateSimCallResponse> {
    await this.assertPlan(i.ws, i.kind);
    const prepared = await prepareRelayRun(this.d.run, { ws: i.ws, relayId: i.relayId });
    const bp = prepared.run.blueprint;
    if (!bp.context.samples[i.sampleIndex]) throw new BatonError("E_BAD_REQUEST", "That sample account does not exist on this relay.");

    const simCallId = simCallIdFor({
      kind: i.kind,
      versionKey: prepared.run.versionId,
      sampleIndex: i.sampleIndex,
      salt: i.kind === "audio" ? this.d.daySalt() : "dry",
    });
    if (await this.d.store.get(simCallId)) return { simCallId, status: "ready", etaSec: 0 };
    const inflight = this.pending.get(simCallId);
    if (inflight && !inflight.error) {
      return { simCallId, status: "generating", etaSec: this.etaOf(i.kind, inflight.startedAt) };
    }

    // Only a real generation draws on a bucket: a repeat within the day is free and already returned `ready`.
    await this.enforceBuckets(i);
    this.pending.set(simCallId, {
      kind: i.kind, relayId: prepared.run.relayId, relayVersionId: prepared.run.versionId,
      sampleIndex: i.sampleIndex, startedAt: Date.now(), error: null,
    });
    this.d.detach(() => this.generate(simCallId, prepared, i));
    return { simCallId, status: "generating", etaSec: i.kind === "audio" ? AUDIO_ETA_SEC : DRY_RUN_ETA_SEC };
  }

  private etaOf(kind: SimCallKind, startedAt: number): number {
    const total = kind === "audio" ? AUDIO_ETA_SEC : DRY_RUN_ETA_SEC;
    return Math.max(1, total - Math.floor((Date.now() - startedAt) / 1000));
  }

  /** The work itself. Never throws: the failure is remembered so the poll can report it. */
  private async generate(simCallId: string, prepared: Awaited<ReturnType<typeof prepareRelayRun>>, i: SimRequest): Promise<void> {
    const bp = prepared.run.blueprint;
    const relay = { relayId: prepared.run.relayId, slug: prepared.run.relaySlug, title: bp.meta.title, blueprintHash: prepared.run.hash };
    try {
      const script = await generateSimScript(this.d.script, { blueprint: bp, sampleIndex: i.sampleIndex, refId: simCallId });
      if (i.kind === "text_dry_run") {
        const out = await runTextDryRun(this.d.dryRun, {
          compiled: prepared.compiled, blueprint: bp, sampleIndex: i.sampleIndex, script: script.script, simCallId,
        });
        await this.d.store.insert({
          id: simCallId, kind: "text_dry_run", relayVersionId: prepared.run.versionId, sampleIndex: i.sampleIndex,
          script: { ...script.script, timeline: [], relay, dryRun: out.result },
          rep: null, customer: null, peaks: null,
          durationMs: 0,
          handoff: { lineStartMs: 0, lineEndMs: 0, acceptStartMs: null, acceptEndMs: null, declined: false },
          aiClips: {}, usd: Math.round((script.usd + out.usd) * 1e6) / 1e6, gallery: false,
        });
        await this.record(i.ws, simCallId, "dry_run", prepared.run.relayId, "text_dry_run");
      } else {
        const voiced = await voiceSimCall(this.d.tts(), {
          simCallId, script: script.script, blueprint: bp, sampleIndex: i.sampleIndex, relay,
          relayVersionId: prepared.run.versionId, gallery: false, scriptUsd: script.usd,
        });
        await this.d.store.insert(voiced.row);
        await this.record(i.ws, simCallId, "voiced_sim", prepared.run.relayId, "simulated");
      }
      this.pending.delete(simCallId);
    } catch (err) {
      simLog.error("sim generation failed", { simCallId, kind: i.kind, err });
      const p = this.pending.get(simCallId);
      const message = err instanceof BatonError || err instanceof SaasError
        ? err.message
        : "The simulated call could not be built. Try again, or play a pre-generated call.";
      if (p) p.error = message;
      else this.pending.set(simCallId, { kind: i.kind, relayId: prepared.run.relayId, relayVersionId: prepared.run.versionId, sampleIndex: i.sampleIndex, startedAt: Date.now(), error: message });
    }
  }

  private async record(ws: string, simCallId: string, kind: "dry_run" | "voiced_sim", relayId: string, source: "text_dry_run" | "simulated"): Promise<void> {
    await getUsageMeter()
      .record({ orgId: ws, kind, quantity: 1, relayId, source, idempotencyKey: `${kind}:${simCallId}`, occurredAt: new Date().toISOString() })
      .catch((err: unknown) => simLog.warn("usage record failed", { err }));
  }

  async get(simCallId: string): Promise<SimCallView | null> {
    const row = await this.d.store.get(simCallId);
    if (row) {
      const script = SimScriptSchema.safeParse(row.script);
      return {
        id: row.id,
        kind: row.kind,
        status: "ready",
        relayId: row.script.relay.relayId,
        relayVersionId: row.relayVersionId,
        sampleIndex: row.sampleIndex,
        gallery: row.gallery,
        callId: row.kind === "audio" ? row.id : null,
        durationMs: row.kind === "audio" ? row.durationMs : null,
        handoff: row.kind === "audio" ? row.handoff : null,
        script: script.success ? script.data : null,
        dryRun: row.script.dryRun,
        usd: row.usd,
        error: null,
        createdAt: row.createdAt,
      };
    }
    const p = this.pending.get(simCallId);
    if (!p) return null;
    return {
      id: simCallId, kind: p.kind, status: p.error ? "failed" : "generating",
      relayId: p.relayId, relayVersionId: p.relayVersionId, sampleIndex: p.sampleIndex, gallery: false,
      callId: null, durationMs: null, handoff: null, script: null, dryRun: null, usd: 0,
      error: p.error, createdAt: new Date(p.startedAt).toISOString(),
    };
  }
}

// ============================================================================================ wiring

type Holder = { service: SimCallServiceImpl | null; openai: OpenAI | null };
const g = globalThis as typeof globalThis & { __changeoverSimService?: Holder };
const holder: Holder = (g.__changeoverSimService ??= { service: null, openai: null });

function openai(): OpenAI {
  if (holder.openai) return holder.openai;
  const key = env().OPENAI_API_KEY;
  if (!key) throw new BatonError("E_INTERNAL", "OPENAI_API_KEY is not configured (value never printed)");
  holder.openai = createOpenAI(key, { maxRetries: 0 });
  return holder.openai;
}

export function buildSimServiceDeps(o: Partial<SimServiceDeps> = {}): SimServiceDeps {
  const llm = { openai, ledger: () => getLimitsAuthority().ledger, env: () => env().BATON_DEPLOY_ID };
  const relays = () => getRelaysDeps();
  return {
    store: o.store ?? getSimCallStore(),
    run: o.run ?? {
      get registry() { return relays().registry; },
      get engine() { return relays().engine; },
      get catalog() { return relays().catalog; },
      binding: () => getKernelBinding(),
      ensureSeeded: () => relays().ensureSeeded(),
    } as RelayRunDeps,
    script: o.script ?? llm,
    dryRun: o.dryRun ?? llm,
    tts: o.tts ?? (() => getTtsService()),
    rateLimiter: o.rateLimiter ?? (() => getRateLimiter()),
    daySalt: o.daySalt ?? (() => new Date().toISOString().slice(0, 10)),
    detach: o.detach ?? ((work) => void setTimeout(() => void work(), 0)),
  };
}

export function getSimCallService(): SimCallServiceImpl {
  holder.service ??= new SimCallServiceImpl(buildSimServiceDeps());
  return holder.service;
}

/** Tests and scripts: replace the graph (null = rebuild from the defaults on next use). */
export function setSimCallService(o: Partial<SimServiceDeps> | null): SimCallServiceImpl | null {
  holder.service = o ? new SimCallServiceImpl(buildSimServiceDeps(o)) : null;
  return holder.service;
}

/** `getDb()` is referenced so a misconfigured deployment fails here, not inside a detached job. */
export const assertSimDbReady = (): void => void getDb();
