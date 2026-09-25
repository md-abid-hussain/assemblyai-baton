/**
 * contracts/v3/events.ts - outbound domain events (SAAS §14, §7.1). WP19; frozen at C3, additive afterwards.
 *
 * **Thin events:** ids, statuses and numbers only. No case field values, transcript text, audio URLs or secrets.
 * Consumers fetch the detail from `/api/v1/runs/{id}` and `/api/v1/cases/{id}` with a key. Events are emitted only
 * when `cases.org_id` is set (SAAS §2.6 "events are not back-filled").
 *
 * The payload keys are snake_case: they go on the wire, under the §6.3 public-API conventions.
 */
import { z } from "zod";

import { PaymentStatusSchema } from "../case";
import { TakeoverOutcomeSchema } from "../takeover";

export const DOMAIN_EVENT_TYPES = ["run.completed", "case.verified", "payment.succeeded", "webhook.test"] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];
export const DomainEventTypeSchema = z.enum(DOMAIN_EVENT_TYPES);

/** The `api_version` every envelope carries. Breaking payload changes need a new value; added fields do not. */
export const EVENT_API_VERSION = "2026-09-25" as const;

/** Where a run's minutes came from (the SAAS §4.5 vocabulary). */
export const EventRunSourceSchema = z.enum(["recorded", "simulated", "text_dry_run", "published", "replay"]);

/** Absolute URLs: the run in the app, and the run in the public API. */
export const EventLinksSchema = z.object({ run: z.string(), api: z.string() }).meta({ id: "EventLinks" });

/** A takeover reached a terminal state (WP14b, in the same transaction). */
export const RunCompletedData = z
  .object({
    run_id: z.string(),
    relay_id: z.string().nullable(),
    relay_version: z.number().int().nullable(),
    source: EventRunSourceSchema,
    outcome: TakeoverOutcomeSchema,
    stages_reached: z.array(z.string()),
    ai_seconds: z.number().nonnegative(),
    payment_status: PaymentStatusSchema,
    started_at: z.string(),
    passed_at: z.string().nullable(),
    ended_at: z.string(),
    links: EventLinksSchema,
  })
  .meta({ id: "RunCompletedData" });

/** Async verification finished, non-provisional (WP18, `jobs/verify-takeover.ts`). */
export const CaseVerifiedData = z
  .object({
    run_id: z.string(),
    relay_id: z.string().nullable(),
    qa: z.object({
      re_asked: z.number().int().nonnegative(),
      disclosures: z.array(z.object({ id: z.string(), similarity: z.number(), ok: z.boolean() })),
      verified_from_recording: z.boolean(),
      provisional: z.literal(false),
    }),
    fields_at_pass: z.object({ verified: z.number().int().nonnegative(), required: z.number().int().nonnegative() }),
    links: EventLinksSchema,
  })
  .meta({ id: "CaseVerifiedData" });

/** A payment became verified, fail-closed (WP16, payments). */
export const PaymentSucceededData = z
  .object({
    run_id: z.string(),
    payment_id: z.string(),
    amount: z.number().nonnegative(),
    currency: z.string(),
    provider: z.enum(["polar_sandbox", "simulated"]),
    verified_by: z.enum(["verified_webhook", "verified_poll"]),
    links: EventLinksSchema,
  })
  .meta({ id: "PaymentSucceededData" });

/** "Send test event" from the endpoint page (WP24). */
export const WebhookTestData = z
  .object({ message: z.literal("Hello from Changeover"), endpoint_id: z.string() })
  .meta({ id: "WebhookTestData" });

/** The HTTP body of every delivery. `data` is one of the four payloads above. */
export const EventEnvelope = z
  .object({
    id: z.string(),
    type: DomainEventTypeSchema,
    created_at: z.string(),
    org_id: z.string(),
    api_version: z.literal(EVENT_API_VERSION),
    data: z.unknown(),
  })
  .meta({ id: "EventEnvelope" });

export type RunCompleted = z.infer<typeof RunCompletedData>;
export type CaseVerified = z.infer<typeof CaseVerifiedData>;
export type PaymentSucceeded = z.infer<typeof PaymentSucceededData>;
export type WebhookTest = z.infer<typeof WebhookTestData>;
export type DomainEventEnvelope = z.infer<typeof EventEnvelope>;

/** The payload schema for each event type, so a sender or a test can validate `data` against `type`. */
export const EVENT_DATA_SCHEMAS = {
  "run.completed": RunCompletedData,
  "case.verified": CaseVerifiedData,
  "payment.succeeded": PaymentSucceededData,
  "webhook.test": WebhookTestData,
} as const satisfies Record<DomainEventType, z.ZodType>;
