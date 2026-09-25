/**
 * contracts/v2/relay.ts - the kernel's runtime seams (PLATFORM §4.1): `IntentSpec`, `PhraseScope`, `UiSpec`,
 * `CompiledListening`, `LintIssue`, plus the small shared vocabularies every v2 consumer needs (built-in tool
 * names, the stage-kind → runtime-stage map, canned greeting states, the stored-account marker) and the generic
 * result shapes `CompiledRelay` returns (`GreetingResult`, `DisclosureText`, `CompileTakeoverOptions`).
 * WP14a; frozen at C2 (D1 13:00); additive changes only afterwards.
 *
 * Pure and isomorphic. The generic result shapes are SUPERSETS of the legacy compiler types
 * (src/core/compiler/{greeting,disclosures,compile}.ts): a legacy Baton value is assignable to them, which the
 * contracts test pins at the type level, so the kernel can return legacy results unchanged for Baton parity.
 */
import { z } from "zod";
import type { CaseState, Stage } from "../case";
import type { InputModePlan } from "../takeover";
import { AccountRecordSchema, type AccountRecord } from "./blueprint";

// ============================================================================================ vocabularies

/** Tools every relay gets (PLATFORM §4.5). `get_disclosure` exists only when the relay has disclosures. */
export const BUILTIN_TOOL_NAMES = ["update_case_field", "hand_back_to_rep", "get_disclosure"] as const;
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];
/** Every stage must list these two (lint S1). */
export const REQUIRED_STAGE_TOOLS = ["update_case_field", "hand_back_to_rep"] as const;

/** The connector `type`s of `ConnectorSchema` (PLATFORM §6.1), in schema order. */
export const CONNECTOR_TYPES = [
  "payment_link", "esign_mock", "sms_mock", "http_action", "lookup_table", "completion_webhook", "confirmation",
] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

/** Blueprint stage kinds in their only legal order (lint S1). */
export const STAGE_KIND_ORDER = ["confirm", "disclose", "act", "close"] as const;
export type StageKind = (typeof STAGE_KIND_ORDER)[number];
/** Blueprint stage kind → the runtime `Stage` (contracts/case.ts): `act` runs as `pay`. At most one stage per kind. */
export const STAGE_KIND_TO_STAGE = { confirm: "confirm", disclose: "disclose", act: "pay", close: "close" } as const satisfies Record<StageKind, Stage>;
export const STAGE_TO_STAGE_KIND = { confirm: "confirm", disclose: "disclose", pay: "act", close: "close" } as const satisfies Record<Stage, StageKind>;

/**
 * The 4 canned snapshot states the Studio renders the greeting for (PLATFORM §7.2 Playbook) and lint G2 checks:
 * every required field VERIFIED; one PENDING (the highest-priority askable field); one MISSING; nothing known.
 */
export const CANNED_STATES = ["all_verified", "one_pending", "one_missing", "nothing"] as const;
export type CannedState = (typeof CANNED_STATES)[number];

/** Spoken words per second used for greeting estimates (WP5b: ≈0.34 s per word). */
export const SECONDS_PER_WORD = 0.34;

/**
 * `cases.policy` holds an `AccountRecord` with this marker for relay runs (PLATFORM §4.2); legacy Baton rows hold
 * a `PolicyRecord` (no marker). `accountOf(caseRow)` (WP14b) maps both to an `AccountRecord`.
 */
export const ACCOUNT_KIND_MARKER = "account" as const;
export const StoredAccountSchema = AccountRecordSchema.extend({ $kind: z.literal(ACCOUNT_KIND_MARKER) });
export type StoredAccount = z.infer<typeof StoredAccountSchema>;

// ============================================================================================ lint

/**
 * Lint codes (PLATFORM §3.4). `SCHEMA` is a `BlueprintSchema` parse failure mapped to a path (unsafe regexes found
 * at parse time are reported as `X3`, naming the offending group).
 */
export const LINT_CODES = [
  "SCHEMA", "L1", "L2", "L3", "G1", "G2", "W3", "C1", "C2", "S1", "S2", "S3", "F1", "F2", "X1", "X2", "X3",
  "B1", "K1", "K2", "W2",
] as const;
export type LintCode = (typeof LINT_CODES)[number];

export const LintIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warn"]),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});
/** Errors block a run or publish; warnings don't (PLATFORM §3.4). `path` is a JSON path into the blueprint. */
export interface LintIssue { code: string; severity: "error" | "warn"; path: (string | number)[]; message: string }

// ============================================================================================ IntentSpec (PLATFORM §4.1)

/** Phrase rendering scope: the account, the (frozen) snapshot and, for `confirmIfRaw`, the raw value. */
export interface PhraseScope { account: AccountRecord; snapshot: Pick<CaseState, "fields">; raw?: string | null }

/**
 * The runtime seam every engine function accepts (optional trailing `spec?: IntentSpec`, TASKS-v2 §2 rule 9).
 * `LEGACY_BATON_SPEC` (src/core/intents/baton-legacy-spec.ts) is hand-written over today's code;
 * `buildIntentSpec(batonBlueprint)` must equal it on the parity corpus (PLATFORM §4.6).
 */
export interface IntentSpec {
  id: string; hash: string;                                   // blueprint hash ("legacy" for LEGACY_BATON_SPEC)
  fieldIds: readonly string[]; required: ReadonlySet<string>; repOnly: ReadonlySet<string>;
  aiSettable: readonly string[]; adviceDomain: ReadonlySet<string>; serverResolvable: ReadonlySet<string>;
  priority: readonly string[];                                // next-step order (GREETING_PRIORITY)
  entityFields: ReadonlySet<string>;
  label(f: string): string;
  normalize(f: string, raw: string | number | boolean | null | undefined, ctx: { callDate: string; account: AccountRecord }): { norm: string; display: string } | null;
  display(f: string, norm: string, account: AccountRecord, raw?: string | null): string;
  compatible(f: string, a: string | null, b: string | null): boolean;
  merge(f: string, a: string, b: string): string;
  inRange(f: string, norm: string, callDate: string): boolean;
  confirmPhrase(f: string, value: string, pc: PhraseScope): string;
  askPhrase(f: string, pc: PhraseScope): string;
  spokenForms(f: string, value: string, account: AccountRecord): string[];
  targetedFields(sentence: string): string[];
  adviceRe: RegExp;                                           // built by compileSafeUnion(qa.adviceLexicon) for blueprints
  inputModeFor(next: { kind: "confirm" | "ask" | "disclosure" | "consent" | "none"; field: string | null }): InputModePlan;
}

// ============================================================================================ UiSpec, CompiledListening

export const UiSpecSchema = z.object({
  relay: z.object({
    id: z.string().nullable(), versionId: z.string().nullable(), slug: z.string(), title: z.string(),
    flagship: z.boolean(), simulated: z.boolean(),
  }),
  fields: z.array(z.object({
    id: z.string(), label: z.string(), required: z.boolean(), group: z.string().nullable(), hidden: z.boolean(),
    type: z.string(), repOnly: z.boolean(), advice: z.boolean(),
  })),
  stages: z.array(z.object({ kind: z.enum(["confirm", "disclose", "pay", "close"]), label: z.string() })),
  disclosures: z.array(z.object({ id: z.string(), title: z.string() })),
  connectors: z.array(z.object({ id: z.string(), type: z.enum(CONNECTOR_TYPES), label: z.string() })),
  phone: z.object({ payment: z.boolean(), esign: z.boolean(), smsSender: z.string() }),
});
/** What the console renders a relay's case card, stage strip, QA card and phone from (PLATFORM §4.1, §7.6). */
export type UiSpec = z.infer<typeof UiSpecSchema>;

export const CompiledListeningSchema = z.object({
  keyterms: z.array(z.string()),
  prompt: z.string(),
  languageCodes: z.array(z.enum(["en", "hi"])),
  tuning: z.enum(["telephony_8k", "wideband_16k"]),
});
/** Realtime STT settings for one run (`buildSttParams` input): merged keyterms, STT prompt, languages, tuning. */
export type CompiledListening = z.infer<typeof CompiledListeningSchema>;

// ============================================================================================ CompiledRelay result shapes

/** Generic `NextStep` (legacy contracts/takeover.ts `NextStep` with a string field id). */
export interface RelayNextStep { kind: "confirm" | "ask" | "disclosure" | "consent" | "none"; field: string | null }

/**
 * `CompiledRelay.greeting()` result: the legacy `GreetingResult` (compiler/greeting.ts) with string ids.
 * `dropped` holds greeting clause ids in drop order (Baton: "date", then "vehicle").
 */
export interface GreetingResult {
  text: string;
  wordCount: number;
  /** Fields whose VERIFIED values the text states outside the confirm clause. */
  asserted: string[];
  /** The MISSING field the closing sentence asks for, if the next step is an ask. */
  asks: string | null;
  /** The PENDING field the closing sentence confirms, if the next step is a confirm. */
  confirms: string | null;
  nextStep: RelayNextStep;
  dropped: string[];
}

/** `CompiledRelay.disclosure()` result: legacy `DisclosureText` with `kind` = the blueprint disclosure id. */
export interface DisclosureText {
  kind: string;
  text: string;
  /** Rendered critical tokens for the verbatim check (empty renders dropped). */
  criticalTokens: string[];
}

/**
 * `CompiledRelay.takeover()` options: legacy `CompileTakeoverOptions` (compiler/compile.ts). `voice` overrides
 * `playbook.voice` (env VA_VOICE on the legacy path); `capEnv` defaults to `playbook.sessionCap`.
 */
export interface CompileTakeoverOptions {
  deployId: string;
  voice?: string;
  keytermsEnabled?: boolean;
  capEnv?: { baseMs: number; perFieldMs: number; maxMs: number };
  compiledBy?: "server" | "client";
  payToolMode?: "hold" | "push";
  stage?: Stage;
}
