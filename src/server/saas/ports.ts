import "server-only";

/**
 * The v3 port registry (SAAS §14). WP19.
 *
 * One get/set pair per port from `src/core/contracts/v3/services.ts`, each with a safe default, so **server code
 * imports ports only from here**. A WP registers its real implementation at start-up (or in a test's `beforeEach`)
 * and nothing else has to import it.
 *
 * The C3 defaults:
 *  - `PrincipalResolver`  → the legacy visitor principal (`principal.ts`), i.e. v2 behaviour unchanged;
 *  - `AuditWriter`, `DomainEvents`, `UsageMeter` → in-memory, for tests and for the pre-C3b server;
 *  - `Entitlements`       → limits from `PLANS` and the org kind; counts come from the counters owners register,
 *                           and rates from the registered `UsageMeter`, so plan limits work before WP21;
 *  - `BillingProvider`    → `simulated`; checkout refuses with `E_BILLING_UNAVAILABLE` (SAAS §4.7);
 *  - `GuestSeeder`, `SecretRebinder` → no-ops (WP14b·4 and WP16 register the real ones);
 *  - `RelaySourceStore`   → read-only and empty until WP14b·4 registers the store that serializes the draft;
 *  - `ConnectorHostPolicy`→ the deployment-wide env allowlist only (no per-org hosts until WP16).
 *
 * The registry lives on `globalThis`, like `src/server/relays`'s deps holder, so Next's dev-mode module reloads do
 * not silently fork it.
 */
import type { AuditEntry } from "../../core/contracts/v3/audit";
import type { DomainEventType } from "../../core/contracts/v3/events";
import type { PlanId } from "../../core/contracts/v3/identity";
import { PLANS, type CountLimitKey, type EntitlementView, type RateLimitKey } from "../../core/contracts/v3/plans";
import type {
  AuditWriter, BillingProvider, ConnectorHostPolicy, DomainEvents, Entitlements, GuestSeeder, PrincipalResolver,
  RelaySourceStore, SecretRebinder, UsageMeter,
} from "../../core/contracts/v3/services";
import type { UsageRecord, UsageSummary } from "../../core/contracts/v3/usage";
import { SaasError } from "./errors";
import { resolveLegacyPrincipal } from "./principal";

// ---------------------------------------------------------------------------------------------- in-memory defaults

/** The audit rows an in-memory writer kept, newest last. Capped so a long-running dev server cannot grow forever. */
const MEMORY_CAP = 2000;

export interface MemoryAuditWriter extends AuditWriter {
  readonly entries: readonly AuditEntry[];
  reset(): void;
}

export function createMemoryAuditWriter(): MemoryAuditWriter {
  const entries: AuditEntry[] = [];
  return {
    entries,
    async write(e) {
      entries.push(e);
      if (entries.length > MEMORY_CAP) entries.splice(0, entries.length - MEMORY_CAP);
    },
    reset() {
      entries.length = 0;
    },
  };
}

export interface MemoryDomainEvent {
  eventId: string;
  orgId: string;
  type: DomainEventType;
  data: unknown;
  dedupeKey: string | null;
}
export interface MemoryDomainEvents extends DomainEvents {
  readonly events: readonly MemoryDomainEvent[];
  reset(): void;
}

export function createMemoryDomainEvents(): MemoryDomainEvents {
  const events: MemoryDomainEvent[] = [];
  const seen = new Map<string, string>();
  let n = 0;
  return {
    events,
    async emit(e) {
      const key = e.dedupeKey ?? null;
      if (key) {
        const existing = seen.get(key);
        if (existing) return { eventId: existing, created: false };
      }
      const eventId = `evt_mem_${++n}`;
      if (key) seen.set(key, eventId);
      events.push({ eventId, orgId: e.orgId, type: e.type, data: e.data, dedupeKey: key });
      if (events.length > MEMORY_CAP) events.splice(0, events.length - MEMORY_CAP);
      return { eventId, created: true };
    },
    reset() {
      events.length = 0;
      seen.clear();
      n = 0;
    },
  };
}

const dayOf = (iso: string | undefined) => (iso ?? new Date().toISOString()).slice(0, 10);

export interface MemoryUsageMeter extends UsageMeter {
  readonly records: readonly UsageRecord[];
  reset(): void;
}

/**
 * Idempotent on `idempotencyKey` and summarised in memory. Minutes stay split Recorded / Simulated / Published and
 * a `replay` is counted as a run with zero minutes (SAAS §4.5), so the default never over-reports billable time.
 */
export function createMemoryUsageMeter(): MemoryUsageMeter {
  const records: UsageRecord[] = [];
  const keys = new Set<string>();
  return {
    records,
    async record(u) {
      if (keys.has(u.idempotencyKey)) return;
      keys.add(u.idempotencyKey);
      records.push(u);
    },
    async summary(orgId, period) {
      const from = period?.from ?? `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`;
      const to = period?.to ?? new Date().toISOString();
      const today = dayOf(undefined);
      const mine = records.filter((r) => r.orgId === orgId);
      const inPeriod = mine.filter((r) => {
        const at = r.occurredAt ?? to;
        return at >= from && at <= to;
      });
      const minutes = (source: UsageRecord["source"]) =>
        inPeriod
          .filter((r) => r.kind === "ai_minutes" && (r.source ?? "recorded") === source)
          .reduce((a, r) => a + r.quantity, 0);
      const todayCount = (kind: UsageRecord["kind"]) =>
        mine.filter((r) => r.kind === kind && dayOf(r.occurredAt) === today).reduce((a, r) => a + r.quantity, 0);

      const plan = await resolvePlan(orgId);
      const limits = PLANS[plan].limits;
      const recorded = minutes("recorded");
      const simulated = minutes("simulated");
      const published = minutes("published");
      const billable = recorded + published;
      const over = Math.max(0, billable - limits.aiMinutesPerMonth);
      const daily = new Map<string, { aiMinutes: number; runs: number }>();
      for (const r of inPeriod) {
        const d = dayOf(r.occurredAt);
        const row = daily.get(d) ?? { aiMinutes: 0, runs: 0 };
        if (r.kind === "ai_minutes") row.aiMinutes += r.quantity;
        if (r.kind === "live_run") row.runs += r.quantity;
        daily.set(d, row);
      }
      return {
        orgId,
        period: { from, to },
        plan,
        aiMinutes: {
          recorded, simulated, published,
          allowance: limits.aiMinutesPerMonth,
          overageUsdEstimate: limits.overageUsdPerMin === null ? 0 : over * limits.overageUsdPerMin,
        },
        today: {
          liveRuns: todayCount("live_run"),
          dryRuns: todayCount("dry_run"),
          voicedSims: todayCount("voiced_sim"),
          drafts: todayCount("draft"),
        },
        daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v })),
      } satisfies UsageSummary;
    },
    reset() {
      records.length = 0;
      keys.clear();
    },
  };
}

// ------------------------------------------------------------------------------------ plan + count resolution

/** How the default `Entitlements` decides an org's plan before WP21's `org_entitlements` exists. */
export type PlanResolver = (orgId: string) => PlanId | Promise<PlanId>;

/** A legacy `ws_<visitorId>` workspace is a guest; anything else is on Free until billing says otherwise. */
export const defaultPlanResolver: PlanResolver = (orgId) => (orgId.startsWith("ws_") ? "guest" : "free");

/** Counts the rows behind one `CountLimitKey` for an org. Owners register theirs; unregistered reads as 0. */
export type OrgCounter = (orgId: string) => number | Promise<number>;

// ----------------------------------------------------------------------------------------------- the registry

interface Registry {
  principal: PrincipalResolver | null;
  audit: AuditWriter | null;
  events: DomainEvents | null;
  usage: UsageMeter | null;
  entitlements: Entitlements | null;
  billing: BillingProvider | null;
  seeder: GuestSeeder | null;
  rebinder: SecretRebinder | null;
  sourceStore: RelaySourceStore | null;
  hostPolicy: ConnectorHostPolicy | null;
  plan: PlanResolver;
  counters: Map<CountLimitKey, OrgCounter>;
}

const emptyRegistry = (): Registry => ({
  principal: null, audit: null, events: null, usage: null, entitlements: null, billing: null,
  seeder: null, rebinder: null, sourceStore: null, hostPolicy: null,
  plan: defaultPlanResolver, counters: new Map(),
});

const g = globalThis as typeof globalThis & { __changeoverSaasPorts?: Registry };
const reg: Registry = (g.__changeoverSaasPorts ??= emptyRegistry());

/** Reset every port to its C3 default. Tests call this in `beforeEach`. */
export function resetSaasPorts(): void {
  Object.assign(reg, emptyRegistry());
}

export const getPrincipalResolver = (): PrincipalResolver => (reg.principal ??= { resolve: resolveLegacyPrincipal });
export const setPrincipalResolver = (v: PrincipalResolver | null): void => void (reg.principal = v);

export const getAuditWriter = (): AuditWriter => (reg.audit ??= createMemoryAuditWriter());
export const setAuditWriter = (v: AuditWriter | null): void => void (reg.audit = v);

export const getDomainEvents = (): DomainEvents => (reg.events ??= createMemoryDomainEvents());
export const setDomainEvents = (v: DomainEvents | null): void => void (reg.events = v);

export const getUsageMeter = (): UsageMeter => (reg.usage ??= createMemoryUsageMeter());
export const setUsageMeter = (v: UsageMeter | null): void => void (reg.usage = v);

export const getBillingProvider = (): BillingProvider => (reg.billing ??= createSimulatedBilling());
export const setBillingProvider = (v: BillingProvider | null): void => void (reg.billing = v);

export const getGuestSeeder = (): GuestSeeder => (reg.seeder ??= { async seed() { return { relayIds: [] }; } });
export const setGuestSeeder = (v: GuestSeeder | null): void => void (reg.seeder = v);

export const getSecretRebinder = (): SecretRebinder => (reg.rebinder ??= { async rebind() { return 0; } });
export const setSecretRebinder = (v: SecretRebinder | null): void => void (reg.rebinder = v);

export const getRelaySourceStore = (): RelaySourceStore => (reg.sourceStore ??= createEmptySourceStore());
export const setRelaySourceStore = (v: RelaySourceStore | null): void => void (reg.sourceStore = v);

export const getConnectorHostPolicy = (): ConnectorHostPolicy => (reg.hostPolicy ??= createEnvHostPolicy());
export const setConnectorHostPolicy = (v: ConnectorHostPolicy | null): void => void (reg.hostPolicy = v);

export const getEntitlements = (): Entitlements => (reg.entitlements ??= createDefaultEntitlements());
export const setEntitlements = (v: Entitlements | null): void => void (reg.entitlements = v);

export const setPlanResolver = (v: PlanResolver | null): void => void (reg.plan = v ?? defaultPlanResolver);
export const resolvePlan = async (orgId: string): Promise<PlanId> => reg.plan(orgId);

/** Register the row counter behind one count limit (`relays` → WP14b, `secrets` → WP16, …). */
export const setOrgCounter = (key: CountLimitKey, fn: OrgCounter | null): void => {
  if (fn) reg.counters.set(key, fn);
  else reg.counters.delete(key);
};
export const countOrg = async (orgId: string, key: CountLimitKey): Promise<number> => {
  const fn = reg.counters.get(key);
  return fn ? fn(orgId) : 0;
};

// ---------------------------------------------------------------------------------------- default implementations

/** Read-only and empty: WP14b·4 registers the store that serializes the canonical draft. */
function createEmptySourceStore(): RelaySourceStore {
  const readOnly = (): never => {
    throw new SaasError("E_UNPROCESSABLE", "Editing relay source is not available on this deployment yet.");
  };
  return { async get() { return null; }, async save() { return readOnly(); }, async create() { return readOnly(); } };
}

/**
 * The deployment-wide allowlist (`CONNECTOR_HOST_ALLOWLIST`, comma-separated, case-insensitive) and nothing else.
 * Per-org allowed hosts are Pro+ and arrive with WP16's policy.
 */
function createEnvHostPolicy(): ConnectorHostPolicy {
  const envHosts = (): string[] =>
    (process.env.CONNECTOR_HOST_ALLOWLIST ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  return {
    async isAllowed(_orgId, host) {
      return envHosts().includes(host.trim().toLowerCase());
    },
    async list() {
      return envHosts();
    },
  };
}

function createSimulatedBilling(): BillingProvider {
  const view = async (orgId: string): Promise<EntitlementView> => getEntitlements().get(orgId);
  return {
    mode: "simulated",
    async startCheckout() {
      throw new SaasError("E_BILLING_UNAVAILABLE", "Billing is not configured on this deployment.");
    },
    syncOrg: view,
    async syncCheckout(_checkoutId, orgId) {
      return view(orgId);
    },
  };
}

/** Which usage number each rate limit is measured against (SAAS §4.1, §4.5). */
const RATE_USED: Record<RateLimitKey, (s: UsageSummary) => number> = {
  liveRunsPerDay: (s) => s.today.liveRuns,
  dryRunsPerDay: (s) => s.today.dryRuns,
  voicedSimsPerDay: (s) => s.today.voicedSims,
  draftsPerDay: (s) => s.today.drafts,
  // Simulated minutes are free (SAAS §4.5): only recorded and published minutes draw on the allowance.
  aiMinutesPerMonth: (s) => s.aiMinutes.recorded + s.aiMinutes.published,
};

/** Limits straight from `PLANS`, counts from the registered counters, rates from the registered meter. */
function createDefaultEntitlements(): Entitlements {
  const get = async (orgId: string): Promise<EntitlementView> => {
    const plan = await resolvePlan(orgId);
    return {
      orgId,
      plan,
      status: plan === "guest" ? "none" : "active",
      source: "default",
      limits: PLANS[plan].limits,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      syncedAt: null,
    };
  };
  return {
    get,
    async assertCount(orgId, key) {
      const { limits, plan } = await get(orgId);
      const limit = limits[key];
      const used = await countOrg(orgId, key);
      if (used >= limit) {
        throw new SaasError(
          "E_PLAN_LIMIT",
          `The ${PLANS[plan].name} plan includes ${limit} ${key}. Upgrade to add more.`,
          { extra: { limit: { key, used, limit, plan } } },
        );
      }
    },
    async checkRate(orgId, key, add = 1) {
      const { limits } = await get(orgId);
      const limit = limits[key];
      const used = RATE_USED[key](await getUsageMeter().summary(orgId));
      return { ok: used + add <= limit, used, limit };
    },
    refresh: get,
  };
}
