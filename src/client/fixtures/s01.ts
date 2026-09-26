/**
 * client/fixtures/s01.ts - generates s01 BatonEvent logs for every console state (DEV FIXTURES).
 *
 * One generator, many variants: live / cached / queued STT, Express prefill, manual or auto pass, live or recorded
 * AI half, VA fallback and failure, hand-back, paused, call ended, QA verified / failed. Every BatonEvent it emits
 * parses with BatonEventSchema (tests/unit/ui/fixtures.test.ts).
 */
import "client-only";

import type { CaseState, Evidence, FactEvent, FieldId } from "@/core/contracts/case";
import type { QaResult } from "@/core/contracts/events";
import type { UiCallContext, UiLogEntry } from "@/core/contracts/ext/wp7-ui";
import type { RunPlan } from "@/core/contracts/run";
import type { Suggestion } from "@/core/contracts/services";
import type { TurnInput } from "@/core/contracts/turns";

import { BATON_UI_SPEC } from "../store/ui-spec";
import {
  emptyCaseState, evidenceFor, FixtureLog, S01_POLICY, setField, syntheticPeaks, turnInput, withConflicts, type ScriptTurn,
} from "./builder";
import {
  S01_AI, S01_CALL_ID, S01_DECISION_POINT_MS, S01_DURATION_MS, S01_EXPRESS_START_MS, S01_HANDOFF, S01_TURNS, type S01Turn,
} from "./s01-script";

export interface S01Options {
  caseId?: string;
  express?: boolean;
  sttHalf?: "live" | "cached";
  queued?: boolean;
  pass?: { kind: "manual"; atMs: number } | { kind: "auto" } | { kind: "none" };
  aiHalf?: "live" | "recorded" | "va-fallback" | "va-failed";
  ending?: "complete" | "handback";
  /** Stop the log at this call-clock ms (shadowing-only fixtures). */
  stopAtMs?: number;
  /**
   * How this take's audio was made (PLATFORM §7.6). The takes that ship today are generated, so the sim variant
   * exists to render exactly what a judge sees on them; "recorded" is the D1 role-play take.
   */
  humanHalf?: "recorded" | "simulated";
  /** Rep reads the date of birth back wrong → an open conflict card. */
  conflict?: boolean;
  paused?: { atMs: number };
  callEnded?: boolean;
  qa?: "verified" | "failed";
}

const PRE_T = 400;
const CLICK_T = 2600;
const EXTRACT_LAG = 900;

const ids = {
  rep: "b9f1c2d4-5e6a-4f70-8a1b-2c3d4e5f6a71",
  customer: "c0a2d3e5-6f7b-4081-9b2c-3d4e5f6a7b82",
  va: "va_7Qk2mZr4TnW8",
};

export function s01Context(): UiCallContext {
  return {
    callId: S01_CALL_ID,
    title: "Add a driver · Priya ↔ Daniel · phone audio 8 kHz, Twilio dual-channel",
    callDate: S01_POLICY.callDate,
    durationMs: S01_DURATION_MS,
    source: "twilio8k",
    language: "en",
    decisionPointMs: S01_DECISION_POINT_MS,
    handoff: S01_HANDOFF,
    hasRecordedAiBundle: true,
    policy: S01_POLICY,
    peaks: syntheticPeaks(S01_TURNS as ScriptTurn[], S01_DURATION_MS),
    sttOpensPerMin: 5,
    cachedTranscribedAt: "2026-09-26",
  };
}

function suggestionsFor(stage: "greeting" | "disclose" | "esign" | "pay" | "close"): Suggestion[] {
  const common: Suggestion[] = [
    { id: "s-daniel", text: "Can I talk to Daniel?", audioUrl: null, voice: "synthetic", kind: "handback" },
    { id: "s-repeat", text: "Sorry, could you repeat that?", audioUrl: null, voice: "synthetic", kind: "repeat" },
  ];
  const head: Record<typeof stage, Suggestion[]> = {
    greeting: [
      { id: "s-yes", text: "Yes, that's all correct.", audioUrl: "/tts/voice/s01/yes-correct.pcm", voice: "recorded", kind: "confirm" },
      { id: "s-try", text: "Actually, she'll mainly drive the Highlander.", audioUrl: null, voice: "synthetic", kind: "try" },
    ],
    disclose: [{ id: "s-go", text: "Yes, go ahead.", audioUrl: "/tts/voice/s01/yes-go-ahead.pcm", voice: "recorded", kind: "consent" }],
    esign: [{ id: "s-text", text: "Yes, text me the link. No paper copy, thanks.", audioUrl: null, voice: "synthetic", kind: "consent" }],
    pay: [{ id: "s-paying", text: "Okay, I'm paying now.", audioUrl: null, voice: "synthetic", kind: "answer" }],
    close: [{ id: "s-bye", text: "No, that's everything. Thanks, bye!", audioUrl: "/tts/voice/s01/bye.pcm", voice: "recorded", kind: "close" }],
  };
  return [...head[stage], ...common].slice(0, 4);
}

function captionWords(text: string, durMs: number): { text: string; atMs: number }[] {
  const toks = text.split(/\s+/).filter(Boolean);
  const per = durMs / Math.max(1, toks.length);
  return toks.map((w, i) => ({ text: w, atMs: Math.round(i * per) }));
}

function qaResult(provisional: boolean, o: { handedBack: boolean; clickMs: number; deadAirMs: number }): QaResult {
  const at = (s: number) => s * 1000;
  return {
    provisional,
    reAsked: 0,
    newlyAsked: 0,
    pendingConfirmed: 0,
    verifiedReconfirmed: o.handedBack ? 2 : 3,
    disclosures: o.handedBack
      ? []
      : [
          { kind: "premium_change", similarity: provisional ? 0.98 : 0.97, ok: true, missingCritical: [] },
          { kind: "esign_consent", similarity: provisional ? 0.96 : 0.95, ok: true, missingCritical: [] },
        ],
    clickToFirstAudibleMs: o.clickMs,
    deadAirAfterRepMs: o.deadAirMs,
    turnLatencyP50Ms: 2400,
    payment: o.handedBack ? "unpaid" : "verified_webhook",
    handedBack: o.handedBack,
    aiSeconds: o.handedBack ? 38 : 112,
    adviceFlags: 0,
    details: [
      { sentence: "I have Maya Raman, born March 14th, 2009, as the primary driver on your 2021 Honda Civic, starting Friday, October 2nd.", atMs: at(3.1), field: "driver_dob", classification: "verified_reconfirm" },
      { sentence: "I have Maya Raman, born March 14th, 2009, as the primary driver on your 2021 Honda Civic, starting Friday, October 2nd.", atMs: at(3.1), field: "operator_type", classification: "verified_reconfirm" },
      ...(o.handedBack
        ? []
        : [
            { sentence: "I have Maya Raman, born March 14th, 2009, as the primary driver on your 2021 Honda Civic, starting Friday, October 2nd.", atMs: at(3.1), field: "effective_date" as FieldId, classification: "verified_reconfirm" as const },
            { sentence: "Is there anything else I can help with?", atMs: at(96.4), field: null, classification: "other" as const },
          ]),
    ],
  };
}

/** Build one s01 variant. */
export function buildS01(o: S01Options = {}): UiLogEntry[] {
  const caseId = o.caseId ?? "case_fixture_s01";
  const L = new FixtureLog();
  const cached = o.sttHalf === "cached";
  const express = !!o.express;
  const offset = express ? S01_EXPRESS_START_MS : 0;
  const pass = o.pass ?? { kind: "manual", atMs: 110_000 };
  const aiHalf = o.aiHalf ?? "live";
  const recordedPlan = aiHalf === "recorded";

  const plan: RunPlan = {
    runId: "run_fixture_s01",
    caseId,
    sttHalf: cached ? "cached" : "live",
    aiHalf: recordedPlan ? "recorded" : "live",
    vaHoldId: recordedPlan ? null : "hold_fixture_s01",
    holdExpiresAt: recordedPlan ? null : "2026-09-25T18:00:00.000Z",
    reason: recordedPlan
      ? "Live AI is busy right now: you'll watch the recorded AI session at Daniel's handoff line (01:50)."
      : cached
        ? "Several people on your network ran live demos this hour: showing the labelled replay; live again in 12 min."
        : null,
    recordedHandoffMs: recordedPlan ? S01_HANDOFF.lineStartMs : null,
  };

  // ---------------------------------------------------------------- pre-flight
  const simulated = o.humanHalf === "simulated";
  L.add(0, { type: "ui.context", context: s01Context() });
  L.add(1, {
    type: "ui.relay",
    relay: BATON_UI_SPEC,
    provenance: {
      humanHalf: simulated ? "simulated" : "recorded",
      transcription: { kind: cached ? "cached" : "live", date: cached ? "2026-09-26" : null },
      aiHalf: { kind: recordedPlan ? "recorded" : "live", date: recordedPlan ? "2026-09-25" : null },
      customerInAiHalf: recordedPlan ? "recorded" : simulated ? "synthetic" : "recorded",
      detail: simulated ? "Simulated audio: script by gpt-6-luna, voices by gpt-4o-mini-tts. Fictional people." : null,
    },
    account: null,
  });
  L.add(PRE_T - 100, { type: "call.loaded", callId: S01_CALL_ID, durationMs: S01_DURATION_MS });
  L.add(PRE_T, { type: "run.plan", plan });
  L.add(PRE_T + 10, { type: "ui.autopilot", on: true });
  L.add(CLICK_T, { type: "ui.start", kind: express ? "express" : "full", startOffsetMs: offset });

  // ---------------------------------------------------------------- connecting / queued
  let callStartT = CLICK_T + 1400;
  if (cached) {
    L.add(CLICK_T + 300, { type: "mode", mode: "cached_replay", reason: plan.reason ?? "live transcription is unavailable" });
    L.add(CLICK_T + 300, { type: "fallback", kind: "cached_turn_replay", label: "CACHED REPLAY: transcribed live by AssemblyAI on Sat 26 Sep 2026; replayed now because live transcription is busy this hour." });
    callStartT = CLICK_T + 900;
  } else {
    if (o.queued) {
      for (const ch of ["rep", "customer"] as const) L.add(CLICK_T + 200, { type: "stt.status", channel: ch, status: "queued", detail: "position 2, ~10 s" });
      for (const ch of ["rep", "customer"] as const) L.add(CLICK_T + 5200, { type: "stt.status", channel: ch, status: "queued", detail: "position 1, ~5 s" });
      callStartT += 9800;
    }
    const c0 = callStartT - 1300;
    for (const ch of ["rep", "customer"] as const) L.add(c0, { type: "stt.status", channel: ch, status: "connecting" });
    L.add(c0 + 1050, { type: "stt.status", channel: "rep", status: "open", detail: `Begin ${ids.rep}` });
    L.add(c0 + 1100, { type: "stt.status", channel: "customer", status: "open", detail: `Begin ${ids.customer}` });
    L.add(c0 + 1120, { type: "ui.session-ids", ids: { rep: ids.rep, customer: ids.customer } });
  }
  const T = (callMs: number) => callStartT + (callMs - offset);

  // ---------------------------------------------------------------- human half
  let cs: CaseState = emptyCaseState(caseId);
  const autoArmMs = S01_HANDOFF.lineStartMs;
  const armCallMs = pass.kind === "manual" ? pass.atMs : pass.kind === "auto" || recordedPlan ? autoArmMs : null;
  const stopMs = Math.min(o.stopAtMs ?? Infinity, o.paused?.atMs ?? Infinity, pass.kind === "manual" ? pass.atMs : Infinity);
  // Auto pass: playback continues through the rep's line and the acceptance (§5.5.4 rule 6).
  const playUntil = pass.kind === "manual" ? stopMs : Math.min(stopMs, (armCallMs !== null ? (S01_HANDOFF.acceptEndMs ?? S01_HANDOFF.lineEndMs) : S01_DURATION_MS) + 1);
  const order = { rep: 0, customer: 0 };
  const cachedOrder = { rep: 0, customer: 0 };
  const prefill: TurnInput[] = [];
  let prefillState: CaseState | null = null;

  const applyUpdates = (turn: TurnInput, st: S01Turn, conflictMode: boolean) => {
    for (const u of st.updates ?? []) {
      let upd = u;
      if (conflictMode && u.field === "driver_dob" && st.ch === "rep") {
        // The rep reads back "March 4th": the customer said the 14th → PENDING (conflict) with both clips.
        const custTurn = S01_TURNS[5] as S01Turn;
        const custInput = turnInput(caseId, custTurn, 2);
        const evCust = evidenceFor(custInput, "March 14th, 2009,");
        const evRep = evidenceFor(turn, "born March 4th, 2009.");
        cs = setField(cs, "driver_dob", { status: "PENDING", reason: "conflict", evidence: [evRep], conflict: { values: ["2009-03-14", "2009-03-04"], evidence: [evCust, evRep] }, flags: [] }, turn.endMs);
        cs = withConflicts(cs, [{ field: "driver_dob", values: [{ value: "Mar 14, 2009", party: "customer", evidence: evCust }, { value: "Mar 4, 2009", party: "rep", evidence: evRep }], resolved: false }]);
        continue;
      }
      if (conflictMode && u.field === "driver_age" && st.ch === "rep") upd = { ...u, status: "PENDING", reason: "stated_once" };
      const ev: Evidence = evidenceFor(turn, upd.quote);
      cs = setField(cs, upd.field, {
        status: upd.status,
        reason: upd.reason,
        ...(upd.value !== undefined ? { value: upd.value } : {}),
        ...(upd.display !== undefined ? { display: upd.display } : {}),
        ...(upd.value !== undefined ? { source: turn.channel } : {}),
        evidence: [ev],
      }, turn.endMs);
    }
  };

  for (const st0 of S01_TURNS) {
    let st = st0;
    if (o.conflict && st0 === S01_TURNS[6]) st = { ...st0, text: st0.text.replace("born March 14th, 2009", "born March 4th, 2009") };
    if (st.startMs >= playUntil) break;
    const isPrefill = express && st.endMs <= offset;
    const useCached = cached || isPrefill;
    const ord = useCached ? cachedOrder[st.ch]++ : order[st.ch]++;
    if (!useCached) cachedOrder[st.ch]++;
    const late = armCallMs !== null && st.endMs > armCallMs;
    const turn = turnInput(caseId, st, ord, { cached: useCached, late });
    applyUpdates(turn, st, !!o.conflict);
    if (isPrefill) {
      prefill.push(turn);
      prefillState = cs;
      continue;
    }
    const dur = st.endMs - st.startMs;
    const words = st.text.split(/\s+/);
    const partialAt = [0.35, 0.7];
    partialAt.forEach((f, k) => {
      const n = Math.max(1, Math.round(words.length * f));
      L.add(T(st.startMs + dur * f + 250), { type: "stt.partial", channel: st.ch, turnOrder: ord, text: words.slice(0, n).join(" ") });
      void k;
    });
    L.add(T(turn.recvMs), { type: "stt.final", turn });
    if (st.updates?.length) L.add(T(turn.recvMs) + EXTRACT_LAG, { type: "case.state", state: cs });
  }
  if (prefill.length) {
    const t0 = CLICK_T + 200;
    prefill.forEach((turn, i) => L.add(t0 + i, { type: "stt.final", turn }));
    if (prefillState) L.add(t0 + prefill.length + 1, { type: "case.state", state: prefillState });
  }
  L.add(T(offset), { type: "ui.clock", callMs: offset, playing: true });
  for (let ms = Math.ceil(offset / 1000) * 1000; ms < Math.min(playUntil, S01_DURATION_MS); ms += 1000) L.add(T(ms), { type: "ui.clock", callMs: ms, playing: true });

  if (o.paused) {
    L.add(T(o.paused.atMs), { type: "ui.clock", callMs: o.paused.atMs, playing: false });
    L.add(T(o.paused.atMs) + 5, { type: "paused", reason: "ios_background", resumed: false });
    return L.entries();
  }
  if (o.stopAtMs !== undefined && armCallMs === null) return L.entries();
  if (o.stopAtMs !== undefined && armCallMs !== null && o.stopAtMs < armCallMs) return L.entries();
  if (armCallMs === null) {
    const endT = T(S01_DURATION_MS);
    L.add(endT, { type: "ui.clock", callMs: S01_DURATION_MS, playing: false });
    if (o.callEnded !== false) L.add(endT + 1600, { type: "ui.call-ended" });
    return L.entries();
  }

  // ---------------------------------------------------------------- the pass (protocol)
  const manual = pass.kind === "manual";
  const A = T(armCallMs);
  const acceptEnd = S01_HANDOFF.acceptEndMs ?? S01_HANDOFF.lineEndMs;
  const repLineEndT = manual ? A + 430 + (S01_HANDOFF.lineEndMs - S01_HANDOFF.lineStartMs) + 300 + (acceptEnd - (S01_HANDOFF.acceptStartMs ?? acceptEnd)) : T(acceptEnd);
  const sealT = manual ? A + 430 : repLineEndT + 120;


  if (recordedPlan) {
    // D14: the controller does not arm; the recording plays through the acceptance, then the recorded AI session
    // bundle (a BatonEvent log of a real run at the same handoff point) takes over, labelled.
    L.add(repLineEndT + 200, { type: "ui.clock", callMs: acceptEnd, playing: false });
    L.add(repLineEndT + 250, { type: "mode", mode: "recorded_ai", reason: "Live AI is busy right now; this is the recorded AI session of this call, from Fri 25 Sep 2026." });
    L.add(repLineEndT + 250, { type: "fallback", kind: "recorded_ai_session", label: "RECORDED AI SESSION from Fri 25 Sep 2026 at Daniel's handoff line: live AI is busy right now." });
    L.add(repLineEndT + 260, { type: "takeover.phase", phase: "armed", atMs: armCallMs, detail: { source: "auto_handoff", midUtterance: 0, recorded: 1 } });
    L.add(repLineEndT + 270, { type: "va.status", status: "ready", sessionId: "va_recorded_s01_0925" });
    L.add(repLineEndT + 280, { type: "takeover.phase", phase: "greeting", atMs: acceptEnd, detail: { recorded: 1 } });
    L.add(repLineEndT + 280, { type: "stage", stage: "confirm" });
    return aiHalfEvents(L, repLineEndT + 300, { caseId, cs, recorded: true, ending: o.ending ?? "complete", qa: o.qa ?? "verified", handoffRepLineEndT: repLineEndT + 300, clickT: A });
  }
  const shift = 0;
  const tp = (dt: number) => A + shift + dt;
  const src = manual ? "manual" : "auto_handoff";
  L.add(tp(0), { type: "takeover.phase", phase: "armed", atMs: armCallMs, detail: { source: src, midUtterance: 0 } });
  L.add(tp(0), { type: "ui.clock", callMs: armCallMs, playing: !manual });
  L.add(tp(15), { type: "va.status", status: "connecting" });
  L.add(sealT + shift, { type: "takeover.phase", phase: "sealing", atMs: armCallMs + (sealT - A) });
  L.add(sealT + shift, { type: "ui.clock", callMs: manual ? armCallMs : acceptEnd, playing: false });
  L.add(sealT + shift + 270, { type: "takeover.phase", phase: "draining", atMs: armCallMs + (sealT - A) + 270 });
  L.add(sealT + shift + 750, { type: "takeover.phase", phase: "compiling", atMs: armCallMs + (sealT - A) + 750 });
  L.add(sealT + shift + 1210, { type: "takeover.phase", phase: "connecting", atMs: armCallMs + (sealT - A) + 1210 });

  if (aiHalf === "va-failed" || aiHalf === "va-fallback") {
    const f0 = sealT + shift + 1210;
    L.add(f0 + 3000, { type: "va.status", status: "error", code: "E_VA_TIMEOUT" });
    L.add(f0 + 3000, { type: "error", code: "E_VA_TIMEOUT", message: "The Voice Agent did not open in time." });
    L.add(f0 + 3010, { type: "takeover.phase", phase: "retrying", atMs: armCallMs + (f0 + 3010 - A), detail: { attempt: 1 } });
    L.add(f0 + 6200, { type: "va.status", status: "error", code: "E_VA_TIMEOUT" });
    if (aiHalf === "va-failed") {
      L.add(f0 + 6210, { type: "takeover.phase", phase: "failed", atMs: armCallMs + (f0 + 6210 - A), detail: { code: "E_VA_TIMEOUT" } });
      L.add(f0 + 6210, { type: "error", code: "E_VA_TIMEOUT", message: "The live AI could not start after one retry (Voice Agent timeout)." });
      return L.entries();
    }
    L.add(f0 + 6210, { type: "takeover.phase", phase: "fallback", atMs: armCallMs + (f0 + 6210 - A), detail: { reason: "E_VA_TIMEOUT" } });
    L.add(f0 + 6220, { type: "fallback", kind: "recorded_ai_session", label: "RECORDED AI SESSION from Fri 25 Sep 2026: live AI failed (Voice Agent timeout)." });
    L.add(f0 + 6220, { type: "mode", mode: "recorded_ai", reason: "Live AI failed (Voice Agent timeout); this is the recorded AI session of this call." });
    return aiHalfEvents(L, f0 + 7000, { caseId, cs, recorded: true, ending: o.ending ?? "complete", qa: o.qa ?? "verified", handoffRepLineEndT: f0 + 6600, clickT: A });
  }

  const readyT = sealT + shift + 1670;
  L.add(readyT, { type: "va.status", status: "ready", sessionId: ids.va });
  L.add(readyT + 1, { type: "ui.session-ids", ids: { va: ids.va } });
  L.add(readyT + 150, { type: "takeover.phase", phase: "greeting", atMs: armCallMs + (readyT + 150 - A - shift), detail: { leadMs: 900 } });
  L.add(readyT + 150, { type: "stage", stage: "confirm" });
  return aiHalfEvents(L, repLineEndT + shift, { caseId, cs, recorded: false, ending: o.ending ?? "complete", qa: o.qa ?? "verified", handoffRepLineEndT: repLineEndT + shift, clickT: A + shift });
}

function aiHalfEvents(
  L: FixtureLog,
  repLineEndT: number,
  o: { caseId: string; cs: CaseState; recorded: boolean; ending: "complete" | "handback"; qa: "verified" | "failed"; handoffRepLineEndT: number; clickT: number },
): UiLogEntry[] {
  let cs = o.cs;
  const R = repLineEndT; // audio of the greeting lands ≈450 ms after the handoff clip
  const first = R + 450;
  const reply = (id: string, startT: number, audibleT: number, text: string, kind: "speech" | "tool_preamble" = "speech") => {
    const dur = Math.max(1800, text.split(/\s+/).length * 290);
    L.add(startT, { type: "va.reply", replyId: id, phase: "started" });
    L.add(audibleT, { type: "va.reply", replyId: id, phase: "first_audible" });
    L.add(audibleT + 40, { type: "va.caption", replyId: id, words: captionWords(text, dur) });
    L.add(audibleT + dur + 300, { type: "va.reply", replyId: id, phase: "done", kind });
    return audibleT + dur + 300;
  };
  const user = (t: number, text: string) => {
    const half = text.split(" ").slice(0, 2).join(" ");
    L.add(t - 700, { type: "va.user", text: half, final: false });
    L.add(t, { type: "va.user", text, final: true });
  };
  const tool = (callId: string, t: number, name: "confirm_effective_date" | "get_disclosure" | "send_esign_and_pay_link" | "send_confirmation" | "update_case_field" | "hand_back_to_rep", args: unknown, result: unknown, resultT: number | null) => {
    L.add(t, { type: "va.tool", callId, name, phase: "call", args });
    if (resultT !== null) L.add(resultT, { type: "va.tool", callId, name, phase: "result", args, result });
  };
  const hud = (t: number, metric: "click_to_first_audible" | "dead_air_after_rep" | "turn_audible_latency" | "tool_turn_latency", ms: number) =>
    L.add(t, { type: "hud", metric, ms });

  // Greeting
  L.add(R - 550, { type: "stage", stage: "confirm" });
  L.add(first, { type: "takeover.phase", phase: "active", atMs: 0 });
  let t = reply("r1", R - 500, first, S01_AI.greeting);
  hud(first + 60, "click_to_first_audible", first - o.clickT);
  hud(first + 60, "dead_air_after_rep", first - o.handoffRepLineEndT);
  L.add(t + 100, { type: "ui.suggestions", items: suggestionsFor("greeting") });

  if (o.ending === "handback") {
    const eos = t + 2200;
    user(eos, "Yes. Actually, before we finish, should I raise her liability limits?");
    L.add(eos + 900, { type: "va.reply", replyId: "r2", phase: "started" });
    tool("t-hb", eos + 1500, "hand_back_to_rep", { reason: "advice_requested", summary: S01_AI.handBackSummary }, { status: "transferring", message: "Daniel is back on the line." }, eos + 1700);
    const end = reply("r3", eos + 1800, eos + 3300, S01_AI.handBack);
    hud(eos + 3360, "tool_turn_latency", 3300);
    L.add(end + 200, { type: "takeover.phase", phase: "closing", atMs: 0 });
    L.add(end + 2100, { type: "va.status", status: "ended" });
    L.add(end + 2200, { type: "takeover.phase", phase: "done", atMs: 0, detail: { outcome: "handed_back" } });
    L.add(end + 2400, { type: "qa", qa: qaResult(true, { handedBack: true, clickMs: first - o.clickT, deadAirMs: first - o.handoffRepLineEndT }) });
    if (o.qa === "verified") L.add(end + 19400, { type: "qa", qa: qaResult(false, { handedBack: true, clickMs: first - o.clickT, deadAirMs: first - o.handoffRepLineEndT }) });
    return L.entries();
  }

  // Confirm → confirm_effective_date (AI-confirmed) → disclose
  const eos1 = t + 1500;
  user(eos1, "Yes, that's all correct.");
  L.add(eos1 + 200, { type: "va.reply", replyId: "r2", phase: "started" });
  tool("t1", eos1 + 800, "confirm_effective_date", { date: "2026-10-02", customer_words: "Yes, that's all correct." }, { status: "confirmed", date: "2026-10-02", spoken: "Friday, October 2nd" }, eos1 + 1050);
  const tu: FactEvent = {
    id: "fe_ai_1", caseId: o.caseId, field: "effective_date", kind: "tool_update", party: "ai", valueRaw: "2026-10-02", valueNorm: "2026-10-02",
    acknowledgesTurnId: null, confidence: "high", turnId: null, turnEndMs: 116_400, late: false, cut: false,
    evidence: { channel: "customer_ai", turnId: "user-0", startMs: 16_900, endMs: 18_300, quote: "Yes, that's all correct.", source: "va_transcript" },
    extractor: "tool", seq: 91,
  };
  L.add(eos1 + 1100, { type: "case.facts", events: [tu] });
  cs = setField(cs, "effective_date", { status: "VERIFIED", reason: "ai_confirmed", source: "ai", evidence: tu.evidence ? [tu.evidence] : [] }, 116_400);
  cs = { ...cs, stage: "disclose" };
  L.add(eos1 + 1150, { type: "case.state", state: cs });
  L.add(eos1 + 1150, { type: "stage", stage: "disclose" });
  tool("t2", eos1 + 1250, "get_disclosure", { kind: "premium_change" }, { kind: "premium_change", text: S01_AI.premiumDisclosureText, must_read_verbatim: true }, eos1 + 1500);
  L.add(eos1 + 1600, { type: "va.reply", replyId: "r2", phase: "done", kind: "tool_preamble" });
  t = reply("r3", eos1 + 1700, eos1 + 3600, S01_AI.premiumDisclosure);
  hud(eos1 + 3660, "tool_turn_latency", 3600);
  L.add(t + 100, { type: "ui.suggestions", items: suggestionsFor("disclose") });

  const eos2 = t + 1300;
  user(eos2, "Yes, go ahead.");
  L.add(eos2 + 200, { type: "va.reply", replyId: "r4", phase: "started" });
  tool("t3", eos2 + 400, "get_disclosure", { kind: "esign_consent" }, { kind: "esign_consent", text: S01_AI.esignText, must_read_verbatim: true }, eos2 + 600);
  cs = { ...cs, disclosuresGiven: ["premium_change"] };
  L.add(eos2 + 650, { type: "case.state", state: cs });
  t = reply("r4b", eos2 + 700, eos2 + 2400, S01_AI.esign);
  L.add(eos2 + 690, { type: "va.reply", replyId: "r4", phase: "done", kind: "tool_preamble" });
  hud(eos2 + 2460, "turn_audible_latency", 2400);
  L.add(t + 100, { type: "ui.suggestions", items: suggestionsFor("esign") });

  // Pay (hold tool) → phone → Polar webhook
  const eos3 = t + 1300;
  user(eos3, "Yes, text me the link. No paper copy, thanks.");
  L.add(eos3 + 200, { type: "va.reply", replyId: "r5", phase: "started" });
  const payT = eos3 + 800;
  L.add(payT, { type: "va.tool", callId: "t4", name: "send_esign_and_pay_link", phase: "call", args: { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "Yes, text me the link." } });
  cs = { ...cs, stage: "pay", disclosuresGiven: ["premium_change", "esign_consent"], payment: { id: "pay_fixture_1", status: "created", amountCents: 4600, totalAmountCents: null, provider: "polar", simulated: false } };
  L.add(payT + 250, { type: "stage", stage: "pay" });
  L.add(payT + 250, { type: "case.state", state: cs });
  L.add(payT + 260, { type: "takeover.phase", phase: "paying", atMs: 0 });
  L.add(payT + 300, { type: "payment", status: "created" });
  L.add(payT + 400, { type: "phone.sms", text: "Harborview: Review & sign your change to policy NBM-4418207: https://baton.example/pay/pay_fixture_1", link: "/pay/pay_fixture_1" });
  L.add(payT + 420, { type: "phone.state", state: "sms-received" });
  t = reply("r5b", payT + 500, payT + 2100, S01_AI.linkSent);
  L.add(payT + 490, { type: "va.reply", replyId: "r5", phase: "done", kind: "tool_preamble" });
  hud(payT + 2160, "tool_turn_latency", payT + 2100 - eos3);
  L.add(t + 100, { type: "ui.suggestions", items: suggestionsFor("pay") });
  const p0 = t + 1200;
  L.add(p0, { type: "phone.state", state: "esign" });
  L.add(p0 + 6500, { type: "phone.state", state: "signed" });
  L.add(p0 + 7400, { type: "phone.state", state: "checkout-loading" });
  L.add(p0 + 8300, { type: "payment", status: "open" });
  L.add(p0 + 8900, { type: "phone.state", state: "checkout-open" });
  L.add(p0 + 25_000, { type: "phone.state", state: "processing" });
  L.add(p0 + 27_600, { type: "payment", status: "succeeded", source: "webhook" });
  L.add(p0 + 27_700, { type: "phone.state", state: "paid" });
  L.add(p0 + 27_800, { type: "va.tool", callId: "t4", name: "send_esign_and_pay_link", phase: "result", result: { status: "paid", amount: "$46.00", receipt: "END-48213", verified_by: "polar_webhook" } });
  L.add(p0 + 27_900, { type: "phone.sms", text: "Payment received. Confirmation END-48213" });
  cs = { ...cs, stage: "close", payment: { id: "pay_fixture_1", status: "succeeded", amountCents: 4600, totalAmountCents: 4600, provider: "polar", simulated: false }, confirmationNumber: "END-48213" };
  L.add(p0 + 28_000, { type: "stage", stage: "close" });
  L.add(p0 + 28_000, { type: "case.state", state: cs });
  L.add(p0 + 28_010, { type: "takeover.phase", phase: "active", atMs: 0 });

  // Close
  const c0 = p0 + 28_100;
  L.add(c0, { type: "va.reply", replyId: "r6", phase: "started" });
  tool("t5", c0 + 300, "send_confirmation", {}, { status: "sent", confirmation: "END-48213" }, c0 + 600);
  L.add(c0 + 650, { type: "va.reply", replyId: "r6", phase: "done", kind: "tool_preamble" });
  t = reply("r6b", c0 + 700, c0 + 2300, S01_AI.confirmation);
  L.add(t + 100, { type: "ui.suggestions", items: suggestionsFor("close") });
  const eos4 = t + 1400;
  user(eos4, "No, that's everything. Thanks, bye!");
  t = reply("r7", eos4 + 200, eos4 + 2000, S01_AI.goodbye);
  hud(eos4 + 2060, "turn_audible_latency", 2000);
  L.add(t + 200, { type: "takeover.phase", phase: "closing", atMs: 0 });
  L.add(t + 2700, { type: "va.status", status: "ended" });
  L.add(t + 2800, { type: "takeover.phase", phase: "done", atMs: 0, detail: { outcome: "completed" } });
  const qaO = { handedBack: false, clickMs: first - o.clickT, deadAirMs: first - o.handoffRepLineEndT };
  L.add(t + 3000, { type: "qa", qa: qaResult(true, qaO) });
  if (o.qa === "failed") L.add(t + 21_000, { type: "ui.qa-status", status: "failed", reason: "the agent's recording was not ready at AssemblyAI in time" });
  else L.add(t + 19_000, { type: "qa", qa: qaResult(false, qaO) });
  void o.recorded;
  return L.entries();
}
