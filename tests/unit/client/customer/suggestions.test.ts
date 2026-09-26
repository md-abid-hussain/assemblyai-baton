/**
 * WP11·1: WHAT the customer can say - WP14a's `suggestReplies` bound to the audio that actually exists.
 * The two shapes of relay: a Baton take (text-keyed committed pack) and the Dental gallery sim (kind-keyed
 * `aiClips` + the relay's compiled spec).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createChipIndex, createSimClipIndex, EMPTY_CLIP_INDEX } from "@/client/customer/clips";
import type { ChipManifest } from "@/client/customer/manifest";
import { buildSuggestions, kindForClass, MAX_SUGGESTIONS } from "@/client/customer/suggestions";
import { S01_AI } from "@/client/fixtures/s01-script";
import type { FieldId, PolicyRecord } from "@/core/contracts/case";
import { BlueprintSchema } from "@/core/contracts/v2/blueprint";
import { compileRelay } from "@/core/relay/compile";
import { repoRoot } from "../../../../scripts/lib/load-env";

import { emptyCaseState, S01_POLICY, simClips } from "./helpers";

const h = (c: string) => c.repeat(64);
const S01_TRUTH: Partial<Record<FieldId, string>> = {
  driver_full_name: "maya raman", driver_dob: "2009-03-14", garaging_zip: "44107", vehicle_assignment: "veh1",
  effective_date: "2026-10-02", license_state: "OH", license_status: "provisional",
};

const input = (lastAgentText: string, over: Partial<Parameters<typeof buildSuggestions>[0]> = {}) => ({
  lastAgentText,
  history: [] as string[],
  snapshot: emptyCaseState("case1"),
  truth: S01_TRUTH,
  stage: null,
  paymentStatus: null,
  policy: S01_POLICY,
  offerTry: false,
  index: EMPTY_CLIP_INDEX,
  ...over,
});

/** A pack that covers exactly the phrases the test needs. */
function packFor(texts: string[]): ChipManifest {
  const clips = texts.map((text, i) => ({ hash: h("0123456789abcdef"[i % 16]!), text, durationMs: 1000, voice: "synthetic" as const }));
  return {
    version: 1, generatedAt: "2026-09-26T00:00:00.000Z", model: "m", voice: "marin",
    clips,
    calls: { take1: { scenarioId: "s01", truth: S01_TRUTH as Record<string, string>, clips: clips.map((c) => c.hash) } },
  };
}

describe("kindForClass", () => {
  it("maps a classification to the sim clip that answers it", () => {
    expect(kindForClass({ kind: "esign_consent", sentence: "", field: null })).toBe("consent");
    expect(kindForClass({ kind: "disclosure_premium", sentence: "", field: null })).toBe("consent");
    expect(kindForClass({ kind: "anything_else", sentence: "", field: null })).toBe("close");
    expect(kindForClass({ kind: "confirm", sentence: "", field: null })).toBe("confirm");
    expect(kindForClass({ kind: "ask", sentence: "", field: "driver_dob" })).toBe("answer");
    expect(kindForClass({ kind: "statement", sentence: "", field: null })).toBeNull();
    expect(kindForClass({ kind: "request", sentence: "", field: null })).toBeNull();
  });
});

describe("buildSuggestions on a Baton take", () => {
  const ASK_ZIP = "What's the ZIP code where the car is kept overnight?";

  it("keeps every phrase when no pack is committed yet, so the judge still sees what would be said", () => {
    const { items } = buildSuggestions(input(ASK_ZIP));
    expect(items[0]?.text).toBe("It's 4 4 1 0 7.");
    expect(items.every((s) => s.clip === null && s.audioUrl === null)).toBe(true);
    expect(items.some((s) => s.text === "Can I talk to Daniel?")).toBe(true);
  });

  it("drops the phrases the pack cannot voice and keeps the ones it can", () => {
    const pack = packFor(["It's 4 4 1 0 7.", "Sorry, could you repeat that?"]);
    const { items } = buildSuggestions(input(ASK_ZIP, { index: createChipIndex(pack, "take1") }));
    expect(items.map((s) => s.text)).toEqual(["It's 4 4 1 0 7.", "Sorry, could you repeat that?"]);
    expect(items[0]?.audioUrl).toMatch(/^\/tts\/[0-9a-f]{64}\.pcm$/);
    expect(items.some((s) => s.text === "Can I talk to Daniel?")).toBe(false);
  });

  it("a read-back the truth agrees with resolves the shared confirm clip", () => {
    const pack = packFor(["Yes, that's right."]);
    const { items, cls } = buildSuggestions(
      input("Just to confirm, the car is kept at ZIP code 4 4 1 0 7. Is that right?", { index: createChipIndex(pack, "take1") }),
    );
    expect(cls).toMatchObject({ kind: "confirm", field: "garaging_zip" });
    expect(items[0]).toMatchObject({ text: "Yes, that's right.", kind: "confirm" });
    expect(items[0]?.clip).not.toBeNull();
  });

  it("the e-sign consent phrase resolves from the pack", () => {
    const text = "Yes, text me the link. No paper copy, thanks.";
    const { items, cls } = buildSuggestions(input(S01_AI.esignText, { index: createChipIndex(packFor([text]), "take1") }));
    expect(cls.kind).toBe("esign_consent");
    expect(items[0]?.text).toBe(text);
    expect(items[0]?.clip).not.toBeNull();
  });

  it("a recorded tail-pack clip is labelled recorded, so the console can say whose voice it is", () => {
    const pack = packFor(["It's 4 4 1 0 7."]);
    pack.clips[0]!.voice = "recorded";
    const { items } = buildSuggestions(input(ASK_ZIP, { index: createChipIndex(pack, "take1") }));
    expect(items[0]?.voice).toBe("recorded");
  });

  it("the loop breaker's explicit sentence is what gets voiced on the second ask", () => {
    const { items } = buildSuggestions(input("Sorry, what's Maya's date of birth?", { history: ["What's her date of birth?"] }));
    expect(items[0]?.text).toBe("Maya's date of birth is March 14th, 2009.");
  });

  it("caps the list", () => {
    const { items } = buildSuggestions(input(ASK_ZIP, { offerTry: true }));
    expect(items.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
  });
});

describe("buildSuggestions on the Dental gallery sim (PLATFORM §7.5 step 5)", () => {
  const bp = BlueprintSchema.parse(JSON.parse(readFileSync(join(repoRoot(), "data/relays/dental-deposit.json"), "utf8")));
  const kernel = compileRelay(bp);
  const account = bp.context.samples[0]! as unknown as PolicyRecord;
  const index = createSimClipIndex(
    simClips("/calls/sim-dental-deposit", {
      confirm: "Yes, that's right.",
      consent: "Yes, please text me the link.",
      close: "No, that's everything, thanks.",
      "answer:appointment_time": "It's 9:30 AM.",
      "answer:patient_full_name": "It's Maya Ortiz.",
    }),
  );
  // A sim's truth never reaches the page: `suggestReplies` alone would answer "I'm not sure, sorry."
  const simInput = (text: string, over: Partial<Parameters<typeof buildSuggestions>[0]> = {}) =>
    input(text, { truth: {}, index, policy: account, spec: kernel.spec, ...over });

  it("answers an open ask with the pre-voiced clip for that field, not with a placeholder", () => {
    const { items } = buildSuggestions(simInput("What time is the appointment?"));
    expect(items[0]).toMatchObject({ text: "It's 9:30 AM.", kind: "answer" });
    expect(items[0]?.audioUrl).toContain("/calls/sim-dental-deposit/");
    expect(items.some((s) => s.text === "I'm not sure, sorry.")).toBe(false);
  });

  it("answers a read-back with the shared confirm clip", () => {
    const { items } = buildSuggestions(simInput("Could you confirm the patient's full name, Maya Ortiz?", { truth: { patient_full_name: "maya ortiz" } as never }));
    expect(items[0]?.text).toBe("Yes, that's right.");
  });

  it("uses the clip's own wording, never a phrase that was never voiced", () => {
    const { items } = buildSuggestions(simInput("Is there anything else I can help with?"));
    expect(items[0]?.text).toBe("No, that's everything, thanks.");
    expect(items.every((s) => s.clip !== null)).toBe(true);
  });

  it("picks up a 'Try an edit' preset's extra field with no extra TTS", () => {
    const withPreset = createSimClipIndex(
      simClips("/calls/sim-dental-deposit", { confirm: "Yes, that's right.", "answer:procedure": "A cleaning, please." }),
    );
    const { items } = buildSuggestions(simInput("And which procedure is it for?", { index: withPreset }));
    expect(items[0]?.text).toBe("A cleaning, please.");
  });
});
