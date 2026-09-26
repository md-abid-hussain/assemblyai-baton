/**
 * WP16·2 acceptance 7 — the PLATFORM SLICE (TASKS-v3 §3 priority 9): the DENTAL relay, a relay with no Baton in it
 * anywhere, driven end to end through `RelayToolService` and the built-in connectors.
 *
 *   a lookup gives the deposit → the deposit link (mock, and the Polar sandbox with the billing address prefilled)
 *   → the confirmation, refused before the deposit is paid and issued after. An amount outside $1–$999 is clamped.
 *
 * `relay-parity.test.ts` proves the flagship still behaves as WP6 documented. This file proves the same code carries
 * a relay whose fields, stages, disclosure, amount and templates are all somebody else's: the case state holds
 * `patient_full_name` and `procedure`, the money comes out of a context table, and the payment bills the ONE generic
 * sandbox demo customer (`RELAY_DEMO_CUSTOMER_KEY`) with the sample's fictional address, because a relay has no
 * Baton scenario to look up in `POLAR_DEMO_CUSTOMERS`.
 *
 * $0 and offline: memory stores, a fake Polar API, no DB and no network. The case rows are built by hand rather than
 * by WP3's repository because the case-state widening (WP14a·4 / WP14b·3) lands in the same slot as this unit; the
 * kernel, the tool service and the connectors are all already generic over the field ids, which is what is asserted.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { CaseState, FactEvent, FieldId, FieldState, PolicyRecord } from "@/core/contracts/case";
import type { AccountRecord, Blueprint, CompiledRelay, RelayToolContext } from "@/core/contracts/v2";
import { AccountRecordSchema, BlueprintSchema } from "@/core/contracts/v2/blueprint";
import { compileRelay } from "@/core/relay/compile";
import { readinessFor } from "@/core/relay/spec";
import { MemoryConnectorCallLog } from "@/server/connectors/call-log";
import { RelayConnectorRuntime } from "@/server/connectors/runtime";
import { buildCheckoutCreate } from "@/server/polar/client";
import {
  accountToPolarCustomer, PAYMENT_MAX_CENTS, RELAY_DEMO_CUSTOMER_KEY, RELAY_FALLBACK_ADDRESS, relayPaymentPolicy,
} from "@/server/payments/relay-account";
import { PaymentService, POLAR_UNAVAILABLE_LABEL } from "@/server/payments/service";
import { RelayToolServiceImpl } from "@/server/tools/relay-tool-service";
import type { RelayRunCase, RelayRunSource } from "@/server/tools/relay-run-source";
import { FakePolar, MemoryPaymentStore, MemoryToolStore, policy as batonPolicy } from "./helpers";

const DENTAL = resolve(process.cwd(), "data/relays/dental-deposit.json");
const CASE_ID = "case_dental_1";
const TKO_ID = "tko_dental_1";
const ORIGIN = "http://localhost:3160";
const VERSION = "rv_dental_1";
const PRODUCT = "prod_demo_relay";
const SANDBOX_CUSTOMER = "cus_sandbox_relay";

const dentalBlueprint = (): Blueprint => BlueprintSchema.parse(JSON.parse(readFileSync(DENTAL, "utf8")));

/**
 * Acceptance 7's "a lookup gives the deposit": the deposit stops being a fixed number and becomes a `lookup` value
 * over a context table, keyed by the procedure the AI settled in the confirm stage. The gallery blueprint keeps its
 * fixed $50 (it is WP17's), so the variant is built here.
 */
function withDepositLookup(bp: Blueprint): Blueprint {
  return {
    ...bp,
    context: {
      ...bp.context,
      tables: [...bp.context.tables, { id: "deposits", label: "Deposits", columns: ["procedure", "deposit_usd"], idColumn: "procedure", labelColumn: "procedure" }],
    },
    values: bp.values.map((v) => (v.id === "deposit_due" ? { ...v, ref: { kind: "lookup" as const, table: "deposits", keyField: "procedure", column: "deposit_usd" } } : v)),
  };
}

const DEPOSIT_ROWS = [
  { procedure: "cleaning", deposit_usd: "40" },
  { procedure: "crown", deposit_usd: "125.50" },
  { procedure: "implant_consult", deposit_usd: "4200" },
];

function dentalAccount(bp: Blueprint, tables: Record<string, Record<string, string>[]> = {}): AccountRecord {
  const a = AccountRecordSchema.parse(bp.context.samples[0]);
  return { ...a, tables: { ...a.tables, ...tables } };
}

// ------------------------------------------------------------------------------------------ the dental case row

const DENTAL_VALUES: Record<string, string> = {
  patient_full_name: "maya ortiz", procedure: "crown", appointment_date: "2026-10-08", appointment_time: "9:30 am",
};

function dentalState(missing: readonly string[] = []): CaseState {
  const ids = ["patient_full_name", "procedure", "appointment_date", "appointment_time", "deposit_amount_usd"];
  const fields: Record<string, FieldState> = {};
  for (const id of ids) {
    const value = missing.includes(id) ? null : (DENTAL_VALUES[id] ?? null);
    fields[id] = {
      field: id as FieldId, status: value === null ? "MISSING" : "VERIFIED", reason: value === null ? "absent" : "acknowledged",
      value, display: value, source: value === null ? null : "customer", evidence: [], conflict: null, flags: [], updatedAtMs: 0,
    };
  }
  return {
    caseId: CASE_ID, intent: "add_driver", version: 0, callClockMs: 60_000,
    fields: fields as unknown as CaseState["fields"],
    readiness: { verified: 0, pending: 0, missing: 0, requiredTotal: 4, ready: false },
    conflicts: [], stage: null, disclosuresGiven: [], payment: null, confirmationNumber: null,
  };
}

/** WP3's repository for one hand-built generic case: enough derivation for `update_case_field` and readiness. */
class DentalCaseRepo {
  version = 0;
  constructor(
    private state: CaseState,
    private readonly spec: CompiledRelay["spec"],
  ) {}
  get current(): CaseState {
    return this.state;
  }
  async load() {
    return {
      state: structuredClone(this.state), version: this.version, policy: batonPolicy as PolicyRecord,
      status: "ai_active" as const, tArmMs: 60_000, scenarioId: "dental", callId: null, runPlan: null,
    };
  }
  async applyEvents(_caseId: string, _expected: number, events: Omit<FactEvent, "seq">[]) {
    const fields = this.state.fields as unknown as Record<string, FieldState | undefined>;
    for (const e of events) {
      const fs = fields[e.field];
      if (!fs || e.kind !== "tool_update" || e.valueNorm === null) continue;
      Object.assign(fs, { status: "VERIFIED", reason: "ai_confirmed", value: e.valueNorm, display: e.valueNorm, source: "ai" });
    }
    this.version += 1;
    this.state = { ...this.state, version: this.version, readiness: readinessFor(this.spec, this.state) };
    return { state: structuredClone(this.state), version: this.version };
  }
}

// ------------------------------------------------------------------------------------------ the harness

interface Harness {
  tools: RelayToolServiceImpl;
  store: MemoryToolStore;
  payStore: MemoryPaymentStore;
  callLog: MemoryConnectorCallLog;
  compiled: CompiledRelay;
  account: AccountRecord;
  polar: FakePolar;
  ctx: RelayToolContext;
}

interface Opts {
  blueprint?: Blueprint;
  /** Rows for the `deposits` context table (default: `DEPOSIT_ROWS`). */
  deposits?: Record<string, string>[];
  missing?: readonly string[];
  /** "mock" (default) = no Polar at all; "polar" = the sandbox provider with `FakePolar`. */
  mode?: "mock" | "polar";
  /** How many `createCheckout` calls the fake should fail (the Simulate fallback). */
  failCreates?: number;
  /** Drop the sample's address, to prove the fictional fallback address still prefills the form. */
  noAddress?: boolean;
}

async function harness(o: Opts = {}): Promise<Harness> {
  const bp = o.blueprint ?? withDepositLookup(dentalBlueprint());
  const compiled = compileRelay(bp, { versionId: VERSION, relayId: "rel_dental", flagship: false });
  const base = dentalAccount(bp, { deposits: o.deposits ?? DEPOSIT_ROWS });
  const account = o.noAddress ? { ...base, customer: { ...base.customer, address: undefined } } : base;

  const payStore = new MemoryPaymentStore();
  const store = new MemoryToolStore(payStore);
  const cases = new DentalCaseRepo(dentalState(o.missing), compiled.spec);
  store.addTakeover({ id: TKO_ID, caseId: CASE_ID });

  const polar = new FakePolar();
  polar.failCreates = o.failCreates ?? 0;
  const payments = new PaymentService({
    store: payStore,
    polar: o.mode === "polar" ? polar : null,
    polarConfig: o.mode === "polar" ? { productId: PRODUCT, demoCustomers: { [RELAY_DEMO_CUSTOMER_KEY]: SANDBOX_CUSTOMER }, embedOrigins: [ORIGIN], appUrl: ORIGIN } : null,
    mode: async () => o.mode ?? "mock",
    sleep: async () => undefined,
  });
  const callLog = new MemoryConnectorCallLog();
  const runs: RelayRunSource = {
    // `simCallId` set => not a recorded flagship run => the generic sandbox customer and the account's address.
    loadCase: async (id) =>
      id === CASE_ID
        ? ({ id: CASE_ID, policy: batonPolicy as PolicyRecord, scenarioId: "dental", callId: null, mode: "watch", relayVersionId: VERSION, simCallId: "sim_dental_1" } satisfies RelayRunCase)
        : null,
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
    confirmationNumber: () => "END-70412",
  });
  const tools = new RelayToolServiceImpl({
    runs,
    cases: { load: () => cases.load(), applyEvents: (id, v, e) => cases.applyEvents(id, v, e) },
    store, payments, connectors, callLog,
    config: { deployId: "wp16-dental", taxSuffix: false },
    confirmationNumber: () => "END-70412",
  });
  return {
    tools, store, payStore, callLog, compiled, account, polar,
    ctx: { caseId: CASE_ID, takeoverId: TKO_ID, callId: "c1", visitorId: "v1", origin: ORIGIN, mode: "test", publicationId: null },
  };
}

const call = (h: Harness, name: string, args: unknown, callId = "c1") => h.tools.handle(name, args, { ...h.ctx, callId });

/** Walk the relay to the `pay` stage: the deposit terms are read and accepted. */
async function atPay(h: Harness): Promise<void> {
  h.store.takeovers.get(TKO_ID)!.stage = "disclose";
  await call(h, "get_disclosure", { kind: "deposit_terms" }, "d_1");
}

const AGREE = { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes, text it" };
/** `esign_mock` always asks for the paper-copy answer too (the kernel adds it whenever a signature is involved). */
const SIGN = { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes, send it" };

// ============================================================================================ acceptance 7

describe("WP16·2 acceptance 7: the Dental relay, end to end on the generic connectors", () => {
  it("the stages advance on the dental exits, and the disclosure quotes the looked-up deposit", async () => {
    const h = await harness({ missing: ["appointment_time"] });

    // The confirm stage exits on `all_required_verified`, over the DENTAL required fields.
    const open = await call(h, "update_case_field", { field: "appointment_time", value: "9:30 am", reason: "newly_provided" }, "f1");
    expect(open.result).toMatchObject({ result: "accepted", field: "appointment_time", status: "VERIFIED" });
    expect(open.stage).toBe("disclose");
    expect(open.nextStep).toContain("get_disclosure");
    expect(open.tools?.map((t) => t.name)).toEqual(["get_disclosure", "update_case_field", "hand_back_to_rep"]);

    // `deposit_terms` is rendered from the blueprint: the deposit is the `deposits` row for "crown", not the $50
    // the gallery blueprint hard-codes, and the critical tokens are recorded for the verbatim check.
    const disc = await call(h, "get_disclosure", { kind: "deposit_terms" }, "f2");
    expect(disc.result.ok).toBe(true);
    expect(disc.result.text).toContain("$125.50 deposit");
    expect(disc.result.text).toContain("48 hours");
    expect(disc.stage).toBe("pay");
    expect(disc.nextStep).toContain("send_deposit_link");
    const rec = h.store.takeovers.get(TKO_ID)!.relayDisclosures.deposit_terms!;
    expect(rec.criticalTokens.length).toBeGreaterThan(0);
  });

  it("the deposit link: the amount is the looked-up row, the SMS is the relay's own template, and there is one payment", async () => {
    const h = await harness();
    await atPay(h);

    const refused = await call(h, "send_deposit_link", { ...AGREE, customer_agreed_to_text: false }, "p0");
    expect(refused.result).toEqual({ status: "not_sent", reason: "consent_required" });
    expect(h.payStore.rows.size).toBe(0);

    const pay = await call(h, "send_deposit_link", AGREE, "p1");
    expect(pay.result).toEqual({ status: "link_sent" });
    const paymentId = pay.ui!.paymentId!;
    expect(pay.ui!.link).toBe(`${ORIGIN}/pay/${paymentId}`);
    expect(pay.ui!.sms).toBe(`Cedar Hollow Dental: pay your $125.50 booking deposit here. ${ORIGIN}/pay/${paymentId}`);
    // `esign: false` on this connector, so no e-sign sheet is offered.
    expect(pay.ui!.esignId).toBeUndefined();
    expect(h.payStore.rows.get(paymentId)!.amountCents).toBe(12_550);

    // Still `pay`: the link being sent is not the deposit being paid.
    expect(pay.stage ?? "pay").toBe("pay");
    const again = await call(h, "send_deposit_link", AGREE, "p2");
    expect(again.ui!.paymentId).toBe(paymentId);
    expect(h.payStore.rows.size).toBe(1);
  });

  it("the confirmation is refused until the deposit is server-verified, then closes the booking", async () => {
    const h = await harness();
    await atPay(h);
    const pay = await call(h, "send_deposit_link", AGREE, "p1");
    const paymentId = pay.ui!.paymentId!;

    // The stage gate holds the relay in `pay` — `send_confirmation` is not on that stage at all.
    const gated = await call(h, "send_confirmation", {}, "c0");
    expect(gated.result).toMatchObject({ status: "not_available" });

    // And the handler refuses too, fail-closed, even with the gate opened by hand: a client-claimed success is
    // never enough, only `statusSource` webhook / server_poll / mock.
    h.store.takeovers.get(TKO_ID)!.stage = "close";
    await h.payStore.transition(paymentId, "succeeded", "webhook", { statusSource: null });
    const claimed = await call(h, "send_confirmation", {}, "c1");
    expect(claimed.result).toEqual({ ok: false, reason: "payment_not_confirmed" });
    expect(h.store.caseStatus.get(CASE_ID)).toBe("ai_active");

    h.payStore.rows.get(paymentId)!.statusSource = "mock";
    const conf = await call(h, "send_confirmation", {}, "c2");
    expect(conf.result).toMatchObject({ ok: true, confirmation_number: "END-70412", sms_sent: true });
    expect(conf.result.spoken).toBe("E N D 7 0 4 1 2");
    expect(conf.ui!.sms).toBe("Cedar Hollow Dental: your appointment is confirmed. Thank you, Maya. END-70412");
    expect(h.store.caseStatus.get(CASE_ID)).toBe("completed");

    // Only the executions are logged, and never the arguments themselves.
    expect(h.callLog.rows.map((r) => `${r.toolName}:${r.status}`)).toEqual([
      "send_deposit_link:ok", "send_confirmation:refused", "send_confirmation:ok",
    ]);
    expect(h.callLog.rows.every((r) => /^[0-9a-f]{64}$/.test(r.argsHash ?? ""))).toBe(true);
  });

  it("an amount outside $1-$999 is clamped before the checkout is opened", async () => {
    const high = await harness({ deposits: [{ procedure: "crown", deposit_usd: "4200" }] });
    await atPay(high);
    const a = await high.tools.handle("send_deposit_link", AGREE, { ...high.ctx, callId: "h1" });
    expect(high.payStore.rows.get(a.ui!.paymentId!)!.amountCents).toBe(PAYMENT_MAX_CENTS);

    const low = await harness({ deposits: [{ procedure: "crown", deposit_usd: "0.25" }] });
    await atPay(low);
    const b = await low.tools.handle("send_deposit_link", AGREE, { ...low.ctx, callId: "l1" });
    expect(low.payStore.rows.get(b.ui!.paymentId!)!.amountCents).toBe(100);
  });

  it("a deposit the table cannot supply refuses instead of charging a guess", async () => {
    const h = await harness({ deposits: [{ procedure: "cleaning", deposit_usd: "40" }] }); // no "crown" row
    await atPay(h);
    const r = await call(h, "send_deposit_link", AGREE, "p1");
    expect(r.result).toMatchObject({ status: "not_sent", reason: "amount_unavailable" });
    expect(h.payStore.rows.size).toBe(0);
  });
});

// ============================================================================================ the Polar adapter

describe("WP16·2: the Polar sandbox adapter for a relay (PLATFORM §6.1)", () => {
  it("bills the generic sandbox demo customer and prefills the sample's fictional billing address", async () => {
    const h = await harness({ mode: "polar" });
    await atPay(h);
    const pay = await call(h, "send_deposit_link", AGREE, "p1");
    expect(pay.result).toEqual({ status: "link_sent" });

    expect(h.polar.createCalls).toHaveLength(1);
    const req = h.polar.createCalls[0] as Record<string, any>;
    // The ONE generic relay customer, never a Baton scenario key: `POLAR_DEMO_CUSTOMERS["relay"]`.
    expect(req.customerId).toBe(SANDBOX_CUSTOMER);
    expect(req.customerName).toBeUndefined();
    // The address the judge does not have to type (research/12 §12), from the blueprint's fictional sample.
    expect(req.customerBillingAddress).toEqual({ country: "US", line1: "118 Larkspur Lane", city: "Fairview", state: "US-OR", postalCode: "97024" });
    expect(req.prices[PRODUCT][0]).toMatchObject({ amountType: "fixed", priceAmount: 12_550, priceCurrency: "usd", taxBehavior: "inclusive" });
    expect(req.allowDiscountCodes).toBe(false);
    expect(req.embedOrigin).toBe(ORIGIN);

    const row = h.payStore.rows.get(pay.ui!.paymentId!)!;
    expect(row.provider).toBe("polar");
    expect(row.status).toBe("open");
    expect(row.checkoutUrl).toContain("sandbox.polar.sh");
  });

  it("a sample with no address still prefills a fictional one rather than dropping the field", async () => {
    const h = await harness({ mode: "polar", noAddress: true });
    await atPay(h);
    await call(h, "send_deposit_link", AGREE, "p1");
    const req = h.polar.createCalls[0] as Record<string, any>;
    expect(req.customerBillingAddress).toEqual({
      country: "US", line1: RELAY_FALLBACK_ADDRESS.street, city: RELAY_FALLBACK_ADDRESS.city,
      state: `US-${RELAY_FALLBACK_ADDRESS.state}`, postalCode: RELAY_FALLBACK_ADDRESS.zip,
    });
  });

  it("Polar down falls back to Simulate: the agent still gets a link, and the row is a mock one", async () => {
    const h = await harness({ mode: "polar", failCreates: 2 }); // both the create and its one retry fail
    await atPay(h);
    const pay = await call(h, "send_deposit_link", AGREE, "p1");

    // The agent's answer is unchanged — a payment provider being down is not the caller's problem.
    expect(pay.result).toEqual({ status: "link_sent" });
    expect(pay.ui!.link).toBe(`${ORIGIN}/pay/${pay.ui!.paymentId}`);
    const row = h.payStore.rows.get(pay.ui!.paymentId!)!;
    expect(row.provider).toBe("mock");
    expect(row.status).toBe("open");
    expect(row.checkoutId).toBeNull();
    expect(h.polar.createCalls).toHaveLength(2);
    // The label the pay page shows; `ConnectorOutcome.ui` carries no such field, so the payment row is the truth.
    expect(POLAR_UNAVAILABLE_LABEL).toBe("Simulated payment (Polar unavailable)");

    // And Simulate still completes the booking, so the demo never dead-ends on a provider outage.
    await h.payStore.transition(row.id, "succeeded", "simulate", { statusSource: "mock", simulated: true });
    h.store.takeovers.get(TKO_ID)!.stage = "close";
    const conf = await call(h, "send_confirmation", {}, "c1");
    expect(conf.result).toMatchObject({ ok: true, confirmation_number: "END-70412" });
  });

  it("accountToPolarCustomer is exactly what buildCheckoutCreate prefills", async () => {
    const bp = dentalBlueprint();
    const account = dentalAccount(bp);
    const { policyholder, address } = accountToPolarCustomer(account);
    expect(policyholder).toEqual({ firstName: "Maya", lastName: "Ortiz" });
    expect(address).toEqual({ street: "118 Larkspur Lane", city: "Fairview", state: "OR", zip: "97024" });

    // The whole `PolicyRecord` the payment layer takes is derived, so nothing downstream sees a half-built record.
    const p = relayPaymentPolicy(account);
    expect(p.agencyName).toBe("Cedar Hollow Dental");
    expect(p.repFirstName).toBe("Dana");
    expect(p.phoneOnFileLast4).toBe("4417");
    expect(p.callDate).toBe(account.callDate);

    const req = buildCheckoutCreate({
      productId: PRODUCT, amountCents: 12_550, customerId: null, policy: p, embedOrigin: null,
      metadata: { paymentId: "pay_1", caseId: CASE_ID, takeoverId: TKO_ID },
    });
    expect(req.customerBillingAddress).toEqual({ country: "US", line1: "118 Larkspur Lane", city: "Fairview", state: "US-OR", postalCode: "97024" });
    // No demo customer configured → Polar at least gets the name, and only the email is typed.
    expect(req.customerName).toBe("Maya Ortiz");
  });
});

// ============================================================================================ the remaining built-ins

describe("WP16·2: esign_mock and a relay lookup tool", () => {
  let bp: Blueprint;
  beforeEach(() => {
    bp = withDepositLookup(dentalBlueprint());
  });

  it("esign_mock sends a sheet bound to the takeover, after consent and its disclosure", async () => {
    bp.connectors = [
      ...bp.connectors,
      {
        type: "esign_mock", id: "treatment_form", label: "Treatment form", toolName: "send_treatment_form",
        description: "Text the patient the treatment consent form to sign.",
        documentTitle: "{org.name} treatment consent for {customer.firstName}",
        smsTemplate: "{org.name}: please sign your treatment consent form.",
        requiresDisclosure: "deposit_terms",
      },
    ];
    bp.playbook.stages = bp.playbook.stages.map((s) => (s.kind === "act" ? { ...s, tools: [...s.tools, "send_treatment_form"] } : s));
    const h = await harness({ blueprint: bp });

    h.store.takeovers.get(TKO_ID)!.stage = "pay";
    const early = await call(h, "send_treatment_form", { ...SIGN, customer_agreed_to_text: true }, "e0");
    expect(early.result).toMatchObject({ status: "not_sent", reason: "disclosure_required" });

    await call(h, "get_disclosure", { kind: "deposit_terms" }, "e1");
    const noConsent = await call(h, "send_treatment_form", { ...SIGN, customer_agreed_to_text: false }, "e2");
    expect(noConsent.result).toEqual({ status: "not_sent", reason: "consent_required" });

    const sent = await call(h, "send_treatment_form", SIGN, "e3");
    expect(sent.result).toEqual({ status: "sent", document: "Cedar Hollow Dental treatment consent for Maya" });
    expect(sent.ui!.sms).toBe("Cedar Hollow Dental: please sign your treatment consent form.");
    expect(sent.ui!.esignId).toBe(`esg_${TKO_ID}_treatment_form`);
    expect(h.store.takeovers.get(TKO_ID)!.connectors.treatment_form).toBeDefined();
    // No checkout: an e-sign sheet is not a payment.
    expect(h.payStore.rows.size).toBe(0);
  });

  it("a lookup_table tool answers the fee question in the confirm stage, and a miss is not_found", async () => {
    bp.connectors = [
      ...bp.connectors,
      {
        type: "lookup_table", id: "fees", label: "Treatment fees", toolName: "lookup_fee",
        description: "Look up the fee for a treatment by its name.",
        table: "fees", keyColumn: "treatment", format: "csv", data: "treatment,fee_usd\ncrown,1240\ncleaning,180\n",
      },
    ];
    bp.playbook.stages = bp.playbook.stages.map((s) => (s.kind === "confirm" ? { ...s, tools: [...s.tools, "lookup_fee"] } : s));
    const h = await harness({ blueprint: bp, missing: ["appointment_time"] });

    const hit = await call(h, "lookup_fee", { key: " Crown " }, "k1");
    expect(hit.result).toEqual({ data: { treatment: "crown", fee_usd: "1240" } });
    const miss = await call(h, "lookup_fee", { key: "veneer" }, "k2");
    expect(miss.result).toEqual({ status: "not_found" });
    // A lookup changes no state, so it never moves the relay on.
    expect(hit.nextStep).toBeNull();
    expect(miss.nextStep).toBeNull();
    expect(h.callLog.rows.map((r) => r.status)).toEqual(["ok", "ok"]);
  });
});

// ============================================================================================ the sandbox setup

describe("WP16·2: the generic Polar sandbox demo customer", () => {
  it("scripts/polar/setup.ts creates exactly the customer the adapter looks up", async () => {
    const { RELAY_DEMO_SCENARIO, demoEmail } = await import("../../../../scripts/polar/setup");
    // The key `payment_link` passes as `scenarioId` for any relay, so the checkout finds a customer at all.
    expect(RELAY_DEMO_SCENARIO.id).toBe(RELAY_DEMO_CUSTOMER_KEY);
    // The same fictional address the adapter falls back to, so a relay with no sample address and the sandbox
    // customer do not disagree about where the buyer lives.
    expect(RELAY_DEMO_SCENARIO.customer.address).toEqual(RELAY_FALLBACK_ADDRESS);
    expect(demoEmail(undefined, RELAY_DEMO_SCENARIO.id)).toBe("baton-demo+relay@mailinator.com");
  });
});
