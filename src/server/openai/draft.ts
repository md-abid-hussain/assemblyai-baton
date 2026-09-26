/**
 * server/openai/draft.ts - the "Describe your desk" call (PLATFORM §7.4 step 2 and step 4's repair; WP17·3).
 *
 * `gpt-6-luna`, effort "low", strict `json_schema` named `draft_blueprint`. One call writes the judgment half of a
 * blueprint from four form answers; `expandDraft` (core) fills the rest; if the result fails `BlueprintSchema` or
 * `lintBlueprint`, the SAME call runs again with its own output and the issue list - at most two repair rounds.
 *
 * `max_output_tokens` is **8000**: reasoning tokens count against it, the target is ≈ 1.5k visible tokens, and the
 * worst case is still under $0.005 at luna prices. An `incomplete` response (`IncompleteError`) is a REPAIR ROUND,
 * not a failure: it was generated and billed, so its reservation is settled and the next round is told to be shorter.
 *
 * Spend: one ledger reservation per attempt (provider `openai`, action `draft`), settled from the response's usage.
 * A refused reservation throws `E_BUDGET` before any request is made. The caller owns quotas; this file owns cost.
 */
import "server-only";

import type OpenAI from "openai";

import { BatonError } from "../../core/contracts/errors";
import type { SpendLedger } from "../../core/contracts/services";
import type { DeskInput, LintIssue } from "../../core/contracts/v2";
import { DraftBlueprintSchema, draftBlueprintFormat, type DraftBlueprint } from "../../core/relay/draft/schema";
import { log } from "../log";
import { extractStructured, IncompleteError, MODELS, type OnTrace, type ReasoningEffort } from "./client";
import { usdOfUsage } from "./extractor";

const draftLog = log.child({ component: "draft-llm" });

export const DRAFT_MODEL = MODELS.fast;
export const DRAFT_EFFORT: ReasoningEffort = "low";
/** PLATFORM §7.4 step 2, exact: reasoning tokens count against it. */
export const DRAFT_MAX_OUTPUT_TOKENS = 8000;
export const DRAFT_TIMEOUT_MS = 90_000;
/** The reservation per attempt. The real cost is ≈ $0.002; it is settled from usage. */
export const DRAFT_EST_USD = 0.02;
/** §7.4 step 4: "repair, at most 2 rounds". An `incomplete` response spends one of them. */
export const DRAFT_MAX_REPAIRS = 2;

export class DraftUnusableError extends Error {
  constructor(readonly issues: readonly string[], readonly attempts: number) {
    super(`the drafted relay is not usable: ${issues.join("; ")}`);
    this.name = "DraftUnusableError";
  }
}

// ============================================================================================ the prompt

const AI_FINISH_TEXT: Record<string, string> = {
  confirm_details: "confirm the details the rep already took",
  read_disclosure: "read something to the customer word for word and get a yes",
  take_payment: "take a payment or a deposit through a link",
  esign: "get a document signed",
  send_confirmation: "send a confirmation message at the end",
  lookup: "look something up for the customer",
};

export const DRAFT_INSTRUCTIONS = `You turn a short description of a service desk into the configuration for a RELAY: a phone call that a human representative starts and an AI assistant finishes after a handover.

Write the parts that need judgment. Everything mechanical - normalizers, phrasing, prompts, keyterms, the second sample account - is filled in for you afterwards, so do not try to produce them.

Rules:
1. EVERYTHING IS FICTIONAL. Invent the business name, the people and the sample values. Never name a real company, brand, bank, insurer or product, not even as an example.
2. Never create a field for a card number, CVV, bank or routing number, national ID or password. A payment is taken with a payment link, never spoken on the call.
3. Fields are what a case card holds: 4 to 9 of them is usually right. Mark a field required when the case is not finished without it. Use setBy "rep_only" for anything only the business may decide, "ai_allowed" for what the assistant may finish, "rep_or_customer" for what either person states but the assistant must not write. At least one REQUIRED field must be "ai_allowed": that is what the assistant is handed the call to finish.
4. Set adviceDomain true only for a judgment the business makes (a price, an eligibility, a recommendation). Such a field is never ai_allowed.
5. Stages run confirm, then disclose, then act, then close, each at most once, and the last stage is always close. Only add a disclose stage when something genuinely must be read word for word, and an act stage only when there is a payment or a signature.
6. A disclosure's text is what the assistant reads out. Keep it under 60 words, plain spoken English, and end it with a question the customer answers yes to. criticalTokens are the exact phrases inside that text that must be said (an amount, a deadline).
7. The handoff line is what the REP says to hand the call over. It names the business's own assistant, is one sentence, and never promises anything the assistant cannot do.
8. Write for the ear. No markdown, no emoji, no stage directions, no placeholders in square brackets. Curly-brace placeholders are not yours to write: use plain words.
9. notes: 2 to 5 short lines, each one an assumption a person should check ("I assumed the deposit is 50 dollars"). Be honest about what you guessed.`;

export function buildDraftInput(i: DeskInput): string {
  const finishes = i.aiFinishes.map((f) => `- ${AI_FINISH_TEXT[f] ?? f}`);
  return [
    `INDUSTRY: ${i.industry}`,
    `BUSINESS NAME: ${i.businessName?.trim() || "(none given - invent a fictional one)"}`,
    ``,
    `WHAT THE REP HANDLES BEFORE HANDING OFF`,
    i.repHandles.trim(),
    ``,
    `WHAT THE ASSISTANT SHOULD FINISH`,
    ...finishes,
    ``,
    `MUST BE READ WORD FOR WORD`,
    i.verbatim?.trim() || "(nothing)",
    ``,
    `PAYMENT AMOUNT OR WHERE IT COMES FROM`,
    i.payment?.trim() || "(no payment)",
    ``,
    `TONE`,
    i.tone?.trim() || "warm, brief, never pushy",
    ...(i.voice ? [``, `VOICE: ${i.voice}`] : []),
  ].join("\n");
}

/** The repair round's input: the base form, the model's own draft, and what is wrong with it. */
export function buildRepairInput(base: string, previous: unknown, issues: readonly string[]): string {
  return [
    base,
    ``,
    `YOUR PREVIOUS DRAFT`,
    JSON.stringify(previous),
    ``,
    `WHAT IS WRONG WITH IT (fix all of it and keep everything else exactly as it is)`,
    ...issues.slice(0, 12).map((i) => `- ${i}`),
  ].join("\n");
}

/** A lint issue as one line the model can act on. */
export const issueLine = (i: LintIssue): string => `${i.path.join(".") || "relay"} [${i.code}]: ${i.message}`;

// ============================================================================================ the call

export interface DraftDeps {
  openai: () => OpenAI;
  /** `getLimitsAuthority().ledger`; null = spend not recorded (unit tests only). */
  ledger: () => SpendLedger | null;
  env: () => string;
  model?: string;
  timeoutMs?: number;
  onTrace?: OnTrace;
}

export interface DraftAttempt {
  /** The parsed draft, or null when the model's shape was illegal. */
  draft: DraftBlueprint | null;
  /** The raw JSON, fed back verbatim on the next round. */
  raw: unknown;
  /** Shape problems, already phrased for the model. */
  issues: string[];
  usd: number;
  ms: number;
  incomplete: boolean;
}

/**
 * ONE luna call. `previous` and `issues` turn it into a repair round. Never throws for a bad shape - a caller that
 * wants to repair needs the issues back, and only transport failures and a refused budget are exceptional.
 */
export async function draftOnce(d: DraftDeps, i: { input: string; refId: string }): Promise<DraftAttempt> {
  const t0 = performance.now();
  const ledger = d.ledger();
  let reservation: string | null = null;
  if (ledger) {
    const res = await ledger.reserve({ provider: "openai", action: "draft", refId: i.refId, estUsd: DRAFT_EST_USD, env: d.env() });
    if (!res.ok) throw new BatonError("E_BUDGET", "Today's drafting budget is used up. Start from a gallery relay instead.");
    reservation = res.id;
  }
  try {
    const r = await extractStructured<unknown>(d.openai(), {
      model: d.model ?? DRAFT_MODEL,
      instructions: DRAFT_INSTRUCTIONS,
      input: i.input,
      format: draftBlueprintFormat(),
      reasoningEffort: DRAFT_EFFORT,
      maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
      store: false,
      request: { timeoutMs: d.timeoutMs ?? DRAFT_TIMEOUT_MS, maxRetries: 0 },
      ...(d.onTrace ? { onTrace: d.onTrace } : {}),
      label: "draft_blueprint",
    });
    const usd = usdOfUsage(r.usage);
    if (ledger && reservation) await ledger.settle(reservation, usd).catch((err: unknown) => draftLog.warn("ledger settle failed", { err }));
    const parsed = DraftBlueprintSchema.safeParse(r.data);
    return {
      draft: parsed.success ? parsed.data : null,
      raw: r.data,
      issues: parsed.success ? [] : parsed.error.issues.slice(0, 8).map((x) => `${x.path.join(".") || "draft"}: ${x.message}`),
      usd,
      ms: Math.round(performance.now() - t0),
      incomplete: false,
    };
  } catch (e) {
    const incomplete = e instanceof IncompleteError;
    if (ledger && reservation) {
      // An incomplete response was generated and billed; a transport failure was not.
      await (incomplete ? ledger.settle(reservation, DRAFT_EST_USD) : ledger.release(reservation))
        .catch((err: unknown) => draftLog.warn("ledger close failed", { err }));
    }
    if (!incomplete) throw e;
    return {
      draft: null, raw: null,
      issues: ["your draft did not finish: write fewer fields and shorter descriptions"],
      usd: DRAFT_EST_USD, ms: Math.round(performance.now() - t0), incomplete: true,
    };
  }
}
