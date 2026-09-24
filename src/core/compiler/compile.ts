/**
 * compiler/compile.ts - `compileTakeover`: snapshot + policy → `CompiledTakeover` (DESIGN §4.1, §5.6–§5.9.5).
 * Pure; used by WP5's `TakeoverService.compile` (server) and the client's local fallback compile (§5.5.3
 * COMPILING +1500 ms). Validates the resulting first update before returning.
 */
import type { CaseState, PolicyRecord, Stage } from "../contracts/case";
import type { CompiledTakeover } from "../contracts/takeover";
import { firstNameOf, relationWord } from "../intents/add-driver";
import { buildFirstUpdate, KEYTERM_MAX_CHARS, KEYTERMS_MAX, validateFirstUpdate } from "./first-update";
import { compileGreeting } from "./greeting";
import { compilePrompt, deployMarkerOf, PROMPT_VERSION } from "./prompt";
import { DEFAULT_VA_CAP_ENV, initialStage, inputModeFor, vaSessionCapMs, type VaCapEnv } from "./stages";
import { toolsForStage, type PayToolMode } from "./tool-schemas";

/** `VA_VOICE` default (DESIGN §3.4). */
export const DEFAULT_VA_VOICE = "alba";

export interface CompileTakeoverOptions {
  /** BATON_DEPLOY_ID (the prompt's deploy marker). */
  deployId: string;
  /** VA_VOICE (default "alba"). */
  voice?: string;
  /** VA_KEYTERMS=1 → `keyterms` filled; otherwise `[]`. */
  keytermsEnabled?: boolean;
  capEnv?: VaCapEnv;
  compiledBy?: "server" | "client";
  payToolMode?: PayToolMode;
  /** Override the initial stage (tests / T-D1-0 compile both `confirm` and `disclose`). */
  stage?: Stage;
}

/**
 * `input.keyterms` (§5.9.1, only when VA_KEYTERMS=1): snapshot values (driver name, relationship word), every policy
 * vehicle's make/model tokens, the policyholder's name, the agency and the rep name. Deduplicated
 * (case-insensitive), each ≤ 50 chars, at most 100.
 */
export function keytermsFor(snapshot: Pick<CaseState, "fields">, policy: PolicyRecord): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string | null | undefined) => {
    const t = (s ?? "").trim();
    if (!t || t.length > KEYTERM_MAX_CHARS || seen.has(t.toLowerCase()) || out.length >= KEYTERMS_MAX) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  const name = snapshot.fields.driver_full_name;
  if (name && name.status !== "MISSING" && name.value) { add(name.display ?? name.value); add(firstNameOf(name.value)); }
  const rel = snapshot.fields.driver_relation;
  if (rel && rel.status !== "MISSING" && rel.value) add(relationWord(rel.value, rel.display));
  for (const v of policy.vehicles) { add(`${v.make} ${v.model}`); add(v.model); }
  add(`${policy.policyholder.firstName} ${policy.policyholder.lastName}`);
  add(policy.agencyName);
  add(policy.repFirstName);
  return out;
}

/** Compile a takeover from a frozen snapshot. Throws `BatonError("E_VA_CONFIG")` if the first update is invalid. */
export function compileTakeover(snapshot: CaseState, policy: PolicyRecord, opts: CompileTakeoverOptions): CompiledTakeover {
  const stage = opts.stage ?? initialStage(snapshot);
  const greeting = compileGreeting(snapshot, policy);
  const keytermsEnabled = opts.keytermsEnabled ?? false;
  const compiled: CompiledTakeover = {
    greeting: greeting.text,
    systemPrompt: compilePrompt(snapshot, policy, stage, { deployId: opts.deployId, ...(opts.payToolMode ? { payToolMode: opts.payToolMode } : {}) }),
    keyterms: keytermsEnabled ? keytermsFor(snapshot, policy) : [],
    tools: toolsForStage(stage, opts.payToolMode ? { payToolMode: opts.payToolMode } : {}),
    stage,
    snapshot,
    voice: opts.voice ?? DEFAULT_VA_VOICE,
    transcriptionMode: inputModeFor(greeting.nextStep).mode,
    vaSessionCapMs: vaSessionCapMs(snapshot, opts.capEnv ?? DEFAULT_VA_CAP_ENV),
    promptVersion: PROMPT_VERSION,
    deployMarker: deployMarkerOf(opts.deployId),
    compiledBy: opts.compiledBy ?? "server",
  };
  validateFirstUpdate(buildFirstUpdate(compiled), { keytermsEnabled });
  return compiled;
}
