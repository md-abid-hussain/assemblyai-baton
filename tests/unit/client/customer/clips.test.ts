/** WP11·1: where a customer phrase's audio comes from (DESIGN §5.15 "Audio", PLATFORM §7.5 step 5). */
import { describe, expect, it } from "vitest";

import {
  chainClipIndexes, createChipIndex, createClipLoader, createSimClipIndex, loadChipManifest, simClipKey,
} from "@/client/customer/clips";
import { ChipManifestSchema, chipClipUrl, normalizeChipText, type ChipManifest } from "@/client/customer/manifest";

import { bytesOf, clipFetch, pcmOf, simClips } from "./helpers";

const h = (c: string) => c.repeat(64);

const manifest: ChipManifest = {
  version: 1,
  generatedAt: "2026-09-26T00:00:00.000Z",
  model: "test-tts",
  voice: "marin",
  clips: [
    { hash: h("a"), text: "Yes, that's right.", durationMs: 1250, voice: "synthetic" },
    { hash: h("b"), text: "It's 4 4 1 0 7.", durationMs: 2100, voice: "recorded" },
    { hash: h("c"), text: "Only in the other take.", durationMs: 900, voice: "synthetic" },
  ],
  calls: { take1: { scenarioId: "s01", truth: { garaging_zip: "44107" }, clips: [h("a"), h("b")] } },
};

describe("normalizeChipText", () => {
  it("ignores case, punctuation and the apostrophe's shape", () => {
    expect(normalizeChipText("Yes, that’s right.")).toBe(normalizeChipText("yes that's  RIGHT"));
  });
});

describe("createChipIndex (the committed pack)", () => {
  it("serves only the clips this take was generated for, and carries the scenario truth", () => {
    const idx = createChipIndex(manifest, "take1");
    expect(idx.byText("yes that's right")?.url).toBe(chipClipUrl(h("a")));
    expect(idx.byText("It's 4 4 1 0 7.")?.voice).toBe("recorded");
    expect(idx.byText("Only in the other take.")).toBeNull();
    expect(idx.truth).toEqual({ garaging_zip: "44107" });
    expect(idx.byKind("confirm", null)).toBeNull(); // the pack is text-keyed, not kind-keyed
  });

  it("an unknown call id resolves nothing rather than the wrong take's voice", () => {
    const idx = createChipIndex(manifest, "someone-elses-take");
    expect(idx.size).toBe(0);
    expect(idx.byText("Yes, that's right.")).toBeNull();
  });
});

describe("createSimClipIndex (a sim's pre-voiced AI half)", () => {
  const clips = simClips("/calls/sim-dental-deposit", {
    confirm: "Yes, that's right.",
    consent: "Yes, please text me the link.",
    close: "No, that's everything, thanks.",
    "answer:appointment_time": "It's 9:30 AM.",
    "answer:insurance_carrier": "It's BrightSmile Plus.",
  });
  const idx = createSimClipIndex(clips);

  it("maps a suggestion kind (plus the classified field) to the clip key", () => {
    expect(simClipKey("confirm", null)).toBe("confirm");
    expect(simClipKey("consent", null)).toBe("consent");
    expect(simClipKey("close", null)).toBe("close");
    expect(simClipKey("answer", "appointment_time")).toBe("answer:appointment_time");
    expect(simClipKey("answer", null)).toBeNull();
    expect(simClipKey("handback", null)).toBeNull();
    expect(simClipKey("repeat", null)).toBeNull();
    expect(simClipKey("try", null)).toBeNull();
  });

  it("resolves by kind and by the clip's own text", () => {
    expect(idx.byKind("answer", "insurance_carrier")?.text).toBe("It's BrightSmile Plus.");
    expect(idx.byKind("answer", "no_such_field")).toBeNull();
    expect(idx.byText("no that's everything thanks")?.url).toContain("close");
  });

  it("covers a preset's extra field the moment WP17 generated its clip", () => {
    const withPreset = createSimClipIndex({ ...clips, ...simClips("/calls/sim-dental-deposit", { "answer:referral_source": "A friend referred me." }) });
    expect(withPreset.byKind("answer", "referral_source")?.text).toBe("A friend referred me.");
  });
});

describe("chainClipIndexes", () => {
  it("the recorded pack wins over the sim's synthetic clip", () => {
    const recorded = createChipIndex(
      { ...manifest, clips: [{ hash: h("d"), text: "Yes, that's right.", durationMs: 1000, voice: "recorded" }], calls: { take1: { scenarioId: "s01", truth: {}, clips: [h("d")] } } },
      "take1",
    );
    const sim = createSimClipIndex(simClips("/calls/sim-x", { confirm: "Yes, that's right." }));
    const chain = chainClipIndexes(recorded, sim);
    expect(chain.byText("Yes, that's right.")?.voice).toBe("recorded");
    // The sim is still the only source of a kind-keyed answer.
    expect(chain.byKind("confirm", null)?.url).toContain("/calls/sim-x");
    expect(chain.size).toBe(2);
  });
});

describe("createClipLoader", () => {
  it("decodes 24 kHz PCM16, caches per URL and never throws on a missing clip", async () => {
    const pcm = pcmOf(1234, 240);
    const { fetch, urls } = clipFetch({ "/tts/one.pcm": bytesOf(pcm) });
    const loader = createClipLoader({ fetchImpl: fetch });
    const ref = { text: "x", durationMs: 10, url: "/tts/one.pcm", voice: "synthetic" as const };
    const a = await loader.load(ref);
    const b = await loader.load(ref);
    expect(Array.from(a!.slice(0, 3))).toEqual([1234, 1234, 1234]);
    expect(a!.length).toBe(240);
    expect(b).toBe(a);
    expect(urls.filter((u) => u === "/tts/one.pcm")).toHaveLength(1);

    const missing = await loader.load({ ...ref, url: "/tts/nope.pcm" });
    expect(missing).toBeNull();
    // A failed clip is not cached: the next click tries again.
    await loader.load({ ...ref, url: "/tts/nope.pcm" });
    expect(urls.filter((u) => u === "/tts/nope.pcm")).toHaveLength(2);
  });
});

describe("loadChipManifest", () => {
  it("parses a good pack and survives a missing one", async () => {
    const { fetch } = clipFetch({ "/tts/manifest.json": JSON.stringify(manifest) });
    const ok = await loadChipManifest("/tts/manifest.json", (raw) => ChipManifestSchema.parse(raw), { fetchImpl: fetch });
    expect(ok?.clips).toHaveLength(3);
    const warnings: string[] = [];
    const gone = await loadChipManifest("/tts/gone.json", (raw) => ChipManifestSchema.parse(raw), { fetchImpl: fetch, log: (_l, m) => warnings.push(m) });
    expect(gone).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});
