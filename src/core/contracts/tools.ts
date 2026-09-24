/**
 * contracts/tools.ts - Voice Agent client function tools (DESIGN §4.1, §5.8). Frozen at G0.
 *
 * The JSON schemas the Voice Agent sees (TOOL_SCHEMAS) are WP1's (src/core/compiler/tool-schemas.ts). This file
 * holds the names, the wire shape of a tool, the argument types (+ zod for route validation) and the result
 * shapes of §5.8 (loose: handlers may add keys).
 */
import { z } from "zod";
import { AI_SETTABLE } from "../intents/add-driver.fields";
import type { FieldId } from "./case";
import { DisclosureKindSchema, FieldIdSchema, FieldStatusSchema, StageSchema } from "./case";

export const TOOL_NAMES = [
  "confirm_effective_date", "get_disclosure", "send_esign_and_pay_link", "send_confirmation",
  "update_case_field", "hand_back_to_rep",
] as const;
export const ToolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const EXECUTION_MODES = ["interactive", "hold"] as const;
export const ExecutionModeSchema = z.enum(EXECUTION_MODES);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

/** A client function tool exactly as sent in `session.update.tools`. */
export const VaFunctionToolSchema = z.object({
  type: z.literal("function"),
  name: ToolNameSchema,
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  execution_mode: ExecutionModeSchema,
  timeout_seconds: z.number().int().positive(),
});
export type VaFunctionTool = z.infer<typeof VaFunctionToolSchema>;

export const UPDATE_FIELD_REASONS = ["customer_confirmed", "customer_corrected", "newly_provided"] as const;
export const HAND_BACK_REASONS = [
  "advice_requested", "customer_request", "conflict", "customer_declined", "out_of_scope", "payment_problem", "other",
] as const;
export type HandBackReason = (typeof HAND_BACK_REASONS)[number];

/** Tool arguments by name (DESIGN §4.1, verbatim). */
export interface ToolArgs {
  confirm_effective_date: { date: string; customer_words: string };
  get_disclosure: { kind: "premium_change" | "esign_consent" };
  send_esign_and_pay_link: { customer_agreed_to_text: boolean; paper_copy_requested: boolean; customer_words: string };
  send_confirmation: Record<string, never>;
  update_case_field: { field: FieldId; value: string; reason: "customer_confirmed" | "customer_corrected" | "newly_provided" };
  hand_back_to_rep: {
    reason: "advice_requested" | "customer_request" | "conflict" | "customer_declined" | "out_of_scope" | "payment_problem" | "other";
    summary: string;
  };
}

/**
 * Route-side validation of `ToolRequest.args` (POST /api/tools/[name]). Deliberately lenient where the model may
 * be sloppy: `date` is not pattern-checked (the server resolves `customer_words` itself, §5.8) and unknown keys are
 * stripped. `update_case_field.field` is restricted to AI_SETTABLE (the tool's enum). `hand_back_to_rep` never fails
 * (G0): a bad `reason` becomes "other" and a missing `summary` becomes "", because a hand-back must always work.
 */
export const ToolArgsSchemas = {
  confirm_effective_date: z.object({ date: z.string(), customer_words: z.string() }),
  get_disclosure: z.object({ kind: DisclosureKindSchema }),
  send_esign_and_pay_link: z.object({
    customer_agreed_to_text: z.boolean(),
    paper_copy_requested: z.boolean(),
    customer_words: z.string(),
  }),
  send_confirmation: z.object({}).transform((): Record<string, never> => ({})),
  update_case_field: z.object({
    field: z.enum(AI_SETTABLE),
    value: z.string(),
    reason: z.enum(UPDATE_FIELD_REASONS),
  }),
  hand_back_to_rep: z
    .object({ reason: z.enum(HAND_BACK_REASONS).catch("other"), summary: z.string().catch("") })
    .catch({ reason: "other", summary: "" }),
} satisfies { [K in ToolName]: z.ZodType<ToolArgs[K], unknown> };

/** Parse the args of a named tool (throws a ZodError on invalid input). */
export function parseToolArgs<N extends ToolName>(name: N, args: unknown): ToolArgs[N] {
  return (ToolArgsSchemas[name] as unknown as z.ZodType<ToolArgs[N], unknown>).parse(args);
}

// ------------------------------------------------------------------------------------------ results (§5.8)

export const ConfirmEffectiveDateResultSchema = z.union([
  z.object({ accepted: z.literal(true), effective_date: z.string(), spoken: z.string(), next: StageSchema.nullable().optional() }).loose(),
  z.object({ accepted: z.literal(false), reason: z.string(), allowed: z.string().optional() }).loose(),
]);
export const UpdateCaseFieldResultSchema = z.union([
  z.object({ result: z.literal("accepted"), field: FieldIdSchema, status: FieldStatusSchema, value: z.string() }).loose(),
  z.object({ result: z.literal("conflict"), field: FieldIdSchema, recorded_value: z.string(), instruction: z.string() }).loose(),
  z.object({ result: z.literal("rejected"), reason: z.string() }).loose(),
]);
export const GetDisclosureResultSchema = z.union([
  z.object({ ok: z.literal(true), disclosure_id: z.string(), text: z.string(), instruction: z.string() }).loose(),
  z.object({ ok: z.literal(false), missing: z.array(z.string()).optional(), reason: z.string().optional() }).loose(),
]);
const PayLinkPaidSchema = z.object({
  status: z.literal("paid"),
  /** Polar's total_amount, formatted ("$23.40"); never a local number. */
  amount: z.string(),
  receipt: z.string(),
  verified_by: z.enum(["polar_webhook", "polar_poll", "simulated"]),
}).loose();
const PayLinkUnpaidSchema = z.object({ status: z.enum(["failed", "expired", "timeout"]), instruction: z.string() }).loose();

/**
 * The terminal `tool.result` of the hold protocol (§5.8). The SERVER builds it (G0): `PaymentView.toolResult`
 * carries it once the payment is terminal, so the amount is Polar's `total_amount` formatted server-side and the
 * receipt is the server's. Only `timeout` is decided by the client (its hold deadline).
 */
export const SendEsignAndPayLinkFinalResultSchema = z.union([PayLinkPaidSchema, PayLinkUnpaidSchema]);
export type SendEsignAndPayLinkFinalResult = z.infer<typeof SendEsignAndPayLinkFinalResultSchema>;

export const SendEsignAndPayLinkResultSchema = z.union([
  z.object({ status: z.literal("not_sent"), reason: z.string() }).loose(),
  /** Push mode (PAY_TOOL_MODE=push), or the route's immediate answer before the browser handler holds. */
  z.object({ status: z.literal("link_sent") }).loose(),
  PayLinkPaidSchema,
  PayLinkUnpaidSchema,
]);
export const SendConfirmationResultSchema = z.union([
  z.object({ ok: z.literal(true), confirmation_number: z.string(), spoken: z.string(), sms_sent: z.boolean() }).loose(),
  z.object({ ok: z.literal(false), reason: z.string() }).loose(),
]);
export const HandBackToRepResultSchema = z.object({ status: z.literal("transferring"), message: z.string() }).loose();

export const ToolResultSchemas = {
  confirm_effective_date: ConfirmEffectiveDateResultSchema,
  get_disclosure: GetDisclosureResultSchema,
  send_esign_and_pay_link: SendEsignAndPayLinkResultSchema,
  send_confirmation: SendConfirmationResultSchema,
  update_case_field: UpdateCaseFieldResultSchema,
  hand_back_to_rep: HandBackToRepResultSchema,
} as const satisfies { [K in ToolName]: z.ZodType };

export type ToolResults = { [K in ToolName]: z.infer<(typeof ToolResultSchemas)[K]> };

/**
 * G0: the `result` route #14 returns with HTTP 200 when the model's arguments fail `ToolArgsSchemas` (§5.8
 * "rejected"). A 4xx would make the browser send an is_error result instead of an answer the agent can act on.
 * (`hand_back_to_rep` args never fail, see ToolArgsSchemas.)
 */
export const INVALID_ARGS_RESULTS = {
  confirm_effective_date: { accepted: false, reason: "invalid_args" },
  get_disclosure: { ok: false, reason: "invalid_args" },
  send_esign_and_pay_link: { status: "not_sent", reason: "invalid_args" },
  send_confirmation: { ok: false, reason: "invalid_args" },
  update_case_field: { result: "rejected", reason: "invalid_args" },
} as const satisfies { [K in Exclude<ToolName, "hand_back_to_rep">]: ToolResults[K] };

/** Non-throwing parse for route #14: either the typed args, or the 200 `result` to answer with. */
export function safeParseToolArgs<N extends ToolName>(
  name: N,
  args: unknown,
): { ok: true; args: ToolArgs[N] } | { ok: false; result: Record<string, unknown>; issues: string[] } {
  const r = (ToolArgsSchemas[name] as unknown as z.ZodType<ToolArgs[N], unknown>).safeParse(args);
  if (r.success) return { ok: true, args: r.data };
  const result = (INVALID_ARGS_RESULTS as Partial<Record<ToolName, Record<string, unknown>>>)[name] ?? { ok: false, reason: "invalid_args" };
  return { ok: false, result: { ...result }, issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}
