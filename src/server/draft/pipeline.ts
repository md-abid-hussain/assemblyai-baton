/**
 * server/draft/pipeline.ts - the "Describe your desk" pipeline, steps 2-6 of PLATFORM §7.4 (WP17·3).
 *
 *   draftOnce(luna) → expandDraft → BlueprintSchema + lintBlueprint → (repair, ≤ 2 rounds) → compliance post-fixes
 *   → re-lint → the relay is created with `origin:"draft"`.
 *
 * The pipeline is a plain async function over injected seams (`llm`, `kernel`, `create`, `onStep`), so the job
 * runner, a test and the offline gallery script all drive the same code. It never throws for a bad draft: a relay
 * that still lints with errors is created anyway, `status:"invalid"`, with the issues on it - §7.4 step 4 says the
 * valid parts are kept and the errors are highlighted rather than thrown away.
 *
 * Quotas, the plan check and the usage record live one level up (`service.ts`); the ledger lives in `openai/draft.ts`.
 */
import "server-only";

import type { Blueprint, DeskInput, LintIssue } from "../../core/contracts/v2";
import { applyComplianceFixes } from "../../core/relay/draft/compliance";
import { expandDraft } from "../../core/relay/draft/expand";
import type { DraftBlueprint } from "../../core/relay/draft/schema";
import { buildDraftInput, buildRepairInput, DRAFT_MAX_REPAIRS, draftOnce, issueLine, type DraftDeps } from "../openai/draft";
import { log } from "../log";

const pipelineLog = log.child({ component: "draft-pipeline" });

export type DraftStep = "drafting" | "repair 1" | "repair 2" | "fixing" | "creating";

export interface DraftPipelineDeps {
  llm: DraftDeps;
  /** `defaultRelayKernel` (parse + lint). Injected so a test can drive the pipeline without the whole kernel. */
  kernel: { parse(json: unknown): { blueprint: Blueprint | null; issues: LintIssue[] } };
  /** Creates the relay and returns its id. `null` = do not create (the offline gallery script). */
  create: ((bp: Blueprint) => Promise<string>) | null;
  /** Progress, so `GET /api/drafts/:id` can show the step. */
  onStep?: (step: DraftStep) => void | Promise<void>;
  /** The sample accounts' call date. */
  today: () => string;
}

export interface DraftPipelineResult {
  status: "ok" | "invalid";
  blueprint: Blueprint | null;
  relayId: string | null;
  /** The model's notes, then every deterministic repair and post-fix. */
  notes: string[];
  lint: LintIssue[];
  usd: number;
  repairs: number;
  /** The last raw model output, kept for debugging a failed draft. */
  draft: DraftBlueprint | null;
}

const errorsOf = (issues: readonly LintIssue[]): LintIssue[] => issues.filter((i) => i.severity === "error");

/**
 * One round: expand the draft, then parse and lint it. Returns the blueprint (null when the shape is illegal), the
 * issues and the expansion notes.
 */
export function evaluateDraft(
  draft: DraftBlueprint,
  d: Pick<DraftPipelineDeps, "kernel" | "today">,
): { blueprint: Blueprint | null; lint: LintIssue[]; notes: string[] } {
  const expanded = expandDraft(draft, { callDate: d.today() });
  const parsed = d.kernel.parse(expanded.blueprint);
  return { blueprint: parsed.blueprint, lint: parsed.issues, notes: expanded.notes };
}

export async function runDraftPipeline(d: DraftPipelineDeps, input: DeskInput, refId: string): Promise<DraftPipelineResult> {
  const base = buildDraftInput(input);
  let usd = 0;
  let repairs = 0;
  let best: { blueprint: Blueprint | null; lint: LintIssue[]; notes: string[]; draft: DraftBlueprint | null } =
    { blueprint: null, lint: [], notes: [], draft: null };
  let previousRaw: unknown = null;
  let issues: string[] = [];

  for (let round = 0; round <= DRAFT_MAX_REPAIRS; round++) {
    const step: DraftStep = round === 0 ? "drafting" : (`repair ${round}` as DraftStep);
    await d.onStep?.(step);
    const attempt = await draftOnce(d.llm, {
      input: round === 0 ? base : buildRepairInput(base, previousRaw, issues),
      refId,
    });
    usd += attempt.usd;
    if (round > 0) repairs = round;
    previousRaw = attempt.raw ?? previousRaw;

    if (!attempt.draft) {
      issues = attempt.issues;
      pipelineLog.warn("draft shape rejected", { round, incomplete: attempt.incomplete, issues: issues.length });
      continue;
    }
    const evaluated = evaluateDraft(attempt.draft, d);
    best = { ...evaluated, draft: attempt.draft };
    if (evaluated.blueprint && errorsOf(evaluated.lint).length === 0) break;
    issues = errorsOf(evaluated.lint).slice(0, 12).map(issueLine);
    if (issues.length === 0) issues = evaluated.lint.slice(0, 8).map(issueLine);
    pipelineLog.warn("drafted relay lints with errors", { round, errors: errorsOf(evaluated.lint).length });
  }

  usd = Math.round(usd * 1e6) / 1e6;
  if (!best.blueprint) {
    return { status: "invalid", blueprint: null, relayId: null, notes: [], lint: [], usd, repairs, draft: best.draft };
  }

  // ---- step 5: the deterministic compliance post-fixes, then one last lint -------------------------------
  await d.onStep?.("fixing");
  const fixed = applyComplianceFixes(best.blueprint);
  const after = d.kernel.parse(fixed.blueprint);
  const blueprint = after.blueprint ?? best.blueprint;
  const lint = after.blueprint ? after.issues : best.lint;
  const notes = [...best.notes, ...fixed.notes];

  // ---- step 6: create the relay ---------------------------------------------------------------------------
  let relayId: string | null = null;
  if (d.create) {
    await d.onStep?.("creating");
    relayId = await d.create(blueprint);
  }
  return {
    status: errorsOf(lint).length === 0 ? "ok" : "invalid",
    blueprint, relayId, notes, lint, usd, repairs, draft: best.draft,
  };
}
