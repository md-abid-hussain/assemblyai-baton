import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LabelsAutoFileSchema } from "../../../../src/core/contracts/ext/wp9-data";
import { CallLabelsSchema } from "../../../../src/core/contracts/scenario";
import { ADD_DRIVER_SPEC } from "../../../../src/core/scenario/intent-spec";
import {
  applyLabelEdit, buildLocatorInput, fmtMs, labelProblems, LOCATOR_FORMAT, locatorFacts, matchQuote, parseLabelEdit, resolveLabels, utterancesFromTranscript, type LocatorOutput,
} from "../../../../src/core/scenario/labels";
import { normalizeScenario } from "../../../../src/core/scenario/normalize";
import { loadScenarios, REPO_ROOT } from "../../../../scripts/calls/lib/kit-io";
import { renderReview } from "../../../../scripts/eval/review-labels";

const s01kit = loadScenarios(join(REPO_ROOT, "data", "scenarios")).find((k) => k.id === "s01")!;
const scenario = normalizeScenario(s01kit, null);
const statedBy = Object.fromEntries(Object.entries(s01kit.facts).map(([f, x]) => [f, x.stated_by]));

const words = (text: string, start: number, step = 300) => text.split(" ").map((w, i) => ({ text: w, start: start + i * step, end: start + (i + 1) * step - 20, channel: null }));
const u = (channel: "1" | "2", start: number, text: string) => {
  const w = words(text, start);
  return { channel, speaker: channel, start, end: w.at(-1)!.end, text, words: w };
};
const transcript = {
  utterances: [
    u("1", 0, "Harborview Insurance, this is Daniel."),
    u("2", 3000, "Hi, I want to add my daughter Maya Raman, she was born March 14th, 2009."),
    u("1", 9000, "Great, Maya Raman, March 14th 2009, got it."),
    u("2", 14_000, "She'll drive the Civic every day."),
    u("1", 20_000, "OK if my assistant finishes the paperwork? I'll stay on the line."),
    u("2", 25_000, "Sure, go ahead."),
  ],
};

describe("labels", () => {
  const utts = utterancesFromTranscript(transcript);

  it("multichannel utterances → numbered call-clock utterances with roles", () => {
    expect(utts.map((x) => `${x.id}:${x.channel}`)).toEqual(["1:rep", "2:customer", "3:rep", "4:customer", "5:rep", "6:customer"]);
    expect(fmtMs(95_300)).toBe("01:35.3");
  });

  it("quotes map to word times: exact, fuzzy, whole utterance", () => {
    const x = utts[1]!;
    expect(matchQuote(x, "born March 14th, 2009")).toMatchObject({ quality: "exact", startMs: 3000 + 11 * 300 });
    expect(matchQuote(x, "daughter Maya Rahman")).toMatchObject({ quality: "fuzzy", startMs: 3000 + 6 * 300 });
    expect(matchQuote(x, "something else entirely")).toMatchObject({ quality: "utterance", startMs: 3000 });
  });

  it("the locator input lists the take's truth (from its scenario) and the numbered transcript", () => {
    const facts = locatorFacts(scenario, ADD_DRIVER_SPEC, statedBy);
    expect(facts.map((f) => f.field)).toEqual(ADD_DRIVER_SPEC.fieldIds.filter((f) => scenario.truth[f] !== undefined));
    const input = buildLocatorInput({ facts, handoffLine: s01kit.handoff.line, utterances: utts });
    expect(input).toContain('- driver_dob (');
    expect(input).toContain('"2009-03-14", expected from CUSTOMER');
    expect(input).toContain("[5] REP 00:20.0 OK if my assistant");
    expect(LOCATOR_FORMAT.schema.required).toContain("facts");
  });

  it("resolveLabels: mentions with acks, hand-off spans, flags for review", () => {
    const located: LocatorOutput = {
      facts: [
        { field: "driver_full_name", found: true, utterance_id: 2, quote: "my daughter Maya Raman", heard_value: "Maya Raman", ack_utterance_id: 3, ack_quote: "Maya Raman", confidence: "high" },
        { field: "driver_dob", found: true, utterance_id: 2, quote: "born March 14th, 2009", heard_value: "2009-03-15", ack_utterance_id: 3, ack_quote: "March 14th 2009", confidence: "high" },
        { field: "vehicle_assignment", found: true, utterance_id: 4, quote: "drive the Civic", heard_value: "veh1", ack_utterance_id: 4, ack_quote: "", confidence: "low" },
        { field: "premium_new_monthly_usd", found: true, utterance_id: 2, quote: "not in there", heard_value: null, ack_utterance_id: null, ack_quote: "", confidence: "high" },
        { field: "effective_date", found: false, utterance_id: null, quote: "", heard_value: null, ack_utterance_id: null, ack_quote: "", confidence: "high" },
      ],
      handoff: { line_utterance_id: 5, line_quote: "OK if my assistant finishes the paperwork?", accept_utterance_id: 6, accept_quote: "Sure, go ahead.", confidence: "high" },
      diagnosis_ends_utterance_id: 4,
      tail_starts_utterance_id: 5,
    };
    const { labels, items } = resolveLabels({ callId: "s01_T", scenario, spec: ADD_DRIVER_SPEC, statedBy, overridden: new Set(["driver_full_name"]), utterances: utts, located });
    expect(CallLabelsSchema.safeParse(labels).success).toBe(true);
    const by = Object.fromEntries(labels.mentions.map((m) => [m.field, m]));
    expect(by.driver_full_name).toMatchObject({ valueNorm: scenario.truth.driver_full_name, channel: "customer", statedAtMs: 3000 + 5 * 300, ackedAtMs: 9000 + 300 });
    expect(by.vehicle_assignment!.ackedAtMs).toBeNull(); // same-party "ack" ignored
    const flags = Object.fromEntries(items.map((i) => [i.key, i.flags]));
    expect(flags.driver_full_name).toEqual(["override"]);
    expect(flags.driver_dob).toEqual(["value_mismatch"]);
    expect(flags.vehicle_assignment).toEqual(["low_confidence"]);
    expect(flags.premium_new_monthly_usd).toEqual(["low_confidence", "channel_mismatch"]);
    expect(flags.effective_date).toEqual(["not_found"]);
    expect(flags.handoff).toEqual([]);
    expect(labels.handoff).toEqual({ lineStartMs: 20_000, lineEndMs: 20_000 + 7 * 300 - 20, acceptStartMs: 25_000, acceptEndMs: 25_000 + 3 * 300 - 20 });
    expect([labels.diagnosisEndsMs, labels.tailStartsMs]).toEqual([utts[3]!.endMs, 20_000]);
    expect(LabelsAutoFileSchema.shape.items.safeParse(items).success).toBe(true);
    const out = renderReview(labels, { callId: "s01_T", scenarioId: "s01", createdAt: "t", transcriptId: null, model: "m", items, utterances: utts.map(({ words: _w, ...x }) => x), usd: { aai: 0, openai: 0 } }, { context: true });
    expect(out.split("\n").find((x) => /^ {2}(!!|ok) /.test(x))).toMatch(/^ {2}!! /); // flagged first
    expect(out).toContain('"born March 14th, 2009"');
    expect(out).toContain("(no mention)");
  });

  it("a missing hand-off is flagged; the acceptance can be missing alone", () => {
    const base: LocatorOutput = { facts: [], handoff: { line_utterance_id: null, line_quote: "", accept_utterance_id: null, accept_quote: "", confidence: "high" }, diagnosis_ends_utterance_id: null, tail_starts_utterance_id: null };
    const r1 = resolveLabels({ callId: "c", scenario, spec: ADD_DRIVER_SPEC, statedBy, overridden: new Set(), utterances: utts, located: base });
    expect(r1.labels.handoff).toBeNull();
    expect(r1.items.find((i) => i.key === "handoff")!.flags).toEqual(["handoff_missing"]);
    const r2 = resolveLabels({ callId: "c", scenario, spec: ADD_DRIVER_SPEC, statedBy, overridden: new Set(), utterances: utts, located: { ...base, handoff: { ...base.handoff, line_utterance_id: 5, line_quote: "OK if my assistant" } } });
    expect(r2.labels.handoff).toMatchObject({ lineStartMs: 20_000, acceptStartMs: null, acceptEndMs: null });
  });

  it("review edits parse times and apply; problems block approval", () => {
    const l = CallLabelsSchema.parse({ callId: "c", reviewed: false, mentions: [{ field: "driver_dob", valueNorm: "2009-03-14", channel: "customer", statedAtMs: 5000, ackedAtMs: 9000, quote: "q" }], handoff: null, diagnosisEndsMs: null, tailStartsMs: null });
    expect(parseLabelEdit("driver_dob.statedAtMs=00:04.5")).toEqual({ op: "set", field: "driver_dob", key: "statedAtMs", ms: 4500 });
    expect(parseLabelEdit("handoff.acceptStartMs=95.3s")).toEqual({ op: "handoff", key: "acceptStartMs", ms: 95_300 });
    expect(parseLabelEdit("tailStartsMs=null")).toEqual({ op: "call", key: "tailStartsMs", ms: null });
    expect(() => parseLabelEdit("nonsense")).toThrow();
    let x = applyLabelEdit(l, parseLabelEdit("handoff.lineStartMs=20000"));
    x = applyLabelEdit(x, parseLabelEdit("handoff.lineEndMs=22000"));
    x = applyLabelEdit(x, parseLabelEdit("driver_dob.ackedAtMs=4000"));
    expect(labelProblems(x, 30_000)).toEqual(["driver_dob: acked before stated"]);
    x = applyLabelEdit(x, parseLabelEdit("drop:driver_dob"));
    expect(x.mentions).toEqual([]);
    expect(labelProblems(applyLabelEdit(x, parseLabelEdit("handoff.acceptStartMs=23000")), 30_000)).toContain("handoff: acceptStartMs/acceptEndMs must both be set or both null");
    expect(l.mentions).toHaveLength(1); // edits never mutate
  });
});
