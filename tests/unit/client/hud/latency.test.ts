import { describe, expect, it } from "vitest";

import { LatencyHudImpl, hudMetricReporter, percentile } from "../../../../src/client/hud/latency";
import { HUD_TOOLTIP, hudViewModel } from "../../../../src/client/hud/view-model";
import { CaptionScheduler, INTERRUPTED_MARK } from "../../../../src/client/va/captions";
import type { HudMetric } from "../../../../src/core/contracts/events";
import { RecordingSink } from "../va/fakes";

describe("LatencyHud (§5.10 metrics)", () => {
  it("click_to_first_audible and dead_air_after_rep from the greeting", () => {
    const got: [HudMetric, number][] = [];
    const hud = new LatencyHudImpl({ onMetric: (m, ms) => got.push([m, ms]) });
    hud.mark("arm", 1000);
    hud.mark("repLineStart", 1200);
    hud.mark("repLineEnd", 4700);
    hud.mark("updateSent", 3800);
    hud.mark("sessionReady", 4300);
    hud.mark("replyStarted", 4400, "r_greet");
    hud.mark("firstAudiblePlayed", 5100, "r_greet");
    expect(got).toEqual([["click_to_first_audible", 4100], ["dead_air_after_rep", 400]]);
    hud.mark("firstAudiblePlayed", 5200, "r_greet"); // duplicate ignored
    expect(got).toHaveLength(2);
  });

  it("dead air is never negative (audio queued before the rep line ended)", () => {
    const hud = new LatencyHudImpl();
    hud.mark("arm", 0);
    hud.mark("repLineEnd", 5000);
    hud.mark("firstAudiblePlayed", 5000, "g");
    expect(hud.summary().dead_air_after_rep?.last).toBe(0);
  });

  it("turn vs tool turn latency; an eos is used once; replies without customer speech give no metric", () => {
    const hud = new LatencyHudImpl();
    hud.mark("arm", 0);
    hud.mark("firstAudiblePlayed", 4000, "g");
    // plain turn
    hud.mark("eos", 10_000);
    hud.mark("replyStarted", 11_000, "r1");
    hud.mark("firstAudiblePlayed", 12_300, "r1");
    hud.noteReplyKind("r1", "speech");
    // tool turn: eos → pre-amble (tool_preamble) → answer
    hud.mark("eos", 20_000);
    hud.mark("replyStarted", 21_000, "pre");
    hud.noteReplyKind("pre", "tool_preamble");
    hud.mark("replyStarted", 22_500, "ans");
    hud.mark("firstAudiblePlayed", 23_900, "ans");
    // reassurance with no customer speech
    hud.mark("replyStarted", 40_000, "re");
    hud.mark("firstAudiblePlayed", 41_000, "re");
    const s = hud.summary();
    expect(s.turn_audible_latency).toEqual({ last: 2300, p50: 2300, p90: 2300, n: 1 });
    expect(s.tool_turn_latency).toEqual({ last: 3900, p50: 3900, p90: 3900, n: 1 });
  });

  it("percentiles, snapshot identity and reset", () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    const hud = new LatencyHudImpl();
    let n = 0;
    hud.subscribe(() => n++);
    const a = hud.snapshot();
    expect(hud.snapshot()).toBe(a);
    hud.setSessionIds({ va: "sess_1" });
    hud.setAudioHealth({ underruns: 2, slowNetwork: true });
    const b = hud.snapshot();
    expect(b).not.toBe(a);
    expect(b.sessionIds).toEqual({ va: "sess_1" });
    expect(b.underruns).toBe(2);
    expect(b.slowNetwork).toBe(true);
    expect(n).toBe(2);
    hud.reset();
    expect(hud.snapshot().sessionIds).toEqual({});
  });

  it("hudMetricReporter emits a hud event and posts it", async () => {
    const sink = new RecordingSink();
    const posts: unknown[] = [];
    const report = hudMetricReporter({ sink, eventTime: () => 7, postEvents: async (b) => void posts.push(b) });
    report("dead_air_after_rep", 380);
    expect(sink.events).toEqual([{ t: 7, type: "hud", metric: "dead_air_after_rep", ms: 380 }]);
    expect(posts).toEqual([{ hud: { dead_air_after_rep: 380 } }]);
  });
});

describe("HUD view model", () => {
  it("leads with dead air after the rep's line and notes the handoff line on click → audible", () => {
    const hud = new LatencyHudImpl();
    hud.mark("arm", 0);
    hud.mark("repLineEnd", 3700);
    hud.mark("firstAudiblePlayed", 4100, "g");
    hud.setSessionIds({ rep: "st_rep", customer: "st_cus", va: "sess_1" });
    const vm = hudViewModel(hud.snapshot(), { repFirst: "Daniel" });
    expect(vm.rows[0]).toMatchObject({ metric: "dead_air_after_rep", label: "Dead air after Daniel's line", value: "400 ms" });
    expect(vm.rows[1]).toMatchObject({ metric: "click_to_first_audible", value: "4,100 ms", note: "includes Daniel's ≈3.5 s handoff line" });
    expect(vm.tooltip).toBe(HUD_TOOLTIP);
    expect(vm.sessionIds).toEqual([
      { label: "Rep STT", id: "st_rep" },
      { label: "Customer STT", id: "st_cus" },
      { label: "Voice Agent", id: "sess_1" },
    ]);
    expect(vm.badges).toEqual([]);
  });
});

describe("CaptionScheduler (§5.10 caption rules)", () => {
  const make = () => {
    let now = 0;
    const sink = new RecordingSink();
    const c = new CaptionScheduler({ sink, nowCtxMs: () => now });
    return { c, sink, at: (t: number) => (now = t) };
  };

  it("buffers words until the first audible chunk PLAYED, then schedules them after the trimmed silence", () => {
    const { c, sink } = make();
    c.onAgentDelta("r1", "Hi ", 250);
    c.onAgentDelta("r1", "Priya,", 400);
    c.onAgentDelta("r1", "this", null);
    expect(sink.events).toEqual([]);
    c.onFirstAudiblePlayed("r1", 5000, 240);
    expect(sink.of("va.caption")).toEqual([
      { t: 0, type: "va.caption", replyId: "r1", words: [{ text: "Hi", atMs: 5010 }, { text: "Priya,", atMs: 5160 }, { text: "this", atMs: 5000 }] },
    ]);
    c.onAgentDelta("r1", "is", 600); // a late delta re-emits the reply's full list
    expect(sink.of("va.caption").at(-1)?.words).toHaveLength(4);
  });

  it("never captions a reply that was never audible (tool pre-amble, unspoken text, silent hold reply)", () => {
    const { c, sink } = make();
    c.onAgentDelta("pre", "I'm sorry, I didn't catch that.", 0);
    c.interrupt("pre", 100);
    expect(sink.events).toEqual([]);
    expect(c.scheduledWords("pre")).toEqual([]);
  });

  it("an interrupted reply stops at the last word scheduled before the flush and appends —", () => {
    const { c, sink } = make();
    for (const [w, s] of [["Your", 100], ["order", 300], ["is", 600], ["in", 900], ["transit", 1200]] as const) c.onAgentDelta("r2", w, s);
    c.onFirstAudiblePlayed("r2", 10_000, 100);
    c.interrupt("r2", 10_550);
    const last = sink.of("va.caption").at(-1)!;
    expect(last.words.map((w) => w.text)).toEqual(["Your", "order", "is", INTERRUPTED_MARK]);
    c.onAgentDelta("r2", "today", 1500); // ignored after the interruption
    expect(sink.of("va.caption").at(-1)).toBe(last);
  });

  it("customer lane: deltas replace, the final closes the line", () => {
    const { c, sink } = make();
    c.onUserDelta("i1", "Yes.");
    c.onUserDelta("i1", "Yes.");
    c.onUserDelta("i1", "Yes, that's right.");
    c.onUserFinal("i1", "Yes, that's right. Tomorrow.");
    expect(sink.of("va.user").map((e) => [e.text, e.final])).toEqual([
      ["Yes.", false],
      ["Yes, that's right.", false],
      ["Yes, that's right. Tomorrow.", true],
    ]);
  });
});
