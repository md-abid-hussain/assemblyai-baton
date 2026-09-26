/**
 * WP18 publish test fixtures: a fake `POST/DELETE /v1/agents` (no network, no spend), a fake `RelayToolService`, a
 * registry over a throwaway database with the WP14a mini blueprint, and row builders for a published run.
 */
import { randomUUID } from "node:crypto";

import type { AgentDefinition, AgentRecord } from "@/core/aai/voice-agent";
import type { RateLimiter } from "@/core/contracts/services";
import type { Blueprint } from "@/core/contracts/v2";
import type { RelayToolContext, RelayToolOutcome, RelayToolService } from "@/core/contracts/v2/services";
import type { VaRestPort, SessionsPage, SessionRecord } from "@/server/aai/va-rest";
import type { Db } from "@/server/db/client";
import { cases, takeovers } from "@/server/db/schema";
import { buildPublishDeps, type PublishDeps } from "@/server/publish/deps";
import { PgRelayRegistry } from "@/server/relays/registry";
import { MemoryGallerySource } from "@/server/relays/seed";
import type { Moderator } from "@/server/relays/moderation";
import { CachedRelayEngineFactory } from "@/server/engine/factory";
import { getKernelBinding } from "@/server/engine/kernel-binding";
import { miniBlueprint } from "../../core/relay/fixtures/mini-blueprint";

export const APP_URL = "https://changeover.example";
export const DEPLOY_ID = "test-wp18";

export function dentalBlueprint(): Blueprint {
  const bp = miniBlueprint();
  bp.meta.slug = "dental-deposit";
  bp.meta.title = "Dental deposit";
  return bp;
}

/** Every `POST /v1/agents` and `DELETE /v1/agents/{id}` this suite makes, recorded instead of sent. */
export class FakeVaRest implements VaRestPort {
  readonly created: { id: string; def: AgentDefinition }[] = [];
  readonly deleted: string[] = [];
  createStatus: "ok" | "fail" = "ok";
  deleteStatus: number | "throw" = 204;
  private n = 0;

  async createAgent(def: AgentDefinition): Promise<AgentRecord> {
    if (this.createStatus === "fail") throw new Error("agent create refused (fake)");
    const id = `agent_${(++this.n).toString(16).padStart(32, "0")}`;
    this.created.push({ id, def });
    return { ...def, id } as AgentRecord;
  }
  async deleteAgent(id: string): Promise<number> {
    if (this.deleteStatus === "throw") throw new Error("delete refused (fake)");
    this.deleted.push(id);
    return this.deleteStatus;
  }
  async getSession(): Promise<SessionRecord> {
    throw new Error("not used");
  }
  async listSessions(): Promise<SessionsPage> {
    return { sessions: [], hasMore: false, nextCursor: null };
  }
  async deleteSession(): Promise<number> {
    return 204;
  }
}

/** A `RelayToolService` that records its calls and answers with whatever the test queued. */
export class FakeToolService implements RelayToolService {
  readonly calls: { name: string; args: unknown; ctx: RelayToolContext }[] = [];
  next: Partial<RelayToolOutcome> = { result: { status: "ok" }, nextStep: null };
  throws: Error | null = null;

  async handle(name: string, args: unknown, ctx: RelayToolContext): Promise<RelayToolOutcome> {
    this.calls.push({ name, args, ctx });
    if (this.throws) throw this.throws;
    return { result: {}, nextStep: null, ...this.next } as RelayToolOutcome;
  }
}

export class FakeModerator implements Moderator {
  constructor(private readonly flag: (text: string) => boolean = () => false) {}
  async check(text: string) {
    const flagged = this.flag(text);
    return { flagged, categories: flagged ? ["harassment"] : [] };
  }
}

/** Never refuses; the quota tests drive the limiter directly. */
export const openLimiter: RateLimiter = { async hit() { return { ok: true, retryAfterSec: 0 }; } };

export interface PublishFixture {
  deps: PublishDeps;
  registry: PgRelayRegistry;
  rest: FakeVaRest;
  tools: FakeToolService;
  clock: { now: number };
}

export function publishFixture(db: Db, o: { moderator?: Moderator; appUrl?: string | null } = {}): PublishFixture {
  const clock = { now: Date.UTC(2026, 8, 25, 12, 0, 0) };
  const registry = new PgRelayRegistry({
    db,
    moderator: o.moderator ?? new FakeModerator(),
    gallery: new MemoryGallerySource([]),
    now: () => clock.now,
  });
  const engine = new CachedRelayEngineFactory({
    versions: registry,
    compiler: () => getKernelBinding()?.compile ?? null,
    legacyBlueprint: async () => null,
  });
  const rest = new FakeVaRest();
  const tools = new FakeToolService();
  const deps = buildPublishDeps({
    db,
    registry,
    engine,
    vaRest: () => rest,
    tools: () => tools,
    rateLimiter: () => openLimiter,
    now: () => clock.now,
    deployId: () => DEPLOY_ID,
    appUrl: () => (o.appUrl === undefined ? APP_URL : o.appUrl),
  });
  return { deps, registry, rest, tools, clock };
}

/** A relay in `ws` with a lint-clean draft, ready to publish. */
export async function seedRelay(registry: PgRelayRegistry, ws: string, bp: Blueprint = dentalBlueprint()): Promise<{ id: string; slug: string }> {
  const detail = await registry.create(ws, { kind: "blueprint", blueprint: bp, origin: "user" });
  return { id: detail.id, slug: detail.slug };
}

/** A minimal case + takeover pair, enough for the gateway and the state route. */
export async function seedRun(
  db: Db,
  i: { visitorId: string; relayVersionId: string | null; stage?: string | null; outcome?: "completed" | null },
): Promise<{ caseId: string; takeoverId: string }> {
  const caseId = `case_${randomUUID().slice(0, 8)}`;
  const takeoverId = `tko_${randomUUID().slice(0, 8)}`;
  await db.insert(cases).values({
    id: caseId,
    mode: "synthetic",
    scenarioId: "s01",
    policy: {},
    state: { fields: {}, readiness: { verified: 2, pending: 0, missing: 0, requiredTotal: 3, ready: false } },
    visitorId: i.visitorId,
    ipKey: "ip_test",
    relayVersionId: i.relayVersionId,
  });
  await db.insert(takeovers).values({
    id: takeoverId,
    caseId,
    tArmMs: 1000,
    stage: i.stage ?? null,
    outcome: i.outcome ?? null,
  });
  return { caseId, takeoverId };
}
