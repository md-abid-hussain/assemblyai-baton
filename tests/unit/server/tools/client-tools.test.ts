/**
 * WP6 browser-side modules (pure logic; they live in src/client/tools, the tests sit in WP6's owned test folder):
 * callTool() retries, the payments client, awaitPaymentResolution() (progress-aware deadline, server-built result,
 * client timeout), and the MockPhone state machine incl. autopilot.
 */
import { describe, expect, it, vi } from "vitest";

import { createCallTool, ToolCallError } from "@/client/tools/call-tool";
import { awaitPaymentResolution, nextHoldDeadline, PaymentHttpError, reassureDue } from "@/client/tools/payments";
import { autopilotAction, countdownLeftS, initialPhone, phoneReducer, type PhoneEvent, type PhoneModel } from "@/client/tools/phone-machine";
import type { PaymentViewExt } from "@/core/contracts/ext/wp6-payments";
import type { PhoneState } from "@/core/contracts/services";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("callTool()", () => {
  it("posts the route #14 body with the takeover token and parses ToolResponse", async () => {
    const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => json(200, { result: { ok: true }, stage: "pay" }));
    const call = createCallTool({ token: () => "tok", fetch: f as unknown as typeof fetch, retryDelayMs: 0 });
    const r = await call("get_disclosure", { kind: "premium_change" }, { takeoverId: "t1", callId: "c1" });
    expect(r).toEqual({ result: { ok: true }, stage: "pay" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("/api/tools/get_disclosure");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(init!.body as string)).toEqual({ takeoverId: "t1", callId: "c1", args: { kind: "premium_change" } });
  });

  it("retries once (same call_id) on 409/5xx/network; a 4xx is thrown as ToolCallError", async () => {
    let n = 0;
    const flaky = vi.fn(async () => (++n === 1 ? json(503, { error: { code: "E_INTERNAL", message: "x" } }) : json(200, { result: { a: 1 } })));
    expect(await createCallTool({ token: () => "t", fetch: flaky as unknown as typeof fetch, retryDelayMs: 0 })("send_confirmation", {}, { takeoverId: "t", callId: "c" })).toEqual({ result: { a: 1 } });
    expect(flaky).toHaveBeenCalledTimes(2);
    const forbidden = vi.fn(async () => json(403, { error: { code: "E_FORBIDDEN", message: "no" } }));
    await expect(createCallTool({ token: () => "t", fetch: forbidden as unknown as typeof fetch, retryDelayMs: 0 })("send_confirmation", {}, { takeoverId: "t", callId: "c" })).rejects.toMatchObject({ status: 403, code: "E_FORBIDDEN" });
    expect(forbidden).toHaveBeenCalledTimes(1);
    const down = vi.fn(async () => {
      throw new TypeError("offline");
    });
    await expect(createCallTool({ token: () => "t", fetch: down as unknown as typeof fetch, retryDelayMs: 0 })("send_confirmation", {}, { takeoverId: "t", callId: "c" })).rejects.toBeInstanceOf(ToolCallError);
    expect(down).toHaveBeenCalledTimes(2);
  });
});

describe("hold deadline (DESIGN §5.8 step 4) and reassurance (step 5)", () => {
  const sms = 0;
  it("60 s while sms-received; extends in 30 s steps while the phone is active, capped at 180 s", () => {
    expect(nextHoldDeadline({ smsAtMs: sms, deadlineMs: 60_000, nowMs: 59_000, phone: "sms-received" })).toBe(60_000);
    expect(nextHoldDeadline({ smsAtMs: sms, deadlineMs: 60_000, nowMs: 40_000, phone: "esign" })).toBe(90_000);
    expect(nextHoldDeadline({ smsAtMs: sms, deadlineMs: 90_000, nowMs: 50_000, phone: "checkout-open" })).toBe(90_000);
    expect(nextHoldDeadline({ smsAtMs: sms, deadlineMs: 170_000, nowMs: 169_000, phone: "processing" })).toBe(180_000);
    expect(nextHoldDeadline({ smsAtMs: sms, deadlineMs: 180_000, nowMs: 179_000, phone: "processing" })).toBe(180_000);
  });
  it("reassures every 45 s except while the overlay is open or processing", () => {
    expect(reassureDue({ smsAtMs: 0, nowMs: 44_000, sent: 0, phone: "sms-received" })).toBe(false);
    expect(reassureDue({ smsAtMs: 0, nowMs: 45_000, sent: 0, phone: "sms-received" })).toBe(true);
    expect(reassureDue({ smsAtMs: 0, nowMs: 50_000, sent: 0, phone: "checkout-open" })).toBe(false);
    expect(reassureDue({ smsAtMs: 0, nowMs: 91_000, sent: 1, phone: "signed" })).toBe(true);
  });
});

function view(status: PaymentViewExt["status"], extra: Partial<PaymentViewExt> = {}): PaymentViewExt {
  return { id: "p1", status, statusSource: null, amountCents: 2340, totalAmountCents: 2340, provider: "polar", simulated: false, embed: null, updatedAt: "2026-09-25T12:00:00Z", ...extra };
}

describe("awaitPaymentResolution()", () => {
  it("resolves with the SERVER-built result once terminal; ignores 429s and blips", async () => {
    let t = 0;
    const seq: (PaymentViewExt | Error)[] = [view("open"), new PaymentHttpError(429, "E_RATE_LIMITED"), view("confirmed"), view("succeeded", { statusSource: "webhook", toolResult: { status: "paid", amount: "$23.40", receipt: "PAY-000001", verified_by: "polar_webhook" } })];
    const client = {
      get: vi.fn(async () => {
        const x = seq.shift()!;
        if (x instanceof Error) throw x;
        return x;
      }),
      timeout: vi.fn(async () => ({ ok: true as const, status: "timeout" })),
    };
    const views: string[] = [];
    const r = await awaitPaymentResolution(client, { paymentId: "p1", smsAtMs: 0, phoneState: () => "sms-received", now: () => t, sleep: async (ms) => void (t += ms), onView: (v) => views.push(v.status) });
    expect(r).toMatchObject({ timedOut: false, result: { status: "paid", verified_by: "polar_webhook" } });
    expect(views).toEqual(["open", "confirmed", "succeeded"]);
    expect(client.timeout).not.toHaveBeenCalled();
  });

  it("times out at 60 s when the phone is untouched, tells the server, and builds the timeout result itself", async () => {
    let t = 0;
    const client = { get: vi.fn(async () => view("open")), timeout: vi.fn(async () => ({ ok: true as const, status: "timeout" })) };
    const r = await awaitPaymentResolution(client, { paymentId: "p1", smsAtMs: 0, phoneState: () => "sms-received", now: () => t, sleep: async (ms) => void (t += ms) });
    expect(r.timedOut).toBe(true);
    expect(r.result).toMatchObject({ status: "timeout" });
    expect(t).toBeGreaterThanOrEqual(60_000);
    expect(t).toBeLessThan(62_000);
    expect(client.timeout).toHaveBeenCalledWith("p1");
  });

  it("an active phone stretches the hold to at most 180 s", async () => {
    let t = 0;
    const client = { get: vi.fn(async () => view("open")), timeout: vi.fn(async () => ({ ok: true as const, status: "timeout" })) };
    const r = await awaitPaymentResolution(client, { paymentId: "p1", smsAtMs: 0, phoneState: (): PhoneState => "checkout-open", now: () => t, sleep: async (ms) => void (t += ms) });
    expect(r.timedOut).toBe(true);
    expect(t).toBeGreaterThanOrEqual(180_000);
    expect(t).toBeLessThan(182_000);
  });

  it("gives up on 403/404", async () => {
    const client = { get: vi.fn(async () => { throw new PaymentHttpError(404, "E_NOT_FOUND"); }), timeout: vi.fn() };
    await expect(awaitPaymentResolution(client, { paymentId: "p1", smsAtMs: 0, phoneState: () => "sms-received", now: () => 0, sleep: async () => undefined })).rejects.toMatchObject({ status: 404 });
  });
});

describe("MockPhone state machine (S6)", () => {
  const run = (events: PhoneEvent[], from: PhoneModel = initialPhone()) => events.reduce(phoneReducer, from);
  const sms: PhoneEvent = { type: "SMS", text: "Harborview: Review & sign your change to policy NBM-4418207: https://x/pay/p1", link: "https://x/pay/p1", paymentId: "p1", atMs: 1000 };

  it("happy path: sms → esign → signed → loading (card shown, hosted link visible) → open → processing → paid (server)", () => {
    const states: string[] = [];
    let m = initialPhone();
    for (const e of [sms, { type: "OPEN_LINK", atMs: 2000 }, { type: "SIGNED", atMs: 3000 }, { type: "PAY_TAP", atMs: 4000, copied: true }, { type: "EMBED_OPEN" }, { type: "EMBED_SUCCESS" }, { type: "SERVER", status: "succeeded" }] as PhoneEvent[]) {
      m = phoneReducer(m, e);
      states.push(m.state);
    }
    expect(states).toEqual(["sms-received", "esign", "signed", "checkout-loading", "checkout-open", "processing", "paid"]);
    expect(m.cardShown && m.cardCopied && m.hostedLinkVisible).toBe(true);
  });

  it("a client-side embed 'success' never reaches paid on its own", () => {
    const m = run([sms, { type: "OPEN_LINK", atMs: 2 }, { type: "SIGNED", atMs: 3 }, { type: "PAY_TAP", atMs: 4, copied: false }, { type: "EMBED_OPEN" }, { type: "EMBED_SUCCESS" }]);
    expect(m.state).toBe("processing");
  });

  it("embed failure returns to the pay sheet with the hosted link; closing the overlay too", () => {
    const loading = run([sms, { type: "OPEN_LINK", atMs: 2 }, { type: "SIGNED", atMs: 3 }, { type: "PAY_TAP", atMs: 4, copied: true }]);
    expect(run([{ type: "EMBED_FAILED" }], loading)).toMatchObject({ state: "signed", embedFailed: true, hostedLinkVisible: true });
    expect(run([{ type: "EMBED_OPEN" }, { type: "EMBED_CLOSED" }], loading).state).toBe("signed");
  });

  it("simulate from any non-final state; a failed simulate goes back", () => {
    for (const pre of [[sms], [sms, { type: "OPEN_LINK", atMs: 2 }], [sms, { type: "OPEN_LINK", atMs: 2 }, { type: "SIGNED", atMs: 3 }]] as PhoneEvent[][]) {
      const m = run([...pre, { type: "SIMULATE_TAP", atMs: 9 }]);
      expect(m.state).toBe("simulating");
      expect(run([{ type: "SERVER", status: "succeeded" }], m).state).toBe("paid");
      expect(run([{ type: "SIMULATE_FAILED" }], m).state).toBe(run(pre).state);
    }
  });

  it("timeout (hold deadline) then a late verified success → paid; timeout never overrides paid", () => {
    const m = run([sms, { type: "SERVER", status: "timeout" }]);
    expect(m.state).toBe("timeout");
    expect(run([{ type: "SERVER", status: "succeeded" }], m).state).toBe("paid");
    expect(run([{ type: "SERVER", status: "succeeded" }, { type: "SERVER", status: "timeout" }], m).state).toBe("paid");
  });

  it("autopilot: untouched 15 s after the SMS → 10 s visible countdown → fire; a touch cancels", () => {
    let m = run([sms]);
    expect(autopilotAction(m, 1000 + 14_999, true)).toBeNull();
    expect(autopilotAction(m, 1000 + 15_000, false)).toBeNull();
    expect(autopilotAction(m, 1000 + 15_000, true)).toBe("start");
    m = run([{ type: "AUTOPILOT_START", atMs: 16_000 }], m);
    expect(m.state).toBe("autopilot-countdown");
    expect(countdownLeftS(m, 19_000)).toBe(7);
    expect(autopilotAction(m, 25_999, true)).toBeNull();
    expect(autopilotAction(m, 26_000, true)).toBe("fire");
    const touched = run([{ type: "TOUCH", atMs: 20_000 }], m);
    expect(touched.state).toBe("sms-received");
    expect(autopilotAction(touched, 60_000, true)).toBeNull(); // touched: no second countdown
  });

  it("a later SMS without a link (the confirmation) only appends", () => {
    const m = run([sms, { type: "SERVER", status: "succeeded" }, { type: "SMS", text: "Payment received. Confirmation END-48213", atMs: 9 }]);
    expect(m.state).toBe("paid");
    expect(m.sms.map((s) => s.text)).toContain("Payment received. Confirmation END-48213");
  });
});
