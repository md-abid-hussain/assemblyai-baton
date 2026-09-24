import "server-only";

import type { CaseState, DisclosureKind, FieldId, PolicyRecord, Stage } from "../../core/contracts/case";
import { BatonError } from "../../core/contracts/errors";
import type { InputModeFor } from "../../core/contracts/services";
import type { NextStep } from "../../core/contracts/takeover";
import type { VaFunctionTool } from "../../core/contracts/tools";

/**
 * The WP1 core functions the tool handlers consume (TASKS WP6 "Consumes"), as an injected port. WP1's modules
 * (`src/core/intents/add-driver.ts`, `src/core/compiler/**`) are built in parallel and are not on this branch, so
 * the handlers code against these signatures (copied from WP1's exports) and the integrator wires the real ones at
 * G1 with `setToolCore(...)` (the exact wiring file is in docs/notes/wp6.md). Unit tests inject fakes.
 */
export interface ToolCore {
  /** WP1 `normalizeField(field, raw, {policy, callDate})` → `{norm, display}` or null (unparseable). */
  normalizeField(field: FieldId, raw: string, ctx: { policy: PolicyRecord; callDate: string }): { norm: string; display: string } | null;
  /** WP1 `compatible(field, a, b)`. */
  compatible(field: FieldId, a: string | null, b: string | null): boolean;
  /** WP1 `resolveRelativeDate(words, callDate)` (the extractor's normalizer, so "this Friday" means the same). */
  resolveRelativeDate(words: string, callDate: string): string | null;
  /** WP1 `spokenDate(iso)` → "Friday, October 2nd". */
  spokenDate(iso: string): string;
  /** WP1 `disclosureText(kind, ctx, {taxSuffix})`. */
  disclosureText(
    kind: DisclosureKind,
    ctx: { snapshot: Pick<CaseState, "fields">; policy: PolicyRecord; monthlyUsd: string; dueTodayUsd: string },
    opts: { taxSuffix?: boolean },
  ): { kind: DisclosureKind; text: string; criticalTokens: string[] };
  /** WP1 `resolvePremium(snapshot, ratingNewMonthlyUsd)`. */
  resolvePremium(snapshot: Pick<CaseState, "fields">, ratingNewMonthlyUsd: number): { monthlyUsd: string; source: "rep_quote" | "rating_tool" };
  /** WP1 `resolveDueToday({...})`. */
  resolveDueToday(i: {
    snapshot: Pick<CaseState, "fields">;
    newMonthlyUsd: string;
    currentMonthlyUsd: number;
    scenarioDueTodayUsd?: number | null;
    callDate: string;
  }): { dueTodayUsd: string; source: "rep_quote" | "scenario" | "prorated" };
  /** WP1 `toolsForStage(stage, {payToolMode})`. */
  toolsForStage(stage: Stage, opts: { payToolMode?: "hold" | "push" }): VaFunctionTool[];
  /** WP1 `compilePrompt(state, policy, stage, {deployId, payToolMode})`. */
  compilePrompt(state: Pick<CaseState, "fields">, policy: PolicyRecord, stage: Stage, opts: { deployId: string; payToolMode?: "hold" | "push" }): string;
  /** WP1 `nextStage(current, s)` (forward-only). */
  nextStage(current: Stage | null, s: Pick<CaseState, "readiness" | "disclosuresGiven" | "payment">): Stage;
  /** WP1 `nextStepOf(snapshot)`. */
  nextStepOf(snapshot: Pick<CaseState, "fields">): NextStep;
  /** WP1 `inputModeFor(next)`. */
  inputModeFor: InputModeFor;
}

let core: ToolCore | null = null;

/** Wire WP1's functions (integrator, G1) or a fake (tests). `null` unwires. */
export function setToolCore(c: ToolCore | null): void {
  core = c;
}

export function getToolCore(): ToolCore {
  if (!core) throw new BatonError("E_INTERNAL", "The tool layer is not wired to the case engine yet (setToolCore).");
  return core;
}

export const hasToolCore = (): boolean => core !== null;
