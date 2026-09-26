/**
 * WP16·2 on the real stack ($0, real Postgres): `POST /api/tools/[name]` routed to `RelayToolService` because the
 * case carries a `relay_version_id`, running the REAL Baton blueprint through the REAL kernel, with WP3's
 * repository and WP2's auth. This is `g1-stack.test.ts` replayed on the relay path (PLATFORM §6.3, acceptance 6):
 * the same s01 flow, the same answers, plus `nextStep`, the stage gate and the route's idempotency.
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FieldId } from "@/core/contracts/case";
import { BlueprintSchema, type Blueprint } from "@/core/contracts/v2/blueprint";
import { policyToAccount } from "@/core/relay/account";
import { compileRelay } from "@/core/relay/compile";
import { issueCaseToken } from "@/server/auth/case-token";
import { issueVisitorToken } from "@/server/auth/visitor";
import { defaultEngine } from "@/server/cases/defaults";
import { PgCaseRepository } from "@/server/cases/repository";
import { PgConnectorCallLog } from "@/server/connectors/call-log";
import { RelayConnectorRuntime } from "@/server/connectors/runtime";
import * as schema from "@/server/db/schema";
import { resetEnvCache } from "@/server/env";
import { getPayment, postSimulate } from "@/server/payments/routes";
import { PaymentService } from "@/server/payments/service";
import { DbPaymentStore } from "@/server/payments/store";
import { kitRatingSource } from "@/server/rating";
import { wp1ToolCore, wp2RequireTakeover } from "@/server/tools/defaults";
import { dbRelayCaseLoader, type RelayRunSource } from "@/server/tools/relay-run-source";
import { RelayToolServiceImpl } from "@/server/tools/relay-tool-service";
import { postTool } from "@/server/tools/route";
import { Wp6ToolService } from "@/server/tools/service";
import { DbToolStore } from "@/server/tools/store";
import { memoryRateLimiter, setWp6 } from "@/server/tools/wiring";
import { policy } from "../../contracts/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "../payments/test-db";

const ORIGIN = "http://localhost:3160";
const VERSION_ID = "rv_baton_wp16";
const params = <P extends Record<string, string>>(p: P) => ({ params: Promise.resolve(p) });

function batonBlueprint(): Blueprint {
  return BlueprintSchema.parse(JSON.parse(readFileSync(resolve(process.cwd(), "data/relays/baton-add-driver.json"), "utf8")));
}

describe.skipIf(!HAS_DB)("WP16·2: /api/tools/[name] on the relay path (real kernel, real Postgres)", () => {
  let t: TestDb;
  let repo: PgCaseRepository;
  const saved = { cts: process.env.CASE_TOKEN_SECRET, vs: process.env.VISITOR_SECRET };

  beforeAll(async () => {
    process.env.CASE_TOKEN_SECRET = randomBytes(32).toString("hex");
    process.env.VISITOR_SECRET = randomBytes(32).toString("hex");
    resetEnvCache();
    t = await createTestDb("wp16relay");
    repo = new PgCaseRepository({ db: t.db, engine: defaultEngine(), policyOf: async () => policy });

    const bp = batonBlueprint();
    const compiled = compileRelay(bp, { versionId: VERSION_ID, relayId: "rel_baton", flagship: true });
    const account = policyToAccount(policy, await kitRatingSource("s01"));

    const payStore = new DbPaymentStore(t.db);
    const toolStore = new DbToolStore(t.db);
    let legacy: Wp6ToolService | null = null;
    const payments = new PaymentService({
      store: payStore, polar: null, polarConfig: null, mode: async () => "mock", sleep: async () => undefined,
      stagePayloadFor: (p) => legacy!.stagePayloadFor(p),
      extrasFor: (p, o) => legacy!.extrasFor(p, o),
    });
    legacy = new Wp6ToolService({
      cases: { load: (id) => repo.load(id), applyEvents: (id, v, e) => repo.applyEvents(id, v, e), setCaseExtras: (id, p) => repo.setCaseExtras(id, p) },
      store: toolStore, payments, core: () => wp1ToolCore, rating: kitRatingSource,
      config: { deployId: "wp16-parity", payToolMode: "push", taxSuffix: false },
    });

    const runs: RelayRunSource = {
      loadCase: dbRelayCaseLoader(() => t.db),
      compiled: async () => compiled,
      account: async () => account,
    };
    const callLog = new PgConnectorCallLog(t.pool);
    const connectors = new RelayConnectorRuntime({
      secrets: { resolve: async () => { throw new Error("no secrets here"); }, nameOf: async () => null },
      callLog,
      payments: { create: (i) => payments.create(i) },
      store: {
        markConnector: (id, r) => toolStore.markConnector(id, r),
        putConfirmationNumber: (id, n) => toolStore.putConfirmationNumber(id, n),
        setCaseStatus: (c, s, from) => toolStore.setCaseStatus(c, s, from),
      },
    });
    const relayTools = new RelayToolServiceImpl({
      runs,
      cases: { load: (id) => repo.load(id), applyEvents: (id, v, e) => repo.applyEvents(id, v, e), setCaseExtras: (id, p) => repo.setCaseExtras(id, p) },
      store: toolStore, payments, connectors, callLog,
      config: { deployId: "wp16-parity", taxSuffix: false },
    });

    setWp6({
      payments, tools: legacy, toolStore, requireTakeover: wp2RequireTakeover, rateLimiter: memoryRateLimiter,
      webhookSecret: null, appUrl: ORIGIN,
      relayTools, relayCaseOf: (id) => runs.loadCase(id), relayEngine: "legacy",
    });
  }, 60_000);

  afterAll(async () => {
    setWp6(null);
    await t?.drop();
    process.env.CASE_TOKEN_SECRET = saved.cts;
    process.env.VISITOR_SECRET = saved.vs;
    resetEnvCache();
  });

  async function seed(opts: { relay?: boolean } = {}) {
    const created = await repo.create({
      mode: "watch", callId: null, scenarioId: "s01", visitorId: "v1", ipKey: "ip1",
      ...(opts.relay === false ? {} : { relayVersionId: VERSION_ID }),
    });
    const takeoverId = `tko_${randomBytes(4).toString("hex")}`;
    await t.db.insert(schema.takeovers).values({ id: takeoverId, caseId: created.caseId, armedAt: new Date(), tArmMs: 60_000 });
    const tok = await issueCaseToken({ caseId: created.caseId, visitorId: "v1", takeoverId });
    return { caseId: created.caseId, takeoverId, tok, visitor: issueVisitorToken("v1") };
  }
  type S = Awaited<ReturnType<typeof seed>>;

  const headers = (s: S) => ({ authorization: `Bearer ${s.tok}`, "content-type": "application/json", origin: ORIGIN, "x-baton-visitor": s.visitor });
  async function tool(s: S, name: string, callId: string, args: unknown) {
    const res = await postTool(
      new Request(`${ORIGIN}/api/tools/${name}`, { method: "POST", headers: headers(s), body: JSON.stringify({ takeoverId: s.takeoverId, callId, args }) }),
      params({ name }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  it("the stage gate refuses an out-of-stage tool, and nothing is written", async () => {
    const s = await seed();
    const r = await tool(s, "send_confirmation", "x1", {});
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ status: "not_available" });
    const rows = await t.db.select().from(schema.payments).where(eq(schema.payments.takeoverId, s.takeoverId));
    expect(rows).toHaveLength(0);
  });

  it("a case with no relay version still runs the legacy Baton service", async () => {
    const s = await seed({ relay: false });
    const r = await tool(s, "update_case_field", "l1", { field: "garaging_zip", value: "44107", reason: "newly_provided" });
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ result: "accepted", field: "garaging_zip" });
    // The legacy path writes the WP6 event id; both paths share it, so the proof is the absence of connector rows.
    const cc = await t.pool.query("select count(*)::int as n from connector_calls where takeover_id = $1", [s.takeoverId]);
    expect(cc.rows[0]!.n).toBe(0);
  });

  it("s01 end to end on the relay path: fields → date → disclosures → pay → simulate → close → confirmation", async () => {
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
        expect(r.body.nextStep).toBeNull();
      }
    }

    const bad = await tool(s, "confirm_effective_date", "d0", { date: "2026-12-25", customer_words: "Christmas day" });
    expect(bad.body.result).toMatchObject({ accepted: false, reason: "out_of_range" });
    const d = await tool(s, "confirm_effective_date", "d1", { date: "2026-10-02", customer_words: "October 2nd" });
    expect(d.body.result).toMatchObject({ accepted: true, effective_date: "2026-10-02", next: "disclose" });
    expect(d.body.stage).toBe("disclose");
    expect(d.body.nextStep).toContain("get_disclosure");

    const early = await tool(s, "send_esign_and_pay_link", "p0", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes" });
    expect(early.body.result).toMatchObject({ status: "not_available" }); // the pay tool is not in the disclose stage

    const prem = await tool(s, "get_disclosure", "g1", { kind: "premium_change" });
    expect(prem.body.result).toMatchObject({ ok: true });
    expect(prem.body.result.text).toContain("$142");
    const esign = await tool(s, "get_disclosure", "g2", { kind: "esign_consent" });
    expect(esign.body.result.ok).toBe(true);
    expect(esign.body.stage).toBe("pay");
    expect(esign.body.nextStep).toContain("send_esign_and_pay_link");

    const [tk] = await t.db.select({ metrics: schema.takeovers.metrics }).from(schema.takeovers).where(eq(schema.takeovers.id, s.takeoverId));
    const disc = (tk!.metrics as { disclosures: Record<string, { text: string; criticalTokens: string[] }> }).disclosures;
    expect(disc.premium_change!.text).toBe(prem.body.result.text);
    expect(disc.esign_consent!.criticalTokens.length).toBeGreaterThan(0);

    const noConsent = await tool(s, "send_esign_and_pay_link", "p1", { customer_agreed_to_text: false, paper_copy_requested: false, customer_words: "no" });
    expect(noConsent.body.result).toEqual({ status: "not_sent", reason: "consent_required" });

    const pay = await tool(s, "send_esign_and_pay_link", "p2", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes text me" });
    expect(pay.body.result).toEqual({ status: "link_sent" });
    const paymentId = pay.body.ui.paymentId as string;
    expect(pay.body.ui.link).toBe(`${ORIGIN}/pay/${paymentId}`);
    expect(pay.body.ui.sms).toContain(pay.body.ui.link);

    // Route idempotency: the same call_id replays the stored result, and no second payment is created.
    const replay = await tool(s, "send_esign_and_pay_link", "p2", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes text me" });
    expect(replay.body.result).toEqual({ status: "link_sent" });
    expect(replay.body.ui.paymentId).toBe(paymentId);
    const pays = await t.db.select().from(schema.payments).where(eq(schema.payments.takeoverId, s.takeoverId));
    expect(pays).toHaveLength(1);

    // Before the payment succeeds the relay is still in `pay`, so the STAGE GATE refuses the confirmation — one
    // step earlier than the legacy handler's `payment_not_confirmed` (acceptance 8; the handler refusal is still
    // there as a fail-safe and is exercised in relay-parity.test.ts).
    const tooEarly = await tool(s, "send_confirmation", "c0", {});
    expect(tooEarly.body.result).toMatchObject({ status: "not_available" });

    const payReq = (path: string, method: "GET" | "POST") => new Request(`${ORIGIN}/api/payments/${paymentId}${path}`, { method, headers: headers(s) });
    expect((await postSimulate(payReq("/simulate", "POST"), params({ id: paymentId }))).status).toBe(200);
    const view = (await (await getPayment(payReq("", "GET"), params({ id: paymentId }))).json()) as Record<string, any>;
    expect(view.status).toBe("succeeded");

    const conf = await tool(s, "send_confirmation", "c1", {});
    expect(conf.body.result).toMatchObject({ ok: true, sms_sent: true });
    expect(conf.body.result.confirmation_number).toMatch(/^END-\d{5}$/);
    expect(conf.body.result.spoken).toBe(String(conf.body.result.confirmation_number).replace("-", "").split("").join(" "));

    // The flow is mirrored into cases.state, exactly as on the legacy path.
    const c = await repo.load(s.caseId);
    expect(c!.status).toBe("completed");
    expect(c!.state.stage).toBe("close");
    expect(c!.state.disclosuresGiven).toEqual(["premium_change", "esign_consent"]);
    expect(c!.state.payment).toMatchObject({ id: paymentId, status: "succeeded", simulated: true });
    expect(c!.state.confirmationNumber).toBe(conf.body.result.confirmation_number);

    // Every connector EXECUTION is logged with its args hash (and nothing else about the args). Exactly three ran:
    // the consent refusal (p1), the link (p2) and the confirmation (c1). The two stage-gate refusals (p0, c0) and
    // the idempotent replay of p2 never reached a connector, so they leave no row — `connector_calls` is the
    // connector-health source (PLATFORM §9), not a tool-call audit.
    const cc = await t.pool.query<{ tool_name: string; status: string; args_hash: string; connector_id: string }>(
      "select tool_name, status, args_hash, connector_id from connector_calls where takeover_id = $1 order by created_at",
      [s.takeoverId],
    );
    expect(cc.rows.map((r) => r.tool_name)).toEqual(["send_esign_and_pay_link", "send_esign_and_pay_link", "send_confirmation"]);
    expect(cc.rows.map((r) => r.status)).toEqual(["refused", "ok", "ok"]);
    expect(cc.rows[1]!.connector_id).toBe("esign_pay");
    expect(cc.rows[2]!.connector_id).toBe("confirmation");
    expect(cc.rows[1]!.args_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cc.rows[1]!.args_hash).not.toContain(createHash("sha256").update("nothing").digest("hex"));
  }, 60_000);
});
