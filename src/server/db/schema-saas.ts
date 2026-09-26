/**
 * The SaaS tables of SAAS §2.7, owned by WP19 (TASKS-v3 §6 carve-out 1). `drizzle-kit generate` turns this file
 * plus `schema-auth.ts` plus the additive columns below into `drizzle/0002_saas.sql`.
 *
 * Conventions follow `schema.ts`: `timestamptz` defaulting to now(), `text` ids, `jsonb` for JSON, enum-like
 * columns as `text` narrowed in TypeScript (no Postgres enums, so later additions never need `ALTER TYPE`).
 *
 * Like `schema.ts`, this file deliberately does NOT `import "server-only"`: drizzle-kit loads it outside Next.
 *
 * **Foreign keys.** Exactly two tables cascade: `org_meta` and `org_entitlements` reference
 * `organizations(id) ON DELETE CASCADE` (`orgRef()` below), because they *are* the org's own record and are
 * meaningless without it. `usage_events`, `domain_events`, `webhook_endpoints`, `webhook_deliveries` and
 * `audit_log` carry `org_id` as a plain `text` column with **no FK and so no cascade**: they are history and
 * ledger, and §3.5 keeps them for a retention window *after* the org is gone, purged by age rather than by the
 * delete. Reading one back therefore has to tolerate an `org_id` with no surviving organization row — that is
 * the intended state, not an orphan to repair, and it is why §9 freezes the actor label at write time.
 *
 * Nothing references `users(id)` — the anonymous user row is deleted by Better Auth on link (§2.7), so a FK there
 * would either block the delete or cascade away a guest's work.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { organizations } from "./schema-auth";

/** Postgres `bytea`, exactly as `schema.ts` defines it (drizzle-orm 0.45 has no built-in pg bytea column). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();
type Json = Record<string, unknown>;

const orgRef = () =>
  text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" });

// ================================================================================================ org metadata

/** SAAS §2.2, §3.3, §5.6, §8.3. One row per organization, created with the org. */
export const orgMeta = pgTable("org_meta", {
  orgId: orgRef(),
  /** guest | personal | team (SAAS §2.2). */
  kind: text("kind", { enum: ["guest", "personal", "team"] }).notNull(),
  /** guest_start | onboarding | switcher | claim | auto_personal. */
  createdVia: text("created_via", {
    enum: ["guest_start", "onboarding", "switcher", "claim", "auto_personal"],
  }).notNull(),
  /** Baton for guest and personal orgs: pinned, never cloned (SAAS §3.3 step 5). */
  pinnedRelayIds: text("pinned_relay_ids")
    .array()
    .notNull()
    .default(sql`'{}'`),
  /** SAAS §5.6: lowercase hostnames this org's `http_action` connectors may call (Pro+). WP16 writes it. */
  connectorHosts: text("connector_hosts")
    .array()
    .notNull()
    .default(sql`'{}'`),
  /** `{templateId, dismissedChecklist}` (SAAS §8.3), plus the §2.6 R1 `claimDeclined` map. */
  onboarding: jsonb("onboarding").$type<Json>().notNull().default({}),
  /** `pickActiveOrg` reads this (SAAS §3.1). */
  lastActiveAt: ts("last_active_at").notNull().defaultNow(),
  createdAt: createdAt(),
});

// ================================================================================================ entitlements

/** SAAS §4.4. One row per organization; WP21 syncs the Polar half. */
export const orgEntitlements = pgTable("org_entitlements", {
  orgId: orgRef(),
  plan: text("plan", { enum: ["guest", "free", "pro", "business"] }).notNull(),
  status: text("status", { enum: ["active", "trialing", "past_due", "canceled", "none"] }).notNull(),
  source: text("source", { enum: ["default", "polar", "simulated", "admin"] }).notNull(),
  /** The Better Auth user id = the Polar customer external id (SAAS §4.3). */
  billingUserId: text("billing_user_id"),
  polarSubscriptionId: text("polar_subscription_id"),
  polarProductId: text("polar_product_id"),
  currentPeriodEnd: ts("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  /** Per-org limit raises (admin only). Never a fork of `PLANS` (SAAS §4.1). */
  overrides: jsonb("overrides").$type<Json>().notNull().default({}),
  /** A trimmed Customer-State snapshot: ids and statuses, never card data (SAAS §4.4). */
  state: jsonb("state").$type<Json>(),
  syncedAt: ts("synced_at"),
  updatedAt: updatedAt(),
});

// ================================================================================================ usage

/** SAAS §4.5. `idempotencyKey` (e.g. `ai_minutes:<takeoverId>`) makes `UsageMeter.record` idempotent. */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    kind: text("kind", {
      enum: ["ai_minutes", "live_run", "dry_run", "voiced_sim", "draft", "publish"],
    }).notNull(),
    quantity: doublePrecision("quantity").notNull(),
    unit: text("unit", { enum: ["minutes", "count"] }).notNull(),
    caseId: text("case_id"),
    relayId: text("relay_id"),
    /** Only `recorded` and `published` minutes draw on the monthly allowance (SAAS §4.5). */
    source: text("source", { enum: ["recorded", "simulated", "text_dry_run", "published", "replay"] }),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    polarIngestedAt: ts("polar_ingested_at"),
    polarError: text("polar_error"),
  },
  (t) => [
    uniqueIndex("usage_events_idempotency_key_unique").on(t.idempotencyKey),
    index("usage_events_org_time_idx").on(t.orgId, t.occurredAt),
    index("usage_events_ingest_idx").on(t.occurredAt).where(sql`${t.polarIngestedAt} is null`),
  ],
);

// ================================================================================================ outbox

/** SAAS §7.1, the transactional outbox. `id` is also the `webhook-id` header (§7.2). */
export const domainEvents = pgTable(
  "domain_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Json>().notNull(),
    /** e.g. `run.completed:<takeoverId>`: emission is idempotent. */
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
    fannedOutAt: ts("fanned_out_at"),
  },
  (t) => [
    uniqueIndex("domain_events_dedupe_key_unique").on(t.dedupeKey),
    index("domain_events_pending_idx").on(t.createdAt).where(sql`${t.fannedOutAt} is null`),
    index("domain_events_org_type_idx").on(t.orgId, t.type, t.createdAt.desc()),
  ],
);

// ================================================================================================ webhooks out

/** SAAS §7.4. The signing secret is sealed with the WP16 key material, like a connector secret. */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    url: text("url").notNull(),
    description: text("description"),
    events: text("events").array().notNull(),
    secretCiphertext: bytea("secret_ciphertext").notNull(),
    secretIv: bytea("secret_iv").notNull(),
    secretTag: bytea("secret_tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    /** "whsec_…9fQ2": the last 4 characters only (SAAS §10.2). */
    secretHint: text("secret_hint").notNull(),
    /** Set when `url` is our own test inbox (SAAS §7.5). */
    inboxId: text("inbox_id"),
    enabled: boolean("enabled").notNull().default(true),
    disabledReason: text("disabled_reason"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdByUserId: text("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    uniqueIndex("webhook_endpoints_inbox_id_unique").on(t.inboxId),
    index("webhook_endpoints_org_idx").on(t.orgId).where(sql`${t.deletedAt} is null`),
  ],
);

/** SAAS §7.3. `UNIQUE (endpoint_id, event_id, manual)` lets a manual redelivery sit beside the automatic one. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    endpointId: text("endpoint_id").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status", {
      enum: ["pending", "succeeded", "failed", "exhausted", "canceled"],
    }).notNull(),
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    lastAttemptAt: ts("last_attempt_at"),
    responseStatus: integer("response_status"),
    responseMs: integer("response_ms"),
    /** ≤ 2 KiB (SAAS §2.7). */
    responseBody: text("response_body"),
    /** timeout | dns | refused_ssrf | tls | http_status | … */
    errorCode: text("error_code"),
    /** "Send test event" / "Send latest" / "Redeliver" (SAAS §7.6). */
    manual: boolean("manual").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("webhook_deliveries_endpoint_event_manual_unique").on(t.endpointId, t.eventId, t.manual),
    index("webhook_deliveries_due_idx").on(t.nextAttemptAt).where(sql`${t.status} in ('pending','failed')`),
    index("webhook_deliveries_endpoint_idx").on(t.endpointId, t.createdAt.desc()),
  ],
);

/** SAAS §7.5, the test receiver. Bodies ≤ 64 KiB, kept 24 h, ≤ 50 per inbox (the purge enforces both). */
export const webhookInboxRequests = pgTable(
  "webhook_inbox_requests",
  {
    id: text("id").primaryKey(),
    inboxId: text("inbox_id").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    headers: jsonb("headers").$type<Json>().notNull(),
    body: text("body").notNull(),
    signatureValid: boolean("signature_valid"),
    eventType: text("event_type"),
  },
  (t) => [index("webhook_inbox_idx").on(t.inboxId, t.receivedAt.desc())],
);

// ================================================================================================ audit

/**
 * SAAS §9. Append-only: `0003_audit_guard` adds the trigger that refuses UPDATE and refuses DELETE unless the
 * retention purge has set `changeover.audit_purge = 'on'` in its own transaction.
 *
 * `metadata` never holds a secret value and never a raw IP (§10.5); `ip_key` is the hashed device key.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    /** Null only for user-level events with no org (SAAS §2.7). No FK: rows outlive the org by 30 days (§3.5). */
    orgId: text("org_id"),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    actorType: text("actor_type", { enum: ["user", "guest", "api_key", "system"] }).notNull(),
    actorId: text("actor_id"),
    /** Frozen at write time ("ada@…", "key cko_…a1b2"), so a rename or a delete never rewrites history. */
    actorLabel: text("actor_label"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Json>().notNull().default({}),
    ipKey: text("ip_key"),
    requestId: text("request_id"),
  },
  (t) => [index("audit_log_org_time_idx").on(t.orgId, t.occurredAt.desc())],
);

export const SAAS_TABLES = [
  orgMeta,
  orgEntitlements,
  usageEvents,
  domainEvents,
  webhookEndpoints,
  webhookDeliveries,
  webhookInboxRequests,
  auditLog,
] as const;
