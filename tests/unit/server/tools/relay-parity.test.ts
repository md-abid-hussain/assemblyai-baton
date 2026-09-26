/**
 * The TOOL-PARITY GATE (TASKS-v2 WP16 acceptance 6, PLATFORM §6.3): WP6's handler contract, replayed against
 * `RelayToolService` with the REAL Baton blueprint compiled by the REAL kernel.
 *
 * Every assertion here is WP6's documented answer (docs/notes/wp6.md "Handler contract"), not a re-derivation of
 * whatever the generic code happens to return: the point of the gate is that the flagship behaves identically once
 * it runs on the blueprint. The three differences are deliberate and asserted as such:
 *   1. an out-of-stage tool answers `{status:"not_available"}` instead of the handler's own refusal (acceptance 8);
 *   2. the pay SMS is the connector's `smsTemplate` + the link, not the hard-coded legacy sentence;
 *   3. a stage change also returns `nextStep` = the new stage's goal text (the published gateway's mechanism).
 *
 * $0: memory stores, `PAYMENTS_MODE=mock`, no network.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { CaseState, FieldId } from "@/core/contracts/case";
import type { AccountRecord, Blueprint, CompiledRelay, RelayToolContext } from "@/core/contracts/v2";
import { BlueprintSchema } from "@/core/contracts/v2/blueprint";
import { policyToAccount } from "@/core/relay/account";
import { compileRelay } from "@/core/relay/compile";
import { MemoryConnectorCallLog } from "@/server/connectors/call-log";
import { RelayConnectorRuntime } from "@/server/connectors/runtime";
import { PaymentService } from "@/server/payments/service";
import { kitRatingSource } from "@/server/rating";
import { RelayToolServiceImpl } from "@/server/tools/relay-tool-service";
import type { RelayRunCase, RelayRunSource } from "@/server/tools/relay-run-source";
import { FakeCaseRepo, makeState, MemoryPaymentStore, MemoryToolStore, policy } from "./helpers";

const BATON = resolve(process.cwd(), "data/relays/baton-add-driver.json");

function batonBlueprint(): Blueprint {
  return BlueprintSchema.parse(JSON.parse(readFileSync(BATON, "utf8")));
}

const CASE_ID = "case_relay_1";
const TKO_ID = "tko_relay_1";
const ORIGIN = "http://localhost:3160";
const VERSION = "rv_baton_1";

interface Harness {
  tools: RelayToolServiceImpl;
  store: MemoryToolStore;
  payStore: MemoryPaymentStore;
  cases: FakeCaseRepo;
  compiled: CompiledRelay;
  account: AccountRecord;
  callLog: MemoryConnectorCallLog;
  ctx: RelayToolContext;
  state(): CaseState;
}

async function harness(opts: { statuses?: Partial<Record<FieldId, CaseState["fields"][FieldId]["status"]>>; blueprint?: Blueprint; callId?: string | null } = {}): Promise<Harness> {
  const bp = opts.blueprint ?? batonBlueprint();
  const compiled = compileRelay(bp, { versionId: VERSION, relayId: "rel_baton", flagship: true });
  const account = policyToAccount(policy, await kitRatingSource("s01"));

  const payStore = new MemoryPaymentStore();
  const store = new MemoryToolStore(payStore);
  const cases = new FakeCaseRepo();
  cases.add(CASE_ID, makeState(CASE_ID, opts.statuses ?? allMissing()), "s01");
  store.addTakeover({ id: TKO_ID, caseId: CASE_ID });

  const payments = new PaymentService({
    store: payStore, polar: null, polarConfig: null, mode: async () => "mock", sleep: async () => undefined,
  });
  const callLog = new MemoryConnectorCallLog();
  const runs: RelayRunSource = {
    loadCase: async (id) =>
      id === CASE_ID ? ({ id: CASE_ID, policy, scenarioId: "s01", callId: "s01_take1", mode: "watch", relayVersionId: VERSION, simCallId: null } satisfies RelayRunCase) : null,
    compiled: async () => compiled,
    account: async () => account,
  };
  const connectors = new RelayConnectorRuntime({
    secrets: { resolve: async () => { throw new Error("no secrets in this test"); }, nameOf: async () => null },
    callLog,
    payments: { create: (i) => payments.create(i) },
    store: {
      markConnector: (id, r) => store.markConnector(id, r),
      putConfirmationNumber: (id, n) => store.putConfirmationNumber(id, n),
      setCaseStatus: (c, s, from) => store.setCaseStatus(c, s, from),
    },
    confirmationNumber: () => "END-48213",
  });
  const tools = new RelayToolServiceImpl({
    runs,
    cases: { load: (id) => cases.load(id), applyEvents: (id, v, e) => cases.applyEvents(id, v, e) },
    store, payments, connectors, callLog,
    config: { deployId: "wp16-parity", taxSuffix: false },
    confirmationNumber: () => "END-48213",
  });
  return {
    tools, store, payStore, cases, compiled, account, callLog,
    ctx: { caseId: CASE_ID, takeoverId: TKO_ID, callId: opts.callId === undefined ? "c1" : opts.callId, visitorId: "v1", origin: ORIGIN, mode: "test", publicationId: null },
    state: () => cases.cases.get(CASE_ID)!.state,
  };
}

const allMissing = (): Partial<Record<FieldId, CaseState["fields"][FieldId]["status"]>> => ({
  driver_full_name: "MISSING", driver_dob: "MISSING", driver_relation: "MISSING", license_state: "MISSING",
  license_status: "MISSING", vehicle_assignment: "MISSING", operator_type: "MISSING", garaging_zip: "MISSING",
  effective_date: "MISSING", premium_new_monthly_usd: "MISSING",
});

const call = (h: Harness, name: string, args: unknown, callId = "c1") => h.tools.handle(name, args, { ...h.ctx, callId });

// ============================================================================================ the stage gate

describe("RelayToolService: the stage gate (acceptance 8)", () => {
  it("refuses an out-of-stage tool with not_available and executes nothing", async () => {
    const h = await harness();
    const r = await call(h, "send_confirmation", {});
    expect(r.result).toEqual({ status: "not_available", instruction: expect.any(String) });
    expect(r.nextStep).toBeNull();
    expect(h.payStore.rows.size).toBe(0);
    expect(h.store.takeovers.get(TKO_ID)!.connectors).toEqual({});
    // Nothing was written to the connector log either: the gate is before dispatch.
    expect(h.callLog.rows).toHaveLength(0);
  });

  it("refuses a tool this relay does not have at all", async () => {
    const h = await harness();
    const r = await call(h, "send_deposit_link", { customer_agreed_to_text: true });
    expect(r.result.status).toBe("not_available");
  });

  it("allows the confirm stage's tools", async () => {
    const h = await harness();
    const r = await call(h, "update_case_field", { field: "garaging_zip", value: "44107", reason: "newly_provided" });
    expect(r.result).toMatchObject({ result: "accepted", field: "garaging_zip", status: "VERIFIED" });
  });
});

// ============================================================================================ built-ins

describe("RelayToolService: the built-in handlers (WP6 parity)", () => {
  it("update_case_field: accepted, then the conflict flow, then customer_corrected", async () => {
    const h = await harness({ statuses: { ...allMissing(), license_state: "VERIFIED" } });
    const same = await call(h, "update_case_field", { field: "license_state", value: "Ohio", reason: "customer_confirmed" }, "a1");
    expect(same.result).toMatchObject({ result: "accepted", field: "license_state", status: "VERIFIED" });

    const first = await call(h, "update_case_field", { field: "license_state", value: "Michigan", reason: "newly_provided" }, "a2");
    expect(first.result).toMatchObject({ result: "conflict", field: "license_state", recorded_value: "OH" });
    expect(first.result.instruction).toContain("customer_corrected");
    expect(first.ui?.conflict).toMatchObject({ field: "license_state", resolved: false });

    const again = await call(h, "update_case_field", { field: "license_state", value: "Michigan", reason: "newly_provided" }, "a3");
    expect(again.result.result).toBe("conflict");

    const corrected = await call(h, "update_case_field", { field: "license_state", value: "Michigan", reason: "customer_corrected" }, "a4");
    expect(corrected.result).toMatchObject({ result: "accepted", field: "license_state" });
  });

  it("update_case_field: an unparseable value is rejected, and invalid args answer the G0 shape", async () => {
    const h = await harness();
    const bad = await call(h, "update_case_field", { field: "driver_dob", value: "??", reason: "newly_provided" }, "b1");
    expect(bad.result).toMatchObject({ result: "rejected", reason: "unparseable", field: "driver_dob" });
    const noField = await call(h, "update_case_field", { value: "x", reason: "newly_provided" }, "b2");
    expect(noField.result).toMatchObject({ result: "rejected", reason: "invalid_args" });
    const notInEnum = await call(h, "update_case_field", { field: "not_a_field", value: "x", reason: "newly_provided" }, "b3");
    expect(notInEnum.result).toMatchObject({ result: "rejected", reason: "invalid_args" });
  });

  it("confirm_effective_date: the server resolution wins, the 30-day window is enforced, and `next` is the new stage", async () => {
    const h = await harness({ statuses: verifiedExcept("effective_date") });
    const far = await call(h, "confirm_effective_date", { date: "2026-12-25", customer_words: "Christmas day" }, "d1");
    expect(far.result).toMatchObject({ accepted: false, reason: "out_of_range" });
    expect(String(far.result.allowed)).toMatch(/^today to /);
    const past = await call(h, "confirm_effective_date", { date: "2020-01-01", customer_words: "January first twenty twenty" }, "d2");
    expect(past.result).toMatchObject({ accepted: false, reason: "out_of_range" });
    const none = await call(h, "confirm_effective_date", { date: "not-a-date", customer_words: "whenever" }, "d3");
    expect(none.result).toMatchObject({ accepted: false, reason: "unparseable" });

    const ok = await call(h, "confirm_effective_date", { date: "2026-10-02", customer_words: "October 2nd" }, "d4");
    expect(ok.result).toMatchObject({ accepted: true, effective_date: "2026-10-02", next: "disclose" });
    expect(typeof ok.result.spoken).toBe("string");
    expect(ok.stage).toBe("disclose");
    expect(ok.nextStep).toContain("get_disclosure");
  });

  it("hand_back_to_rep never refuses and names the rep", async () => {
    const h = await harness();
    const r = await call(h, "hand_back_to_rep", { reason: "advice_requested", summary: "Asked about coverage." }, "h1");
    expect(r.result).toEqual({ status: "transferring", message: "Tell the customer Daniel is coming back on the line now." });
    expect(h.store.caseStatus.get(CASE_ID)).toBe("handed_back");
  });

  it("get_disclosure: not_ready, then order, then idempotent text recorded for the verbatim check", async () => {
    const notReady = await harness({ statuses: { ...verifiedExcept("garaging_zip"), effective_date: "VERIFIED" } });
    notReady.store.takeovers.get(TKO_ID)!.stage = "disclose";
    const nr = await call(notReady, "get_disclosure", { kind: "premium_change" }, "g0");
    expect(nr.result).toMatchObject({ ok: false, reason: "not_ready" });
    expect(nr.result.missing).toContain("garaging_zip");

    const h = await harness({ statuses: verifiedAll() });
    h.store.takeovers.get(TKO_ID)!.stage = "disclose";
    const early = await call(h, "get_disclosure", { kind: "esign_consent" }, "g1");
    expect(early.result).toMatchObject({ ok: false, reason: "premium_change_first" });

    const prem = await call(h, "get_disclosure", { kind: "premium_change" }, "g2");
    expect(prem.result).toMatchObject({ ok: true, instruction: "Read this exactly, then wait for the answer." });
    expect(String(prem.result.text)).toContain("$142");
    expect(prem.transcriptionMode).toBe("min_latency");
    const again = await call(h, "get_disclosure", { kind: "premium_change" }, "g3");
    expect(again.result.text).toBe(prem.result.text);
    expect(again.result.disclosure_id).toBe(prem.result.disclosure_id);

    // wp8-to-wp6 item 1: the exact text and the money are on takeovers.metrics.disclosures[kind].
    const rec = h.store.takeovers.get(TKO_ID)!.relayDisclosures.premium_change!;
    expect(rec.text).toBe(prem.result.text);
    expect(rec.criticalTokens.length).toBeGreaterThan(0);
    expect(rec.monthlyUsd).toBe("142.00");
    expect(Number(rec.dueTodayUsd)).toBeGreaterThan(0);

    const esign = await call(h, "get_disclosure", { kind: "esign_consent" }, "g4");
    expect(esign.result.ok).toBe(true);
    expect(esign.stage).toBe("pay");
    expect(esign.nextStep).toContain("send_esign_and_pay_link");
    expect(esign.tools?.map((t) => t.name)).toEqual(["send_esign_and_pay_link", "get_disclosure", "update_case_field", "hand_back_to_rep"]);
  });
});

// ============================================================================================ connectors

describe("RelayToolService: the built-in connectors", () => {
  async function atPay(): Promise<Harness> {
    const h = await harness({ statuses: verifiedAll() });
    h.store.takeovers.get(TKO_ID)!.stage = "disclose";
    await call(h, "get_disclosure", { kind: "premium_change" }, "p_g1");
    await call(h, "get_disclosure", { kind: "esign_consent" }, "p_g2");
    return h;
  }

  it("payment_link: consent and the disclosure are required, then one payment, the template SMS and our link", async () => {
    const h = await atPay();
    const noConsent = await call(h, "send_esign_and_pay_link", { customer_agreed_to_text: false, paper_copy_requested: false, customer_words: "no" }, "p1");
    expect(noConsent.result).toEqual({ status: "not_sent", reason: "consent_required" });
    expect(h.payStore.rows.size).toBe(0);

    const pay = await call(h, "send_esign_and_pay_link", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes text me" }, "p2");
    expect(pay.result).toEqual({ status: "link_sent" });
    const paymentId = pay.ui!.paymentId!;
    expect(pay.ui!.link).toBe(`${ORIGIN}/pay/${paymentId}`);
    // The SMS is the connector's own template (rendered) plus the link.
    expect(pay.ui!.sms).toContain("Harborview");
    expect(pay.ui!.sms).toContain(pay.ui!.link!);
    expect(pay.ui!.esignId).toBe(paymentId);
    // The amount is the named value `due_today`, in cents.
    const row = h.payStore.rows.get(paymentId)!;
    expect(row.amountCents).toBe(4452);

    // A second call reuses the open payment: never two checkouts.
    const twice = await call(h, "send_esign_and_pay_link", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "again" }, "p3");
    expect(twice.ui!.paymentId).toBe(paymentId);
    expect(h.payStore.rows.size).toBe(1);
  });

  it("payment_link refuses before its disclosure", async () => {
    const h = await harness({ statuses: verifiedAll() });
    h.store.takeovers.get(TKO_ID)!.stage = "pay";
    const early = await call(h, "send_esign_and_pay_link", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes" }, "e1");
    expect(early.result).toMatchObject({ status: "not_sent", reason: "disclosure_required" });
    expect(h.payStore.rows.size).toBe(0);
  });

  it("confirmation: refused before the payment is server-verified, then issues a stable number and completes the case", async () => {
    const h = await atPay();
    const pay = await call(h, "send_esign_and_pay_link", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes" }, "c_p");
    const paymentId = pay.ui!.paymentId!;

    h.store.takeovers.get(TKO_ID)!.stage = "close"; // the gate only; the handler is what must refuse
    const early = await call(h, "send_confirmation", {}, "c_1");
    expect(early.result).toEqual({ ok: false, reason: "payment_not_confirmed" });

    await h.payStore.transition(paymentId, "succeeded", "simulate", { statusSource: "mock", simulated: true });
    const conf = await call(h, "send_confirmation", {}, "c_2");
    expect(conf.result).toMatchObject({ ok: true, confirmation_number: "END-48213", sms_sent: true });
    expect(conf.result.spoken).toBe("E N D 4 8 2 1 3");
    expect(conf.ui!.sms).toContain("END-48213");
    expect(h.store.caseStatus.get(CASE_ID)).toBe("completed");

    const twice = await call(h, "send_confirmation", {}, "c_3");
    expect(twice.result.confirmation_number).toBe("END-48213");
  });

  it("the amount is clamped to $1-$999", async () => {
    const bp = batonBlueprint();
    bp.values = bp.values.map((v) => (v.id === "due_today" ? { ...v, ref: { kind: "fixed", value: "4200.00" } } : v));
    const h = await harness({ statuses: verifiedAll(), blueprint: bp });
    h.store.takeovers.get(TKO_ID)!.stage = "disclose";
    await call(h, "get_disclosure", { kind: "premium_change" }, "cl_1");
    await call(h, "get_disclosure", { kind: "esign_consent" }, "cl_2");
    const pay = await call(h, "send_esign_and_pay_link", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes" }, "cl_3");
    expect(h.payStore.rows.get(pay.ui!.paymentId!)!.amountCents).toBe(99_900);
  });

  it("lookup_table answers under `data`, and a miss is not_found", async () => {
    const bp = batonBlueprint();
    bp.connectors = [
      ...bp.connectors,
      {
        type: "lookup_table", id: "prices", label: "Prices", toolName: "lookup_prices",
        description: "Look up the price of a service by its code.",
        table: "prices", keyColumn: "code", format: "csv", data: "code,price\ncleaning,75\nfilling,180\n",
      },
    ];
    bp.playbook.stages = bp.playbook.stages.map((s) => (s.kind === "confirm" ? { ...s, tools: [...s.tools, "lookup_prices"] } : s));
    const h = await harness({ blueprint: bp });
    const hit = await call(h, "lookup_prices", { key: "Cleaning" }, "l1");
    expect(hit.result).toEqual({ data: { code: "cleaning", price: "75" } });
    const miss = await call(h, "lookup_prices", { key: "crown" }, "l2");
    expect(miss.result).toEqual({ status: "not_found" });
    expect(h.callLog.rows.map((r) => r.toolName)).toEqual(["lookup_prices", "lookup_prices"]);
  });

  it("sms_mock renders its template with the args and reaches the phone", async () => {
    const bp = batonBlueprint();
    bp.connectors = [
      ...bp.connectors,
      {
        type: "sms_mock", id: "reminder", label: "Reminder", toolName: "send_reminder",
        description: "Text the customer a short reminder about the change.",
        template: "{org.name}: reminder for {customer.firstName} about {v.topic}.",
        params: { type: "object", required: ["topic"], properties: { topic: { type: "string" } } },
      },
    ];
    bp.playbook.stages = bp.playbook.stages.map((s) => (s.kind === "confirm" ? { ...s, tools: [...s.tools, "send_reminder"] } : s));
    const h = await harness({ blueprint: bp });
    const r = await call(h, "send_reminder", { topic: "the new driver" }, "s1");
    expect(r.result).toEqual({ status: "sent" });
    expect(r.ui!.sms).toBe("Harborview Insurance Agency: reminder for Priya about the new driver.");
    expect(h.store.takeovers.get(TKO_ID)!.connectors.reminder).toBeDefined();
  });
});

// ============================================================================================ dedupe, nextStep

describe("RelayToolService: dedupe and nextStep", () => {
  it("the published path (no call id) dedupes a connector call within 30 s and opens no second checkout", async () => {
    const h = await harness({ statuses: verifiedAll(), callId: null });
    h.store.takeovers.get(TKO_ID)!.stage = "disclose";
    await h.tools.handle("get_disclosure", { kind: "premium_change" }, { ...h.ctx, callId: null });
    await h.tools.handle("get_disclosure", { kind: "esign_consent" }, { ...h.ctx, callId: null });

    const args = { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes" };
    const first = await h.tools.handle("send_esign_and_pay_link", args, { ...h.ctx, callId: null });
    const second = await h.tools.handle("send_esign_and_pay_link", args, { ...h.ctx, callId: null });
    expect(second.result).toEqual(first.result);
    expect(h.payStore.rows.size).toBe(1);
    // One executed call, and the replay did not add a second connector_calls row.
    expect(h.callLog.rows.filter((r) => r.toolName === "send_esign_and_pay_link")).toHaveLength(1);
  });

  it("nextStep is the new stage's goal on a change and null otherwise", async () => {
    const h = await harness({ statuses: verifiedExcept("effective_date") });
    const noChange = await call(h, "update_case_field", { field: "garaging_zip", value: "44107", reason: "customer_confirmed" }, "n1");
    expect(noChange.nextStep).toBeNull();
    const changed = await call(h, "confirm_effective_date", { date: "2026-10-02", customer_words: "October second" }, "n2");
    expect(changed.nextStep).toBe(h.compiled.ui.stages.length > 0 ? goal(h, "disclose") : null);
    expect(changed.nextStep).not.toBeNull();
  });

  it("replay answers with the stored result and the current stage payload, and never a new nextStep", async () => {
    const h = await harness();
    const r = await h.tools.replay("update_case_field", { result: "accepted", field: "garaging_zip" }, h.ctx);
    expect(r.result).toEqual({ result: "accepted", field: "garaging_zip" });
    expect(r.nextStep).toBeNull();
    expect(r.stage).toBe("confirm");
    expect(r.tools?.length).toBeGreaterThan(0);
  });
});

function goal(h: Harness, stage: "confirm" | "disclose" | "pay" | "close"): string {
  const k = h.compiled as unknown as { stageGoal(s: string, snapshot: CaseState, a: AccountRecord): string };
  return k.stageGoal(stage, h.state(), h.account);
}

function verifiedAll(): Partial<Record<FieldId, CaseState["fields"][FieldId]["status"]>> {
  return {};
}

function verifiedExcept(field: FieldId): Partial<Record<FieldId, CaseState["fields"][FieldId]["status"]>> {
  return { [field]: "MISSING" };
}
