/**
 * contracts/ext/wp18-publish.ts - WP18 additive types for the published gateway (PLATFORM §6.6, §8.3; TASKS-v2 §2
 * rule 3: additive types live in `ext/`, never in the frozen `v2/`). Pure: type-only imports plus one zod schema.
 *
 * Two things the v2 contracts leave open:
 *
 *  1. **`PublishedToolContext`** = `RelayToolContext` plus the org the call executes in. PLATFORM §6.2 ("whose
 *     secrets") and SAAS §10.1 rule 5 both require a published run to execute connectors in the **publication's**
 *     org, never the visitor's, so the gateway resolves it and hands it down. `RelayToolService` implementations
 *     (WP16) read `ctx.workspaceId` when `ctx.mode === "published"` and pass it straight into `ConnectorCtx`.
 *  2. **`PublishedCallRecord`** = what the gateway stores in `connector_calls.result`: the exact body the agent was
 *     given, plus the UI event of the call. The 30 s `(takeoverId, tool, argsHash)` dedupe replays `body` verbatim
 *     (so a retried `payment_link` never creates a second checkout), and the one state route turns the rest into
 *     `PublishedRunEvent`s.
 */
import { z } from "zod";

import type { Stage } from "../case";
import type { RelayToolContext } from "../v2/services";

/** `RelayToolContext` + the publication's org (= the relay owner's `workspace_id`; SAAS S1: `ws ≡ organization.id`). */
export interface PublishedToolContext extends RelayToolContext {
  mode: "published";
  publicationId: string;
  /** The relay owner's workspace/org. Connector secrets and the host policy resolve here (PLATFORM §6.2). */
  workspaceId: string;
  /** Same string as `workspaceId`, under the v3 name, so an org-aware implementation needs no mapping. */
  orgId: string;
}

/** The UI half of a tool call, mirrored to the console timeline and the MockPhone (`PublishedRunEvent.ui`). */
export const PublishedCallUiSchema = z.object({
  sms: z.string().optional(),
  link: z.string().optional(),
  paymentId: z.string().optional(),
  esignId: z.string().optional(),
});

/** `connector_calls.result` for a published run. */
export const PublishedCallRecordSchema = z.object({
  /** The response body the agent received, verbatim (incl. `next_step` when the stage changed). */
  body: z.record(z.string(), z.unknown()),
  stage: z.string().nullable(),
  nextStep: z.string().nullable(),
  ui: PublishedCallUiSchema.nullable(),
});
export type PublishedCallRecord = Omit<z.infer<typeof PublishedCallRecordSchema>, "stage"> & { stage: Stage | null };

/** Gateway statuses that are answers rather than errors: they reach the agent as a normal tool result. */
export const PUBLISHED_SOFT_STATUSES = ["no_active_call", "not_available", "unavailable", "failed"] as const;
export type PublishedSoftStatus = (typeof PUBLISHED_SOFT_STATUSES)[number];

/** How many tool calls one published run may make before the gateway stops answering (a loop guard). */
export const PUBLISHED_MAX_TOOL_CALLS_PER_RUN = 40;

/** The `(takeoverId, tool, argsHash)` dedupe window (PLATFORM §6.3 step 5). */
export const PUBLISHED_DEDUPE_MS = 30_000;
