/**
 * WP5 acceptance 1: the pure takeover reducer (DESIGN §5.5) on a fake clock: every transition and timeout,
 * ForceEndpoint only after SEAL_TAIL_MS, retry at most once with attempt 1, pagehide from every state releases the
 * run, auto-baton, and recorded runs never arm manually.
 */
import { describe, expect, it } from "vitest";

import { TAKEOVER_TIMING as T } from "../../../../src/core/contracts/takeover";
import {
  armView,
  clampLead,
  CLOSE_BACKSTOP_MS,
  DRAIN_BACKSTOP_GRACE_MS,
  isRetryableVaCode,
  manualPassAllowed,
  REP_BACK_MAX_MS,
  type TakeoverEffect,
} from "../../../../src/core/protocol/takeover-machine";
import { compiledFixture, HANDOFF, M } from "./_harness";

describe("IDLE → ARMED (manual)", () => {
  it("arms at the click with tArm = callMs, midUtterance from speech or an open partial, and fires the arm request", () => {
    const m = new M();
    m.sample({ callMs: 61_234.5, rep: true });
    const fx = m.arm();
    expect(m.phase).toBe("armed");
    expect(m.p.tArmMs).toBe(61_234.5);
    expect(m.p.midUtterance).toBe(true);
    expect(m.p.speakingCh).toBe("rep");
    expect(fx).toContainEqual({ type: "hud_mark", name: "arm", ctxMs: m.now });
    expect(fx).toContainEqual({ type: "post_arm", tArmMs: 61_234.5, midUtterance: true, source: "manual" });
    expect(m.has("stop_playback", fx)).toBe(false);
    expect(m.s.passes).toBe(1);
  });

  it("an open partial alone makes the pass mid-utterance", () => {
    const m = new M();
    m.sample({ speaking: { rep: false, customer: false }, quiet: false, partialCustomer: true });
    m.arm();
    expect(m.p.midUtterance).toBe(true);
    expect(m.p.speakingCh).toBe("customer");
  });

  it("the arm response starts the VA token mint (attempt 0) at once: the WS pre-opens in parallel with sealing", () => {
    const m = new M();
    m.sample({ rep: true });
    m.arm();
    const fx = m.armOk("tko_9", 700);
    expect(fx).toEqual([{ type: "mint_va", attempt: 0, takeoverId: "tko_9" }]);
    expect(m.p.arm.leadMs).toBe(700);
    const open = m.send({ type: "va_token", now: m.now + 100, attempt: 0, liveSessionId: "va_tko_9_0" });
    expect(open).toEqual([{ type: "open_va", attempt: 0 }]);
    expect(m.phase).toBe("armed");
  });

  it("leadMs is clamped to 500–1500", () => {
    expect(clampLead(100)).toBe(T.LEAD_MS_MIN);
    expect(clampLead(9999)).toBe(T.LEAD_MS_MAX);
    expect(clampLead(Number.NaN)).toBe(T.DEFAULT_LEAD_MS);
    expect(clampLead(812)).toBe(812);
  });

  it("an arm failure before sealing returns to shadowing (the recording keeps playing)", () => {
    const m = new M();
    m.sample({ rep: true });
    m.arm();
    const fx = m.send({ type: "arm_failed", now: m.now + 80, code: "E_RATE_LIMITED", message: "too many passes" });
    expect(m.phase).toBe("idle");
    expect(m.s.pass).toBeNull();
    expect(m.s.passes).toBe(0);
    expect(m.has("notice", fx)).toBe(true);
    expect(m.has("stop_playback", m.all)).toBe(false);
    expect(manualPassAllowed(m.s)).toBe(true);
  });

  it("allows at most MAX_TAKEOVERS_PER_CASE passes", () => {
    const m = new M({ maxPasses: 1 });
    m.toActive();
    m.send({ type: "va_hand_back", now: (m.now += 10), reason: "customer_request" });
    m.send({ type: "rep_back_done", now: (m.now += 2000) });
    m.send({ type: "va_ended", now: (m.now += 300), attempt: 0, reason: "hand_back", sessionSeconds: 30 });
    expect(m.phase).toBe("done");
    expect(manualPassAllowed(m.s)).toBe(false);
    expect(m.arm()).toEqual([]);
    expect(m.phase).toBe("done");
  });
});

describe("ARMED → SEALING", () => {
  it("seals on the first sample with both channels quiet ≥400 ms: tCut = callMs, stop(30 ms), handoff clip", () => {
    const m = new M();
    m.sample({ rep: true });
    m.arm();
    m.now += 320;
    const fx = m.sample({ callMs: 60_320, quiet: true, partialRep: true });
    expect(m.phase).toBe("sealing");
    expect(m.p.tCutMs).toBe(60_320);
    expect(m.p.capHit).toBe(false);
    expect(fx).toContainEqual({ type: "stop_playback", fadeMs: 30 });
    expect(fx).toContainEqual({ type: "play_handoff_clip" });
    expect(fx).toContainEqual({ type: "hud_mark", name: "repLineStart", ctxMs: m.now });
    expect(m.p.timings.sealed).toBe(320);
  });

  it("a click in silence seals immediately (tCut = the click)", () => {
    const m = new M();
    m.sample({ callMs: 70_000, quiet: true });
    const fx = m.arm();
    expect(m.phase).toBe("draining"); // sealed at the click; no open partial → straight to DRAINING
    expect(m.p.sealedAt).toBe(m.now);
    expect(m.p.tCutMs).toBe(70_000);
    expect(m.p.midUtterance).toBe(false);
    expect(fx).toContainEqual({ type: "play_handoff_clip" });
  });

  it("the 1.5 s cap seals while still speaking and marks capHit on the speaking channel", () => {
    const m = new M();
    m.sample({ customer: true, partialCustomer: true });
    m.arm();
    const t0 = m.now;
    expect(m.deadline).toBe(t0 + T.ARM_TURN_END_MAX_MS);
    m.now = t0 + 1000;
    m.sample({ callMs: 61_000, customer: true, partialCustomer: true });
    expect(m.at(t0 + T.ARM_TURN_END_MAX_MS - 1)).toEqual([]);
    expect(m.phase).toBe("armed");
    m.at(t0 + T.ARM_TURN_END_MAX_MS);
    expect(m.phase).toBe("sealing");
    expect(m.p.capHit).toBe(true);
    expect(m.p.speakingCh).toBe("customer");
    expect(m.p.tCutMs).toBe(61_000);
  });

  it("the cap without speech (only an open partial) seals without capHit", () => {
    const m = new M();
    m.sample({ speaking: { rep: false, customer: false }, quiet: false, partialRep: true });
    m.arm();
    m.at(m.now + T.ARM_TURN_END_MAX_MS);
    expect(m.phase).toBe("sealing");
    expect(m.p.capHit).toBe(false);
  });

  it("the handoff clip's scheduled end becomes repLineEnd (HUD mark)", () => {
    const m = new M().toSealing();
    const fx = m.send({ type: "clip_scheduled", now: m.now, endCtxMs: m.now + 3480 });
    expect(m.p.repLineEnd).toBe(m.now + 3480);
    expect(fx).toContainEqual({ type: "hud_mark", name: "repLineEnd", ctxMs: m.now + 3480 });
  });

  it("without a labelled handoff there is no clip and repLineEnd = the seal", () => {
    const m = new M({ handoff: null });
    m.sample({ quiet: true });
    const fx = m.arm();
    expect(m.has("play_handoff_clip", fx)).toBe(false);
    expect(m.p.repLineEnd).toBe(m.now);
  });
});

describe("SEALING: ForceEndpoint only after SEAL_TAIL_MS (rule 1)", () => {
  it("never force-endpoints before tCut + 250 ms, then only channels with an open partial, once", () => {
    const m = new M();
    m.sample({ rep: true, partialRep: true });
    m.arm();
    m.at(m.now + 100);
    expect(m.effects("force_endpoint")).toEqual([]); // never in ARMED
    m.now += 200;
    m.sample({ quiet: true, partialRep: true });
    const sealedAt = m.p.sealedAt!;
    expect(m.deadline).toBe(sealedAt + T.SEAL_TAIL_MS);
    m.sample({ quiet: true, partialRep: true, partialCustomer: false });
    m.at(sealedAt + T.SEAL_TAIL_MS - 1);
    expect(m.effects("force_endpoint")).toEqual([]);
    const fx = m.at(sealedAt + T.SEAL_TAIL_MS);
    expect(fx).toEqual([{ type: "force_endpoint", channel: "rep" }]);
    m.at(sealedAt + 400);
    expect(m.effects("force_endpoint")).toHaveLength(1);
    expect(m.phase).toBe("sealing");
  });

  it("force-endpoints both channels when both have open partials", () => {
    const m = new M();
    m.sample({ rep: true, partialRep: true, partialCustomer: true });
    m.arm();
    m.now += 400;
    m.sample({ quiet: true, partialRep: true, partialCustomer: true });
    const fx = m.at(m.p.sealedAt! + T.SEAL_TAIL_MS);
    expect(fx).toEqual([
      { type: "force_endpoint", channel: "rep" },
      { type: "force_endpoint", channel: "customer" },
    ]);
  });

  it("no open partials at the seal → DRAINING at once, no ForceEndpoint ever", () => {
    const m = new M();
    m.sample({ quiet: true });
    const fx = m.arm();
    expect(m.phase).toBe("draining");
    expect(fx).toContainEqual({ type: "drain", timeoutMs: T.DRAIN_MAX_MS });
    expect(fx).toContainEqual({ type: "terminate_stt" });
    m.at(m.now + 1000);
    expect(m.effects("force_endpoint")).toEqual([]);
  });

  it("SEALING → DRAINING when the partials close", () => {
    const m = new M().toSealing();
    m.at(m.p.sealedAt! + T.SEAL_TAIL_MS);
    m.now += 150;
    const fx = m.sample({ quiet: true });
    expect(m.phase).toBe("draining");
    expect(fx).toContainEqual({ type: "drain", timeoutMs: T.DRAIN_MAX_MS });
    expect(m.p.timings.finals).toBe(m.now - m.p.t0);
  });

  it("SEALING → DRAINING at tCut + FINALS_WAIT_MAX_MS even with a partial still open", () => {
    const m = new M().toSealing();
    const sealedAt = m.p.sealedAt!;
    m.at(sealedAt + T.SEAL_TAIL_MS);
    m.at(sealedAt + T.FINALS_WAIT_MAX_MS - 1);
    expect(m.phase).toBe("sealing");
    m.at(sealedAt + T.FINALS_WAIT_MAX_MS);
    expect(m.phase).toBe("draining");
  });

  it("cut turns: with capHit, the final of the in-progress turn on the speaking channel is cut; others are not", () => {
    const m = new M();
    m.sample({ callMs: 80_000, customer: true, partialCustomer: true });
    m.arm();
    m.now += 1000;
    m.sample({ callMs: 81_000, customer: true, partialCustomer: true });
    m.at(m.now + 500); // cap at t0 + 1500
    expect(m.p.capHit).toBe(true);
    const tCut = m.p.tCutMs!;
    m.send({ type: "final", now: m.now + 300, turnId: "customer-7", channel: "customer", startMs: tCut - 2400, endMs: tCut + 180 });
    m.send({ type: "final", now: m.now + 310, turnId: "rep-6", channel: "rep", startMs: tCut - 5000, endMs: tCut - 3000 });
    m.at(m.p.sealedAt! + T.FINALS_WAIT_MAX_MS);
    m.send({ type: "arm_ok", now: m.now, takeoverId: "tko_1", leadMs: 900 });
    m.send({ type: "drained", now: m.now + 100, completedTurnIds: ["customer-7", "rep-6"], pendingTurnIds: [], waitedMs: 100 });
    expect(m.p.drain?.cutTurnIds).toEqual(["customer-7"]);
    expect(m.p.drain?.capHit).toBe(true);
  });

  it("without capHit no turn is cut", () => {
    const m = new M().toSealing();
    m.send({ type: "final", now: m.now + 100, turnId: "rep-4", channel: "rep", startMs: m.p.tCutMs! - 900, endMs: m.p.tCutMs! - 350 });
    expect(m.p.cutTurnIds).toEqual([]);
  });
});

describe("DRAINING → COMPILING", () => {
  it("builds the DrainReport and posts /compile", () => {
    const m = new M().toDraining();
    const tArm = m.p.tArmMs;
    const fx = m.send({ type: "drained", now: m.now + 180, completedTurnIds: ["rep-3", "customer-2", "rep-4"], pendingTurnIds: ["rep-4", "customer-3"], waitedMs: 180 });
    expect(m.phase).toBe("compiling");
    const pc = m.effects("post_compile", fx)[0]!;
    expect(pc.takeoverId).toBe("tko_1");
    expect(pc.drain).toMatchObject({
      tArmMs: tArm,
      tCutMs: m.p.tCutMs,
      capHit: false,
      midUtterance: true,
      completedTurnIds: ["rep-3", "customer-2", "rep-4"],
      pendingTurnIds: ["customer-3"],
      cutTurnIds: [],
      waitedMs: 180,
    });
    expect(pc.drain.timings).toMatchObject({ armed: 0, sealed: 300 });
    expect(pc.drain.timings.drained).toBeGreaterThan(pc.drain.timings.finals!);
  });

  it("stops waiting for CaseSync at DRAIN_MAX_MS + grace", () => {
    const m = new M().toDraining();
    m.send({ type: "va_token", now: m.now, attempt: 0, liveSessionId: "l0" });
    m.send({ type: "va_open", now: m.now, attempt: 0 });
    const start = m.p.drainStartedAt!;
    expect(m.deadline).toBe(start + T.DRAIN_MAX_MS + DRAIN_BACKSTOP_GRACE_MS);
    m.at(start + T.DRAIN_MAX_MS + DRAIN_BACKSTOP_GRACE_MS - 1);
    expect(m.phase).toBe("draining");
    const fx = m.at(start + T.DRAIN_MAX_MS + DRAIN_BACKSTOP_GRACE_MS);
    expect(m.phase).toBe("compiling");
    expect(m.effects("post_compile", fx)[0]!.drain.waitedMs).toBe(T.DRAIN_MAX_MS + DRAIN_BACKSTOP_GRACE_MS);
  });

  it("waits for a slow arm response before compiling", () => {
    const m = new M();
    m.sample({ quiet: true });
    m.arm(); // → draining at once, arm still pending
    m.send({ type: "drained", now: m.now + 50, completedTurnIds: [], pendingTurnIds: [], waitedMs: 50 });
    expect(m.phase).toBe("compiling");
    expect(m.p.compile.status).toBe("waiting_arm");
    expect(m.effects("post_compile")).toEqual([]);
    const fx = m.armOk("tko_late");
    expect(m.effects("post_compile", fx)[0]!.takeoverId).toBe("tko_late");
    expect(fx).toContainEqual({ type: "mint_va", attempt: 0, takeoverId: "tko_late" });
  });

  it("an arm that failed after sealing ends the pass at COMPILING (fallback bundle)", () => {
    const m = new M().toSealing();
    // toSealing() acknowledged the arm; simulate a pass whose arm failed instead
    const m2 = new M();
    m2.sample({ rep: true, partialRep: true });
    m2.arm();
    m2.now += 300;
    m2.sample({ quiet: true });
    m2.send({ type: "arm_failed", now: m2.now, code: "E_DB", message: "db down" });
    expect(m2.phase).toBe("draining");
    m2.send({ type: "drained", now: m2.now + 20, completedTurnIds: [], pendingTurnIds: [], waitedMs: 20 });
    expect(m2.phase).toBe("fallback");
    expect(m2.effects("play_recorded")).toHaveLength(1);
    expect(m2.effects("post_end")).toEqual([]); // no takeover id to end
    expect(m.phase).toBe("sealing");
  });
});

describe("COMPILING → CONNECTING", () => {
  it("falls back to a local compile after COMPILE_TIMEOUT_MS", () => {
    const m = new M().toCompiling();
    const start = m.p.compile.startedAt!;
    expect(m.deadline).toBe(start + T.COMPILE_TIMEOUT_MS);
    m.at(start + T.COMPILE_TIMEOUT_MS - 1);
    expect(m.effects("compile_local")).toEqual([]);
    const fx = m.at(start + T.COMPILE_TIMEOUT_MS);
    expect(fx).toEqual([{ type: "compile_local", drain: m.p.drain }]);
    m.send({ type: "compiled", now: m.now + 5, compiled: { ...compiledFixture(), compiledBy: "client" }, by: "client" });
    expect(m.p.compile.by).toBe("client");
    // a late server answer is ignored
    m.send({ type: "compiled", now: m.now + 50, compiled: compiledFixture(), by: "server" });
    expect(m.p.compile.by).toBe("client");
  });

  it("a server compile error goes local at once; a local failure ends the pass", () => {
    const m = new M({ hasRecordedBundle: false }).toCompiling();
    const fx = m.send({ type: "compile_failed", now: m.now + 30, by: "server", code: "E_VA_CONFIG", message: "bad" });
    expect(fx).toEqual([{ type: "compile_local", drain: m.p.drain }]);
    m.send({ type: "compile_failed", now: m.now + 40, by: "client", code: "E_VA_CONFIG", message: "bad" });
    expect(m.phase).toBe("failed");
    expect(m.effects("post_end").at(-1)).toMatchObject({ outcome: "failed", takeoverId: "tko_1" });
  });
});

describe("CONNECTING → GREETING at tSend = max(now, repLineEnd − leadMs)", () => {
  it("waits for tSend and sends the compiled config with holdAudioUntil = repLineEnd", () => {
    const m = new M().toConnecting();
    expect(m.phase).toBe("connecting");
    const repEnd = m.p.repLineEnd!;
    expect(m.deadline).toBe(repEnd - 900);
    m.at(repEnd - 901);
    expect(m.phase).toBe("connecting");
    const fx = m.at(repEnd - 900);
    expect(m.phase).toBe("greeting");
    expect(fx).toEqual([{ type: "start_va", attempt: 0, compiled: m.p.compile.compiled, holdAudioUntilCtxMs: repEnd }]);
    expect(m.p.timings.sessionUpdateSent).toBe(repEnd - 900 - m.p.t0);
  });

  it("sends at once when tSend has passed", () => {
    const m = new M();
    m.sample({ quiet: true, callMs: 50_000 });
    m.arm();
    m.armOk("tko_1", 900);
    m.send({ type: "clip_scheduled", now: m.now, endCtxMs: m.now + 500 });
    m.send({ type: "drained", now: (m.now += 100), completedTurnIds: [], pendingTurnIds: [], waitedMs: 100 });
    m.send({ type: "compiled", now: (m.now += 200), compiled: compiledFixture(), by: "server" });
    m.send({ type: "va_token", now: (m.now += 100), attempt: 0, liveSessionId: "va_tko_1_0" });
    expect(m.phase).toBe("connecting");
    const fx = m.send({ type: "va_open", now: (m.now += 400), attempt: 0 });
    expect(m.phase).toBe("greeting");
    expect(m.effects("start_va", fx)).toHaveLength(1);
  });

  it("waits for the clip end to be known (manual pass)", () => {
    const m = new M();
    m.sample({ quiet: true });
    m.arm();
    m.armOk();
    m.send({ type: "drained", now: (m.now += 100), completedTurnIds: [], pendingTurnIds: [], waitedMs: 100 });
    m.send({ type: "compiled", now: (m.now += 100), compiled: compiledFixture(), by: "server" });
    m.send({ type: "va_token", now: (m.now += 100), attempt: 0, liveSessionId: "l" });
    m.send({ type: "va_open", now: (m.now += 100), attempt: 0 });
    expect(m.phase).toBe("connecting");
    const fx = m.send({ type: "clip_scheduled", now: m.now, endCtxMs: m.now + 100 });
    expect(m.phase).toBe("greeting");
    expect(m.effects("start_va", fx)).toHaveLength(1);
  });
});

describe("GREETING → ACTIVE, and the Voice Agent timeouts", () => {
  it("session.ready then the first audible chunk PLAYED → ACTIVE; posts the timings (sessionUpdateSent, firstAudiblePlayed)", () => {
    const m = new M().toGreeting();
    const rep = m.send({ type: "va_ready", now: (m.now += 640), attempt: 0, sessionId: "sess_A" });
    expect(rep).toEqual([{ type: "report_va", event: "opened", liveSessionId: "va_tko_1_0", providerSessionId: "sess_A" }]);
    const audibleAt = m.p.repLineEnd! + 280;
    m.now = audibleAt;
    const fx = m.send({ type: "va_first_audible", now: audibleAt, attempt: 0, ctxMs: audibleAt });
    expect(m.phase).toBe("active");
    const pe = m.effects("post_events", fx)[0]!;
    expect(pe.phase).toBe("active");
    expect(pe.vaSessionId).toBe("sess_A");
    expect(pe.timings?.firstAudiblePlayed).toBe(audibleAt - m.p.t0);
    expect(pe.timings?.sessionUpdateSent).toBeDefined();
  });

  it("session.ready timeout (3000 ms after the first update) → RETRYING with attempt 1", () => {
    const m = new M().toGreeting();
    const sent = m.now;
    expect(m.deadline).toBe(sent + T.SESSION_READY_TIMEOUT_MS);
    m.at(sent + T.SESSION_READY_TIMEOUT_MS - 1);
    expect(m.phase).toBe("greeting");
    const fx = m.at(sent + T.SESSION_READY_TIMEOUT_MS);
    expect(m.phase).toBe("retrying");
    expect(fx).toEqual([
      { type: "abort_va", attempt: 0, reason: "E_VA_TIMEOUT" },
      { type: "report_failure", takeoverId: "tko_1", code: "E_VA_TIMEOUT" },
      { type: "mint_va", attempt: 1, takeoverId: "tko_1" },
    ]);
  });

  it("no audible greeting within 5000 ms of max(ready, repLineEnd) → RETRYING", () => {
    const m = new M().toGreeting();
    m.send({ type: "va_ready", now: (m.now += 600), attempt: 0, sessionId: "s" });
    const base = Math.max(m.now, m.p.repLineEnd!);
    expect(m.deadline).toBe(base + T.FIRST_AUDIBLE_TIMEOUT_MS);
    m.at(base + T.FIRST_AUDIBLE_TIMEOUT_MS - 1);
    expect(m.phase).toBe("greeting");
    m.at(base + T.FIRST_AUDIBLE_TIMEOUT_MS);
    expect(m.phase).toBe("retrying");
  });

  it("the retry reuses the same compiled config and goes back to GREETING, then ACTIVE", () => {
    const m = new M().toGreeting();
    const compiled = m.p.compile.compiled;
    m.send({ type: "va_error", now: (m.now += 200), attempt: 0, code: "E_VA_TRANSIENT", retryable: true, message: "server_error" });
    expect(m.phase).toBe("retrying");
    // stale events of the old socket are ignored
    expect(m.send({ type: "va_ready", now: m.now, attempt: 0, sessionId: "old" })).toEqual([]);
    expect(m.send({ type: "va_token", now: (m.now += 300), attempt: 1, liveSessionId: "va_tko_1_1" })).toEqual([{ type: "open_va", attempt: 1 }]);
    const fx = m.send({ type: "va_open", now: (m.now += 400), attempt: 1 });
    const sv = m.effects("start_va", fx);
    expect(sv).toHaveLength(1);
    expect(sv[0]!.attempt).toBe(1);
    expect(sv[0]!.compiled).toBe(compiled);
    expect(m.phase).toBe("greeting");
    m.send({ type: "va_ready", now: (m.now += 600), attempt: 1, sessionId: "sess_B" });
    m.send({ type: "va_first_audible", now: (m.now += 300), attempt: 1, ctxMs: m.now });
    expect(m.phase).toBe("active");
  });

  it("retries at most once: a second failure → FALLBACK (recorded bundle) and never a third mint", () => {
    const m = new M().toGreeting();
    m.send({ type: "va_error", now: (m.now += 200), attempt: 0, code: "E_VA_AUTH", retryable: true, message: "unauthorized" });
    m.send({ type: "va_token", now: (m.now += 300), attempt: 1, liveSessionId: "va_tko_1_1" });
    m.send({ type: "va_open", now: (m.now += 300), attempt: 1 });
    const fx = m.send({ type: "va_error", now: (m.now += 900), attempt: 1, code: "E_VA_TRANSIENT", retryable: true, message: "again" });
    expect(m.phase).toBe("fallback");
    expect(fx).toContainEqual({ type: "abort_va", attempt: 1, reason: "E_VA_TRANSIENT" });
    expect(fx).toContainEqual({ type: "play_recorded" });
    expect(m.effects("post_end", fx)[0]).toMatchObject({ outcome: "failed", keepalive: false });
    const mints = m.effects("mint_va");
    expect(mints.map((e) => e.attempt)).toEqual([0, 1]);
    expect(m.effects("report_failure")).toHaveLength(1);
    // nothing more happens
    m.at(m.now + 60_000);
    expect(m.effects("mint_va")).toHaveLength(2);
  });

  it("without a recorded bundle the second failure ends FAILED with an error card", () => {
    const m = new M({ hasRecordedBundle: false }).toGreeting();
    m.at(m.now + T.SESSION_READY_TIMEOUT_MS);
    m.send({ type: "va_token_failed", now: (m.now += 50), attempt: 1, code: "E_VA_CAPACITY", message: "busy" });
    expect(m.phase).toBe("failed");
    expect(m.effects("notice").at(-1)).toMatchObject({ level: "error", code: "E_VA_CAPACITY" });
  });

  it("E_VA_CONFIG never retries", () => {
    const m = new M().toGreeting();
    m.send({ type: "va_error", now: (m.now += 100), attempt: 0, code: "E_VA_CONFIG", retryable: false, message: "1008" });
    expect(m.phase).toBe("fallback");
    expect(m.effects("mint_va").map((e) => e.attempt)).toEqual([0]);
    expect(isRetryableVaCode("E_VA_CONFIG")).toBe(false);
    expect(isRetryableVaCode("E_VA_AUTH")).toBe(true);
  });

  it("a retryable code marked non-retryable by the source is not retried", () => {
    const m = new M().toGreeting();
    m.send({ type: "va_error", now: (m.now += 100), attempt: 0, code: "E_VA_TRANSIENT", retryable: false, message: "x" });
    expect(m.phase).toBe("fallback");
  });

  it("an unexpected session end during the greeting counts as a retryable failure", () => {
    const m = new M().toGreeting();
    m.send({ type: "va_ended", now: (m.now += 100), attempt: 0, reason: "closed", sessionSeconds: 0.4 });
    expect(m.phase).toBe("retrying");
  });

  it("pre-open failures retry in the background without changing the protocol phase", () => {
    const m = new M();
    m.sample({ rep: true, partialRep: true });
    m.arm();
    m.armOk();
    const minted = m.now;
    expect(m.deadline).toBe(minted + T.VA_TOKEN_TIMEOUT_MS < m.p.t0 + T.ARM_TURN_END_MAX_MS ? minted + T.VA_TOKEN_TIMEOUT_MS : m.p.t0 + T.ARM_TURN_END_MAX_MS);
    m.now += 200;
    m.sample({ quiet: true, partialRep: true }); // sealing
    const fx = m.at(minted + T.VA_TOKEN_TIMEOUT_MS); // token timed out (sealing → draining at +900 already)
    expect(fx).toContainEqual({ type: "report_failure", takeoverId: "tko_1", code: "E_VA_TIMEOUT" });
    expect(fx).toContainEqual({ type: "mint_va", attempt: 1, takeoverId: "tko_1" });
    expect(m.effects("abort_va", fx)).toEqual([]); // no socket yet
    expect(["sealing", "draining"]).toContain(m.phase);
    expect(m.p.va.attempt).toBe(1);
  });

  it("a WS that does not open within 3000 ms is a failure (attempt 0 → retry)", () => {
    const m = new M();
    m.sample({ rep: true });
    m.arm();
    m.armOk();
    m.send({ type: "va_token", now: (m.now += 100), attempt: 0, liveSessionId: "l0" });
    const opening = m.now;
    const fx = m.at(opening + T.VA_WS_OPEN_TIMEOUT_MS);
    expect(fx).toContainEqual({ type: "abort_va", attempt: 0, reason: "E_VA_TIMEOUT" });
    expect(fx).toContainEqual({ type: "mint_va", attempt: 1, takeoverId: "tko_1" });
  });

  it("a VA that died before CONNECTING ends the pass at CONNECTING, after the snapshot froze", () => {
    const m = new M();
    m.sample({ rep: true, partialRep: true });
    m.arm();
    m.armOk();
    m.send({ type: "va_token_failed", now: (m.now += 50), attempt: 0, code: "E_VA_CAPACITY", message: "slots full" });
    expect(m.p.va.status).toBe("dead");
    expect(m.phase).toBe("armed");
    m.now += 100;
    m.sample({ quiet: true });
    m.send({ type: "clip_scheduled", now: m.now, endCtxMs: m.now + 3000 });
    m.send({ type: "drained", now: (m.now += 100), completedTurnIds: [], pendingTurnIds: [], waitedMs: 100 });
    expect(m.phase).toBe("compiling");
    m.send({ type: "compiled", now: (m.now += 300), compiled: compiledFixture(), by: "server" });
    expect(m.phase).toBe("fallback");
    expect(m.effects("post_compile")).toHaveLength(1);
    expect(m.effects("mint_va").map((e) => e.attempt)).toEqual([0]);
  });
});

describe("ACTIVE ⇄ PAYING → CLOSING → DONE", () => {
  it("paying toggles; close_ready → session.end → ended → report closed, POST /end completed", () => {
    const m = new M().toActive();
    m.send({ type: "va_paying", now: (m.now += 10), on: true });
    expect(m.phase).toBe("paying");
    m.send({ type: "va_paying", now: (m.now += 10), on: false });
    expect(m.phase).toBe("active");
    const fx = m.send({ type: "va_close_ready", now: (m.now += 10) });
    expect(m.phase).toBe("closing");
    expect(fx).toEqual([{ type: "end_va", reason: "close_ready" }]);
    const done = m.send({ type: "va_ended", now: (m.now += 400), attempt: 0, reason: "close_ready", sessionSeconds: 95.25 });
    expect(m.phase).toBe("done");
    expect(done).toEqual([
      { type: "report_va", event: "closed", liveSessionId: "va_tko_1_0", billedSeconds: 95.25 },
      { type: "post_end", takeoverId: "tko_1", outcome: "completed", vaSessionId: "sess_1", reason: "close_ready", keepalive: false },
    ]);
    expect(m.s.lastOutcome).toBe("completed");
    expect(manualPassAllowed(m.s)).toBe(false);
  });

  it("hand_back: the rep's line plays first, then session.end; outcome handed_back; a second pass is allowed (no clip)", () => {
    const m = new M().toActive();
    const fx = m.send({ type: "va_hand_back", now: (m.now += 10), reason: "customer_request" });
    expect(fx).toEqual([{ type: "play_rep_back" }]);
    expect(m.deadline).toBe(m.now + REP_BACK_MAX_MS);
    expect(m.send({ type: "rep_back_done", now: (m.now += 2100) })).toEqual([{ type: "end_va", reason: "hand_back" }]);
    m.send({ type: "va_ended", now: (m.now += 300), attempt: 0, reason: "hand_back", sessionSeconds: 40 });
    expect(m.effects("post_end").at(-1)).toMatchObject({ outcome: "handed_back" });
    expect(m.phase).toBe("done");
    expect(manualPassAllowed(m.s)).toBe(true);
    m.sample({ playing: false, quiet: true });
    const again = m.arm();
    expect(m.phase).toBe("draining"); // playback is stopped: sealed at the click, nothing to drain but CaseSync
    expect(m.has("play_handoff_clip", again)).toBe(false);
    expect(m.p.repLineEnd).toBe(m.now);
    expect(m.s.passes).toBe(2);
  });

  it("the rep line has REP_BACK_MAX_MS to finish", () => {
    const m = new M().toActive();
    m.send({ type: "va_hand_back", now: (m.now += 10), reason: "other" });
    expect(m.at(m.now + REP_BACK_MAX_MS)).toEqual([{ type: "end_va", reason: "hand_back" }]);
  });

  it("CLOSING without session.ended closes after SESSION_ENDED_WAIT_MS + backstop", () => {
    const m = new M().toActive();
    m.send({ type: "end_call", now: (m.now += 10), reason: "user_end" });
    expect(m.phase).toBe("closing");
    const start = m.now;
    m.at(start + T.SESSION_ENDED_WAIT_MS + CLOSE_BACKSTOP_MS - 1);
    expect(m.phase).toBe("closing");
    const fx = m.at(start + T.SESSION_ENDED_WAIT_MS + CLOSE_BACKSTOP_MS);
    expect(fx[0]).toEqual({ type: "end_va_now", reason: "session_ended_timeout" });
    expect(m.effects("post_end", fx)[0]).toMatchObject({ outcome: "abandoned", reason: "user_end" });
    expect(m.phase).toBe("done");
  });

  it("the cap (the VA controller ends the session itself) → outcome handed_back, reason cap", () => {
    const m = new M().toActive();
    m.send({ type: "va_ended", now: (m.now += 150_000), attempt: 0, reason: "cap", sessionSeconds: 150 });
    expect(m.phase).toBe("done");
    expect(m.effects("post_end").at(-1)).toMatchObject({ outcome: "handed_back", reason: "cap" });
  });

  it("a failure after the greeting is not retried: the session ends and the pass is FAILED", () => {
    const m = new M().toActive();
    m.send({ type: "va_error", now: (m.now += 20_000), attempt: 0, code: "E_VA_SILENT", retryable: true, message: "silent twice" });
    expect(m.phase).toBe("closing");
    expect(m.effects("mint_va").map((e) => e.attempt)).toEqual([0]);
    m.send({ type: "va_ended", now: (m.now += 200), attempt: 0, reason: "error", sessionSeconds: 30 });
    expect(m.phase).toBe("failed");
    expect(m.effects("post_end").at(-1)).toMatchObject({ outcome: "failed", reason: "E_VA_SILENT" });
  });

  it("End call before the AI speaks abandons the pass", () => {
    const m = new M().toSealing();
    const fx = m.send({ type: "end_call", now: (m.now += 10), reason: "user_abort" });
    expect(m.phase).toBe("done");
    expect(fx).toContainEqual({ type: "terminate_stt" });
    expect(m.effects("post_end", fx)[0]).toMatchObject({ outcome: "abandoned", reason: "user_abort" });
    expect(m.effects("abort_va", fx)).toHaveLength(0); // the token mint was still in flight: nothing to abort
  });
});

describe("pagehide from every state releases the run (rule 8)", () => {
  type Build = () => M;
  const states: [string, Build][] = [
    ["idle", () => new M()],
    ["armed", () => { const m = new M(); m.sample({ rep: true }); m.arm(); m.armOk(); return m; }],
    ["sealing", () => new M().toSealing()],
    ["draining", () => new M().toDraining()],
    ["compiling", () => new M().toCompiling()],
    ["connecting", () => new M().toConnecting()],
    ["retrying", () => { const m = new M().toGreeting(); m.send({ type: "va_error", now: m.now + 1, attempt: 0, code: "E_VA_TRANSIENT", retryable: true, message: "x" }); return m; }],
    ["greeting", () => new M().toGreeting()],
    ["active", () => new M().toActive()],
    ["paying", () => { const m = new M().toActive(); m.send({ type: "va_paying", now: m.now, on: true }); return m; }],
    ["closing", () => { const m = new M().toActive(); m.send({ type: "va_close_ready", now: m.now }); return m; }],
    ["done", () => { const m = new M().toActive(); m.send({ type: "va_close_ready", now: m.now }); m.send({ type: "va_ended", now: m.now + 1, attempt: 0, reason: "x", sessionSeconds: 1 }); return m; }],
    ["failed", () => { const m = new M({ hasRecordedBundle: false }).toGreeting(); m.send({ type: "va_error", now: m.now + 1, attempt: 0, code: "E_VA_CONFIG", retryable: false, message: "x" }); return m; }],
    ["fallback", () => { const m = new M().toGreeting(); m.send({ type: "va_error", now: m.now + 1, attempt: 0, code: "E_VA_CONFIG", retryable: false, message: "x" }); return m; }],
  ];

  for (const [phase, build] of states) {
    it(`from ${phase}`, () => {
      const m = build();
      expect(m.phase).toBe(phase);
      const endedBefore = m.effects("post_end").length;
      const fx = m.send({ type: "pagehide", now: m.now + 5 });
      expect(fx).toContainEqual({ type: "release_run", keepalive: true });
      expect(fx).toContainEqual({ type: "terminate_stt" });
      // A socket exists (pre-opened or in session) → session.end is sent synchronously first.
      const socket = ["connecting", "greeting", "active", "paying", "closing"].includes(phase);
      expect(m.has("end_va_now", fx)).toBe(socket);
      if (socket) expect(fx[0]).toEqual({ type: "end_va_now", reason: "pagehide" });
      const livePass = !["idle", "done", "failed"].includes(phase) && endedBefore === 0;
      const ends = m.effects("post_end", fx);
      if (livePass) expect(ends).toEqual([expect.objectContaining({ outcome: "abandoned", reason: "pagehide", keepalive: true })]);
      else expect(ends).toEqual([]);
      if (phase === "fallback") expect(fx).toContainEqual({ type: "stop_recorded" });
      // inert afterwards
      expect(m.s.disposed).toBe(true);
      expect(m.send({ type: "tick", now: m.now + 100_000 })).toEqual([]);
      expect(m.arm()).toEqual([]);
      expect(manualPassAllowed(m.s)).toBe(false);
    });
  }
});

describe("auto-baton at the recorded handoff line (rule 6)", () => {
  it("arms at lineStartMs with tArm = lineStartMs, no clip, and seals after the recorded acceptance", () => {
    const m = new M();
    m.sample({ callMs: HANDOFF.lineStartMs - 40, rep: true });
    expect(m.phase).toBe("idle");
    m.now += 40;
    const fx = m.sample({ callMs: HANDOFF.lineStartMs + 5, rep: true });
    expect(m.phase).toBe("armed");
    expect(m.p.source).toBe("auto_handoff");
    expect(m.p.tArmMs).toBe(HANDOFF.lineStartMs);
    expect(m.p.midUtterance).toBe(false);
    expect(fx).toContainEqual({ type: "post_arm", tArmMs: HANDOFF.lineStartMs, midUtterance: false, source: "auto_handoff" });
    const expectedRepEnd = m.now + (HANDOFF.acceptEndMs! - (HANDOFF.lineStartMs + 5));
    expect(m.p.repLineEnd).toBe(expectedRepEnd);
    expect(fx).toContainEqual({ type: "hud_mark", name: "repLineEnd", ctxMs: expectedRepEnd });
    // playback continues through the rep line and the acceptance; quiet gaps do not seal
    m.now += 1000;
    m.sample({ callMs: HANDOFF.lineStartMs + 1005, quiet: true });
    expect(m.phase).toBe("armed");
    m.at(m.now + T.ARM_TURN_END_MAX_MS); // no 1.5 s cap for the auto-baton
    expect(m.phase).toBe("armed");
    m.now = expectedRepEnd;
    const sealFx = m.sample({ callMs: HANDOFF.acceptEndMs!, quiet: true });
    expect(m.phase).not.toBe("armed");
    expect(m.p.tCutMs).toBe(HANDOFF.acceptEndMs);
    expect(sealFx).toContainEqual({ type: "stop_playback", fadeMs: 30 });
    expect(m.has("play_handoff_clip", m.all)).toBe(false);
  });

  it("without a labelled acceptance it seals at lineEndMs + 1500", () => {
    const h = { ...HANDOFF, acceptStartMs: null, acceptEndMs: null };
    const m = new M({ handoff: h });
    m.sample({ callMs: h.lineStartMs });
    expect(m.phase).toBe("armed");
    m.sample({ callMs: h.lineEndMs + 1499 });
    expect(m.phase).toBe("armed");
    m.sample({ callMs: h.lineEndMs + 1500 });
    expect(m.phase).not.toBe("armed");
  });

  it("seals by the backstop if playback stalls", () => {
    const m = new M();
    m.sample({ callMs: HANDOFF.lineStartMs });
    const backstop = m.p.sealBackstopAt!;
    expect(m.deadline).toBe(backstop);
    m.at(backstop);
    expect(m.phase).not.toBe("armed");
  });

  it("is off for declined handoffs, when disabled, after a manual pass, and fires only once", () => {
    const declined = new M({ handoff: { ...HANDOFF, declined: true } });
    declined.sample({ callMs: HANDOFF.lineStartMs + 10 });
    expect(declined.phase).toBe("idle");

    const off = new M({ autoBaton: false });
    off.sample({ callMs: HANDOFF.lineStartMs + 10 });
    expect(off.phase).toBe("idle");

    const once = new M();
    once.sample({ callMs: HANDOFF.lineStartMs });
    once.send({ type: "arm_failed", now: once.now, code: "E_DB", message: "x" });
    expect(once.phase).toBe("idle");
    once.sample({ callMs: HANDOFF.lineStartMs + 500 });
    expect(once.phase).toBe("idle");
    expect(once.effects("post_arm")).toHaveLength(1);
  });

  it("the public arm('auto_handoff') is ignored when not eligible", () => {
    const m = new M({ handoff: null });
    m.sample({ callMs: 1000 });
    expect(m.arm("auto_handoff")).toEqual([]);
    expect(m.phase).toBe("idle");
  });
});

describe("recorded AI half (rule 7): recorded runs never arm manually", () => {
  it("manual Pass is refused with a notice; auto-baton does not arm; the recorded session plays after the acceptance", () => {
    const m = new M({ aiHalf: "recorded" });
    m.sample({ callMs: 30_000, rep: true });
    expect(manualPassAllowed(m.s)).toBe(false);
    const fx = m.arm("manual");
    expect(m.phase).toBe("idle");
    expect(m.effects("post_arm")).toEqual([]);
    expect(fx[0]).toMatchObject({ type: "notice", level: "info" });
    m.sample({ callMs: HANDOFF.lineStartMs + 10 });
    expect(m.phase).toBe("idle");
    expect(m.effects("post_arm")).toEqual([]);
    const rec = m.sample({ callMs: HANDOFF.acceptEndMs! });
    expect(m.phase).toBe("fallback");
    expect(rec).toEqual([{ type: "stop_playback", fadeMs: 30 }, { type: "terminate_stt" }, { type: "play_recorded" }]);
    expect(m.arm("manual").some((e) => e.type === "post_arm")).toBe(false);
    m.send({ type: "recorded_done", now: m.now + 90_000 });
    expect(m.phase).toBe("done");
  });

  it("with no bundle the run ends with 'live AI unavailable'", () => {
    const m = new M({ aiHalf: "recorded", hasRecordedBundle: false });
    const fx = m.sample({ callMs: HANDOFF.acceptEndMs! + 20 });
    expect(m.phase).toBe("done");
    expect(fx.at(-1)).toMatchObject({ type: "notice", message: "Call ended: live AI unavailable; see the Explorer." });
  });
});

describe("end of the recording (rule 8)", () => {
  it("without a pass releases the run once", () => {
    const m = new M({ handoff: null });
    m.sample({ callMs: 10_000 });
    expect(m.send({ type: "recording_ended", now: m.now })).toEqual([{ type: "release_run", keepalive: false }]);
    expect(m.send({ type: "recording_ended", now: m.now })).toEqual([]);
  });

  it("after a pass it does not release (the hold was consumed)", () => {
    const m = new M().toActive();
    expect(m.send({ type: "recording_ended", now: m.now }).some((e: TakeoverEffect) => e.type === "release_run")).toBe(false);
  });

  it("an auto-baton still waiting for the acceptance seals at the end of the recording", () => {
    const m = new M({ handoff: { ...HANDOFF, acceptEndMs: 200_000 } });
    m.sample({ callMs: HANDOFF.lineStartMs });
    m.send({ type: "recording_ended", now: m.now + 5000 });
    expect(m.phase).not.toBe("armed");
  });
});

describe("views", () => {
  it("armView exposes tArm while a pass is in flight (WP4's late flag)", () => {
    const m = new M();
    expect(armView(m.s)).toEqual({ armed: false, tArmMs: null });
    m.sample({ callMs: 12_345, rep: true });
    m.arm();
    expect(armView(m.s)).toEqual({ armed: true, tArmMs: 12_345 });
  });

  it("the reducer never mutates its input state", () => {
    const m = new M().toCompiling();
    const before = JSON.stringify(m.s);
    const snapshot = m.s;
    m.at(m.now + T.COMPILE_TIMEOUT_MS);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});
