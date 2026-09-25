import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CallManifestEntrySchema, type CallLabels } from "../../../../src/core/contracts/scenario";
import { REQUIRED_FIELDS } from "../../../../src/core/intents/add-driver.fields";
import { chooseTake, decisionPointMs, planCalls, type TakeInput } from "../../../../src/core/scenario/build";
import { isDualChannel, type KitSidecar } from "../../../../src/core/scenario/kit";
import { loadScenarios, REPO_ROOT } from "../../../../scripts/calls/lib/kit-io";

const kits = loadScenarios(join(REPO_ROOT, "data", "scenarios"));

let n = 0;
function sidecar(scenarioId: string, o: { take?: number; review?: "keep" | "unreviewed" | "discard"; publishable?: boolean; channels?: number; mono?: boolean; state?: KitSidecar["state"] } = {}): KitSidecar {
  const take = o.take ?? 1;
  return {
    kit: "baton-recording-kit",
    sidecar_version: 1,
    base: `${scenarioId}_2026092${take}T0${n++ % 10}0000Z`,
    state: o.state ?? "downloaded",
    scenario: { id: scenarioId, title: "t", language: "en", file: "f", sha256: "x" },
    take,
    review: { status: o.review ?? "keep", notes: [], fact_overrides: {}, status_overrides: {} },
    channel_map: { "1": "rep", "2": "customer" },
    consent: { all_recording_consent: true, publishable: o.publishable ?? true },
    twilio: { recording_channels: o.channels ?? 2 },
    audio: { source_sample_rate: 8000, source_channels: 2, output_sample_rate: 8000, duration_s: 100, warnings: o.mono ? ["recording is MONO, not dual-channel: …"] : [] },
  } as KitSidecar;
}
const take = (sc: KitSidecar, labels: CallLabels | null = null): TakeInput => ({ sidecar: sc, durationMs: 100_000, labels });

describe("planCalls", () => {
  it("chooses the newest keep take (else the newest usable), like `kit report`", () => {
    const a = sidecar("s02", { take: 1, review: "keep" });
    const b = sidecar("s02", { take: 2, review: "unreviewed" });
    const c = sidecar("s02", { take: 3, review: "discard" });
    expect(chooseTake([a, b])?.base).toBe(a.base);
    expect(chooseTake([b])?.base).toBe(b.base);
    const plan = planCalls({ scenarios: kits, takes: [take(a), take(b), take(c)] });
    expect(plan.calls.map((x) => x.entry.callId)).toEqual([a.base, b.base]); // discards are not usable
    expect(plan.calls.find((x) => x.chosen)?.entry.callId).toBe(a.base);
  });

  it("exactly one featured entry: the chosen publishable 2-channel s01 take", () => {
    const s01a = sidecar("s01", { take: 1, review: "unreviewed" });
    const s01b = sidecar("s01", { take: 2, review: "keep" });
    const plan = planCalls({ scenarios: kits, takes: [take(s01a), take(s01b), take(sidecar("s02")), take(sidecar("s05"))] });
    const featured = plan.calls.filter((c) => c.entry.featured);
    expect(featured.map((c) => c.entry.callId)).toEqual([s01b.base]);
    expect(featured[0]!.entry.picker).toBe("main");
    for (const c of plan.calls) expect(CallManifestEntrySchema.omit({ assets: true }).safeParse(c.entry).success).toBe(true);
  });

  it("without a publishable s01, features the first main call and warns", () => {
    const plan = planCalls({ scenarios: kits, takes: [take(sidecar("s01", { publishable: false })), take(sidecar("s02"))] });
    expect(plan.calls.filter((c) => c.entry.featured).map((c) => c.entry.scenarioId)).toEqual(["s02"]);
    expect(plan.warnings.join("\n")).toMatch(/no publishable 2-channel s01 take/);
  });

  it("MONO takes (recording_channels !== 2) are never in eval, the picker or featured", () => {
    const missing = sidecar("s01");
    delete (missing.twilio as { recording_channels?: number }).recording_channels; // a missing value is not trusted
    for (const sc of [sidecar("s01", { channels: 1, mono: true }), missing, sidecar("s01", { mono: true })]) {
      expect(isDualChannel(sc)).toBe(false);
      const plan = planCalls({ scenarios: kits, takes: [take(sc, { callId: sc.base, reviewed: true, mentions: [], handoff: null, diagnosisEndsMs: null, tailStartsMs: null })] });
      const e = plan.calls[0]!.entry;
      expect([e.inEval, e.featured, e.picker]).toEqual([false, false, "hidden"]);
    }
  });

  it("picker tiers: accepted + positive change = main; declined = more; decrease / no change / far start = hidden", () => {
    const ids = ["s02", "s03", "s04", "s09", "s07", "s14", "s17"];
    const plan = planCalls({ scenarios: kits, takes: ids.map((id) => take(sidecar(id))) });
    const tier = Object.fromEntries(plan.calls.map((c) => [c.entry.scenarioId, c.entry.picker]));
    expect(tier).toMatchObject({ s02: "main", s03: "more", s14: "more", s17: "more", s04: "hidden", s09: "hidden", s07: "hidden" });
    expect(plan.calls.find((c) => c.entry.scenarioId === "s03")!.entry.handoff).toBeNull(); // no labels yet
  });

  it("private takes are listed (eval) but never published; inEval needs reviewed labels", () => {
    const sc = sidecar("s05", { publishable: false });
    const labels: CallLabels = { callId: sc.base, reviewed: false, mentions: [], handoff: { lineStartMs: 90_000, lineEndMs: 93_000, acceptStartMs: 93_500, acceptEndMs: 94_200 }, diagnosisEndsMs: null, tailStartsMs: null };
    let e = planCalls({ scenarios: kits, takes: [take(sc, labels)] }).calls[0]!.entry;
    expect([e.publishAudio, e.picker, e.inEval]).toEqual([false, "hidden", false]);
    e = planCalls({ scenarios: kits, takes: [take(sc, { ...labels, reviewed: true })] }).calls[0]!.entry;
    expect(e.inEval).toBe(true);
    expect(e.decisionPointMs).toBe(90_000);
    expect(e.handoff).toEqual({ ...labels.handoff, declined: false });
  });

  it("decision point: hand-off line start, else last acknowledged required fact + 2 s", () => {
    const m = (field: string, ackedAtMs: number | null) => ({ field, valueNorm: "x", channel: "customer", statedAtMs: 1000, ackedAtMs, quote: "q" }) as CallLabels["mentions"][number];
    const base: CallLabels = { callId: "c", reviewed: true, mentions: [m(REQUIRED_FIELDS[0]!, 40_000), m(REQUIRED_FIELDS[1]!, 61_000), m("good_student_discount", 80_000)], handoff: null, diagnosisEndsMs: null, tailStartsMs: null };
    expect(decisionPointMs(base, REQUIRED_FIELDS)).toBe(63_000);
    expect(decisionPointMs({ ...base, handoff: { lineStartMs: 70_000, lineEndMs: 72_000, acceptStartMs: null, acceptEndMs: null } }, REQUIRED_FIELDS)).toBe(70_000);
    expect(decisionPointMs(null, REQUIRED_FIELDS)).toBeNull();
  });

  it("warns on a stale kit manifest and on unknown scenarios; per-take overrides flow into the take's scenario", () => {
    const sc = sidecar("s01");
    sc.review.fact_overrides = { effective_date: "2026-10-09" };
    const orphan = sidecar("s99");
    const plan = planCalls({ scenarios: kits, takes: [take(sc), take(orphan)], manifestChosen: { s01: "s01_other" } });
    expect(plan.warnings.join("\n")).toMatch(/s99 not found/);
    expect(plan.warnings.join("\n")).toMatch(/kit manifest chose s01_other/);
    expect(plan.calls[0]!.scenario.truth.effective_date).toBe("2026-10-09");
    expect(plan.scenarios.find((s) => s.id === "s01")!.truth.effective_date).toBe("2026-10-09");
    expect(plan.scenarios.find((s) => s.id === "s02")!.truth.effective_date).toBeDefined();
    expect(plan.scenarios).toHaveLength(22);
  });
});
