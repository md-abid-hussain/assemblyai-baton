/**
 * WP7·2 (G2 slice UI, $0): the MockPhone mount, the phone's event list, the `?express=1` countdown, the provenance
 * banner and the AI-half input gating. Server-rendered (no DOM): effects do not run, so the phone renders its first
 * (lock-screen) frame and the countdown card is rendered directly.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { fixtureLog } from "@/client/fixtures";
import { createFixturePaymentsClient, FIXTURE_PAYMENT_ID } from "@/client/fixtures/phone-client";
import { resolveAt } from "@/client/fixtures/player";
import { callHref } from "@/client/session/prime";
import { ConsoleStoreProvider } from "@/client/store/hooks";
import { initialUiState } from "@/client/store/reduce";
import { provenance } from "@/client/store/selectors";
import { createConsoleStore, isPhoneEvent } from "@/client/store/store";
import { CallConsole } from "@/components/call/call-console";
import { ExpressCountdownCard, expressCountdownActive } from "@/components/call/state-cards";
import { ConsoleEnvProvider, type ConsoleEnv } from "@/components/common/console-context";
import { MockPhone } from "@/components/phone/MockPhone";
import type { BatonEvent } from "@/core/contracts/events";
import type { MockPhoneProps } from "@/core/contracts/services";

function storeAt(name: string, at: string) {
  const log = fixtureLog(name) ?? [];
  const t = resolveAt(log, at) ?? 0;
  const store = createConsoleStore(initialUiState());
  for (const e of log.filter((x) => x.t <= t)) store.apply(e);
  return { store, t };
}

function render(name: string, at: string, env: Partial<ConsoleEnv> = {}): string {
  const { store, t } = storeAt(name, at);
  return renderToStaticMarkup(
    <ConsoleStoreProvider store={store}>
      <ConsoleEnvProvider value={{ fixture: name, clockNow: () => t, ...env }}>
        <CallConsole />
      </ConsoleEnvProvider>
    </ConsoleStoreProvider>,
  );
}

describe("store.phoneEvents(): the MockPhone's event list", () => {
  it("keeps only the phone's events, survives the bounded log, and resets with the store", () => {
    const store = createConsoleStore();
    const sms: BatonEvent = { t: 1, type: "phone.sms", text: "Review & sign: https://x/pay/p1", link: "https://x/pay/p1" };
    store.dispatch(sms);
    for (let i = 0; i < 5200; i++) store.dispatch({ t: 2 + i, type: "stt.partial", channel: "rep", turnOrder: i, text: "…" } as BatonEvent);
    store.dispatch({ t: 9000, type: "payment", status: "succeeded", source: "mock" });
    store.dispatch({ t: 9001, type: "va.tool", callId: "c1", name: "hand_back_to_rep", phase: "result", result: {} } as BatonEvent);
    store.dispatch({ t: 9002, type: "va.tool", callId: "c2", name: "confirm_effective_date", phase: "result", result: {} } as BatonEvent);
    expect(store.events()).toHaveLength(5000); // the ring dropped the SMS …
    expect(store.events()).not.toContain(sms);
    expect(store.phoneEvents().map((e) => e.type)).toEqual(["phone.sms", "payment", "va.tool"]); // … the phone did not
    store.reset();
    expect(store.phoneEvents()).toEqual([]);
  });

  it("isPhoneEvent matches exactly what WP6's MockPhone reads (wp6-to-wp7.md)", () => {
    expect(isPhoneEvent({ t: 0, type: "phone.state", state: "esign" })).toBe(true);
    expect(isPhoneEvent({ t: 0, type: "stage", stage: "pay" })).toBe(false);
  });
});

describe("the MockPhone mount (renderPhone)", () => {
  const seen: MockPhoneProps[] = [];
  const renderPhone = (p: MockPhoneProps & { className?: string }) => {
    seen.push(p);
    return <MockPhone {...p} client={createFixturePaymentsClient({ caseState: () => null, policy: () => null })} />;
  };

  it("floats WP6's phone (its own frame, positioned by the console) once the SMS arrived, with the pay link and token", () => {
    seen.length = 0;
    const html = render("s01-full", "paying+3000", { renderPhone, phoneAuth: () => ({ paymentId: "pay_1", takeoverToken: "tt_1" }) });
    expect(html).toContain("Customer&#x27;s phone (simulated)"); // WP6's section, not the preview
    expect(html).not.toContain("Read-only preview of");
    expect(html).toContain("bt-phone-float");
    const p = seen.at(-1)!;
    expect(p).toMatchObject({ paymentId: "pay_1", takeoverToken: "tt_1", variant: "floating", readOnly: false, autopilot: true });
    expect(p.events.map((e) => e.type)).toEqual(expect.arrayContaining(["phone.sms", "payment"]));
    expect(p.events.every(isPhoneEvent)).toBe(true);
  });

  it("the recorded AI half mounts it read-only; without renderPhone the preview renders", () => {
    seen.length = 0;
    render("s01-recorded-ai", "end", { renderPhone });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.readOnly)).toBe(true);
    expect(render("s01-full", "paying+3000")).toContain("Read-only preview of");
  });

  it("the fixture payments client builds WP6's view from the case (amounts, e-sign summary) and simulates to succeeded", async () => {
    const { store } = storeAt("s01-full", "paying+3000");
    const c = createFixturePaymentsClient({ caseState: () => store.getState().caseState, policy: () => store.getState().context?.policy ?? null }, { delayMs: 0 });
    const v = await c.get(FIXTURE_PAYMENT_ID, { extras: true });
    expect(v).toMatchObject({ id: FIXTURE_PAYMENT_ID, status: "created", provider: "mock", embed: null });
    expect(v.amountCents).toBeGreaterThan(0);
    expect(v.summary?.policyNumber).toBe(store.getState().context?.policy.policyNumber);
    await c.esign(FIXTURE_PAYMENT_ID, "Priya Raman");
    await c.simulate(FIXTURE_PAYMENT_ID);
    expect(await c.get(FIXTURE_PAYMENT_ID)).toMatchObject({ status: "succeeded", statusSource: "mock", simulated: true });
  });
});

describe("?express=1: the landing CTA's 3 s countdown", () => {
  it("runs only when Express is possible, the plan is ready and nobody chose yet", () => {
    const base = { autoStart: "express" as const, decisionPointMs: 106_500, planReady: true, phase: "preflight", cancelled: false };
    expect(expressCountdownActive(base)).toBe(true);
    expect(expressCountdownActive({ ...base, autoStart: null })).toBe(false);
    expect(expressCountdownActive({ ...base, decisionPointMs: null })).toBe(false);
    expect(expressCountdownActive({ ...base, planReady: false })).toBe(false);
    expect(expressCountdownActive({ ...base, phase: "connecting" })).toBe(false);
    expect(expressCountdownActive({ ...base, cancelled: true })).toBe(false);
  });

  it("the card offers Start now and Full call instead", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(<ExpressCountdownCard left={3} minutes={3} title="Priya calls to add a driver." onNow={noop} onFull={noop} onCancel={noop} ios={false} />);
    expect(html).toContain("Express starts in 3 s");
    expect(html).toContain("Start now");
    expect(html).toContain("Full call instead");
  });

  it("callHref builds the landing CTA's URL", () => {
    expect(callHref("s01-take2", { express: true })).toBe("/call/s01-take2?express=1");
    expect(callHref("a b")).toBe("/call/a%20b");
  });
});

describe("provenance banner", () => {
  it("states the four segments in plain words, live and cached", () => {
    const { store } = storeAt("s01-full", "shadowing:end");
    const live = provenance(store.getState(), { customerInput: "mic" }).map((x) => `${x.label}: ${x.value}`);
    expect(live).toEqual([
      "Human half: recorded role-play, real phone line",
      "Transcription: live AssemblyAI",
      "AI half: live Voice Agent",
      "Customer in the AI half: you (mic)",
    ]);
    const rec = storeAt("s01-recorded-ai", "end").store.getState();
    expect(provenance(rec, { customerInput: "synthetic" }).map((x) => x.value)).toEqual(expect.arrayContaining(["recorded session", "recorded"]));
  });

  it("is on the console (the live page answers with the mic: autopilot and typing are hidden)", () => {
    const html = render("s01-full", "ai-speaking+2000", { inputs: { autopilot: false, typed: false, mic: true } });
    expect(html).toContain("Where this run comes from");
    expect(html).toContain("you (mic)");
    expect(html).toContain("Answer as Priya with your mic.");
    expect(html).not.toContain("Autopilot customer");
    expect(html).not.toContain("typed-reply");
    const fx = render("s01-full", "ai-speaking+2000");
    expect(fx).toContain("Autopilot customer");
    expect(fx).toContain("synthetic");
  });
});
