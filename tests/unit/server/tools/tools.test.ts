/**
 * WP6 acceptance 2, 4 and 5 (handler level, $0): the six tool handlers gate the flow (DESIGN §5.8).
 */
import { describe, expect, it } from "vitest";

import type { FieldId, FieldState, Stage } from "@/core/contracts/case";
import type { ToolContext } from "@/core/contracts/services";
import { PaymentService } from "@/server/payments/service";
import { kitRatingSource } from "@/server/rating";
import { Wp6ToolService } from "@/server/tools/service";
import { clock, FakeCaseRepo, fakeCore, FakePolar, makeState, MemoryPaymentStore, MemoryToolStore } from "./helpers";

function setup(opts: { statuses?: Partial<Record<FieldId, FieldState["status"]>>; stage?: Stage | null; mode?: "polar" | "mock"; scenarioId?: string } = {}) {
  const payStore = new MemoryPaymentStore();
  const store = new MemoryToolStore(payStore);
  const cases = new FakeCaseRepo();
  const polar = new FakePolar();
  const c = clock();
  let n = 0;
  const payments = new PaymentService({
    store: payStore,
    polar,
    polarConfig: { productId: "prod_1", demoCustomers: {}, embedOrigins: [], appUrl: "http://localhost:3107" },
    mode: async () => opts.mode ?? "mock",
    now: c.now,
    sleep: async () => undefined,
    newId: () => `pay_${++n}`,
  });
  const tools = new Wp6ToolService({
    cases,
    store,
    payments,
    core: () => fakeCore,
    rating: kitRatingSource,
    config: { deployId: "dev-wp6", payToolMode: "push", taxSuffix: false },
    now: c.now,
    newId: () => `ev_${++n}`,
    confirmationNumber: () => "END-48213",
  });
  cases.add("case_1", makeState("case_1", opts.statuses ?? {}), opts.scenarioId ?? "s01");
  store.addTakeover({ id: "tko_1", caseId: "case_1", stage: opts.stage === undefined ? null : opts.stage });
  const ctx: ToolContext = { caseId: "case_1", takeoverId: "tko_1", callId: "call_x", visitorId: "v1", origin: "http://localhost:3107" };
  return { payStore, store, cases, polar, c, payments, tools, ctx };
}

const NOT_READY = { effective_date: "PENDING", garaging_zip: "MISSING" } as const;

describe("get_disclosure", () => {
  it("refuses before the case is ready (acceptance 4)", async () => {
    const { tools, ctx } = setup({ statuses: NOT_READY, stage: "confirm" });
    const r = await tools.handle("get_disclosure", { kind: "premium_change" }, ctx);
    expect(r.result).toMatchObject({ ok: false, reason: "not_ready" });
    expect(r.result.missing).toEqual(expect.arrayContaining(["effective_date", "garaging_zip"]));
    expect(r.stage).toBeUndefined();
  });

  it("premium from the rating tool; esign needs premium first; esign → stage pay with the pay tools", async () => {
    const { tools, ctx, store } = setup({ stage: "disclose" });
    const early = await tools.handle("get_disclosure", { kind: "esign_consent" }, ctx);
    expect(early.result).toMatchObject({ ok: false, reason: "premium_change_first" });

    const p = await tools.handle("get_disclosure", { kind: "premium_change" }, ctx);
    // s01: $142 new vs $96 current; fake proration = 20% of the difference = $9.20.
    expect(p.result).toMatchObject({ ok: true, text: "PREMIUM $142.00 a month, $9.20 due today", instruction: "Read this exactly, then wait for the answer." });
    expect(p.result.disclosure_id).toMatch(/^dsc_/);
    expect(p.stage).toBeUndefined();
    expect(p.transcriptionMode).toBe("min_latency");
    const again = await tools.handle("get_disclosure", { kind: "premium_change" }, ctx);
    expect(again.result.disclosure_id).toBe(p.result.disclosure_id); // idempotent: the same verbatim text

    const e = await tools.handle("get_disclosure", { kind: "esign_consent" }, ctx);
    expect(e.result).toMatchObject({ ok: true });
    expect(e.stage).toBe("pay");
    expect(e.tools?.map((t) => t.name)).toEqual(["send_esign_and_pay_link", "get_disclosure", "update_case_field", "hand_back_to_rep"]);
    expect(e.systemPrompt).toContain("stage=pay");
    expect(e.systemPrompt).toContain("pay=push");
    expect((await store.getTakeover("tko_1"))!.stage).toBe("pay");
    const rec = (await store.getTakeover("tko_1"))!.disclosures;
    expect(rec.premium_change).toMatchObject({ monthlyUsd: "142.00", dueTodayUsd: "9.20", premiumSource: "rating_tool", dueSource: "prorated" });
  });

  it("uses the scenario's own amount due today when the kit defines it (s05: $34.10)", async () => {
    const { tools, ctx } = setup({ stage: "disclose", scenarioId: "s05" });
    const p = await tools.handle("get_disclosure", { kind: "premium_change" }, ctx);
    expect(p.result.text).toBe("PREMIUM $204.00 a month, $34.10 due today");
  });
});

describe("confirm_effective_date", () => {
  it("resolves the customer's words server-side (server wins over the LLM), records a tool_update, → disclose", async () => {
    const { tools, ctx, cases, c } = setup({ statuses: { effective_date: "PENDING" }, stage: "confirm" });
    c.advance(5_000); // 5.5 s after armed_at (the clock starts 30 s after armed_at … see helpers)
    const r = await tools.handle("confirm_effective_date", { date: "2026-10-09", customer_words: "this Friday works" }, ctx);
    // 2026-09-25 is a Friday → "this Friday" (fake core: the next one) = 2026-10-02.
    expect(r.result).toMatchObject({ accepted: true, effective_date: "2026-10-02", next: "disclose" });
    expect(r.result.spoken).toBe("Friday, October 2");
    expect(r.stage).toBe("disclose");
    expect(r.tools?.map((t) => t.name)).toContain("get_disclosure");
    const ev = cases.cases.get("case_1")!.events[0]!;
    expect(ev).toMatchObject({ field: "effective_date", kind: "tool_update", party: "ai", valueNorm: "2026-10-02", confidence: "high", extractor: "tool" });
    // G0: turnEndMs = t_arm_ms (60 000) + (now − armed_at) = 60 000 + 35 000.
    expect(ev.turnEndMs).toBe(95_000);
  });

  it("range check: callDate … callDate + 30 days; words that do not parse fall back to the LLM date", async () => {
    const { tools, ctx } = setup({ statuses: { effective_date: "PENDING" }, stage: "confirm" });
    const far = await tools.handle("confirm_effective_date", { date: "2026-11-09", customer_words: "sometime next month" }, ctx);
    expect(far.result).toEqual({ accepted: false, reason: "out_of_range", allowed: "today to October 25th" });
    const past = await tools.handle("confirm_effective_date", { date: "2026-09-20", customer_words: "uh the one we said" }, ctx);
    expect(past.result).toMatchObject({ accepted: false, reason: "out_of_range" });
    const none = await tools.handle("confirm_effective_date", { date: "soon", customer_words: "whenever" }, ctx);
    expect(none.result).toMatchObject({ accepted: false, reason: "unparseable" });
    const ok = await tools.handle("confirm_effective_date", { date: "2026-10-25", customer_words: "the twenty fifth" }, ctx);
    expect(ok.result).toMatchObject({ accepted: true, effective_date: "2026-10-25" });
  });
});

describe("update_case_field", () => {
  it("PENDING or MISSING → accepted as VERIFIED (ai_confirmed) and may advance the stage", async () => {
    const { tools, ctx } = setup({ statuses: { garaging_zip: "MISSING" }, stage: "confirm" });
    const r = await tools.handle("update_case_field", { field: "garaging_zip", value: "44107", reason: "newly_provided" }, ctx);
    expect(r.result).toEqual({ result: "accepted", field: "garaging_zip", status: "VERIFIED", value: "44107" });
    expect(r.stage).toBe("disclose");
    expect(r.transcriptionMode).toBe("min_latency");
  });

  it("the conflict flow: first incompatible update of a VERIFIED field → conflict; again with customer_corrected → accepted + flagged", async () => {
    const { tools, ctx, cases } = setup({ statuses: { garaging_zip: "MISSING" }, stage: "confirm" });
    const first = await tools.handle("update_case_field", { field: "license_state", value: "WI", reason: "customer_corrected" }, ctx);
    expect(first.result).toMatchObject({ result: "conflict", field: "license_state", recorded_value: "OH" });
    expect(String(first.result.instruction)).toContain("Read back the recorded value");
    expect(first.ui?.conflict).toMatchObject({ field: "license_state", resolved: false });
    expect(cases.cases.get("case_1")!.events).toHaveLength(0);

    const sameReason = await tools.handle("update_case_field", { field: "license_state", value: "WI", reason: "customer_confirmed" }, ctx);
    expect(sameReason.result.result).toBe("conflict");

    const second = await tools.handle("update_case_field", { field: "license_state", value: "WI", reason: "customer_corrected" }, ctx);
    expect(second.result).toMatchObject({ result: "accepted", field: "license_state", status: "VERIFIED", value: "WI" });
    expect(second.ui?.conflict).toMatchObject({ field: "license_state" });
    const fs = cases.cases.get("case_1")!.state.fields.license_state!;
    expect(fs.flags).toContain("customer_corrected_verified");
  });

  it("a compatible value for a VERIFIED field is accepted without a new event; an unparseable one is rejected", async () => {
    const { tools, ctx, cases } = setup({ stage: "disclose" });
    const same = await tools.handle("update_case_field", { field: "license_state", value: "oh", reason: "customer_confirmed" }, ctx);
    expect(same.result).toMatchObject({ result: "accepted", status: "VERIFIED" });
    const bad = await tools.handle("update_case_field", { field: "driver_dob", value: "??", reason: "newly_provided" }, ctx);
    expect(bad.result).toMatchObject({ result: "rejected", reason: "unparseable" });
    expect(cases.cases.get("case_1")!.events).toHaveLength(0);
  });
});

async function toPay(t: ReturnType<typeof setup>) {
  await t.tools.handle("get_disclosure", { kind: "premium_change" }, t.ctx);
  await t.tools.handle("get_disclosure", { kind: "esign_consent" }, t.ctx);
}

describe("send_esign_and_pay_link", () => {
  it("requires consent (acceptance 4) and the disclosures", async () => {
    const t = setup({ stage: "disclose" });
    const noDisc = await t.tools.handle("send_esign_and_pay_link", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes" }, t.ctx);
    expect(noDisc.result).toMatchObject({ status: "not_sent", reason: "disclosure_required" });
    await toPay(t);
    const r = await t.tools.handle("send_esign_and_pay_link", { customer_agreed_to_text: false, paper_copy_requested: false, customer_words: "no thanks" }, t.ctx);
    expect(r.result).toEqual({ status: "not_sent", reason: "consent_required" });
    expect(t.payStore.rows.size).toBe(0);
  });

  it("creates one payment for the disclosed amount and returns link_sent + ui at once; a repeat reuses it", async () => {
    const t = setup({ stage: "disclose" });
    await toPay(t);
    const r = await t.tools.handle("send_esign_and_pay_link", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes text me" }, t.ctx);
    expect(r.result).toEqual({ status: "link_sent" });
    expect(r.ui?.paymentId).toBeTruthy();
    expect(r.ui?.link).toBe(`http://localhost:3107/pay/${r.ui!.paymentId}`);
    expect(r.ui?.sms).toBe(`Harborview: Review & sign your change to policy NBM-4418207: http://localhost:3107/pay/${r.ui!.paymentId}`);
    const p = t.payStore.rows.get(r.ui!.paymentId!)!;
    expect(p.amountCents).toBe(920);
    const again = await t.tools.handle("send_esign_and_pay_link", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes" }, { ...t.ctx, callId: "call_y" });
    expect(again.ui?.paymentId).toBe(r.ui?.paymentId);
    expect(t.payStore.rows.size).toBe(1);
  });
});

describe("send_confirmation (server-authoritative, acceptance 2)", () => {
  it("before the payment succeeded → payment_not_confirmed; a client 'success' has no way in", async () => {
    const t = setup({ stage: "disclose", mode: "polar" });
    await toPay(t);
    const pay = await t.tools.handle("send_esign_and_pay_link", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes" }, t.ctx);
    const early = await t.tools.handle("send_confirmation", {}, { ...t.ctx, callId: "c2" });
    expect(early.result).toEqual({ ok: false, reason: "payment_not_confirmed" });
    // The embed says "success" → the client can only ask for a reconcile; Polar still says open → nothing moves.
    t.c.advance(2_000);
    const v = await t.payments.view(pay.ui!.paymentId!, { reconcile: true });
    expect(v.status).toBe("open");
    expect((await t.tools.handle("send_confirmation", {}, { ...t.ctx, callId: "c3" })).result).toMatchObject({ ok: false });
  });

  it("after a verified success → END- number (stable), SMS, case completed; the view carries the close stage payload", async () => {
    const t = setup({ stage: "disclose", mode: "polar" });
    t.payments["deps"].stagePayloadFor = (p) => t.tools.stagePayloadFor(p);
    await toPay(t);
    const pay = await t.tools.handle("send_esign_and_pay_link", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes" }, t.ctx);
    t.polar.setStatus("co_1", "succeeded");
    t.c.advance(2_000);
    const v = await t.payments.view(pay.ui!.paymentId!, { reconcile: true });
    expect(v.status).toBe("succeeded");
    expect(v.stagePayload).toMatchObject({ stage: "close", transcriptionMode: "min_latency" });
    expect(v.stagePayload!.tools.map((x) => x.name)).toEqual(["send_confirmation", "update_case_field", "hand_back_to_rep"]);
    expect((await t.store.getTakeover("tko_1"))!.stage).toBe("close");

    const r = await t.tools.handle("send_confirmation", {}, { ...t.ctx, callId: "c4" });
    expect(r.result).toEqual({ ok: true, confirmation_number: "END-48213", spoken: "E N D 4 8 2 1 3", sms_sent: true });
    expect(r.ui?.sms).toBe("Payment received. Confirmation END-48213");
    expect(t.store.caseStatus.get("case_1")).toBe("completed");
    const again = await t.tools.handle("send_confirmation", {}, { ...t.ctx, callId: "c5" });
    expect(again.result.confirmation_number).toBe("END-48213");
  });
});

describe("hand_back_to_rep", () => {
  it("returns at once with the rep's name; case → handed_back", async () => {
    const t = setup({ stage: "confirm", statuses: NOT_READY });
    const r = await t.tools.handle("hand_back_to_rep", { reason: "advice_requested", summary: "Asked about coverage." }, t.ctx);
    expect(r.result).toEqual({ status: "transferring", message: "Tell the customer Daniel is coming back on the line now." });
    expect(t.store.caseStatus.get("case_1")).toBe("handed_back");
    expect((await t.store.getTakeover("tko_1"))!.toolFlow.handBack).toMatchObject({ reason: "advice_requested" });
  });
});

describe("the full flow with PAYMENTS_MODE=mock (acceptance 5)", () => {
  it("confirm → disclose → pay → simulate → close → confirmation", async () => {
    const t = setup({ statuses: { effective_date: "PENDING" }, stage: "confirm", mode: "mock" });
    t.payments["deps"].stagePayloadFor = (p) => t.tools.stagePayloadFor(p);
    const d = await t.tools.handle("confirm_effective_date", { date: "2026-10-02", customer_words: "October 2nd, 2026-10-02" }, t.ctx);
    expect(d.stage).toBe("disclose");
    await toPay(t);
    const pay = await t.tools.handle("send_esign_and_pay_link", { customer_agreed_to_text: true, paper_copy_requested: true, customer_words: "sure" }, t.ctx);
    const id = pay.ui!.paymentId!;
    const v0 = await t.payments.view(id);
    expect(v0).toMatchObject({ provider: "mock", status: "open", embed: null });
    await t.payments.esign(id, "Priya Raman");
    await t.payments.simulate(id);
    const v = await t.payments.view(id);
    expect(v.toolResult).toMatchObject({ status: "paid", amount: "$9.20", verified_by: "simulated" });
    expect(v.stagePayload?.stage).toBe("close");
    const conf = await t.tools.handle("send_confirmation", {}, { ...t.ctx, callId: "z" });
    expect(conf.result).toMatchObject({ ok: true, confirmation_number: "END-48213" });
  });
});
