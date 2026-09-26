/**
 * Scenario fixtures (TASKS WP1 acceptance): a synthetic, talk-track-shaped call per kit scenario goes through the
 * real pipeline (raw extractor patch → applyExtraction → deriveCaseState) and must reproduce the kit designer's
 * `status_at_handoff` for every fact; the compiled greeting equals the one from the intended hand-off state.
 */
import { describe, expect, it } from "vitest";
import type { FieldId, NewFactEvent, RawPatchEvent, TurnInput } from "../../../../src/core/contracts";
import { turnIdOf } from "../../../../src/core/contracts";
import { applyExtraction } from "../../../../src/core/case/apply";
import { deriveCaseState } from "../../../../src/core/case/derive";
import { compileGreeting } from "../../../../src/core/compiler/greeting";
import { compileTakeover } from "../../../../src/core/compiler/compile";
import { buildFirstUpdate, validateFirstUpdate } from "../../../../src/core/compiler/first-update";
import { expectedAtHandoff, handoffStateOf, kitScenario, policyOf } from "./_fixtures";

const WORD_MS = 250;

function synthCall(id: string): { turns: TurnInput[]; events: NewFactEvent[] } {
  const s = kitScenario(id);
  const policy = policyOf(id);
  const counters = { rep: 0, customer: 0 };
  let t = 0;
  const turns: TurnInput[] = [];
  const events: NewFactEvent[] = [];
  const say = (channel: "rep" | "customer", text: string, raw: Omit<RawPatchEvent, "turn_id">[]) => {
    const words = text.split(/\s+/).map((w, i) => ({ text: w, startMs: t + i * WORD_MS, endMs: t + (i + 1) * WORD_MS - 20, confidence: 0.95 }));
    const turn: TurnInput = {
      caseId: `case_${id}`, turnId: turnIdOf(channel, counters[channel]++), channel, text, startMs: t, endMs: words.at(-1)!.endMs,
      words, source: "stt_live", recvMs: words.at(-1)!.endMs + 400, cut: false, late: false,
    };
    t = turn.endMs + 300;
    turns.push(turn);
    const patch = { no_facts: raw.length === 0, events: raw.map((r) => ({ ...r, turn_id: turn.turnId })) };
    events.push(...applyExtraction(patch, [turn], { caseId: `case_${id}`, policy }));
    return turn;
  };
  const facts = Object.entries(s.facts) as [FieldId, NonNullable<(typeof s.facts)[FieldId]>][];
  const ordered = [...facts.filter(([, f]) => f.status_at_handoff === "VERIFIED"), ...facts.filter(([, f]) => f.status_at_handoff === "PENDING")];
  for (const [field, fact] of ordered) {
    const sayIt = fact.say_it ?? String(fact.value);
    const value = String(fact.value);
    const other = fact.stated_by === "rep" ? "customer" : "rep";
    const stated = say(fact.stated_by, `${sayIt}.`, [{ field, kind: "stated", value, quote: sayIt, acknowledges_turn_id: null, confidence: "high" }]);
    if (fact.status_at_handoff !== "VERIFIED") continue;
    if (other === "rep") say("rep", `${sayIt}, got it.`, [{ field, kind: "readback", value, quote: sayIt, acknowledges_turn_id: null, confidence: "high" }]);
    else say("customer", "Yes, that's right.", [{ field, kind: "ack", value: null, quote: "Yes, that's right", acknowledges_turn_id: stated.turnId, confidence: "high" }]);
  }
  return { turns, events };
}

describe("scenario fixtures reproduce expectedAtHandoff (s01, s02, s05)", () => {
  for (const id of ["s01", "s02", "s05"]) {
    it(id, () => {
      const policy = policyOf(id);
      const { events } = synthCall(id);
      const seqd = events.map((e, i) => ({ ...e, seq: i + 1 }));
      const st = deriveCaseState(policy, seqd, { caseId: `case_${id}` });
      const expected = expectedAtHandoff(id);
      const got = Object.fromEntries(Object.keys(expected).map((f) => [f, st.fields[f]!.status]));
      expect(got).toEqual(expected);
      // Values agree with the kit truth for every non-MISSING fact.
      const intended = handoffStateOf(id);
      for (const f of Object.keys(expected) as FieldId[]) {
        if (expected[f] !== "MISSING") expect(st.fields[f]!.value, f).toBe(intended.fields[f]!.value);
      }
      // Evidence is word-aligned inside the source turn.
      for (const f of Object.keys(expected) as FieldId[]) for (const e of st.fields[f]!.evidence) expect(e.endMs).toBeGreaterThan(e.startMs);
      // Same greeting as the designer's intended state, and a valid first update in both initial stages.
      expect(compileGreeting(st, policy).text).toBe(compileGreeting(intended, policy).text);
      for (const stage of ["confirm", "disclose"] as const) {
        const c = compileTakeover(st, policy, { deployId: "dev-wp1", stage });
        expect(() => validateFirstUpdate(buildFirstUpdate(c), { keytermsEnabled: false })).not.toThrow();
      }
    });
  }

  it("every kit scenario (s01-s22): statuses reproduce and every truth value normalizes", () => {
    const bad: string[] = [];
    for (let k = 1; k <= 22; k++) {
      const id = `s${String(k).padStart(2, "0")}`;
      const policy = policyOf(id);
      const st = deriveCaseState(policy, synthCall(id).events.map((e, i) => ({ ...e, seq: i + 1 })), { caseId: id });
      for (const [f, want] of Object.entries(expectedAtHandoff(id)) as [FieldId, string][]) {
        if (st.fields[f]!.status !== want) bad.push(`${id}.${f}: ${st.fields[f]!.status}/${st.fields[f]!.reason} ≠ ${want}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("arming before the last turns makes them late: the s01 effective date read-back is no longer VERIFIED", () => {
    const policy = policyOf("s01");
    const { events, turns } = synthCall("s01");
    const dateTurn = turns.find((t) => t.text.startsWith("next Friday"))!;
    const st = deriveCaseState(policy, events.map((e, i) => ({ ...e, seq: i + 1 })), { caseId: "c", tArmMs: dateTurn.endMs });
    expect(st.fields.effective_date).toMatchObject({ status: "PENDING", reason: "late_turn", flags: ["late_turn"] });
  });
});
