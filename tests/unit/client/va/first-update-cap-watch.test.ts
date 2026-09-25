import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaymentView } from "../../../../src/core/contracts/api";
import { SessionCap, wrapUpInstructions } from "../../../../src/client/va/cap";
import { basicFirstUpdateGuard, buildFirstUpdate } from "../../../../src/client/va/first-update";
import { PAY_TIMEOUT_RESULT, PaymentWatch, type PaymentOutcome } from "../../../../src/client/va/payment-watch";
import { compiledFromFixture, fixture } from "./fakes";

describe("buildFirstUpdate (§5.9.1)", () => {
  it("emits exactly the live-verified keys, keyterms only when enabled and non-empty", () => {
    const c = compiledFromFixture();
    const off = buildFirstUpdate(c, { keytermsEnabled: false });
    expect(Object.keys(off.session).sort()).toEqual(["greeting", "input", "output", "system_prompt", "tools"]);
    expect(off.session.input).toEqual({ format: { encoding: "audio/pcm", sample_rate: 24000 }, transcription_mode: "min_latency" });
    expect(off.session.output).toEqual({ voice: "alba", format: { encoding: "audio/pcm", sample_rate: 24000 } });
    const on = buildFirstUpdate(c, { keytermsEnabled: true });
    expect(on.session.input.keyterms).toEqual(["Lucas Delgado", "Corolla"]);
    expect(buildFirstUpdate({ ...c, keyterms: [] }, { keytermsEnabled: true }).session.input).not.toHaveProperty("keyterms");
  });

  it("round-trips the T-D1-0 fixtures (what passed live)", () => {
    for (const name of ["first-update-confirm.json", "first-update-disclose.json"]) {
      const fx = fixture(name);
      const built = buildFirstUpdate(compiledFromFixture(name, { keyterms: [] }), { keytermsEnabled: false });
      expect(built).toEqual(fx);
      expect(() => basicFirstUpdateGuard(fx, { keytermsEnabled: false })).not.toThrow();
    }
  });
});

describe("basicFirstUpdateGuard", () => {
  const ok = () => structuredClone(fixture("first-update-disclose.json"));
  const bad = (mut: (s: Record<string, any>) => void, keyterms = false) => {
    const m = ok();
    mut(m.session as Record<string, any>);
    return () => basicFirstUpdateGuard(m, { keytermsEnabled: keyterms });
  };
  it("rejects anything outside the whitelist with E_VA_CONFIG", () => {
    const cases = [
      bad((s) => (s.llm = [])),
      bad((s) => (s.greeting = "")),
      bad((s) => delete s.greeting),
      bad((s) => (s.input.turn_detection = { min_silence: 100 })),
      bad((s) => (s.input.transcription_mode = "fast")),
      bad((s) => (s.output.voice = "ivy")),
      bad((s) => (s.output.volume = 80)),
      bad((s) => (s.input.keyterms = ["x"])), // keyterms while VA_KEYTERMS=0
      bad((s) => (s.input.keyterms = ["x".repeat(51)]), true),
      bad((s) => (s.input.keyterms = Array.from({ length: 101 }, (_, i) => `k${i}`)), true),
      bad((s) => (s.tools[0].execution_mode = "hold")),
      bad((s) => (s.tools[0].timeout_seconds = 120)),
      bad((s) => (s.tools[0].http = { url: "https://example.com" })),
      bad((s) => (s.tools[1].parameters.properties.date.format = "date")),
      bad((s) => (s.tools[0].parameters.oneOf = [])),
    ];
    for (const run of cases) expect(run).toThrowError(expect.objectContaining({ code: "E_VA_CONFIG" }));
  });
  it("accepts keyterms when enabled (T-D1-0 runs 3–4)", () => {
    const m = ok();
    (m.session.input as Record<string, unknown>).keyterms = ["Maya Raman", "Honda Civic"];
    expect(() => basicFirstUpdateGuard(m, { keytermsEnabled: true })).not.toThrow();
  });
});

describe("SessionCap (§5.9.5)", () => {
  it("wraps up at cap − 20 s, ends at cap, and pauses while paying", () => {
    const cap = new SessionCap({ capMs: 150_000, vaSessionCapMaxMs: 420_000 });
    cap.start(0);
    expect(cap.tick(129_000)).toBe("none");
    cap.setPaying(true, 100_000);
    expect(cap.tick(135_000)).toBe("none"); // paying: no wrap-up
    expect(cap.tick(200_000)).toBe("none");
    cap.setPaying(false, 200_000); // 100 s paused
    expect(cap.activeMs(200_000)).toBe(100_000);
    expect(cap.effectiveCapMs(200_000)).toBe(250_000);
    expect(cap.tick(229_000)).toBe("none");
    expect(cap.tick(230_000)).toBe("wrap_up");
    expect(cap.tick(231_000)).toBe("none"); // once
    expect(cap.tick(250_000)).toBe("cap");
    expect(cap.tick(260_000)).toBe("none"); // done
  });
  it("never wraps up in closing, but the absolute ceiling ends any stage", () => {
    const cap = new SessionCap({ capMs: 150_000, vaSessionCapMaxMs: 420_000 });
    expect(cap.ceilingMs).toBe(600_000);
    cap.start(1000);
    cap.setClosing(true);
    expect(cap.tick(200_000)).toBe("none");
    cap.setClosing(false);
    cap.setPaying(true, 200_000);
    expect(cap.tick(601_000)).toBe("ceiling");
  });
  it("wrap-up line names the rep", () => {
    expect(wrapUpInstructions("Daniel")).toBe("Tell the customer you need to wrap up and that Daniel will follow up on anything left.");
  });
});

describe("PaymentWatch (§5.8 steps 3–8)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const view = (status: PaymentView["status"], toolResult?: PaymentView["toolResult"]): PaymentView => ({
    id: "pay_1", status, statusSource: status === "succeeded" ? "webhook" : null, amountCents: 2340, totalAmountCents: 2340,
    provider: "mock", simulated: false, embed: null, updatedAt: "2026-09-25T00:00:00Z", ...(toolResult ? { toolResult } : {}),
  });

  function make(poll: (id: string) => Promise<PaymentView>) {
    let now = 0;
    const outcomes: PaymentOutcome[] = [];
    const reassures: number[] = [];
    const w = new PaymentWatch({ paymentId: "pay_1", poll, now: () => now, onOutcome: (o) => outcomes.push(o), onReassure: () => reassures.push(now) });
    return { w, outcomes, reassures, at: (t: number) => (now = t) };
  }

  it("times out 60 s after the SMS while the phone is untouched; reassures at +45 s", () => {
    const m = make(async () => view("open"));
    m.w.start(0);
    m.at(45_000);
    m.w.tick();
    expect(m.reassures).toEqual([45_000]);
    m.at(59_999);
    m.w.tick();
    expect(m.outcomes).toEqual([]);
    m.at(60_000);
    m.w.tick();
    expect(m.outcomes).toEqual([{ kind: "timeout", atMs: 60_000 }]);
    expect(m.w.state).toBe("timed_out");
  });

  it("extends in 30 s steps up to 180 s while the phone is active, and suppresses reassurance in the overlay", () => {
    const m = make(async () => view("open"));
    m.w.start(0);
    m.w.setPhoneState("checkout-open");
    m.at(45_000);
    m.w.tick();
    expect(m.reassures).toEqual([]); // overlay open
    for (const t of [60_000, 90_000, 120_000, 150_000]) {
      m.at(t);
      m.w.tick();
      expect(m.outcomes).toEqual([]);
    }
    expect(m.w.deadlineAt).toBe(180_000);
    m.at(180_000);
    m.w.tick();
    expect(m.outcomes[0]).toEqual({ kind: "timeout", atMs: 180_000 });
  });

  it("stops extending when the phone goes back to sms-received", () => {
    const m = make(async () => view("open"));
    m.w.start(0);
    m.w.setPhoneState("esign");
    m.at(60_000);
    m.w.tick();
    m.w.setPhoneState("sms-received");
    m.at(90_000);
    m.w.tick();
    expect(m.outcomes[0]).toEqual({ kind: "timeout", atMs: 90_000 });
  });

  it("reports the server-built terminal result from the poll loop, and a late success after a timeout", async () => {
    let status: PaymentView["status"] = "open";
    const m = make(async () => (status === "succeeded" ? view("succeeded", { status: "paid", amount: "$23.40", receipt: "PAY-1", verified_by: "polar_webhook" }) : view(status)));
    m.w.start(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(m.outcomes).toEqual([]);
    m.at(60_000);
    m.w.tick();
    expect(m.outcomes[0]?.kind).toBe("timeout");
    status = "succeeded";
    await vi.advanceTimersByTimeAsync(3500);
    expect(m.outcomes[1]).toMatchObject({ kind: "terminal", late: true, view: { status: "succeeded" } });
    expect(m.w.state).toBe("done");
  });

  it("ignores poll errors and a failed result after a timeout", async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const outcomes: PaymentOutcome[] = [];
    let now = 0;
    const w = new PaymentWatch({
      paymentId: "p", now: () => now, onOutcome: (o) => outcomes.push(o), onPollError: (e) => errors.push(e),
      poll: async () => {
        calls++;
        if (calls === 1) throw new Error("network");
        return view("failed", { status: "failed", instruction: PAY_TIMEOUT_RESULT.instruction });
      },
    });
    w.start(0);
    now = 60_000;
    w.tick(); // timeout first
    await w.pollOnce(); // network error
    await w.pollOnce(); // failed after timeout: not reported
    expect(errors).toHaveLength(1);
    expect(outcomes.map((o) => o.kind)).toEqual(["timeout"]);
    w.stop();
  });
});
