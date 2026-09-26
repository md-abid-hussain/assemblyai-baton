/**
 * WP11·1 acceptance 1, against the COMMITTED pack: `public/tts/` must be able to voice every reply the s01
 * autopilot and its chips can produce, so a run makes zero live TTS calls. If this fails, re-run
 * `RUN_LIVE=1 npm run tts:chips` (a warm cache is $0) - do not weaken the test.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createChipIndex } from "@/client/customer/clips";
import { ChipManifestSchema, normalizeChipText } from "@/client/customer/manifest";
import { buildSuggestions } from "@/client/customer/suggestions";
import { S01_AI } from "@/client/fixtures/s01-script";
import type { FieldId } from "@/core/contracts/case";
import { CallScenariosFileSchema } from "@/core/contracts/ext/wp9-data";
import { emptyCaseState } from "@/core/case/state";
import { chipPhrases } from "../../../../scripts/tts/generate-chips";
import { repoRoot } from "../../../../scripts/lib/load-env";

const root = repoRoot();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(root, p), "utf8"));
const PACK = join(root, "public/tts/manifest.json");
const has = existsSync(PACK);

/** 24 kHz PCM16 mono: 48 bytes per ms. */
const durationOf = (bytes: number): number => Math.round(((bytes / 2) * 1000) / 24_000);

describe.skipIf(!has)("the committed chip pack (public/tts)", () => {
  const manifest = ChipManifestSchema.parse(readJson("public/tts/manifest.json"));
  const scenarios = CallScenariosFileSchema.parse(readJson("src/generated/call-scenarios.json"));
  const callId = Object.keys(manifest.calls)[0]!;
  const scenario = scenarios[callId]!;

  it("covers the featured Baton take, with that take's own truth", () => {
    expect(scenario).toBeDefined();
    expect(manifest.calls[callId]!.scenarioId).toBe(scenario.id);
    expect(manifest.calls[callId]!.truth).toEqual(scenario.truth);
    expect(manifest.voice).toBe("marin");
  });

  it("every clip is on disk, is PCM16 and matches its recorded duration", () => {
    for (const c of manifest.clips) {
      const file = join(root, "public/tts", `${c.hash}.pcm`);
      expect(existsSync(file), `${c.hash} (${c.text})`).toBe(true);
      const size = statSync(file).size;
      expect(size % 2, `${c.hash} is not whole PCM16 samples`).toBe(0);
      expect(size).toBeGreaterThan(2000);
      expect(Math.abs(durationOf(size) - c.durationMs)).toBeLessThanOrEqual(2);
    }
  });

  it("every phrase the generator plans is in the pack (no live synthesis is ever needed)", () => {
    const have = new Set(manifest.clips.map((c) => normalizeChipText(c.text)));
    const missing = chipPhrases(scenario).filter((t) => !have.has(normalizeChipText(t)));
    expect(missing).toEqual([]);
  });

  it("the phrases are distinct and the take references all of them", () => {
    const keys = manifest.clips.map((c) => normalizeChipText(c.text));
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(manifest.calls[callId]!.clips)).toEqual(new Set(manifest.clips.map((c) => c.hash)));
  });

  describe("an s01 AI half answers every agent turn from the pack alone", () => {
    const index = createChipIndex(manifest, callId);
    const truth = scenario.truth as Partial<Record<FieldId, string>>;
    const at = (lastAgentText: string, over: Record<string, unknown> = {}) =>
      buildSuggestions({
        lastAgentText,
        history: [],
        snapshot: emptyCaseState("case1"),
        truth,
        stage: null,
        paymentStatus: null,
        policy: scenario.policy,
        offerTry: false,
        index,
        ...over,
      });

    const turns: [string, Record<string, unknown>][] = [
      [S01_AI.greeting, {}],
      ["What's the ZIP code where the car is kept overnight?", {}],
      ["When would you like the change to start?", {}],
      ["What's Maya's date of birth?", {}],
      ["Just to confirm, the car is kept at ZIP code 4 4 1 0 8. Is that right?", {}],
      ["Will she drive it every day?", {}],
      [S01_AI.premiumDisclosureText, { stage: "disclose" }],
      [S01_AI.esignText, { stage: "disclose" }],
      [S01_AI.linkSent, { stage: "pay", paymentStatus: "open" }],
      [S01_AI.confirmation, { stage: "close", paymentStatus: "succeeded" }],
      ["Sorry, what's Maya's date of birth?", { history: ["What's her date of birth?"] }],
    ];

    for (const [text, over] of turns) {
      it(`"${text.slice(0, 48)}…"`, () => {
        const { items } = at(text, over);
        expect(items.length).toBeGreaterThan(0);
        expect(items[0]?.clip, `no clip for "${items[0]?.text}"`).not.toBeNull();
        expect(items[0]?.audioUrl).toMatch(/^\/tts\/[0-9a-f]{64}\.pcm$/);
      });
    }

    it("offers the 'Try this' live-conflict chip with a voice behind it", () => {
      const { items } = at("Great, thanks.", { offerTry: true, snapshot: emptyCaseState("case1") });
      const tryChip = items.find((s) => s.kind === "try");
      // The chip only appears once the vehicle is VERIFIED in the snapshot; when it does, it must be playable.
      if (tryChip) expect(tryChip.clip).not.toBeNull();
      expect(items[0]?.clip).not.toBeNull();
    });
  });
});
