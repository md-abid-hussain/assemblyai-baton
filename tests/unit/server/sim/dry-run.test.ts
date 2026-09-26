/**
 * TEXT DRY RUN (PLATFORM §7.5.2; WP17·3). The relay is the drafted one from the wizard fixture, compiled by the real
 * kernel, so what is tested is the real case card, the real compiled greeting and the real next asks. The extractor
 * is faked (that seam is WP3's, tested there), so the file costs $0.
 */
import { describe, expect, it } from "vitest";

import type { NewFactEvent } from "@/core/contracts/case";
import type { CompiledRelay } from "@/core/contracts/v2";
import { SimScriptSchema, type SimScript } from "@/core/contracts/v2/api";
import { compileRelay } from "@/core/relay/compile";
import { applyComplianceFixes } from "@/core/relay/draft/compliance";
import { expandDraft } from "@/core/relay/draft/expand";
import { DRY_RUN_BATCH, dryRunTurns, runTextDryRun, type DryRunDeps } from "@/server/sim/dry-run";
import { draftFixture } from "../../core/relay-draft/helpers";

const blueprint = applyComplianceFixes(expandDraft(draftFixture(), { callDate: "2026-09-25" }).blueprint).blueprint;
const compiled: CompiledRelay = compileRelay(blueprint, { versionId: "rv_dry", relayId: "rl_dry", hash: "h_dry", flagship: false });
const SIM_ID = "sim_0123456789abcdef";

const script: SimScript = SimScriptSchema.parse({
  turns: [
    { speaker: "rep", text: "Riverbend Dental, this is Dana. How can I help?", tag: "greet" },
    { speaker: "customer", text: "Hi, I'd like to book a cleaning.", tag: "other" },
    { speaker: "rep", text: "Of course. Can I take your full name?", tag: "ask" },
    { speaker: "customer", text: "Maya Ortiz.", tag: "answer" },
    { speaker: "rep", text: "Thanks, Maya. Which day suits you?", tag: "ask" },
    { speaker: "customer", text: "Tuesday the sixth of October.", tag: "answer" },
    { speaker: "rep", text: "Tuesday the sixth, for a cleaning. Is that right?", tag: "readback" },
    { speaker: "customer", text: "Yes, that's right.", tag: "confirm" },
    { speaker: "rep", text: blueprint.handoff.repLine, tag: "handoff" },
    { speaker: "customer", text: "Sure, go ahead.", tag: "accept" },
  ],
  left_for_ai: ["insurance_carrier"],
  ai_half_answers: [{ field: "insurance_carrier", spoken: "It's Riverbend Plus." }],
  consent_phrase: "Yes, please text me the link.",
  closing_phrase: "No, that's everything, thanks.",
});

/**
 * A stand-in extractor: the customer states a value and the rep reads it back, which is what makes a field
 * VERIFIED. It settles everything the script settles and nothing it does not, so the case card under test is the
 * real one the status rules produce.
 */
const SETTLES: Record<string, { field: string; value: string; kind: "stated" | "readback"; party: "rep" | "customer" }> = {
  "Maya Ortiz.": { field: "patient_full_name", value: "Maya Ortiz", kind: "stated", party: "customer" },
  "Tuesday the sixth of October.": { field: "appointment_date", value: "2026-10-06", kind: "stated", party: "customer" },
  "Tuesday the sixth, for a cleaning. Is that right?": { field: "procedure", value: "cleaning", kind: "readback", party: "rep" },
  "Yes, that's right.": { field: "patient_full_name", value: "Maya Ortiz", kind: "readback", party: "rep" },
};

function fakeExtract(o: { calls?: { turns: number; recent: number }[]; usdEach?: number } = {}): NonNullable<DryRunDeps["extract"]> {
  return async ({ turns, recent }) => {
    o.calls?.push({ turns: turns.length, recent: recent.length });
    const events: NewFactEvent[] = [];
    for (const t of turns) {
      const settle = SETTLES[t.text];
      if (!settle) continue;
      events.push({
        id: `fe_${t.turnId}_${settle.field}`,
        caseId: t.caseId,
        field: settle.field as NewFactEvent["field"],
        kind: settle.kind,
        party: settle.party,
        valueRaw: settle.value,
        valueNorm: settle.value,
        acknowledgesTurnId: null,
        confidence: "high",
        turnId: t.turnId,
        turnEndMs: t.endMs,
        late: false,
        cut: false,
        evidence: { channel: t.channel, turnId: t.turnId, startMs: t.startMs, endMs: t.endMs, quote: t.text, source: "stt_live" },
        extractor: "luna",
      });
    }
    return { events, usd: o.usdEach ?? 0.0005 };
  };
}

const deps = (extract: NonNullable<DryRunDeps["extract"]>): DryRunDeps => ({
  openai: () => { throw new Error("a dry-run test must never reach OpenAI"); },
  ledger: () => null,
  env: () => "test",
  extract,
});

const input = { compiled, blueprint, sampleIndex: 0, script, simCallId: SIM_ID };

describe("dryRunTurns", () => {
  it("turns the script into finals on the call clock, with legal turn ids", () => {
    const turns = dryRunTurns(script, SIM_ID);
    expect(turns).toHaveLength(script.turns.length);
    expect(turns[0]).toMatchObject({ turnId: "rep-1", channel: "rep", source: "typed", cut: false, late: false });
    expect(turns[1]).toMatchObject({ turnId: "customer-1", channel: "customer" });
    expect(turns[2]!.turnId).toBe("rep-2");
    for (const t of turns) {
      expect(t.endMs).toBeGreaterThan(t.startMs);
      expect(t.recvMs).toBe(t.endMs);
      expect(t.caseId).toBe(SIM_ID);
    }
  });

  it("never invents word timings or an STT source: there is no audio", () => {
    for (const t of dryRunTurns(script, SIM_ID)) {
      expect(t.words).toEqual([]);
      expect(t.source).toBe("typed");
    }
  });
});

describe("runTextDryRun", () => {
  it("feeds the human half in §5.3 batches, with the recent window", async () => {
    const calls: { turns: number; recent: number }[] = [];
    await runTextDryRun(deps(fakeExtract({ calls })), input);
    expect(calls.length).toBe(Math.ceil(script.turns.length / DRY_RUN_BATCH));
    for (const c of calls) expect(c.turns).toBeLessThanOrEqual(DRY_RUN_BATCH);
    expect(calls[0]!.recent).toBe(0);
    expect(calls[1]!.recent).toBeGreaterThan(0);
  });

  it("shows the case card at the pass, with the turn that settled each field", async () => {
    const { result } = await runTextDryRun(deps(fakeExtract()), input);
    expect(result.fields.map((f) => f.id)).toEqual(compiled.ui.fields.map((f) => f.id));
    const name = result.fields.find((f) => f.id === "patient_full_name")!;
    expect(name.status).toBe("VERIFIED");
    expect(name.value).toBe("Maya Ortiz");
    expect(name.quote).toBeTruthy();
    expect(name.turnId).toMatch(/^(rep|customer)-\d+$/);
    const carrier = result.fields.find((f) => f.id === "insurance_carrier")!;
    expect(carrier.status).toBe("MISSING");     // deliberately left for the AI half
    expect(carrier.quote).toBeNull();
  });

  it("shows the compiled greeting the assistant would open with", async () => {
    const { result } = await runTextDryRun(deps(fakeExtract()), input);
    expect(result.greeting.text).toContain("AI assistant");
    expect(result.greeting.text).toContain("recorded");
    expect(result.greeting.wordCount).toBeGreaterThan(0);
    expect(result.greeting.wordCount).toBeLessThanOrEqual(blueprint.playbook.greeting.maxWords);
  });

  it("says what it would ask next in every stage", async () => {
    const { result } = await runTextDryRun(deps(fakeExtract()), input);
    expect(result.steps.map((s) => s.stage)).toEqual(["confirm", "disclose", "pay", "close"]);
    expect(result.steps.map((s) => s.label)).toEqual(blueprint.playbook.stages.map((s) => s.label));
    for (const s of result.steps) expect(s.ask.length).toBeGreaterThan(0);
    // The confirm stage asks for what is still open. Here `procedure` was only read back by the rep and never
    // stated by the customer, so it is PENDING and the assistant's first line confirms it.
    expect(result.steps[0]!.ask.toLowerCase()).toContain("confirm");
    expect(result.steps[0]!.ask.toLowerCase()).toContain("procedure");
    expect(result.steps[1]!.ask).toContain("word for word");
    expect(result.steps[2]!.ask.toLowerCase()).toContain("deposit link");
  });

  it("asks for the field the script left for the AI once nothing is pending", async () => {
    const settled: NonNullable<DryRunDeps["extract"]> = async ({ turns }) => {
      const events: NewFactEvent[] = [];
      for (const t of turns) {
        if (t.text !== "Yes, that's right.") continue;
        for (const [field, value] of [["patient_full_name", "Maya Ortiz"], ["appointment_date", "2026-10-06"], ["procedure", "cleaning"]] as const) {
          for (const [kind, party] of [["stated", "customer"], ["readback", "rep"]] as const) {
            events.push({
              id: `fe_${field}_${kind}`, caseId: t.caseId, field: field as NewFactEvent["field"], kind, party,
              valueRaw: value, valueNorm: value, acknowledgesTurnId: null, confidence: "high",
              turnId: t.turnId, turnEndMs: t.endMs, late: false, cut: false,
              evidence: { channel: t.channel, turnId: t.turnId, startMs: t.startMs, endMs: t.endMs, quote: t.text, source: "stt_live" },
              extractor: "luna",
            });
          }
        }
      }
      return { events, usd: 0 };
    };
    const { result } = await runTextDryRun(deps(settled), input);
    expect(result.fields.filter((f) => f.status === "VERIFIED")).toHaveLength(3);
    expect(result.steps[0]!.ask.toLowerCase()).toContain("insurance carrier");
  });

  it("carries no placeholder through to the page", async () => {
    const { result } = await runTextDryRun(deps(fakeExtract()), input);
    for (const s of result.steps) expect(s.ask).not.toMatch(/\{[a-z]/i);
    expect(result.greeting.text).not.toMatch(/\{[a-z]/i);
  });

  it("pins the extractor version, so a re-run against a changed relay is visibly different", async () => {
    const { result } = await runTextDryRun(deps(fakeExtract()), input);
    expect(result.extractorVersionId).toBe(compiled.extractor.versionId);
  });

  it("adds up what the extraction cost", async () => {
    const { usd, ms } = await runTextDryRun(deps(fakeExtract({ usdEach: 0.001 })), input);
    expect(usd).toBeCloseTo(0.001 * Math.ceil(script.turns.length / DRY_RUN_BATCH), 9);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("refuses a sample that does not exist", async () => {
    await expect(runTextDryRun(deps(fakeExtract()), { ...input, sampleIndex: 9 })).rejects.toThrow(RangeError);
  });
});
