/**
 * `relayQaContext` and the relay half of `buildQaInput` (WP14b·3, TASKS-v2 WP14b acceptance 6; PLATFORM §4.1, §4.7).
 *
 * No DB, no upstreams, $0: the REAL WP14a kernel compiles the mini Dental blueprint, and the three sets `buildQaInput`
 * used to hard-code (Baton's six tool names, `KEYTERM_FIELDS`, the two `DisclosureKind`s) are read off the compile.
 *
 * The load-bearing claim of every case below is the pair: **with** the context the Dental run is scored on Dental's
 * own ids, and **without** it every output is Baton's byte for byte — which is what keeps WP8's corpus green and what
 * a flagship run (the parity target) still gets.
 */
import { describe, expect, it } from "vitest";

import type { CaseState, FieldState, PolicyRecord } from "@/core/contracts/case";
import type { AccountRecord, CompiledRelay } from "@/core/contracts/v2";
import { compileRelay } from "@/core/relay/compile";
import { storedAccount } from "@/core/relay/account";
import { relayQaContext, relayQaContextFor } from "@/server/engine/qa-context";
import { buildQaInput, keytermsOf, readMetrics, toolCallsOf, type QaSources, type VaTimeline } from "@/server/qa/build-input";
import { policyOf } from "../cases/helpers/fixtures";
import { dentalBlueprint } from "../relays/helpers";

const dental = (): CompiledRelay => compileRelay(dentalBlueprint()) as unknown as CompiledRelay;

const POLICY = policyOf("s01") as PolicyRecord;
const ACCOUNT: AccountRecord = dentalBlueprint().context.samples[0]! as AccountRecord;

/** A VA timeline with one call per name, all resolved at the same instant. */
const timelineOf = (names: string[]): VaTimeline =>
  ({
    started_at_unix_ms: 1_000,
    turns: [{ tool_calls: names.map((name) => ({ name, arguments: {}, dispatched_at_ms: 2_000, result_received_at_ms: 2_100 })) }],
  }) as unknown as VaTimeline;

const HUD = { click_to_first_audible: 640, turn_audible_latency: 310 };

/** `takeovers.metrics` as a DENTAL run writes it: the keys are the blueprint's disclosure ids. */
const DENTAL_METRICS = {
  disclosures: { deposit_terms: { text: "The deposit is fifty dollars and it is refundable for 24 hours.", criticalTokens: ["fifty dollars"] } },
  hud: HUD,
};

/** The same shape as a BATON run writes it: one of the two `DisclosureKind`s. */
const BATON_METRICS = {
  disclosures: { premium_change: { text: "Your premium may change.", criticalTokens: ["may change"] } },
  hud: HUD,
};

const field = (id: string, value: string, display?: string): FieldState =>
  ({ field: id, value, display: display ?? null, status: "VERIFIED" }) as unknown as FieldState;

const sources = (policy: PolicyRecord | AccountRecord, names: string[], metrics: unknown = DENTAL_METRICS): QaSources => ({
  snapshot: { fields: { patient_name: field("patient_name", "Maya Ortiz"), driver_full_name: field("driver_full_name", "Dana Reed") } as CaseState["fields"] },
  policy,
  transcript: { utterances: [], audio_duration: 30 },
  timeline: timelineOf(names),
  greeting: "hi",
  outcome: "completed",
  metrics,
  payment: null,
  durationSec: 30,
});

describe("relayQaContext: the three sets come off the compile", () => {
  it("a Dental compile answers Dental's tool names, disclosure ids and entity fields — not Baton's", () => {
    const ctx = relayQaContext(dental())!;
    expect(ctx).not.toBeNull();

    // The disclosure id is the blueprint's, and Baton's two do not appear.
    expect(ctx.disclosureIds).toEqual(["deposit_terms"]);

    // The relay's connector tools and the three built-ins; Baton-only names are absent.
    expect(ctx.toolNames.has("send_deposit_link")).toBe(true);
    expect(ctx.toolNames.has("confirm_appointment_date")).toBe(true);
    expect(ctx.toolNames.has("send_confirmation")).toBe(true);
    // `log_crm_note` is a connector the blueprint declares but no stage offers, so no stage's tool list has it.
    expect(ctx.toolNames.has("log_crm_note")).toBe(false);
    expect(ctx.toolNames.has("update_case_field")).toBe(true);
    expect(ctx.toolNames.has("get_disclosure")).toBe(true);
    expect(ctx.toolNames.has("confirm_effective_date")).toBe(false);
    expect(ctx.toolNames.has("send_esign_and_pay_link")).toBe(false);

    expect(ctx.spec.entityFields.has("patient_name")).toBe(true);
    expect(ctx.spec.entityFields.has("driver_full_name")).toBe(false);
  });

  it("the legacy Baton engine (no blueprint) is null, so QA keeps Baton's constants (the parity target)", () => {
    expect(relayQaContext({ ...dental(), blueprint: null })).toBeNull();
  });

  it("relayQaContextFor: null for a Baton case, null with no relay graph, and the compile for a version", async () => {
    const compiled = dental();
    const relays = () => ({ engine: { forVersion: async () => compiled } }) as never;
    expect(await relayQaContextFor(relays, null)).toBeNull();
    expect(await relayQaContextFor(null, "rv_1")).toBeNull();
    expect((await relayQaContextFor(relays, "rv_1"))!.disclosureIds).toEqual(["deposit_terms"]);
  });

  it("a compile failure scores with Baton's sets rather than losing the whole verification", async () => {
    const relays = () => ({ engine: { forVersion: async () => { throw new Error("gone"); } } }) as never;
    expect(await relayQaContextFor(relays, "rv_1")).toBeNull();
  });
});

describe("toolCallsOf: which names are known", () => {
  it("without a context it is Baton's six, and `send_deposit_link` is dropped", () => {
    const names = toolCallsOf(timelineOf(["send_deposit_link", "confirm_effective_date", "made_up_tool"])).map((c) => c.name);
    expect(names).toEqual(["confirm_effective_date"]);
  });

  it("with the Dental context it is the relay's, and `made_up_tool` is still dropped (P§4.7 widened ToolNameSchema)", () => {
    const known = relayQaContext(dental())!.toolNames;
    const names = toolCallsOf(timelineOf(["send_deposit_link", "confirm_effective_date", "made_up_tool"]), known).map((c) => c.name);
    expect(names).toEqual(["send_deposit_link"]);
  });
});

describe("buildQaInput: the Dental run is scored on Dental's ids", () => {
  it("with the context: the relay's disclosure survives the two-value parse, and Baton's does not appear", () => {
    const ctx = relayQaContext(dental())!;
    const input = buildQaInput(sources(storedAccount(ACCOUNT), ["send_deposit_link", "get_disclosure"]), ctx);
    expect(input.disclosures.map((d) => d.kind)).toEqual(["deposit_terms"]);
    expect(input.disclosures[0]!.criticalTokens).toEqual(["fifty dollars"]);
    expect(input.toolCalls.map((c) => c.name)).toEqual(["send_deposit_link", "get_disclosure"]);
  });

  it("without the context a Baton run is unchanged: its own kind, its own six tool names", () => {
    const input = buildQaInput(sources(POLICY, ["send_deposit_link", "get_disclosure"], BATON_METRICS));
    expect(input.disclosures.map((d) => d.kind)).toEqual(["premium_change"]);
    expect(input.toolCalls.map((c) => c.name)).toEqual(["get_disclosure"]);
    expect(input.latency!.clickToFirstAudibleMs).toBe(HUD.click_to_first_audible);
  });

  it("a relay's disclosure ids no longer cost the run its HUD latency (readMetrics retries without them)", () => {
    // The strict `partialRecord` over Baton's two kinds rejects `deposit_terms`, and with it the whole object —
    // so before the retry every Dental run scored with null latency.
    expect(readMetrics(DENTAL_METRICS).hud).toEqual(HUD);
    expect(readMetrics(DENTAL_METRICS).disclosures).toBeUndefined();
    expect(readMetrics(BATON_METRICS).disclosures).toEqual(BATON_METRICS.disclosures);

    const input = buildQaInput(sources(storedAccount(ACCOUNT), []), relayQaContext(dental())!);
    expect(input.latency!.clickToFirstAudibleMs).toBe(HUD.click_to_first_audible);
    expect(input.disclosures.map((d) => d.kind)).toEqual(["deposit_terms"]);
  });

  it("a relay's ids are invisible without the context, so nothing Baton scores can be a relay's text", () => {
    const input = buildQaInput(sources(storedAccount(ACCOUNT), ["get_disclosure"]));
    expect(input.disclosures).toEqual([]);
  });

  it("a stored AccountRecord in `cases.policy` is handed to QA as a PolicyRecord (WP8's contract is unchanged)", () => {
    const input = buildQaInput(sources(storedAccount(ACCOUNT), []), relayQaContext(dental())!);
    expect(input.policy.policyholder.firstName).toBe(ACCOUNT.customer.firstName);
    expect((input.policy as unknown as { $kind?: string }).$kind).toBeUndefined();
  });
});

describe("keytermsOf: the entity fields are the relay's", () => {
  it("with the Dental spec: the patient, the account name and the treatment table — never Baton's driver", () => {
    const spec = relayQaContext(dental())!.spec;
    const terms = keytermsOf(sources(storedAccount(ACCOUNT), []).snapshot, storedAccount(ACCOUNT), 100, spec);
    expect(terms).toContain("Maya Ortiz");
    expect(terms).not.toContain("Dana Reed");
    expect(terms).toContain(`${ACCOUNT.customer.firstName} ${ACCOUNT.customer.lastName}`.trim());
    // The lookup table the deposit is read from. The id column is added before the label, and the dedupe is
    // case-insensitive, so the surviving form is "whitening" — which is what an STT keyterm matches anyway.
    expect(terms).toContain("whitening");
    expect(terms).toContain("75.00");
  });

  it("without a spec it is Baton's: the driver, the policyholder and the vehicles, and the patient is dropped", () => {
    const terms = keytermsOf(sources(POLICY, []).snapshot, POLICY);
    expect(terms).toContain("Dana Reed");
    expect(terms).not.toContain("Maya Ortiz");
    expect(terms).toContain(`${POLICY.policyholder.firstName} ${POLICY.policyholder.lastName}`);
  });
});
