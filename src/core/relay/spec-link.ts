/**
 * relay/spec-link.ts - the seam between the legacy engine functions and the kernel (WP14a·3; TASKS-v2 §2 rule 9,
 * PLATFORM §4.1). WP14a. Pure and isomorphic.
 *
 * LEAF MODULE: it imports contract types only, so every legacy module (case/, compiler/, qa/, aai/) can import it
 * without an import cycle. ("No default spec is ever built from JSON inside legacy modules", PLATFORM §4.1.)
 *
 * - The legacy functions take an optional trailing `spec?: IntentSpec`. Absent → today's Baton code, unchanged.
 * - FIELD SEMANTICS (derive, status rules, apply, next step, input mode, session cap, QA) come from the spec itself.
 * - BLUEPRINT-LEVEL outputs (case JSON, disclosure text, listening, the verbatim threshold) are not in `IntentSpec`.
 *   `compileRelay()` links its spec to them here (`linkSpecKernel`), so `compiled.spec` carries them. A spec without a
 *   link is either `LEGACY_BATON_SPEC` (`hash === "legacy"` → the legacy code) or a bare `buildIntentSpec()` spec, which
 *   those functions refuse (`kernelOrLegacy` throws): pass `compileRelay(bp).spec` instead.
 */
import type { CaseState, FieldState, Readiness } from "../contracts/case";
import type { AccountRecord, Blueprint } from "../contracts/v2/blueprint";
import type { CompiledListening, DisclosureText, IntentSpec, RelayNextStep } from "../contracts/v2/relay";

/** `IntentSpec.hash` of `LEGACY_BATON_SPEC` (PLATFORM §4.1). */
export const LEGACY_SPEC_HASH = "legacy";

type Fields = Pick<CaseState, "fields">;

/** The blueprint-level kernel outputs a legacy function may need (a subset of `KernelRelay`). */
export interface SpecKernel {
  readonly blueprint: Blueprint;
  caseJson(snapshot: Fields, account: AccountRecord): string;
  disclosure(id: string, ctx: { snapshot: Fields; account: AccountRecord; opts: { taxSuffix: boolean } }): DisclosureText;
  listening(account: AccountRecord): CompiledListening;
  /** `qa.verbatimThreshold` (Baton 0.90 = `VERBATIM_MIN_SIMILARITY`). */
  readonly verbatimThreshold: number;
  /** `qa.reaskTargets` ([] = every field with QA patterns). */
  readonly reaskTargets: readonly string[];
}

const KERNELS = new WeakMap<IntentSpec, SpecKernel>();

/** Called by `compileRelay()` only. */
export function linkSpecKernel(spec: IntentSpec, kernel: SpecKernel): void {
  KERNELS.set(spec, kernel);
}

/** The kernel linked to a spec (null for `LEGACY_BATON_SPEC` and bare `buildIntentSpec()` specs). */
export const specKernelOf = (spec: IntentSpec | null | undefined): SpecKernel | null => (spec ? (KERNELS.get(spec) ?? null) : null);

/** No spec, or `LEGACY_BATON_SPEC`. */
export const isLegacySpec = (spec: IntentSpec | null | undefined): boolean => !spec || spec.hash === LEGACY_SPEC_HASH;

/**
 * For a blueprint-level legacy function: the linked kernel, or null when the legacy code applies (no spec, or
 * `LEGACY_BATON_SPEC`). Throws for a spec that has neither (a bare `buildIntentSpec()` spec): silently running
 * Baton's code for another relay would be wrong.
 */
export function kernelOrLegacy(spec: IntentSpec | null | undefined, fn: string): SpecKernel | null {
  if (!spec) return null;
  const k = KERNELS.get(spec);
  if (k) return k;
  if (spec.hash === LEGACY_SPEC_HASH) return null;
  throw new Error(`${fn}: spec "${spec.id}" (${spec.hash.slice(0, 8)}) has no compiled kernel; pass compileRelay(bp).spec`);
}

// ============================================================================================ spec rules
// Pure field-semantics rules shared by the kernel (relay/spec.ts, relay/compile.ts) and the legacy functions
// (compiler/stages.ts, case/state.ts). For LEGACY_BATON_SPEC they equal the legacy code (parity-spec.test.ts).

/** The state of a field by string id (absent → undefined). */
export const specFieldState = (s: Fields, id: string): FieldState | undefined =>
  (s.fields as unknown as Record<string, FieldState | undefined>)[id];

/** The next step (§5.6 sentence 4): the first PENDING field in priority order → confirm; else the first required
 *  MISSING field that is not server-resolvable → ask; else none. */
export function nextStepFor(spec: IntentSpec, snapshot: Fields): RelayNextStep {
  for (const f of spec.priority) if (specFieldState(snapshot, f)?.status === "PENDING") return { kind: "confirm", field: f };
  for (const f of spec.priority) {
    if (spec.required.has(f) && !spec.serverResolvable.has(f) && (specFieldState(snapshot, f)?.status ?? "MISSING") === "MISSING") {
      return { kind: "ask", field: f };
    }
  }
  return { kind: "none", field: null };
}

/** Required fields not VERIFIED at the snapshot, excluding server-resolvable ones (never asked). */
export function openRequiredFor(spec: IntentSpec, snapshot: Fields): string[] {
  return [...spec.required].filter((f) => !spec.serverResolvable.has(f) && specFieldState(snapshot, f)?.status !== "VERIFIED");
}

/** Readiness over a spec's required fields (as case/state.ts `readinessOf`). */
export function readinessFor(spec: IntentSpec, snapshot: Fields): Readiness {
  let verified = 0, pending = 0, missing = 0;
  let ready = true;
  for (const f of spec.required) {
    const status = specFieldState(snapshot, f)?.status ?? "MISSING";
    if (status === "VERIFIED") verified++;
    else if (status === "PENDING") pending++;
    else missing++;
    if (status !== "VERIFIED" && !spec.serverResolvable.has(f)) ready = false;
  }
  return { verified, pending, missing, requiredTotal: spec.required.size, ready };
}

/** Required entity fields that are MISSING (the static input-mode fallback, compiler/stages.ts `staticInputMode`). */
export const missingEntityFor = (spec: IntentSpec, snapshot: Fields): boolean =>
  [...spec.entityFields].some((f) => spec.required.has(f) && (specFieldState(snapshot, f)?.status ?? "MISSING") === "MISSING");

/** Blueprint regexes are clipped like `safeTest()` (1000 chars) when a spec's compiled `adviceRe` is matched. */
export const SPEC_MATCH_MAX_CHARS = 1000;
export const specAdvice = (spec: IntentSpec, sentence: string): boolean => {
  spec.adviceRe.lastIndex = 0;
  return spec.adviceRe.test(sentence.slice(0, SPEC_MATCH_MAX_CHARS));
};
