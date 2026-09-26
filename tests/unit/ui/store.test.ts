import { describe, expect, it } from "vitest";

import type { BatonEvent } from "@/core/contracts/events";
import type { UiLogEntry } from "@/core/contracts/ext/wp7-ui";
import type { TurnInput } from "@/core/contracts/turns";
import { fixtureLog } from "@/client/fixtures";
import { emptyCaseState, S01_POLICY, setField } from "@/client/fixtures/builder";
import { phaseSpans, resolveAt } from "@/client/fixtures/player";
import { initialUiState, parseQueueDetail, percentile, reduceEntry, replayLog } from "@/client/store/reduce";
import {
  formatCallClock, formatCallDate, formatMmSs, narrator, passEstimate, passState, protocolSteps, provenance, separatorText,
} from "@/client/store/selectors";
import { createConsoleStore } from "@/client/store/store";

const turn = (id: string, ch: "rep" | "customer", text: string, startMs: number, endMs: number, extra: Partial<TurnInput> = {}): TurnInput => ({
  caseId: "c1", turnId: id, channel: ch, text, startMs, endMs, words: [], source: id.includes("-c") ? "stt_cache" : "stt_live", recvMs: endMs + 300, cut: false, late: false, ...extra,
});

const ctx: UiLogEntry = {
  t: 0,
  type: "ui.context",
  context: {
    callId: "c", title: "t", callDate: "2026-09-25", durationMs: 120_000, source: "twilio8k", language: "en", decisionPointMs: 100_000,
    handoff: { lineStartMs: 110_400, lineEndMs: 114_200, acceptStartMs: 114_800, acceptEndMs: 116_000, declined: false },
    hasRecordedAiBundle: true, policy: S01_POLICY, peaks: null,
  },
};

describe("reducer", () => {
  it("replaces partials per channel and clears them on the final; dedupes finals by turnId", () => {
    let s = replayLog([ctx, { t: 1, type: "ui.start", kind: "full", startOffsetMs: 0 }]);
    s = reduceEntry(s, { t: 2, type: "stt.partial", channel: "rep", turnOrder: 0, text: "Thanks for" });
    s = reduceEntry(s, { t: 3, type: "stt.partial", channel: "rep", turnOrder: 0, text: "Thanks for calling" });
    expect(s.partials.rep?.text).toBe("Thanks for calling");
    const f: BatonEvent = { t: 4, type: "stt.final", turn: turn("rep-0", "rep", "Thanks for calling.", 800, 2000) };
    s = reduceEntry(s, f);
    s = reduceEntry(s, { ...f, t: 5 });
    expect(s.partials.rep).toBeNull();
    expect(s.human).toHaveLength(1);
    expect(s.phase).toBe("shadowing");
    expect(s.clock.callMs).toBe(2300);
  });

  it("maps cached finals to the cached source and keeps the prefill in connecting until STT opens", () => {
    let s = replayLog([ctx, { t: 1, type: "ui.start", kind: "express", startOffsetMs: 80_000 }]);
    s = reduceEntry(s, { t: 2, type: "stt.final", turn: turn("rep-c0", "rep", "Hello", 0, 1000) });
    expect(s.human[0]?.source).toBe("cached");
    expect(s.phase).toBe("connecting");
    s = reduceEntry(s, { t: 3, type: "stt.status", channel: "rep", status: "open" });
    expect(s.phase).toBe("shadowing");
  });

  it("parses WP4's queued detail and derives the queued phase", () => {
    expect(parseQueueDetail("position 2, ~10 s")).toEqual({ position: 2, etaMs: 10_000 });
    expect(parseQueueDetail("close 1006")).toBeNull();
    let s = replayLog([ctx, { t: 1, type: "ui.start", kind: "full", startOffsetMs: 0 }]);
    s = reduceEntry(s, { t: 2, type: "stt.status", channel: "rep", status: "queued", detail: "position 2, ~10 s" });
    expect(s.phase).toBe("queued");
    expect(s.queue).toMatchObject({ position: 2, etaMs: 10_000 });
  });

  it("computes HUD last / p50 / p90 / n", () => {
    let s = initialUiState();
    for (const ms of [2000, 2400, 3000, 5000]) s = reduceEntry(s, { t: ms, type: "hud", metric: "turn_audible_latency", ms });
    expect(s.hud.turn_audible_latency).toMatchObject({ last: 5000, p50: 2400, p90: 5000, n: 4 });
    expect(percentile([], 50)).toBe(0);
  });

  it("never captions tool pre-ambles and marks interrupted replies", () => {
    let s = initialUiState();
    s = reduceEntry(s, { t: 1, type: "va.caption", replyId: "r1", words: [{ text: "Let", atMs: 100 }, { text: "me", atMs: 300 }] });
    s = reduceEntry(s, { t: 2, type: "va.reply", replyId: "r1", phase: "done", kind: "tool_preamble" });
    expect(s.ai).toHaveLength(0);
    expect(s.va.checking).toBe(true);
    s = reduceEntry(s, { t: 3, type: "va.caption", replyId: "r2", words: [{ text: "Hi", atMs: 500 }] });
    expect(s.ai[0]?.words?.[0]?.atMs).toBe(0);
    s = reduceEntry(s, { t: 4, type: "va.reply", replyId: "r2", phase: "done", kind: "speech", interrupted: true });
    expect(s.ai[0]?.interrupted).toBe(true);
  });

  it("tracks tools, the hold, AI-confirmed fields and hand-back", () => {
    let s = initialUiState();
    s = reduceEntry(s, { t: 1, type: "va.tool", callId: "a", name: "update_case_field", phase: "call", args: { field: "garaging_zip", value: "44107", reason: "customer_corrected" } });
    expect(s.tools[0]?.pending).toBe(true);
    s = reduceEntry(s, { t: 2, type: "va.tool", callId: "a", name: "update_case_field", phase: "result", result: { status: "updated" } });
    expect(s.tools[0]?.pending).toBe(false);
    expect(s.aiConfirmed).toContain("garaging_zip");
    s = reduceEntry(s, { t: 3, type: "va.tool", callId: "b", name: "send_esign_and_pay_link", phase: "call", args: {} });
    expect(s.tools[1]?.hold).toBe(true);
    s = reduceEntry(s, { t: 4, type: "va.tool", callId: "c", name: "hand_back_to_rep", phase: "call", args: { reason: "advice_requested", summary: "x" } });
    s = reduceEntry(s, { t: 5, type: "takeover.phase", phase: "done", atMs: 0 });
    expect(s.phase).toBe("handed-back");
    expect(s.qa.status).toBe("waiting");
  });

  it("a new arm after a hand-back starts a fresh takeover (Pass the baton again)", () => {
    const log = fixtureLog("s01-handback") ?? [];
    let s = replayLog(log);
    expect(s.phase).toBe("handed-back");
    expect(passState(s).enabled).toBe(true);
    s = reduceEntry(s, { t: s.t + 1, type: "takeover.phase", phase: "armed", atMs: 130_000, detail: { source: "manual" } });
    expect(s.takeover.count).toBe(2);
    expect(s.handBack).toBeNull();
    expect(s.tools).toHaveLength(0);
    expect(s.phase).toBe("arming");
  });

  it("paused overlays and resumes to the flow phase; fatal errors win", () => {
    let s = replayLog(fixtureLog("s01-paused") ?? []);
    expect(s.phase).toBe("paused");
    s = reduceEntry(s, { t: s.t + 1, type: "paused", reason: "ios_background", resumed: true });
    expect(s.phase).toBe("shadowing");
    s = reduceEntry(s, { t: s.t + 1, type: "error", code: "E_OPENAI_TIMEOUT", message: "slow" });
    expect(s.phase).toBe("shadowing");
    s = reduceEntry(s, { t: s.t + 1, type: "error", code: "E_CASE_TOKEN", message: "expired" });
    expect(s.phase).toBe("error");
  });
});

describe("selectors and copy", () => {
  it("formats the clock, durations and the call date", () => {
    expect(formatCallClock(102_345)).toBe("01:42.3");
    expect(formatMmSs(95_400)).toBe("01:35");
    expect(formatCallDate("2026-09-25")).toBe("Fri 25 Sep 2026");
  });

  it("disables the manual pass for a recorded AI half with the DESIGN tooltip", () => {
    const s = replayLog(fixtureLog("s01-recorded-ai") ?? [], initialUiState());
    const early = replayLog((fixtureLog("s01-recorded-ai") ?? []).filter((e) => e.t < 30_000));
    const p = passState(early);
    expect(p.enabled).toBe(false);
    expect(p.reason).toBe("Live AI is unavailable right now: the recorded AI session starts at Daniel's handoff line (01:50).");
    // The stacked RECORDED AI SESSION badge is gone (WP7 acceptance 4): the provenance strip's AI segment says it.
    expect(provenance(s, { customerInput: "synthetic" }).segments.find((g) => g.key === "ai")?.tag).toBe("RECORDED");
  });

  it("estimates the AI's remaining work from the case", () => {
    let cs = emptyCaseState("c");
    expect(passEstimate({ caseState: cs, relay: null }).facts).toBe(9); // 10 required minus the server-resolvable premium
    cs = setField(cs, "driver_full_name", { status: "VERIFIED", reason: "read_back", value: "Maya" }, 1000);
    expect(passEstimate({ caseState: cs, relay: null }).text).toBe("Pass now: the AI will need to collect 8 facts, about 4 min.");
  });

  it("shows the protocol steps with ms and the separator row", () => {
    const log = fixtureLog("s01-full") ?? [];
    const s = replayLog(log);
    const steps = protocolSteps(s);
    expect(steps.map((x) => x.status)).toEqual(["done", "done", "done", "done", "done"]);
    expect(steps.every((x) => x.ms !== null && x.ms > 0)).toBe(true);
    expect(separatorText(s)).toMatch(/^Baton passed at 01:50\.0 · protocol \d\.\d s$/);
    expect(narrator(s).text).toBe("Done: this QA card is computed from the AI's own recording");
  });

  it("the fixture player resolves `at` by phase", () => {
    const log = fixtureLog("s01-full") ?? [];
    const spans = phaseSpans(log);
    expect(spans[0]?.phase).toBe("preflight");
    const t = resolveAt(log, "paying");
    expect(t).not.toBeNull();
    const s = replayLog(log.filter((e) => e.t <= (t as number)));
    expect(s.phase).toBe("paying");
    expect(resolveAt(log, "end")).toBe(log[log.length - 1]?.t);
    expect(resolveAt(log, "nonsense")).toBeNull();
  });

  it("the store notifies subscribers and keeps the event log for MockPhone", () => {
    const store = createConsoleStore();
    let n = 0;
    const off = store.subscribe(() => n++);
    store.apply({ t: 1, type: "phone.sms", text: "hi" });
    store.apply({ t: 2, type: "ui.autopilot", on: false });
    off();
    store.apply({ t: 3, type: "phone.state", state: "esign" });
    expect(n).toBe(2);
    expect(store.events().map((e) => e.type)).toEqual(["phone.sms", "phone.state"]);
    expect(store.getState().phone.state).toBe("esign");
  });
});
