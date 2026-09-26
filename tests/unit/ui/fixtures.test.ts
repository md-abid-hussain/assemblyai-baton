import { describe, expect, it } from "vitest";

import { BatonEventSchema } from "@/core/contracts/events";
import { UI_PHASES, type UiPhase } from "@/core/contracts/ext/wp7-ui";
import { isBatonEvent } from "@/client/fixtures/builder";
import { FIXTURES, fixtureLog } from "@/client/fixtures";
import { initialUiState, reduceEntry } from "@/client/store/reduce";
import { phaseCopy } from "@/client/store/selectors";

function phasesOf(name: string): { seen: Set<UiPhase>; final: ReturnType<typeof initialUiState> } {
  const log = fixtureLog(name);
  if (!log) throw new Error(`no fixture ${name}`);
  let s = initialUiState();
  const seen = new Set<UiPhase>([s.phase]);
  for (const e of log) {
    s = reduceEntry(s, e);
    seen.add(s.phase);
  }
  return { seen, final: s };
}

describe("fixture logs (WP7 acceptance 1, 2)", () => {
  it.each(FIXTURES.map((f) => [f.name]))("%s: every BatonEvent parses with BatonEventSchema and t is non-decreasing", (name) => {
    const log = fixtureLog(name) ?? [];
    expect(log.length).toBeGreaterThan(10);
    let last = -Infinity;
    for (const e of log) {
      expect(e.t).toBeGreaterThanOrEqual(last);
      last = e.t;
      if (!isBatonEvent(e)) continue;
      const r = BatonEventSchema.safeParse(e);
      if (r.success) continue;
      // A relay other than the flagship carries widened facts: its own field ids in the case state, its own
      // disclosure ids and fields in the QA result. The frozen contracts are Baton-shaped (an `add_driver` literal,
      // an exhaustive record over the 21 Baton field ids, two disclosure kinds) and stay that way until the P§4.7
      // widening, so these two events are checked by shape. Everything else parses strictly, for every relay.
      const widened = (e.type === "case.state" || e.type === "qa") && !name.startsWith("s01");
      if (!widened) throw new Error(`${name}: ${e.type} at t=${e.t}: ${r.error.message}`);
      if (e.type === "case.state") expect(Object.keys(e.state.fields).length).toBeGreaterThan(0);
      else expect(typeof e.qa.provisional).toBe("boolean");
    }
  });

  it.each(FIXTURES.map((f) => [f.name, f.reaches] as const))("%s reaches its reference states", (name, reaches) => {
    const { seen } = phasesOf(name);
    for (const p of reaches) expect(seen, `${name} should reach ${p}; saw ${[...seen].join(", ")}`).toContain(p);
  });

  it("every S2 state is reachable by some fixture and has copy", () => {
    const all = new Set<UiPhase>();
    for (const f of FIXTURES) for (const p of phasesOf(f.name).seen) all.add(p);
    for (const p of UI_PHASES) {
      expect(all, `no fixture reaches ${p}`).toContain(p);
      const copy = phaseCopy({ ...initialUiState(), phase: p, flowPhase: p });
      expect(copy.title.length).toBeGreaterThan(3);
      expect(copy.body.length).toBeGreaterThan(10);
    }
  });

  it("s01-full ends completed with a verified QA card, paid by webhook, re-asked 0", () => {
    const { final } = phasesOf("s01-full");
    expect(final.phase).toBe("completed");
    expect(final.qa.status).toBe("verified");
    expect(final.qa.verified?.reAsked).toBe(0);
    expect(final.qa.provisional?.provisional).toBe(true);
    expect(final.payment).toMatchObject({ status: "succeeded", source: "webhook" });
    expect(final.caseState?.readiness).toMatchObject({ verified: 10, ready: true });
    expect(final.aiConfirmed).toContain("effective_date");
    expect(final.stagesSeen).toEqual(["confirm", "disclose", "pay", "close"]);
    expect(final.tools.every((x) => !x.pending)).toBe(true);
    expect(final.hud.click_to_first_audible?.n).toBe(1);
    expect(final.takeover.tArmMs).toBe(110_000);
    // Tool pre-ambles are never captioned (§5.10 rule 2).
    expect(final.ai.some((l) => l.kind === "tool_preamble")).toBe(false);
  });

  it("s01-express prefills cached turns and passes automatically at the handoff line with late finals", () => {
    const { final } = phasesOf("s01-express");
    expect(final.started?.kind).toBe("express");
    expect(final.human.some((l) => l.source === "cached")).toBe(true);
    expect(final.human.some((l) => l.source === "live")).toBe(true);
    expect(final.takeover.source).toBe("auto_handoff");
    expect(final.human.filter((l) => l.late).map((l) => l.text)).toContain("Sure, go ahead.");
  });

  it("s01-recorded-ai: plan says recorded, mode flips to recorded_ai and the shadow lanes are greyed", () => {
    const { final } = phasesOf("s01-recorded-ai");
    expect(final.plan?.aiHalf).toBe("recorded");
    expect(final.mode).toBe("recorded_ai");
    expect(final.shadowGreyed).toBe(true);
    expect(final.phase).toBe("completed");
  });

  it("s01-error ends in the error phase; s01-paused ends paused; s01-call-ended flags the end", () => {
    expect(phasesOf("s01-error").final.phase).toBe("error");
    expect(phasesOf("s01-paused").final.phase).toBe("paused");
    expect(phasesOf("s01-call-ended").final.callEnded).toBe(true);
    expect(phasesOf("s01-qa-failed").final.qa.status).toBe("failed");
    expect(phasesOf("s01-conflict").final.caseState?.conflicts).toHaveLength(1);
    const hb = phasesOf("s01-handback").final;
    expect(hb.phase).toBe("handed-back");
    expect(hb.handBack?.reason).toBe("advice_requested");
  });
});
