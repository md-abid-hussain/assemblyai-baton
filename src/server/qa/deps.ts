/**
 * server/qa/deps.ts - the one seam between WP8 and the packages built in parallel (TASKS §0.3: code against the
 * contracts and inject). Every job, hook and route of WP8 reads its collaborators from `wp8()`; tests and the G1
 * wiring replace them with `configureWp8({...})`.
 *
 * | Port | Default (round 1) | G1 wiring (docs/notes/requests/wp8-to-integrator.md) |
 * |---|---|---|
 * | `runner` | null (routes answer without advancing) | WP2 `getJobRunner()` |
 * | `ledger` | null (no reserve/settle) | WP2 `getLimitsAuthority().ledger` |
 * | `computeQa` | null (S4 fails with "QA engine not wired") | WP1 `computeQa` from `src/core/qa` |
 * | `authorizeTakeover` | case-token check (sub/scp/tko) | WP2 `requireCase(req, {takeoverId})` (adds the visitor) |
 * | `rateLimiter` | in-memory sliding window | WP2 `getRateLimiter()` |
 * | `flags` / `tripReplayOnly` | "live" / not wired (logged) | WP2 `getFlagStore()` |
 * | `vaRest`, `asyncClient`, `fetchJson` | live AssemblyAI clients from `ASSEMBLYAI_API_KEY` | (unchanged) |
 *
 * The holder lives on `globalThis`, so the instrumentation bundle and the route bundles of one process share it.
 */
import "server-only";

import type { AppFlags, JobRunner, RateLimiter, SpendLedger } from "../../core/contracts/services";
import type { ComputeQa } from "../../core/contracts/ext/wp8-verify";
import type { PublishedAgentRef } from "../../core/contracts/ext/wp18-audit";
import { AssemblyAIAsyncClient, type Transcript, type TranscriptParams } from "../aai/async";
import { defaultVaRest, type VaRestPort } from "../aai/va-rest";
import { getDb, type Db } from "../db/client";
import { env, requireEnv } from "../env";
import { tokenAuthorizer, type AuthorizeTakeover } from "./auth";

export interface AsyncPort {
  submit(p: TranscriptParams): Promise<Transcript>;
  get(id: string): Promise<Transcript>;
  delete(id: string): Promise<Transcript>;
}

export interface Wp8Config {
  /** Public origin for the AssemblyAI webhook; null or a localhost URL → poll-only (webhooks cannot reach it). */
  appUrl: string | null;
  webhookSecret: string | null;
  deployId: string;
  vaMaxConcurrent: number;
}

export interface Wp8Ports {
  db(): Db;
  now(): number;
  runner(): JobRunner | null;
  ledger(): SpendLedger | null;
  computeQa: ComputeQa | null;
  vaRest(): VaRestPort;
  asyncClient(): AsyncPort;
  /** Download a pre-signed artifact (timeline JSON). Never sends our API key. */
  fetchJson(url: string): Promise<unknown>;
  authorizeTakeover: AuthorizeTakeover;
  rateLimiter(): RateLimiter;
  flags(): Promise<Pick<AppFlags, "mode" | "reason">>;
  /** Flip `mode=replay_only` with a reason (WP2 precedence rules). Returns whether the mode changed. */
  tripReplayOnly: ((reason: string) => Promise<boolean>) | null;
  config(): Wp8Config;
  /**
   * WP18 (tightened F6, PLATFORM §8.4): the publications' stored agents and active runs. Optional: when unset the
   * audit reads `relay_publications` itself (and finds none while migration 0001 is not applied).
   */
  publishedAgents?: () => Promise<PublishedAgentRef[]>;
}

/** Sliding-window limiter for one process (the default until WP2's DB limiter is wired). */
export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  async hit(bucket: string, key: string, limit: number, windowSec: number, cost = 1): Promise<{ ok: boolean; retryAfterSec: number }> {
    const k = `${bucket}:${key}`;
    const t = this.now();
    const from = t - windowSec * 1000;
    const arr = (this.hits.get(k) ?? []).filter((x) => x > from);
    if (arr.length + cost > limit) {
      this.hits.set(k, arr);
      const oldest = arr[0] ?? t;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowSec * 1000 - t) / 1000)) };
    }
    for (let i = 0; i < cost; i++) arr.push(t);
    this.hits.set(k, arr);
    if (this.hits.size > 5000) for (const [kk, v] of this.hits) if (!v.some((x) => x > from)) this.hits.delete(kk);
    return { ok: true, retryAfterSec: 0 };
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`artifact download failed: HTTP ${res.status}`);
  return res.json();
}

function defaults(): Wp8Ports {
  let rest: VaRestPort | null = null;
  let asyncClient: AsyncPort | null = null;
  let limiter: RateLimiter | null = null;
  return {
    db: () => getDb(),
    now: () => Date.now(),
    runner: () => null,
    ledger: () => null,
    computeQa: null,
    vaRest: () => (rest ??= defaultVaRest()),
    asyncClient: () => (asyncClient ??= new AssemblyAIAsyncClient({ apiKey: requireEnv("ASSEMBLYAI_API_KEY").ASSEMBLYAI_API_KEY })),
    fetchJson: defaultFetchJson,
    authorizeTakeover: tokenAuthorizer(),
    rateLimiter: () => (limiter ??= new MemoryRateLimiter()),
    flags: async () => ({ mode: "live", reason: null }),
    tripReplayOnly: null,
    config: () => {
      const e = env();
      return { appUrl: e.APP_URL ?? null, webhookSecret: e.AAI_WEBHOOK_SECRET ?? null, deployId: e.BATON_DEPLOY_ID, vaMaxConcurrent: e.VA_MAX_CONCURRENT };
    },
  };
}

const g = globalThis as typeof globalThis & { __batonWp8?: Wp8Ports };

export function wp8(): Wp8Ports {
  return (g.__batonWp8 ??= defaults());
}

/** Replace some ports (G1 wiring, tests). Returns a function that restores the previous ports. */
export function configureWp8(patch: Partial<Wp8Ports>): () => void {
  const prev = wp8();
  g.__batonWp8 = { ...prev, ...patch };
  return () => {
    g.__batonWp8 = prev;
  };
}

/** Back to the defaults (tests). */
export function resetWp8(): void {
  g.__batonWp8 = defaults();
}
