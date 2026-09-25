/**
 * Data model (DESIGN §4.2). One initial migration (drizzle/0000_*.sql); later changes are ADDITIVE ONLY.
 *
 * Conventions: timestamps are `timestamptz` defaulting to now(); ids are `text` (nanoid, 21 chars) unless noted;
 * JSON columns are `jsonb`. Enum-like columns are `text` narrowed in TypeScript (no Postgres enums, so later
 * additive changes never need `ALTER TYPE`).
 *
 * NOTE: this file deliberately does NOT `import "server-only"`: drizzle-kit loads it outside Next.
 * It holds only table definitions; the boundaries test keeps client code from importing `src/server/**`.
 * JSON column types are left as `unknown`/records here; repositories cast to the `src/core/contracts` types.
 *
 * G0: every call-clock or measured millisecond value (`*_ms` that comes from `callMs`, word times or a timer) and
 * `billed_seconds` is `double precision`, not int: callMs at 8 kHz is fractional (0.125 ms steps) and VA
 * `session_duration_seconds` is a float, and Postgres rejects "12345.625" for an int column (22P02). Configured
 * caps (`cap_ms`, `va_session_cap_ms`) and counters stay int.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();
type Json = Record<string, unknown>;

// =============================================================================================
// Case tables
// =============================================================================================

export const cases = pgTable(
  "cases",
  {
    id: text("id").primaryKey(),
    mode: text("mode", { enum: ["watch", "live", "spot", "synthetic"] }).notNull(),
    callId: text("call_id"),
    scenarioId: text("scenario_id").notNull(),
    intent: text("intent", { enum: ["add_driver"] }).notNull().default("add_driver"),
    policy: jsonb("policy").$type<Json>().notNull(),
    /** Latest derived `CaseState` (a denormalized cache of the fact events). */
    state: jsonb("state").$type<Json>().notNull(),
    /** Optimistic version of `state` (F1 step 4: saved with version+1 under the case advisory lock). */
    version: integer("version").notNull().default(0),
    status: text("status", {
      enum: ["shadowing", "armed", "ai_active", "completed", "handed_back", "abandoned", "failed"],
    })
      .notNull()
      .default("shadowing"),
    visitorId: text("visitor_id").notNull(),
    ipKey: text("ip_key").notNull(),
    tArmMs: doublePrecision("t_arm_ms"),
    /** `RunPlan` (D14). */
    runPlan: jsonb("run_plan").$type<Json>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** 0001 (PLATFORM §2.4): the relay version this run executes; null = the legacy Baton path. */
    relayVersionId: text("relay_version_id"),
    /** 0001: the simulated call (`sim_calls.id`) this run plays, if any. */
    simCallId: text("sim_call_id"),
  },
  (t) => [
    index("cases_visitor_created_idx").on(t.visitorId, t.createdAt),
    index("cases_created_idx").on(t.createdAt),
    index("cases_relay_version_idx").on(t.relayVersionId, t.createdAt),
  ],
);

export const turns = pgTable(
  "turns",
  {
    /** `${caseId}:${turnId}` */
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    source: text("source").notNull(),
    text: text("text").notNull(),
    startMs: doublePrecision("start_ms").notNull(),
    endMs: doublePrecision("end_ms").notNull(),
    recvMs: doublePrecision("recv_ms").notNull(),
    words: jsonb("words").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    cut: boolean("cut").notNull().default(false),
    late: boolean("late").notNull().default(false),
    extractStatus: text("extract_status", { enum: ["pending", "done", "failed", "skipped"] })
      .notNull()
      .default("pending"),
    extractMs: doublePrecision("extract_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("turns_case_recv_idx").on(t.caseId, t.recvMs)],
);

export const factEvents = pgTable(
  "fact_events",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    turnId: text("turn_id"),
    /**
     * G0: `FactEvent.turnEndMs`, the derivation ordering key `(turn_end_ms, seq)`. Always the call clock: the turn's
     * endMs; tool_update = t_arm_ms + ms since armed_at; verifier = uptoRecvMs; policy = 0 (contracts/case.ts).
     * No default on purpose: a writer that forgets it must fail, not sort the event to the start of the call.
     */
    turnEndMs: doublePrecision("turn_end_ms").notNull(),
    /** Per case, monotonic. */
    seq: integer("seq").notNull(),
    field: text("field").notNull(),
    /** `FactKind` (incl. "verifier", G0). */
    kind: text("kind").notNull(),
    party: text("party").notNull(),
    valueRaw: text("value_raw"),
    valueNorm: text("value_norm"),
    acknowledgesTurnId: text("acknowledges_turn_id"),
    /** high | medium | low (required by FactEventSchema, G0). */
    confidence: text("confidence", { enum: ["high", "medium", "low"] }).notNull(),
    late: boolean("late").notNull().default(false),
    cut: boolean("cut").notNull().default(false),
    evidence: jsonb("evidence").$type<Json>(),
    extractor: text("extractor").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("fact_events_case_seq_uq").on(t.caseId, t.seq)],
);

export const verifierRuns = pgTable(
  "verifier_runs",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    uptoTurnRecvMs: doublePrecision("upto_turn_recv_ms").notNull(),
    /** `VerifierResult` */
    result: jsonb("result").$type<Json>().notNull(),
    disagreements: jsonb("disagreements").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    ms: doublePrecision("ms").notNull(),
    usd: numeric("usd", { precision: 10, scale: 5, mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("verifier_runs_case_created_idx").on(t.caseId, t.createdAt)],
);

// =============================================================================================
// Takeover and payment tables
// =============================================================================================

export const takeovers = pgTable(
  "takeovers",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    armedAt: ts("armed_at").notNull().defaultNow(),
    tArmMs: doublePrecision("t_arm_ms").notNull(),
    midUtterance: boolean("mid_utterance").notNull().default(false),
    /** `TakeoverPhase` */
    phase: text("phase").notNull().default("armed"),
    /** Per-phase timings. */
    protocol: jsonb("protocol").$type<Json>().notNull().default(sql`'{}'::jsonb`),
    /** Frozen `CaseState` (immutable once set). */
    snapshot: jsonb("snapshot").$type<Json>(),
    greeting: text("greeting"),
    systemPromptHash: text("system_prompt_hash"),
    promptVersion: text("prompt_version"),
    /** `Stage` */
    stage: text("stage"),
    vaSessionId: text("va_session_id"),
    /** 0 or 1; the VA mint checks it (§4.4 #10). */
    retries: integer("retries").notNull().default(0),
    lastFailureAt: ts("last_failure_at"),
    vaSessionCapMs: integer("va_session_cap_ms"),
    outcome: text("outcome", { enum: ["completed", "handed_back", "abandoned", "failed"] }),
    /** HUD numbers, provisional QA. */
    metrics: jsonb("metrics").$type<Json>().notNull().default(sql`'{}'::jsonb`),
    endedAt: ts("ended_at"),
  },
  (t) => [index("takeovers_case_idx").on(t.caseId), index("takeovers_va_session_idx").on(t.vaSessionId)],
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    takeoverId: text("takeover_id")
      .notNull()
      .references(() => takeovers.id, { onDelete: "cascade" }),
    /** Voice Agent `call_id`. */
    callId: text("call_id").notNull(),
    name: text("name").notNull(),
    args: jsonb("args").$type<Json>().notNull().default(sql`'{}'::jsonb`),
    result: jsonb("result").$type<Json>(),
    status: text("status", { enum: ["ok", "error", "rejected"] }),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("tool_calls_takeover_idx").on(t.takeoverId), uniqueIndex("tool_calls_takeover_call_uq").on(t.takeoverId, t.callId)],
);

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    takeoverId: text("takeover_id")
      .notNull()
      .references(() => takeovers.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["polar", "mock"] }).notNull(),
    checkoutId: text("checkout_id"),
    checkoutUrl: text("checkout_url"),
    /** What the disclosure said. */
    amountCents: integer("amount_cents").notNull(),
    /** Polar's own figures. */
    totalAmountCents: integer("total_amount_cents"),
    taxAmountCents: integer("tax_amount_cents"),
    simulated: boolean("simulated").notNull().default(false),
    /** `PaymentStatus` */
    status: text("status").notNull().default("none"),
    statusSource: text("status_source", { enum: ["webhook", "server_poll", "mock"] }),
    /** `amount_mismatch` | `polar_failed` | … */
    failureReason: text("failure_reason"),
    esignConsentAt: ts("esign_consent_at"),
    esignName: text("esign_name"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("payments_checkout_uq").on(t.checkoutId)],
);

export const webhookEvents = pgTable("webhook_events", {
  /** `polar:<webhook-id>` or `aai:<transcript_id>:<status>` */
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  type: text("type").notNull(),
  /** Redacted. */
  payload: jsonb("payload").$type<Json>(),
  receivedAt: ts("received_at").notNull().defaultNow(),
  processedAt: ts("processed_at"),
  error: text("error"),
});

export const verifications = pgTable("verifications", {
  takeoverId: text("takeover_id")
    .primaryKey()
    .references(() => takeovers.id, { onDelete: "cascade" }),
  aaiTranscriptId: text("aai_transcript_id"),
  status: text("status", { enum: ["pending", "completed", "failed"] })
    .notNull()
    .default("pending"),
  /** Non-provisional `QaResult`. */
  qa: jsonb("qa").$type<Json>(),
  completedAt: ts("completed_at"),
});

// =============================================================================================
// Background and platform tables
// =============================================================================================

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    /** `JobKind` (TASKS §2): verify_takeover | purge | va_audit | budget_guard */
    kind: text("kind", { enum: ["verify_takeover", "purge", "va_audit", "budget_guard"] }).notNull(),
    refId: text("ref_id").notNull(),
    /** Step machine state. */
    state: jsonb("state").$type<unknown>(),
    status: text("status", { enum: ["pending", "running", "done", "failed"] })
      .notNull()
      .default("pending"),
    runAfter: ts("run_after").notNull().defaultNow(),
    leaseUntil: ts("lease_until"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("jobs_status_run_after_idx").on(t.status, t.runAfter)],
);

export const spendLedger = pgTable(
  "spend_ledger",
  {
    id: text("id").primaryKey(),
    /** UTC day. */
    day: date("day", { mode: "string" })
      .notNull()
      .default(sql`(now() at time zone 'utc')::date`),
    provider: text("provider", { enum: ["aai_stt", "aai_va", "aai_async", "openai", "polar"] }).notNull(),
    action: text("action").notNull(),
    refId: text("ref_id").notNull(),
    /** `BATON_DEPLOY_ID` of the spender. */
    env: text("env").notNull(),
    estUsd: numeric("est_usd", { precision: 10, scale: 5, mode: "number" }).notNull(),
    actualUsd: numeric("actual_usd", { precision: 10, scale: 5, mode: "number" }),
    status: text("status", { enum: ["reserved", "settled", "released"] })
      .notNull()
      .default("reserved"),
    createdAt: createdAt(),
    settledAt: ts("settled_at"),
  },
  (t) => [index("spend_ledger_day_provider_idx").on(t.day, t.provider), index("spend_ledger_ref_idx").on(t.refId)],
);

export const rateEvents = pgTable(
  "rate_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    cost: integer("cost").notNull().default(1),
    ts: ts("ts").notNull().defaultNow(),
  },
  (t) => [index("rate_events_bucket_key_ts_idx").on(t.bucket, t.key, t.ts)],
);

export const streamQueue = pgTable(
  "stream_queue",
  {
    ticket: text("ticket").primaryKey(),
    visitorId: text("visitor_id").notNull(),
    /** Added so the broker can enforce "≤2 open tickets per ipKey" (DESIGN §2.3). */
    ipKey: text("ip_key"),
    n: integer("n").notNull(),
    status: text("status", { enum: ["queued", "granted", "expired", "cancelled"] })
      .notNull()
      .default("queued"),
    createdAt: createdAt(),
    grantedAt: ts("granted_at"),
    lastPollAt: ts("last_poll_at").notNull().defaultNow(),
  },
  (t) => [index("stream_queue_status_created_idx").on(t.status, t.createdAt)],
);

export const liveSessions = pgTable(
  "live_sessions",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["stt", "va"] }).notNull(),
    /** Null for script/synthetic opens without a case. */
    caseId: text("case_id"),
    visitorId: text("visitor_id"),
    ledgerId: text("ledger_id"),
    providerSessionId: text("provider_session_id"),
    openedAt: ts("opened_at"),
    closedAt: ts("closed_at"),
    billedSeconds: doublePrecision("billed_seconds"),
    capMs: integer("cap_ms").notNull(),
    runId: text("run_id"),
    deployId: text("deploy_id").notNull(),
    /** `OpenSource` of the opener (judge | script | synthetic | test | mirror). */
    source: text("source"),
    holdExpiresAt: ts("hold_expires_at"),
    lastHeartbeatAt: ts("last_heartbeat_at"),
    status: text("status", { enum: ["held", "open", "closed", "stale", "released"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("live_sessions_kind_status_idx").on(t.kind, t.status)],
);

export const appFlags = pgTable("app_flags", {
  /** `mode` | `notice` | `payments_mode_override` | `aai_balance_usd` */
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>(),
  reason: text("reason"),
  updatedAt: updatedAt(),
});

export const promotedAgents = pgTable(
  "promoted_agents",
  {
    /** AssemblyAI `agent_…` id. */
    id: text("id").primaryKey(),
    intent: text("intent").notNull(),
    configHash: text("config_hash").notNull(),
    /** Headers stripped. */
    config: jsonb("config").$type<Json>().notNull(),
    evidence: jsonb("evidence").$type<Json>(),
    createdAt: createdAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("promoted_agents_intent_deleted_idx").on(t.intent, t.deletedAt)],
);

export const healthChecks = pgTable(
  "health_checks",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["light", "full"] }).notNull(),
    ok: boolean("ok").notNull(),
    /** Per-probe `{ok, ms, code}`. */
    details: jsonb("details").$type<Json>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("health_checks_created_idx").on(t.createdAt)],
);

// =============================================================================================
// Relay platform tables: migration drizzle/0001_relays.sql (PLATFORM §2.4 v2.1; additive only; WP14b)
// =============================================================================================

/** Postgres `bytea` (drizzle-orm 0.45 has no built-in pg bytea column). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** One row per relay. `draft` is the autosaved blueprint (always a `BlueprintSchema`-valid JSON). */
export const relays = pgTable(
  "relays",
  {
    /** `rl_<nanoid>` */
    id: text("id").primaryKey(),
    /** `ws_<visitorId>` or `ws_gallery`. */
    workspaceId: text("workspace_id").notNull(),
    slug: text("slug").notNull().unique("relays_slug_unique"),
    title: text("title").notNull(),
    status: text("status", { enum: ["draft", "published", "archived"] }).notNull().default("draft"),
    visibility: text("visibility", { enum: ["private", "unlisted", "gallery"] }).notNull().default("private"),
    flagship: boolean("flagship").notNull().default(false),
    draft: jsonb("draft").$type<Json>().notNull(),
    /** Optimistic revision of `draft` (saveDraft with a stale expectedRev → 409). */
    draftRev: integer("draft_rev").notNull().default(0),
    /** `LintIssue[]` of the draft. */
    lint: jsonb("lint").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    currentVersionId: text("current_version_id"),
    origin: text("origin", { enum: ["seed", "user", "draft", "clone"] }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Any read/save/run; drives the LRU eviction (PLATFORM §10.2). */
    lastUsedAt: ts("last_used_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    index("relays_ws_updated_idx").on(t.workspaceId, t.updatedAt),
    index("relays_lru_idx").on(t.lastUsedAt).where(sql`deleted_at IS NULL AND visibility <> 'gallery'`),
  ],
);

/** Immutable, content-addressed versions. A run always points at a version, never at a draft. */
export const relayVersions = pgTable(
  "relay_versions",
  {
    /** `rv_<nanoid>` */
    id: text("id").primaryKey(),
    relayId: text("relay_id")
      .notNull()
      .references(() => relays.id),
    version: integer("version").notNull(),
    blueprint: jsonb("blueprint").$type<Json>().notNull(),
    /** `sha256(canonicalJson(blueprint))`, hex. */
    blueprintHash: text("blueprint_hash").notNull(),
    kernelVersion: text("kernel_version").notNull(),
    /** `{flagged, categories, checkedAt}`: OpenAI moderation, once per version (PLATFORM §7.4). */
    moderation: jsonb("moderation").$type<Json>(),
    /**
     * WP14b addition to P§2.4: `{id, label, baseVersionId}` when this version is a seeded "Try an edit" preset of a
     * gallery relay (PLATFORM §7.5.3), else null. Presets never become `relays.current_version_id`.
     */
    preset: jsonb("preset").$type<Json>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("relay_versions_relay_version_uq").on(t.relayId, t.version),
    uniqueIndex("relay_versions_relay_hash_uq").on(t.relayId, t.blueprintHash),
  ],
);

/** WP18: one live publication per relay (stored AssemblyAI agent + share link). */
export const relayPublications = pgTable("relay_publications", {
  /** `pub_<nanoid>` */
  id: text("id").primaryKey(),
  relayId: text("relay_id").notNull(),
  versionId: text("version_id").notNull(),
  aaiAgentId: text("aai_agent_id"),
  shareSlug: text("share_slug").notNull().unique("relay_publications_share_slug_unique"),
  /** sha256 of the X-Changeover-Key header value. */
  keyHash: text("key_hash").notNull(),
  status: text("status", { enum: ["creating", "live", "deleting", "deleted", "failed"] }).notNull(),
  /** Gallery publications never expire. */
  pinned: boolean("pinned").notNull().default(false),
  /** One live session per publication (PLATFORM §8.3). */
  activeRunId: text("active_run_id"),
  activeUntil: ts("active_until"),
  lastUsedAt: ts("last_used_at"),
  createdAt: createdAt(),
  deletedAt: ts("deleted_at"),
});

/** WP16: AES-GCM encrypted connector secrets (never serialized). */
export const connectorSecrets = pgTable(
  "connector_secrets",
  {
    /** `sec_<16 lower alnum>` */
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    tag: bytea("tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    createdAt: createdAt(),
    /** 7 days for visitor workspaces. */
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [uniqueIndex("connector_secrets_ws_name_uq").on(t.workspaceId, t.name)],
);

/** WP16/WP18: every connector execution (analytics, gateway dedupe). */
export const connectorCalls = pgTable(
  "connector_calls",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id"),
    takeoverId: text("takeover_id"),
    relayVersionId: text("relay_version_id"),
    publicationId: text("publication_id"),
    connectorId: text("connector_id").notNull(),
    toolName: text("tool_name").notNull(),
    mode: text("mode", { enum: ["test", "live", "published", "console"] }).notNull(),
    status: text("status", { enum: ["ok", "error", "blocked", "timeout", "refused"] }).notNull(),
    httpStatus: integer("http_status"),
    ms: integer("ms").notNull(),
    reqBytes: integer("req_bytes").notNull().default(0),
    resBytes: integer("res_bytes").notNull().default(0),
    /** Gateway dedupe (PLATFORM §6.6): the same (takeover, tool, args) within 30 s returns `result`. */
    argsHash: text("args_hash"),
    result: jsonb("result").$type<Json>(),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (t) => [
    index("connector_calls_version_idx").on(t.relayVersionId, t.createdAt),
    index("connector_calls_dedupe_idx").on(t.takeoverId, t.toolName, t.argsHash, t.createdAt),
  ],
);

/** WP17: simulated calls (audio, or a text dry run with no audio columns). */
export const simCalls = pgTable("sim_calls", {
  /** `sim_<first 16 hex of the content hash>` */
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["audio", "text_dry_run"] }).notNull().default("audio"),
  relayVersionId: text("relay_version_id").notNull(),
  sampleIndex: integer("sample_index").notNull(),
  script: jsonb("script").$type<Json>().notNull(),
  /** Audio only: raw 8 kHz mu-law, one channel each. */
  rep: bytea("rep"),
  customer: bytea("customer"),
  peaks: jsonb("peaks").$type<unknown>(),
  durationMs: integer("duration_ms").notNull(),
  handoff: jsonb("handoff").$type<Json>().notNull(),
  aiClips: jsonb("ai_clips").$type<Json>().notNull().default(sql`'{}'::jsonb`),
  usd: doublePrecision("usd").notNull(),
  gallery: boolean("gallery").notNull().default(false),
  createdAt: createdAt(),
  lastUsedAt: ts("last_used_at").notNull().defaultNow(),
});

/** WP17: TTS clips keyed by `sha256(model|voice|instructions|text)`. */
export const ttsCache = pgTable("tts_cache", {
  hash: text("hash").primaryKey(),
  model: text("model").notNull(),
  voice: text("voice").notNull(),
  text: text("text").notNull(),
  pcm24k: bytea("pcm24k").notNull(),
  durationMs: integer("duration_ms").notNull(),
  createdAt: createdAt(),
});

/** WP17: "Describe your desk" drafts (async, PLATFORM §7.4). */
export const drafts = pgTable("drafts", {
  /** `drf_<nanoid>` */
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  input: jsonb("input").$type<Json>().notNull(),
  output: jsonb("output").$type<Json>(),
  lint: jsonb("lint").$type<unknown[]>(),
  repairs: integer("repairs").notNull().default(0),
  usd: doublePrecision("usd").notNull().default(0),
  status: text("status", { enum: ["queued", "running", "ok", "invalid", "failed"] }).notNull(),
  relayId: text("relay_id"),
  createdAt: createdAt(),
});

/** Tables of migration 0001 (PLATFORM §2.4), in dependency order. */
export const RELAY_TABLES = [
  "relays",
  "relay_versions",
  "relay_publications",
  "connector_secrets",
  "connector_calls",
  "sim_calls",
  "tts_cache",
  "drafts",
] as const;

/**
 * The tables of the initial migration 0000_init, in dependency order (used by the migration test and `/api/health`
 * diagnostics). The 0001 tables are `RELAY_TABLES`; `EVERY_TABLE` is both.
 */
export const ALL_TABLES = [
  "cases",
  "turns",
  "fact_events",
  "verifier_runs",
  "takeovers",
  "tool_calls",
  "payments",
  "webhook_events",
  "verifications",
  "jobs",
  "spend_ledger",
  "rate_events",
  "stream_queue",
  "live_sessions",
  "app_flags",
  "promoted_agents",
  "health_checks",
] as const;

/** Every table of every migration (0000 + 0001). */
export const EVERY_TABLE = [...ALL_TABLES, ...RELAY_TABLES] as const;
