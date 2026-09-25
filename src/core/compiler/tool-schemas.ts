/**
 * compiler/tool-schemas.ts - the Voice Agent client function tools exactly as DESIGN §5.8 lists them, and the
 * per-stage tool lists (WP1 early deliverable; WP5/WP5b/WP6/WP10 import these).
 *
 * Schema rules (verified `lookup_policy` schema, research 10 §3.5): only `type`, `required`, `properties`, `enum`,
 * `description`, `pattern`, `examples`. No `format`, no `oneOf`/`anyOf`, no `$ref`. `validateFirstUpdate` enforces it.
 */
import type { Stage } from "../contracts/case";
import type { ToolName, VaFunctionTool } from "../contracts/tools";
import { AI_SETTABLE } from "../intents/add-driver.fields";

/** `PAY_TOOL_MODE` (§5.8): `hold` (default) or the `push` fallback if T-D1-1 fails. */
export type PayToolMode = "hold" | "push";

/** The only JSON-schema keywords a tool's `parameters` may use (§5.8). */
export const ALLOWED_SCHEMA_KEYWORDS = ["type", "required", "properties", "enum", "description", "pattern", "examples"] as const;

export const TOOL_SCHEMAS: Readonly<Record<ToolName, VaFunctionTool>> = {
  confirm_effective_date: {
    type: "function",
    name: "confirm_effective_date",
    execution_mode: "interactive",
    timeout_seconds: 10,
    description:
      "Record the date the customer confirmed or chose for this change to take effect. Call only after the customer says the date or clearly confirms it.",
    parameters: {
      type: "object",
      required: ["date", "customer_words"],
      properties: {
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD", examples: ["2026-10-02"] },
        customer_words: { type: "string", description: "The customer's exact words" },
      },
    },
  },
  get_disclosure: {
    type: "function",
    name: "get_disclosure",
    execution_mode: "interactive",
    timeout_seconds: 10,
    description: "Get disclosure text that you must read to the customer word for word.",
    parameters: {
      type: "object",
      required: ["kind"],
      properties: { kind: { type: "string", enum: ["premium_change", "esign_consent"] } },
    },
  },
  send_esign_and_pay_link: {
    type: "function",
    name: "send_esign_and_pay_link",
    execution_mode: "hold",
    timeout_seconds: 120,
    description:
      "Text the customer a secure link to e-sign the change and pay the amount due today. Only after the customer agreed to the premium and to receiving the text. Returns when payment finishes, fails or times out.",
    parameters: {
      type: "object",
      required: ["customer_agreed_to_text", "paper_copy_requested", "customer_words"],
      properties: {
        customer_agreed_to_text: { type: "boolean" },
        paper_copy_requested: { type: "boolean" },
        customer_words: { type: "string", description: "The customer's exact words agreeing" },
      },
    },
  },
  send_confirmation: {
    type: "function",
    name: "send_confirmation",
    execution_mode: "interactive",
    timeout_seconds: 10,
    description: "Finalize the change and text a confirmation. Only after payment is confirmed.",
    parameters: { type: "object", required: [], properties: {} },
  },
  update_case_field: {
    type: "function",
    name: "update_case_field",
    execution_mode: "interactive",
    timeout_seconds: 10,
    description: "Record a field value the customer just confirmed, corrected or newly provided.",
    parameters: {
      type: "object",
      required: ["field", "value", "reason"],
      properties: {
        field: { type: "string", enum: [...AI_SETTABLE] },
        value: {
          type: "string",
          description: "As spoken; date of birth as YYYY-MM-DD; state as 2 letters; ZIP as 5 digits; vehicle as year make model",
        },
        reason: { type: "string", enum: ["customer_confirmed", "customer_corrected", "newly_provided"] },
      },
    },
  },
  hand_back_to_rep: {
    type: "function",
    name: "hand_back_to_rep",
    execution_mode: "interactive",
    timeout_seconds: 10,
    description: "Return the call to the human representative. After calling it, say one short sentence that the rep is coming back.",
    parameters: {
      type: "object",
      required: ["reason", "summary"],
      properties: {
        reason: {
          type: "string",
          enum: ["advice_requested", "customer_request", "conflict", "customer_declined", "out_of_scope", "payment_problem", "other"],
        },
        summary: { type: "string", description: "One sentence for the rep" },
      },
    },
  },
};

/**
 * `send_esign_and_pay_link` in `PAY_TOOL_MODE=push` (§5.8 fallback): interactive, returns `{status:"link_sent"}`
 * immediately; the system later tells the agent that payment is confirmed.
 */
export const PAY_LINK_PUSH_TOOL: VaFunctionTool = {
  ...TOOL_SCHEMAS.send_esign_and_pay_link,
  execution_mode: "interactive",
  timeout_seconds: 30,
  description:
    "Text the customer a secure link to e-sign the change and pay the amount due today. Only after the customer agreed to the premium and to receiving the text. Returns as soon as the link is sent; then wait quietly until the system says payment is confirmed.",
};

/** §5.8 stage lists (always the full list; `update_case_field` and `hand_back_to_rep` are in every stage). */
export const STAGE_TOOL_NAMES: Readonly<Record<Stage, readonly ToolName[]>> = {
  confirm: ["confirm_effective_date", "update_case_field", "hand_back_to_rep"],
  disclose: ["get_disclosure", "confirm_effective_date", "update_case_field", "hand_back_to_rep"],
  pay: ["send_esign_and_pay_link", "get_disclosure", "update_case_field", "hand_back_to_rep"],
  close: ["send_confirmation", "update_case_field", "hand_back_to_rep"],
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** The full tool list for a stage (fresh deep copies; safe to mutate or serialize). */
export function toolsForStage(stage: Stage, opts: { payToolMode?: PayToolMode } = {}): VaFunctionTool[] {
  return STAGE_TOOL_NAMES[stage].map((name) =>
    clone(name === "send_esign_and_pay_link" && opts.payToolMode === "push" ? PAY_LINK_PUSH_TOOL : TOOL_SCHEMAS[name]),
  );
}
