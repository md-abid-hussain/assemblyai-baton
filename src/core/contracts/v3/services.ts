/**
 * contracts/v3/services.ts - the v3 ports (SAAS §14). TYPES ONLY: no runtime code.
 * WP19; frozen at C3. The default implementations and the get/set registry live in `src/server/saas/ports.ts`,
 * and server code imports ports only from there, so a WP can register its real implementation without any other
 * WP importing it directly.
 */
import type { Permission } from "./permissions";
import type { CountLimitKey, EntitlementView, RateLimitKey } from "./plans";
import type { DomainEventType } from "./events";
import type { AuditEntry } from "./audit";
import type { CodeDiagnostic, RelaySource, RelaySourceView, SourceFormat } from "./relay-code";
import type { Principal } from "./identity";
import type { UsageRecord, UsageSummary } from "./usage";

/** SAAS §2.3. `need.allowVisitor` keeps the v2 device-only routes working. */
export interface PrincipalResolver {
  resolve(req: Request, need?: { perm?: Permission; account?: boolean; allowVisitor?: boolean }): Promise<Principal>;
}

/** SAAS §9. `tx` is the caller's transaction handle when our code owns one. */
export interface AuditWriter {
  write(e: AuditEntry, tx?: unknown): Promise<void>;
}

/** SAAS §7.1 outbox. `dedupeKey` (e.g. `run.completed:<takeoverId>`) makes emission idempotent. */
export interface DomainEvents {
  emit(
    e: { orgId: string; type: DomainEventType; data: unknown; dedupeKey?: string },
    tx?: unknown,
  ): Promise<{ eventId: string; created: boolean }>;
}

/** SAAS §4.5. `record` is idempotent on `UsageRecord.idempotencyKey`. */
export interface UsageMeter {
  record(u: UsageRecord, tx?: unknown): Promise<void>;
  summary(orgId: string, period?: { from: string; to: string }): Promise<UsageSummary>;
}

/** SAAS §4.2. `assertCount` throws `E_PLAN_LIMIT`; `checkRate` reports rather than throws. */
export interface Entitlements {
  get(orgId: string): Promise<EntitlementView>;
  assertCount(orgId: string, key: CountLimitKey): Promise<void>;
  checkRate(orgId: string, key: RateLimitKey, add?: number): Promise<{ ok: boolean; used: number; limit: number }>;
  refresh(orgId: string, reason: string): Promise<EntitlementView>;
}

/** SAAS §4.3 (WP21). `mode: "simulated"` when Polar is not configured (§4.7). */
export interface BillingProvider {
  mode: "polar" | "simulated";
  startCheckout(i: {
    orgId: string;
    userId: string;
    plan: "pro" | "business";
    headers: Headers;
  }): Promise<{ url: string }>;
  syncOrg(orgId: string): Promise<EntitlementView>;
  syncCheckout(checkoutId: string, orgId: string, userId: string): Promise<EntitlementView>;
}

/** Seeds a new guest org with Baton pinned and a Dental copy (SAAS §3.3). WP14b·4 registers it. */
export interface GuestSeeder {
  seed(orgId: string): Promise<{ relayIds: string[] }>;
}

/** Re-seals a workspace's secrets under the new AAD, keeping the row ids (SAAS §2.6 step 4). WP16 registers it. */
export interface SecretRebinder {
  rebind(fromWs: string, toWs: string, tx?: unknown): Promise<number>;
}

/** SAAS §5.2–§5.3. WP14b·4 registers it. */
export interface RelaySourceStore {
  get(
    relayId: string,
    ws: string,
    opts?: { version?: number; format?: SourceFormat },
  ): Promise<RelaySourceView | null>;
  save(
    relayId: string,
    ws: string,
    source: RelaySource,
    expectedRev: number,
    via: "studio" | "api" | "cli",
  ): Promise<
    | { ok: true; rev: number; hash: string; diagnostics: CodeDiagnostic[] }
    | { ok: false; conflict: true; rev: number; hash: string }
    | { ok: false; invalid: true; diagnostics: CodeDiagnostic[] }
  >;
  create(
    ws: string,
    source: RelaySource,
    via: "studio" | "api" | "cli",
  ): Promise<{ ok: true; relayId: string } | { ok: false; invalid: true; diagnostics: CodeDiagnostic[] }>;
}

/** SAAS §5.6. WP16 registers it; the default is the deployment-wide env allowlist only. */
export interface ConnectorHostPolicy {
  isAllowed(orgId: string, host: string): Promise<boolean>;
  list(orgId: string): Promise<string[]>;
}
