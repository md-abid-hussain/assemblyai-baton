/**
 * WP6 routes on real Postgres ($0): #14 tools (idempotency, invalid args → 200, auth), #15–#17 payments, the
 * additive timeout, and #18 the Polar webhook (acceptance 1: both schemes verify, tampered → 403, a replayed
 * webhook-id → no-op 202; acceptance 5: a late webhook after timeout reaches succeeded).
 */
import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { Webhook } from "standardwebhooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { resetEnvCache } from "@/server/env";
import { PaymentService } from "@/server/payments/service";
import { DbPaymentStore } from "@/server/payments/store";
import { getPayment, postEsign, postPolarWebhook, postSimulate, postTimeout } from "@/server/payments/routes";
import { kitRatingSource } from "@/server/rating";
import { postTool } from "@/server/tools/route";
import { Wp6ToolService } from "@/server/tools/service";
import { DbToolStore } from "@/server/tools/store";
import { jwtRequireTakeover, memoryRateLimiter, setWp6 } from "@/server/tools/wiring";
import { FakeCaseRepo, fakeCore, FakePolar, makeState, policy } from "../tools/helpers";
import { createTestDb, HAS_DB, seedCaseAndTakeover, type TestDb } from "./test-db";

const SECRET = randomBytes(32).toString("hex");
const WH_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const ORIGIN = "http://localhost:3107";

async function token(caseId: string, takeoverId: string, scp = ["case", "tools"], vid = "v1") {
  return new SignJWT({ vid, scp, tko: takeoverId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(caseId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(SECRET));
}

const params = <P extends Record<string, string>>(p: P) => ({ params: Promise.resolve(p) });

describe.skipIf(!HAS_DB)("WP6 routes (real Postgres)", () => {
  let t: TestDb;
  let polar: FakePolar;
  let cases: FakeCaseRepo;
  let payments: PaymentService;
  let tools: Wp6ToolService;
  let n = 0;

  beforeAll(async () => {
    process.env.CASE_TOKEN_SECRET = SECRET;
    resetEnvCache();
    t = await createTestDb("wp6routes");
    polar = new FakePolar();
    cases = new FakeCaseRepo();
    const payStore = new DbPaymentStore(t.db);
    const toolStore = new DbToolStore(t.db);
    payments = new PaymentService({
      store: payStore,
      polar,
      polarConfig: { productId: "prod_1", demoCustomers: { s01: "cus_1" }, embedOrigins: [ORIGIN], appUrl: ORIGIN },
      mode: async () => "polar",
      sleep: async () => undefined,
      stagePayloadFor: (p) => tools.stagePayloadFor(p),
    });
    tools = new Wp6ToolService({
      cases, store: toolStore, payments, core: () => fakeCore, rating: kitRatingSource,
      config: { deployId: "dev-wp6", payToolMode: "push", taxSuffix: false },
      newId: () => `ev_${++n}`,
    });
    setWp6({ payments, tools, toolStore, requireTakeover: jwtRequireTakeover, rateLimiter: memoryRateLimiter, webhookSecret: WH_SECRET, appUrl: ORIGIN });
  }, 60_000);

  afterAll(async () => {
    setWp6(null);
    await t?.drop();
  });

  async function seed(tag: string) {
    const ids = { caseId: `case_${tag}`, takeoverId: `tko_${tag}` };
    const state = makeState(ids.caseId);
    await seedCaseAndTakeover(t.db, ids, policy, state);
    cases.add(ids.caseId, state, "s01");
    return { ...ids, tok: await token(ids.caseId, ids.takeoverId) };
  }

  const toolReq = (name: string, tok: string, body: unknown) =>
    postTool(
      new Request(`${ORIGIN}/api/tools/${name}`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(body),
      }),
      params({ name }),
    );

  async function payFlow(tag: string) {
    const s = await seed(tag);
    await toolReq("get_disclosure", s.tok, { takeoverId: s.takeoverId, callId: "d1", args: { kind: "premium_change" } });
    const e = await toolReq("get_disclosure", s.tok, { takeoverId: s.takeoverId, callId: "d2", args: { kind: "esign_consent" } });
    expect((await e.json()).stage).toBe("pay");
    const r = await toolReq("send_esign_and_pay_link", s.tok, {
      takeoverId: s.takeoverId, callId: "p1", args: { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes" },
    });
    const body = await r.json();
    expect(body.result).toEqual({ status: "link_sent" });
    return { ...s, paymentId: body.ui.paymentId as string };
  }

  it("#14: auth, invalid args → 200 rejected, idempotent replay on (takeoverId, callId)", async () => {
    const s = await seed("a");
    const valid = JSON.stringify({ takeoverId: s.takeoverId, callId: "x", args: { kind: "premium_change" } });
    const noTok = await postTool(new Request(`${ORIGIN}/api/tools/get_disclosure`, { method: "POST", body: valid }), params({ name: "get_disclosure" }));
    expect(noTok.status).toBe(401);
    const badBody = await postTool(new Request(`${ORIGIN}/api/tools/get_disclosure`, { method: "POST", body: "{}" }), params({ name: "get_disclosure" }));
    expect(badBody.status).toBe(400);
    const other = await token("case_other", s.takeoverId);
    expect((await toolReq("get_disclosure", other, { takeoverId: s.takeoverId, callId: "x", args: { kind: "premium_change" } })).status).toBe(403);
    expect((await toolReq("nope", s.tok, { takeoverId: s.takeoverId, callId: "x", args: {} })).status).toBe(404);

    const bad = await toolReq("get_disclosure", s.tok, { takeoverId: s.takeoverId, callId: "c1", args: { kind: "weather" } });
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({ result: { ok: false, reason: "invalid_args" } });

    const first = await toolReq("get_disclosure", s.tok, { takeoverId: s.takeoverId, callId: "c2", args: { kind: "premium_change" } });
    const b1 = await first.json();
    expect(b1.result.ok).toBe(true);
    const again = await toolReq("get_disclosure", s.tok, { takeoverId: s.takeoverId, callId: "c2", args: { kind: "premium_change" } });
    const b2 = await again.json();
    expect(b2.result).toEqual(b1.result);
    expect(b2.stage).toBe("disclose");
    const rows = await t.db.select().from(schema.toolCalls).where(eq(schema.toolCalls.takeoverId, s.takeoverId));
    expect(rows.map((r) => [r.callId, r.status]).sort()).toEqual([["c1", "rejected"], ["c2", "ok"]]);
    // Disclosures merge into metrics without clobbering WP5's keys.
    const [tko] = await t.db.select().from(schema.takeovers).where(eq(schema.takeovers.id, s.takeoverId));
    expect(tko!.metrics).toMatchObject({ hud: { click_to_first_audible: 900 }, disclosures: { premium_change: { text: expect.any(String) } } });
  });

  it("#15/#16/#17: auth by the payment's takeover; esign; send_confirmation fails closed until simulate", async () => {
    const s = await payFlow("b");
    const get = (tok: string, q = "") =>
      getPayment(new Request(`${ORIGIN}/api/payments/${s.paymentId}${q}`, { headers: { authorization: `Bearer ${tok}` } }), params({ id: s.paymentId }));
    const v = await (await get(s.tok)).json();
    expect(v).toMatchObject({ id: s.paymentId, status: "open", provider: "polar", embed: { url: expect.stringContaining("sandbox.polar.sh") } });
    expect((await get(await token(s.caseId, "tko_other"))).status).toBe(403);
    expect((await getPayment(new Request(`${ORIGIN}/api/payments/nope`, { headers: { authorization: `Bearer ${s.tok}` } }), params({ id: "nope" }))).status).toBe(404);

    const es = await postEsign(
      new Request(`${ORIGIN}/api/payments/${s.paymentId}/esign`, { method: "POST", headers: { authorization: `Bearer ${s.tok}` }, body: JSON.stringify({ consent: true, typedName: "Priya Raman" }) }),
      params({ id: s.paymentId }),
    );
    expect(await es.json()).toMatchObject({ ok: true, signedAt: expect.any(String) });

    const conf1 = await toolReq("send_confirmation", s.tok, { takeoverId: s.takeoverId, callId: "k1", args: {} });
    expect((await conf1.json()).result).toEqual({ ok: false, reason: "payment_not_confirmed" });

    const sim = await postSimulate(new Request(`${ORIGIN}/api/payments/${s.paymentId}/simulate`, { method: "POST", headers: { authorization: `Bearer ${s.tok}` } }), params({ id: s.paymentId }));
    expect(await sim.json()).toEqual({ ok: true });
    const v2 = await (await get(s.tok)).json();
    expect(v2).toMatchObject({ status: "succeeded", statusSource: "mock", simulated: true, provider: "mock", label: "Simulated", toolResult: { status: "paid", verified_by: "simulated" } });
    expect(v2.stagePayload.stage).toBe("close");
    const conf2 = await toolReq("send_confirmation", s.tok, { takeoverId: s.takeoverId, callId: "k2", args: {} });
    expect((await conf2.json()).result).toMatchObject({ ok: true, confirmation_number: expect.stringMatching(/^END-\d{5}$/) });
    const [c] = await t.db.select().from(schema.cases).where(eq(schema.cases.id, s.caseId));
    expect(c!.status).toBe("completed");
  });

  const whReq = (body: string, headers: Headers) => postPolarWebhook(new Request(`${ORIGIN}/api/webhooks/polar`, { method: "POST", headers, body }), params({}));
  function sign(key: string, body: string, id: string) {
    const ts = new Date();
    return new Headers({ "webhook-id": id, "webhook-timestamp": String(Math.floor(ts.getTime() / 1000)), "webhook-signature": new Webhook(key).sign(id, ts, body), "content-type": "application/json" });
  }

  it("#18: tampered → 403; verified → 202 applied; replayed webhook-id → 202 no-op; late success after timeout", async () => {
    const s = await payFlow("c");
    const [p] = await t.db.select().from(schema.payments).where(eq(schema.payments.id, s.paymentId));
    const timeout = await postTimeout(new Request(`${ORIGIN}/x`, { method: "POST", headers: { authorization: `Bearer ${s.tok}` } }), params({ id: s.paymentId }));
    expect(await timeout.json()).toEqual({ ok: true, status: "timeout" });

    const body = JSON.stringify({ type: "order.paid", data: { id: "ord_1", checkout_id: p!.checkoutId, total_amount: p!.amountCents, metadata: { paymentId: p!.id } } });
    const h = sign(WH_SECRET, body, "msg_late_1");
    const tampered = await whReq(body.replace(`"total_amount":${p!.amountCents}`, '"total_amount":1'), h);
    expect(tampered.status).toBe(403);

    const ok = await whReq(body, h);
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ ok: true, outcome: "applied" });
    const [after] = await t.db.select().from(schema.payments).where(eq(schema.payments.id, s.paymentId));
    expect(after).toMatchObject({ status: "succeeded", statusSource: "webhook" });

    const replay = await whReq(body, h);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
    const [wh] = await t.db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, "polar:msg_late_1"));
    expect(wh).toMatchObject({ provider: "polar", type: "order.paid", error: null });
    expect(JSON.stringify(wh!.payload)).not.toContain("email");

    // The legacy scheme (base64 of the UTF-8 secret) verifies too; an unknown event is 202 and ignored.
    const legacyKey = Buffer.from(WH_SECRET, "utf-8").toString("base64");
    const other = JSON.stringify({ type: "customer.updated", data: { id: "cus_1" } });
    const ign = await whReq(other, sign(legacyKey, other, "msg_other_1"));
    expect(ign.status).toBe(202);
    expect(await ign.json()).toEqual({ ok: true, ignored: true });
  });

  it("DbPaymentStore: conditional forward-only writes under concurrency", async () => {
    const s = await payFlow("d");
    const store = new DbPaymentStore(t.db);
    const results = await Promise.all([
      store.transition(s.paymentId, "succeeded", "webhook", { statusSource: "webhook" }, { notSimulated: true }),
      store.transition(s.paymentId, "failed", "webhook", { statusSource: "webhook" }, { notSimulated: true }),
      store.transition(s.paymentId, "expired", "webhook", { statusSource: "webhook" }, { notSimulated: true }),
    ]);
    const winners = results.filter(Boolean);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    const final = await store.get(s.paymentId);
    // Whatever won first, nothing moved it backwards to open and at most one terminal state stuck.
    expect(["succeeded", "failed", "expired"]).toContain(final!.status);
    expect(await store.transition(s.paymentId, "open", "server_poll")).toBeNull();
  });
});
