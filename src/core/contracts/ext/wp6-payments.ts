/**
 * contracts/ext/wp6-payments.ts - additive types for tools, payments and the MockPhone (WP6; TASKS §0.2 "missing
 * types go in ext/"). Nothing here changes a frozen shape: `PaymentViewExtSchema` EXTENDS `PaymentViewSchema`, so a
 * client that parses the #15 body with the frozen schema still works (zod strips the extra keys).
 */
import { z } from "zod";

import { PaymentViewSchema, type ToolResponse } from "../api";
import { StageSchema, type PaymentStatus } from "../case";
import type { PhoneState } from "../services";
import { TranscriptionModeSchema } from "../takeover";
import { VaFunctionToolSchema, type SendEsignAndPayLinkFinalResult, type ToolName } from "../tools";

/**
 * The stage payload the Voice Agent controller needs when a stage change is NOT carried by a tool response: the
 * hold/push protocol's paid → close transition (DESIGN §5.8 step 3 and step 8; request wp5b-to-wp6 item 2).
 * Same fields as the stage part of `ToolResponse`.
 */
export const StagePayloadSchema = z.object({
  stage: StageSchema,
  systemPrompt: z.string(),
  tools: z.array(VaFunctionToolSchema),
  transcriptionMode: TranscriptionModeSchema.optional(),
});
export type StagePayload = z.infer<typeof StagePayloadSchema>;

/**
 * #15 GET /api/payments/[id], as WP6 serves it: the frozen `PaymentView` plus
 * - `stagePayload`: present once `status === "succeeded"` (the server has moved the takeover to `close`);
 * - `label`: plain-words provenance for the phone and the QA card ("Verified by Polar webhook", "Simulated",
 *   "Simulated payment (Polar unavailable)", …);
 * - `esignedAt`: when the e-sign sheet was signed (null before);
 * - `sms`: the SMS text of the pay link (the phone can re-render after a reload).
 */
export const PaymentViewExtSchema = PaymentViewSchema.extend({
  stagePayload: StagePayloadSchema.optional(),
  label: z.string().optional(),
  esignedAt: z.string().nullable().optional(),
  sms: z.string().optional(),
});
export type PaymentViewExt = z.infer<typeof PaymentViewExtSchema>;

/**
 * POST /api/payments/[id]/timeout (WP6, additive to DESIGN §4.4): the hold handler's progress-aware deadline passed.
 * Sets `timeout` from a non-terminal status only; a later verified webhook can still set `succeeded` (§5.12).
 */
export const PaymentTimeoutResponseSchema = z.object({ ok: z.literal(true), status: z.string() });
export type PaymentTimeoutResponse = z.infer<typeof PaymentTimeoutResponseSchema>;

/** Terminal payment statuses (the hold resolves on these). `timeout` is a client/UI terminal, not a Polar one. */
export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = ["succeeded", "failed", "expired"];

/** `callTool()` (WP6, `src/client/tools/call-tool.ts`): route #14 as a function. Satisfies WP5b's `VaToolCaller`. */
export type CallTool = (name: ToolName, args: unknown, ctx: { takeoverId: string; callId: string }) => Promise<ToolResponse>;

/**
 * `awaitPaymentResolution()` (WP6, `src/client/tools/payments.ts`): the hold protocol's wait (DESIGN §5.8 steps
 * 3, 4 and 7) as one promise. Resolves with the server-built final result, or a client-built `timeout`.
 */
export interface AwaitPaymentOptions {
  paymentId: string;
  /** The phone's current state (drives the progress-aware deadline). */
  phoneState: () => PhoneState;
  /** When the SMS was shown (ms on `now()`'s clock). */
  smsAtMs: number;
  now?: () => number;
  signal?: AbortSignal;
  /** Every poll result (the phone and the store mirror it). */
  onView?: (v: PaymentViewExt) => void;
}
export interface PaymentResolution {
  result: SendEsignAndPayLinkFinalResult;
  view: PaymentViewExt | null;
  /** True when the client decided `timeout` (the server was told via POST …/timeout, best-effort). */
  timedOut: boolean;
}
