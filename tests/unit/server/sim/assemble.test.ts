import { describe, expect, it } from "vitest";

import { MULAW_SILENCE } from "@/core/audio";
import { SIM_TIMELINE } from "@/core/contracts/ext/wp17-sim";
import { PeaksSchema } from "@/core/contracts/scenario";
import {
  assembleSimCall, clipToMulaw8k, computePeaks, planSimLines, seededRandom, SimScriptError, SimTooLongError, type SimLineAudio,
} from "@/server/sim/assemble";
import { REP_LINE, scriptFixture, tone24k } from "./helpers";

const H = "a".repeat(64);

function linesOf(ms: number[], tags?: SimLineAudio["tag"][]): SimLineAudio[] {
  const plan = planSimLines(scriptFixture(), { repLine: REP_LINE }).lines;
  return plan.map((l, i) => ({ speaker: l.speaker, tag: tags?.[i] ?? l.tag, text: l.text, pcm24k: tone24k(ms[i] ?? 1000), clipHash: H }));
}

describe("planSimLines", () => {
  it("puts the EXACT repLine on the handoff turn, keeps the acceptance next and drops what follows", () => {
    const { script, lines } = planSimLines(scriptFixture(), { repLine: `  ${REP_LINE}  ` });
    expect(script.turns).toHaveLength(10);
    expect(script.turns[8]).toEqual({ speaker: "rep", text: REP_LINE, tag: "handoff" });
    expect(script.turns[9]).toMatchObject({ speaker: "customer", tag: "accept", text: "Sure, go ahead." });
    expect(lines.map((l) => l.voice)).toEqual(["cedar", "marin", "cedar", "marin", "cedar", "marin", "cedar", "marin", "cedar", "marin"]);
  });

  it("rejects scripts that cannot be voiced", () => {
    const s = scriptFixture();
    const code = (turns: typeof s.turns) => {
      try {
        planSimLines({ ...s, turns }, { repLine: REP_LINE });
        return "ok";
      } catch (e) {
        return (e as SimScriptError).code;
      }
    };
    expect(code([s.turns[1]!, ...s.turns])).toBe("first_not_rep");
    expect(code(s.turns.map((t) => (t.tag === "handoff" ? { ...t, tag: "other" as const } : t)))).toBe("no_handoff");
    expect(code(s.turns.map((t, i) => (i === 9 ? { ...t, tag: "other" as const } : t)))).toBe("no_accept");
    expect(code(s.turns.map((t, i) => (i === 8 ? { ...t, speaker: "customer" as const } : t)))).toBe("handoff_not_rep");
    expect(code([...s.turns.slice(0, 2), ...s.turns.slice(8)])).toBe("too_short");
    expect(code(s.turns.map((t, i) => (i === 3 ? { ...t, text: "  " } : t)))).toBe("empty_line");
  });
});

describe("assembleSimCall (PLATFORM §7.5 step 3)", () => {
  const ms = [2000, 1500, 1200, 800, 1400, 900, 1300, 700, 2600, 900];

  it("lays both voices on one timeline: 0.8 s lead-in, seeded 350-650 ms gaps, 300 ms before the acceptance, 1 s tail", () => {
    const a = assembleSimCall(linesOf(ms), { seed: "sim_0000000000000000" });
    const t = a.timeline;
    expect(t[0]!.startMs).toBe(SIM_TIMELINE.leadInMs);
    for (let i = 1; i < t.length; i++) {
      const gap = t[i]!.startMs - t[i - 1]!.endMs;
      if (i === 9) expect(gap).toBe(300);
      else {
        expect(gap).toBeGreaterThanOrEqual(349);
        expect(gap).toBeLessThanOrEqual(651);
      }
      expect(t[i]!.endMs - t[i]!.startMs).toBe(ms[i]);
    }
    expect(a.durationMs).toBe(t[9]!.endMs + SIM_TIMELINE.tailMs);
    expect(a.rep.length).toBe(a.customer.length);
    expect(a.rep.length).toBe(a.durationMs * 8);
    expect(a.handoff).toEqual({ lineStartMs: t[8]!.startMs, lineEndMs: t[8]!.endMs, acceptStartMs: t[9]!.startMs, acceptEndMs: t[9]!.endMs, declined: false });
  });

  it("keeps the other channel silent (0xFF) while one side speaks", () => {
    const a = assembleSimCall(linesOf(ms), { seed: "s" });
    const at = (m: number) => m * 8;
    const repTurn = a.timeline[0]!;
    const cusTurn = a.timeline[1]!;
    expect(a.customer.subarray(at(repTurn.startMs), at(repTurn.endMs)).every((b) => b === MULAW_SILENCE)).toBe(true);
    expect(a.rep.subarray(at(cusTurn.startMs), at(cusTurn.endMs)).every((b) => b === MULAW_SILENCE)).toBe(true);
    expect(a.rep.subarray(0, at(SIM_TIMELINE.leadInMs)).every((b) => b === MULAW_SILENCE)).toBe(true);
    expect(a.rep.subarray(at(repTurn.startMs), at(repTurn.endMs)).some((b) => b !== MULAW_SILENCE)).toBe(true);
  });

  it("is deterministic: the same seed gives byte-identical channels; another seed moves the gaps", () => {
    const a = assembleSimCall(linesOf(ms), { seed: "x" });
    const b = assembleSimCall(linesOf(ms), { seed: "x" });
    const c = assembleSimCall(linesOf(ms), { seed: "y" });
    expect(Buffer.from(a.rep).equals(Buffer.from(b.rep))).toBe(true);
    expect(Buffer.from(a.customer).equals(Buffer.from(b.customer))).toBe(true);
    expect(JSON.stringify(a.peaks)).toBe(JSON.stringify(b.peaks));
    expect(c.timeline.map((x) => x.startMs)).not.toEqual(a.timeline.map((x) => x.startMs));
  });

  it("computes 50/s peaks in the peaks.json format", () => {
    const a = assembleSimCall(linesOf(ms), { seed: "p" });
    expect(PeaksSchema.parse(a.peaks)).toBeTruthy();
    expect(a.peaks.rep).toHaveLength(Math.ceil(a.rep.length / 160));
    expect(a.peaks.rep[0]).toBe(0);
    const mid = Math.floor((a.timeline[0]!.startMs + a.timeline[0]!.endMs) / 2 / 20);
    expect(a.peaks.rep[mid]!).toBeGreaterThan(0.1);
    expect(a.peaks.customer[mid]).toBe(0);
  });

  it("trims the TTS clip's edge silence so the handoff times hug the speech", () => {
    const withSilence = tone24k(1000, { leadMs: 400, tailMs: 500 });
    const out = clipToMulaw8k(withSilence);
    // 1000 ms of tone + ≤ 2 × 30 ms pad (+ one 10 ms analysis step) at 8 kHz
    expect(out.length).toBeGreaterThanOrEqual(8000);
    expect(out.length).toBeLessThanOrEqual(8 * 1080);
  });

  it("caps the human half at 90 s", () => {
    expect(() => assembleSimCall(linesOf(ms.map(() => 9000)), { seed: "long" })).toThrow(SimTooLongError);
    expect(() => assembleSimCall(linesOf(ms), { seed: "cap", timeline: { maxMs: 10_000 } })).toThrow(SimTooLongError);
  });

  it("requires the handoff line then the acceptance", () => {
    const tags = linesOf(ms).map((l) => l.tag);
    tags[9] = "other";
    expect(() => assembleSimCall(linesOf(ms, tags), { seed: "t" })).toThrow(SimScriptError);
  });

  it("peaks and PRNG helpers are stable", () => {
    expect(computePeaks(new Int16Array([0, 16384, -32768, 0]), 100, 50)).toEqual([0.5, 1]);
    const r = seededRandom("abc");
    const r2 = seededRandom("abc");
    const xs = [r(), r(), r()];
    expect([r2(), r2(), r2()]).toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });
});
