import "server-only";

import type {
  CasePayment, CaseState, DisclosureKind, FactEvent, NewFactEvent, PolicyRecord, Stage,
} from "../../core/contracts/case";
import type { RawPatch, VerifierResult } from "../../core/contracts/extract";
import type { TurnInput } from "../../core/contracts/turns";
import type { IntentSpec } from "../../core/contracts/v2/relay";

/**
 * The pure case engine WP3 drives (TASKS WP3 "Consumes": WP1 `applyExtraction`, `deriveCaseState`,
 * `EXTRACTOR_PROMPT_V3`, `ADD_DRIVER_PATCH_FORMAT`). The signatures below are the ones WP1 ships in
 * `src/core/case/**` (read from wp/wp1 at 7996dc4); the parameter types are structural subsets of WP1's
 * `DeriveCtx`/`ApplyCtx`, so WP1's functions are assignable to this interface as they are.
 *
 * Until G1 merges wp/wp1, `defaults.ts` binds a small stub engine (`engine-stub.ts`). The integrator's G1 binding
 * (one file) is in docs/notes/requests/wp3-to-integrator.md.
 *
 * **WP14b·3:** every method gained the same optional trailing `spec?: IntentSpec` WP14a·3 put on the core functions
 * (TASKS-v2 §2 rule 9). Without it the behaviour is Baton's, unchanged. `relay-engine.ts` builds the per-version
 * engine that supplies it, and the repository, the extract service and the verifier runner pick the engine from
 * `cases.relay_version_id` instead of holding one for the whole process.
 */

/** An event as WP1's derive takes it (`DerivableEvent`): a FactEvent whose seq may be absent. */
export type EngineEvent = Omit<FactEvent, "seq"> & { seq?: number };

/** Subset of WP1 `DeriveCtx`. */
export interface EngineDeriveCtx {
  caseId: string;
  version?: number;
  callClockMs?: number;
  tArmMs?: number | null;
  verifier?: VerifierResult | null;
  stage?: Stage | null;
  disclosuresGiven?: DisclosureKind[];
  payment?: CasePayment | null;
  confirmationNumber?: string | null;
}

/** Subset of WP1 `ApplyCtx`. */
export interface EngineApplyCtx {
  caseId: string;
  policy: PolicyRecord;
  callDate?: string;
  newId?: (turnId: string, index: number) => string;
}

export interface ExtractorArtefacts {
  /** EXTRACTOR_PROMPT_V3 (DESIGN §5.3, verbatim). */
  prompt: string;
  /** ADD_DRIVER_PATCH_FORMAT (strict json_schema `add_driver_patch`). */
  format: { name: string; strict?: boolean; schema: Record<string, unknown> };
  /** "gpt-6-luna" */
  model: string;
  /** "none" */
  effort: "none";
  /** sha256(prompt + schema + model + effort).slice(0, 12) (§5.3 version pinning). */
  version: string;
  /** ≤3 NEW TURNS per call (§5.3 batching). */
  maxNewTurns: number;
  /** RECENT = the last 6 finals before the new ones. */
  recentTurns: number;
}

type TurnText = Pick<TurnInput, "turnId" | "channel" | "text">;

export interface CaseEngine {
  /** A fresh case: every field MISSING. */
  emptyCaseState(caseId: string, spec?: IntentSpec): CaseState;
  /** Pure, full recompute from the append-only events, sorted by (turnEndMs, seq) (§5.4). */
  deriveCaseState(policy: PolicyRecord, events: readonly EngineEvent[], ctx: EngineDeriveCtx, spec?: IntentSpec): CaseState;
  /** §5.3 post-processing of one raw patch (drop foreign/empty events, party, normalize, evidence, late/cut). */
  applyExtraction(raw: RawPatch, turns: readonly TurnInput[], ctx: EngineApplyCtx, spec?: IntentSpec): NewFactEvent[];
  /** F2 step 3: sol's disagreements as `kind:"verifier"` events (G0 encoding). */
  verifierDisagreementEvents(result: VerifierResult, state: Pick<CaseState, "fields">, turns: readonly TurnInput[], ctx: EngineApplyCtx, spec?: IntentSpec): NewFactEvent[];
  /** §5.3 "User input" JSON string. */
  buildExtractorInput(i: { callDate: string; policy: PolicyRecord; state: Pick<CaseState, "fields">; recent: readonly TurnText[]; newTurns: readonly TurnText[] }): string;
  extractor: ExtractorArtefacts;
  /** Which implementation is bound ("wp1" after G1, "stub" before). Logged and shown in notes. */
  readonly impl: "wp1" | "stub";
}
