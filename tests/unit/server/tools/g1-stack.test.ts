/**
 * WP6 on the real G1 stack ($0, real Postgres): route #14 and #15/#17 with WP1's core (`wp1ToolCore`), WP3's
 * `PgCaseRepository` (applyEvents + setCaseExtras) and WP2's `requireCase` (case JWT + visitor match), in
 * PAYMENTS_MODE=mock. The s01 flow from an empty case: tool updates for every required field → confirm the date →
 * both disclosures → pay link (push) → confirmation refused → Simulate → close → confirmation.
 * This is the handler contract WP16 replays against `RelayToolService` (docs/notes/wp6.md "Handler contract").
 */
import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FieldId } from "@/core/contracts/case";
import { issueCaseToken } from "@/server/auth/case-token";
import { issueVisitorToken } from "@/server/auth/visitor";
import { defaultEngine } from "@/server/cases/defaults";
import { PgCaseRepository } from "@/server/cases/repository";
import * as schema from "@/server/db/schema";
import { resetEnvCache } from "@/server/env";
import { getPayment, postSimulate } from "@/server/payments/routes";
import { PaymentService } from "@/server/payments/service";
import { DbPaymentStore } from "@/server/payments/store";
import { kitRatingSource } from "@/server/rating";
import { wp1ToolCore, wp2RequireTakeover } from "@/server/tools/defaults";
import { postTool } from "@/server/tools/route";
import { toolEventId, Wp6ToolService } from "@/server/tools/service";
import { DbToolStore } from "@/server/tools/store";
import { memoryRateLimiter, setWp6 } from "@/server/tools/wiring";
import { policy } from "../../contracts/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "../payments/test-db";

const ORIGIN = "http://localhost:3107";
const params = <P extends Record<string, string>>(p: P) => ({ params: Promise.resolve(p) });

describe.skipIf(!HAS_DB)("WP6 on the G1 stack (WP1 core, WP3 repository, WP2 auth; real Postgres)", () => {
  let t: TestDb;
  let repo: PgCaseRepository;
  const saved = { cts: process.env.CASE_TOKEN_SECRET, vs: process.env.VISITOR_SECRET };

  beforeAll(async () => {
    process.env.CASE_TOKEN_SECRET = randomBytes(32).toString("hex");
    process.env.VISITOR_SECRET = randomBytes(32).toString("hex");
    resetEnvCache();
    t = await createTestDb("wp6g1");
    repo = new PgCaseRepository({ db: t.db, engine: defaultEngine(), policyOf: async () => policy });
    let tools: Wp6ToolService | null = null;
    const payments = new PaymentService({
      store: new DbPaymentStore(t.db),
      polar: null,
      polarConfig: null,
      mode: async () => "mock",
      sleep: async () => undefined,
      stagePayloadFor: (p) => tools!.stagePayloadFor(p),
      extrasFor: (p, o) => tools!.extrasFor(p, o),
    });
    const toolStore = new DbToolStore(t.db);
    tools = new Wp6ToolService({
      cases: { load: (id) => repo.load(id), applyEvents: (id, v, e) => repo.applyEvents(id, v, e), setCaseExtras: (id, p) => repo.setCaseExtras(id, p) },
      store: toolStore,
      payments,
      core: () => wp1ToolCore,
      rating: kitRatingSource,
      config: { deployId: "dev-wp6", payToolMode: "push", taxSuffix: false },
    });
    setWp6({ payments, tools, toolStore, requireTakeover: wp2RequireTakeover, rateLimiter: memoryRateLimiter, webhookSecret: null, appUrl: ORIGIN });
  }, 60_000);

  afterAll(async () => {
    setWp6(null);
    await t?.drop();
    process.env.CASE_TOKEN_SECRET = saved.cts;
    process.env.VISITOR_SECRET = saved.vs;
    resetEnvCache();
  });

  async function seed() {
    const created = await repo.create({ mode: "watch", callId: null, scenarioId: "s01", visitorId: "v1", ipKey: "ip1" });
    const takeoverId = `tko_${randomBytes(4).toString("hex")}`;
    await t.db.insert(schema.takeovers).values({ id: takeoverId, caseId: created.caseId, armedAt: new Date(), tArmMs: 60_000 });
    const tok = await issueCaseToken({ caseId: created.caseId, visitorId: "v1", takeoverId });
    return { caseId: created.caseId, takeoverId, tok, visitor: issueVisitorToken("v1") };
  }
  type S = Awaited<ReturnType<typeof seed>>;

  const headers = (s: S, visitor: string | null = s.visitor) => ({
    authorization: `Bearer ${s.tok}`, "content-type": "application/json", origin: ORIGIN, ...(visitor ? { "x-baton-visitor": visitor } : {}),
  });
  async function tool(s: S, name: string, callId: string, args: unknown, visitor?: string | null) {
    const res = await postTool(
      new Request(`${ORIGIN}/api/tools/${name}`, { method: "POST", headers: headers(s, visitor), body: JSON.stringify({ takeoverId: s.takeoverId, callId, args }) }),
      params({ name }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  it("rejects a token whose visitor does not match (WP2 requireCase)", async () => {
    const s = await seed();
    const r = await tool(s, "update_case_field", "x1", { field: "garaging_zip", value: "44107", reason: "newly_provided" }, issueVisitorToken("someone-else"));
    expect(r.status).toBe(403);
    const none = await tool(s, "update_case_field", "x2", { field: "garaging_zip", value: "44107", reason: "newly_provided" }, null);
    expect(none.status).toBe(403); // no cookie and no header → a fresh visitor id → mismatch
  });

  it("s01 end to end: fields → date → disclosures → pay (push) → simulate → close → confirmation; cases.state mirrors the flow", async () => {
    const s = await seed();
    const fields: [FieldId, string][] = [
      ["driver_full_name", "Maya Raman"], ["driver_dob", "March 14, 2009"], ["driver_relation", "daughter"], ["license_state", "Ohio"],
      ["license_status", "provisional"], ["vehicle_assignment", "2021 Honda Civic"], ["operator_type", "primary"], ["garaging_zip", "44107"],
    ];
    let i = 0;
    for (const [field, value] of fields) {
      const r = await tool(s, "update_case_field", `f${++i}`, { field, value, reason: "newly_provided" });
      expect(r.status, field).toBe(200);
      expect(r.body.result, field).toMatchObject({ result: "accepted", field, status: "VERIFIED" });
      if (i === 1) {
        expect(r.body.stage).toBe("confirm");
        expect(r.body.tools.map((x: { name: string }) => x.name)).toContain("update_case_field");
        expect(typeof r.body.systemPrompt).toBe("string");
      }
    }
    // Deterministic tool_update ids (wp3-to-wp6 item 1).
    const evs = await t.db.select({ id: schema.factEvents.id, kind: schema.factEvents.kind }).from(schema.factEvents).where(eq(schema.factEvents.caseId, s.caseId));
    expect(evs.map((e) => e.id)).toContain(toolEventId(s.caseId, s.takeoverId, "f1"));
    expect(evs.every((e) => e.kind === "tool_update")).toBe(true);

    const bad = await tool(s, "confirm_effective_date", "d0", { date: "2026-12-25", customer_words: "Christmas day" });
    expect(bad.body.result).toMatchObject({ accepted: false, reason: "out_of_range" });
    const d = await tool(s, "confirm_effective_date", "d1", { date: "2026-10-02", customer_words: "October 2nd" });
    expect(d.body.result).toMatchObject({ accepted: true, effective_date: "2026-10-02", next: "disclose" });
    expect(d.body.stage).toBe("disclose");
    expect(d.body.tools.map((x: { name: string }) => x.name)).toContain("get_disclosure");

    const early = await tool(s, "send_esign_and_pay_link", "p0", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes" });
    expect(early.body.result).toMatchObject({ status: "not_sent", reason: "disclosure_required" });
    const prem = await tool(s, "get_disclosure", "g1", { kind: "premium_change" });
    expect(prem.body.result).toMatchObject({ ok: true });
    expect(prem.body.result.text).toContain("$142");
    const esign = await tool(s, "get_disclosure", "g2", { kind: "esign_consent" });
    expect(esign.body.result.ok).toBe(true);
    expect(esign.body.stage).toBe("pay");
    const payTool = (esign.body.tools as { name: string; execution_mode?: string }[]).find((x) => x.name === "send_esign_and_pay_link");
    expect(payTool?.execution_mode).toBe("interactive"); // push mode (T-D1-1)
    // wp8-to-wp6 item 1: the verbatim disclosure text is in takeovers.metrics.disclosures[kind].
    const [tk] = await t.db.select({ metrics: schema.takeovers.metrics }).from(schema.takeovers).where(eq(schema.takeovers.id, s.takeoverId));
    const disc = (tk!.metrics as { disclosures: Record<string, { text: string; criticalTokens: string[] }> }).disclosures;
    expect(disc.premium_change!.text).toBe(prem.body.result.text);
    expect(disc.esign_consent!.criticalTokens.length).toBeGreaterThan(0);

    const noConsent = await tool(s, "send_esign_and_pay_link", "p1", { customer_agreed_to_text: false, paper_copy_requested: false, customer_words: "no" });
    expect(noConsent.body.result).toMatchObject({ status: "not_sent", reason: "consent_required" });
    const pay = await tool(s, "send_esign_and_pay_link", "p2", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes text me" });
    expect(pay.body.result).toEqual({ status: "link_sent" });
    expect(pay.body.ui.link).toBe(`${ORIGIN}/pay/${pay.body.ui.paymentId}`);
    expect(pay.body.ui.sms).toContain(policy.policyNumber);
    const paymentId = pay.body.ui.paymentId as string;

    const tooEarly = await tool(s, "send_confirmation", "c0", {});
    expect(tooEarly.body.result).toEqual({ ok: false, reason: "payment_not_confirmed" });

    const payReq = (path: string, method: "GET" | "POST") => new Request(`${ORIGIN}/api/payments/${paymentId}${path}`, { method, headers: headers(s) });
    expect((await postSimulate(payReq("/simulate", "POST"), params({ id: paymentId }))).status).toBe(200);
    const view = (await (await getPayment(payReq("", "GET"), params({ id: paymentId }))).json()) as Record<string, any>;
    expect(view.status).toBe("succeeded");
    expect(view.simulated).toBe(true);
    expect(view.stagePayload).toMatchObject({ stage: "close", transcriptionMode: "min_latency" });
    expect(view.stagePayload.tools.map((x: { name: string }) => x.name)).toContain("send_confirmation");

    const conf = await tool(s, "send_confirmation", "c1", {});
    expect(conf.body.result).toMatchObject({ ok: true, sms_sent: true });
    expect(conf.body.result.confirmation_number).toMatch(/^END-\d{5}$/);
    expect(conf.body.result.spoken).toBe(conf.body.result.confirmation_number.replace("-", "").split("").join(" "));

    // wp3-to-wp6 item 2: the flow parts are mirrored into cases.state via setCaseExtras.
    const c = await repo.load(s.caseId);
    expect(c!.status).toBe("completed");
    expect(c!.state.stage).toBe("close");
    expect(c!.state.disclosuresGiven).toEqual(["premium_change", "esign_consent"]);
    expect(c!.state.payment).toMatchObject({ id: paymentId, status: "succeeded", simulated: true });
    expect(c!.state.confirmationNumber).toBe(conf.body.result.confirmation_number);
    expect(c!.state.readiness.ready).toBe(true);
    for (const [f] of fields) expect(c!.state.fields[f].status, f).toBe("VERIFIED");

    // wp8-to-wp6 item 2: status_source is set on the transition to succeeded.
    const [prow] = await t.db.select().from(schema.payments).where(eq(schema.payments.id, paymentId));
    expect(prow!.statusSource).toBe("mock");
    expect(prow!.simulated).toBe(true);
  }, 30_000);
});
