import "server-only";

import type OpenAI from "openai";

import type { PolicyRecord } from "../../core/contracts/case";
import { VerifierResultSchema, VERIFIER_SUPPORT, type VerifierResult } from "../../core/contracts/extract";
import type { Verifier } from "../../core/contracts/services";
import type { TurnInput } from "../../core/contracts/turns";
import { FIELD_IDS } from "../../core/intents/add-driver.fields";
import { extractStructured, VERIFIER_EFFORT, VERIFIER_MODEL, type OnTrace, type Usage } from "./client";

/**
 * The background `gpt-6-sol` verifier (DESIGN §4.5 F2, §5.4.3; `Verifier`, TASKS §2). It re-reads ALL finals of the
 * case at once and reports, per field, sol's value and its support. It can only DOWNGRADE: WP3 inserts
 * `kind:"verifier"` events for disagreements and the derivation never adopts them (G0 encoding, §5.4.3), so sol
 * can never make a field VERIFIED. Runs are slow (sol/low ≈ 25.9 s for one structured extraction, 10d t02), so the
 * caller never overlaps them and never awaits them on the takeover path.
 */

/** sol list price, $ per 1M tokens (DESIGN §7.1). Reasoning tokens are billed as output. */
export const SOL_USD_PER_M = { input: 2, output: 10 } as const;
export const VERIFY_TIMEOUT_MS = 60_000;
export const VERIFY_MAX_OUTPUT_TOKENS = 6000;

export const VERIFIER_PROMPT_V1 = `You audit an insurance policy-change case from the full transcript of a phone call between an agency REP and a
policyholder CUSTOMER. Intent: add a driver to a personal auto policy. Read ALL turns, then report, for every field
below that the call discusses, its FINAL value and how well the call supports it.

support:
- stated_and_confirmed: one party gave the value and the OTHER party confirmed it (read it back, said yes/correct,
  or stated the same value). A later correction that was confirmed counts; report the corrected value.
- stated_once: the value was given but never confirmed by the other party.
- conflicting: the parties gave incompatible values and the call never settled which one is right.
- absent: the field was not discussed (you may simply omit absent fields).
Never invent values. Use only what the turns say. premium_* and amount_due_today_usd can only come from the REP.

Value formats:
- driver_full_name: the new driver's name as spoken ("Maya Raman").  - driver_dob: YYYY-MM-DD.  - driver_age: integer.
- driver_relation: spouse, domestic_partner, child, stepchild, parent, sibling, other_relative, non_relative_resident,
  non_relative_nonresident.
- license_state: 2-letter US state code.  - license_number: digits/letters only.
- license_status: learner_permit, provisional or full.  - incidents_3y: "none" or a short description.
- vehicle_assignment: the policy vehicle id from POLICY VEHICLES ("veh1").  - operator_type: primary or occasional.
- garaging_zip: 5 digits.  - effective_date: YYYY-MM-DD, relative dates resolved against CALL DATE.
- good_student_discount, driver_training_discount, distant_student_discount, mature_driver_discount: eligible,
  not_eligible or pending_proof.
- coverage_change: short text.  - underwriting_review: "true" or "false".
- premium_new_monthly_usd, premium_change_monthly_usd, amount_due_today_usd: dollars with cents ("142.00", "-12.50").
turn_ids: the turns that carry the value (the statement first, then the confirmation). quote: the shortest verbatim
span of the first cited turn that carries the value.`;

export const VERIFIER_FORMAT = {
  name: "add_driver_audit",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["fields"],
    properties: {
      fields: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["field", "value", "support", "turn_ids", "quote"],
          properties: {
            field: { type: "string", enum: [...FIELD_IDS] },
            value: { type: ["string", "null"] },
            support: { type: "string", enum: [...VERIFIER_SUPPORT] },
            turn_ids: { type: "array", items: { type: "string" } },
            quote: { type: "string" },
          },
        },
      },
    },
  } as Record<string, unknown>,
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function buildVerifierInput(i: { callDate: string; policy: PolicyRecord; turns: readonly TurnInput[] }): string {
  const [y, m, d] = i.callDate.split("-").map(Number) as [number, number, number];
  return JSON.stringify({
    call_date: i.callDate,
    call_weekday: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "",
    policy: {
      policyholder: `${i.policy.policyholder.firstName} ${i.policy.policyholder.lastName}`,
      vehicles: i.policy.vehicles.map((v) => ({ id: v.id, label: v.label })),
      address_zip: i.policy.address.zip,
      existing_drivers: i.policy.existingDrivers.map((x) => x.name),
    },
    turns: [...i.turns]
      .sort((a, b) => a.endMs - b.endMs)
      .map((t) => ({ turn_id: t.turnId, speaker: t.channel === "rep" ? "REP" : "CUSTOMER", text: t.text })),
  });
}

export const usdOfSol = (u: Usage): number => (u.input_tokens * SOL_USD_PER_M.input + u.output_tokens * SOL_USD_PER_M.output) / 1e6;

export interface OpenAIVerifierOptions {
  client: OpenAI | (() => OpenAI);
  model?: string;
  timeoutMs?: number;
  onTrace?: OnTrace;
}

export class OpenAIVerifier implements Verifier {
  private inst: OpenAI | null;
  constructor(private readonly o: OpenAIVerifierOptions) {
    this.inst = typeof o.client === "function" ? null : o.client;
  }

  private client(): OpenAI {
    if (!this.inst) this.inst = (this.o.client as () => OpenAI)();
    return this.inst;
  }

  async verifyCase(input: { caseId: string; policy: PolicyRecord; callDate: string; turns: TurnInput[] }): Promise<VerifierResult & { ms: number; usd: number }> {
    const uptoRecvMs = input.turns.reduce((m, t) => Math.max(m, t.recvMs), 0);
    const r = await extractStructured<{ fields: { field: string; value: string | null; support: string; turn_ids: string[]; quote: string }[] }>(this.client(), {
      model: this.o.model ?? VERIFIER_MODEL,
      instructions: VERIFIER_PROMPT_V1,
      input: buildVerifierInput(input),
      format: VERIFIER_FORMAT,
      reasoningEffort: VERIFIER_EFFORT,
      maxOutputTokens: VERIFY_MAX_OUTPUT_TOKENS,
      store: false,
      request: { timeoutMs: this.o.timeoutMs ?? VERIFY_TIMEOUT_MS, maxRetries: 0 },
      ...(this.o.onTrace ? { onTrace: this.o.onTrace } : {}),
      label: "verify",
    });
    const known = new Set(input.turns.map((t) => t.turnId));
    const parsed = VerifierResultSchema.parse({
      uptoRecvMs,
      fields: (r.data.fields ?? []).map((f) => ({
        field: f.field, value: f.value, support: f.support, turnIds: (f.turn_ids ?? []).filter((id) => known.has(id)), quote: f.quote ?? "",
      })),
    });
    return { ...parsed, ms: r.ms, usd: usdOfSol(r.usage) };
  }
}
