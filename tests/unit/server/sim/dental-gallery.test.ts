/**
 * WP17·2: the committed gallery artefacts - `data/relays/dental-deposit.json`, its two "Try an edit" presets, the
 * pre-generated simulated call in `src/generated/sim-calls.json`, its static assets and its Express cache.
 *
 * These are the files the demo ships (PLATFORM §7.5, §7.5.3; TASKS-v2 §6 WP17 acceptance 1 and 3), so the test reads
 * them from disk exactly as the app does. $0: no network, no DB.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GallerySimCallsSchema, SIM_CALL_ID_RE, simClipFile } from "@/core/contracts/ext/wp17-sim";
import { CachedTurnsFileSchema } from "@/core/contracts/eval";
import { BlueprintSchema, type Blueprint } from "@/core/contracts/v2/blueprint";
import { PeaksSchema } from "@/core/contracts/scenario";
import { applyRelayPreset, parsePresetsFile } from "@/core/relay/draft/presets";
import { hasLintErrors, lintBlueprint } from "@/core/relay/lint";
import { compileRelay } from "@/core/relay/compile";
import { simCallIdFor } from "@/server/sim/generate";
import { GallerySimCatalog, resolutionOfGallery } from "@/server/sim/store";
import { RelayPresetsFileSchema as Wp14bPresetsFileSchema } from "@/core/contracts/ext/wp14b-relays";
import { applyJsonPatch as wp14bApplyJsonPatch } from "@/server/relays/json-patch";
import { blueprintHash } from "../../../../scripts/sim/lib/blueprint-hash";
import { repoRoot } from "../../../../scripts/lib/load-env";

const root = repoRoot();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(root, p), "utf8"));

const SLUG = "dental-deposit";
const blueprint: Blueprint = BlueprintSchema.parse(readJson(`data/relays/${SLUG}.json`));
const presetsFile = parsePresetsFile(readJson(`data/relays/${SLUG}.presets.json`), SLUG);
const manifest = GallerySimCallsSchema.parse(readJson("src/generated/sim-calls.json"));
const sim = manifest.find((g) => g.relay.slug === SLUG);

/** PLATFORM §5.1 / TASKS-v3 §2 rule 19: these words never describe Changeover. */
const BANNED = /no-code|drag-and-drop|canvas/i;
const allText = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(allText) : v && typeof v === "object" ? Object.values(v).flatMap(allText) : [];

describe("data/relays/dental-deposit.json", () => {
  it("is a valid blueprint whose meta says it is a sample", () => {
    expect(blueprint.meta.slug).toBe(SLUG);
    expect(blueprint.meta.origin).toBe("seed");
    expect(blueprint.meta.sampleOnly).toBe(true);
    expect(blueprint.playbook.promptTemplate).toBeNull();
  });

  it("has a fictional billing address in every sample (PLATFORM §6.1)", () => {
    expect(blueprint.context.samples.length).toBeGreaterThanOrEqual(2);
    for (const s of blueprint.context.samples) {
      expect(s.customer.address).toBeDefined();
      expect(s.customer.address!.zip).toMatch(/^\d{5}$/);
      expect(s.customer.address!.state).toMatch(/^[A-Z]{2}$/);
    }
  });

  it("takes a deposit through a named money value, with a consent disclosure before the act stage", () => {
    const deposit = blueprint.values.find((v) => v.id === "deposit_due");
    expect(deposit?.type).toBe("money");
    expect(deposit?.ref).toEqual({ kind: "fixed", value: "50" });
    const pay = blueprint.connectors.find((c) => c.id === "deposit_link");
    expect(pay?.type).toBe("payment_link");
    expect(pay && "amount" in pay ? pay.amount : null).toBe("deposit_due");
    const consent = blueprint.playbook.disclosures.filter((d) => d.consent);
    expect(consent).toHaveLength(1);
    expect(blueprint.playbook.stages.map((s) => s.kind)).toEqual(["confirm", "disclose", "act", "close"]);
  });

  it("leaves at least one required ai_allowed field for the AI half", () => {
    const aiRequired = blueprint.fields.filter((f) => f.required && f.setBy === "ai_allowed");
    expect(aiRequired.length).toBeGreaterThanOrEqual(1);
    expect(blueprint.fields.filter((f) => f.required).length).toBeLessThanOrEqual(12);
  });

  it("is lint-clean and compiles (TASKS-v2 §6 WP17 T2: hand-curated and lint-clean)", () => {
    const issues = lintBlueprint(blueprint);
    expect(issues.filter((i) => i.severity === "error"), JSON.stringify(issues.filter((i) => i.severity === "error"))).toEqual([]);
    expect(hasLintErrors(issues)).toBe(false);
    expect(() => compileRelay(blueprint)).not.toThrow();
  });

  it("never says no-code, drag-and-drop or canvas", () => {
    for (const s of allText(blueprint)) expect(s).not.toMatch(BANNED);
    for (const s of allText(presetsFile)) expect(s).not.toMatch(BANNED);
  });
});

describe("data/relays/dental-deposit.presets.json", () => {
  it("is the two NEVER-CUT presets of PLATFORM §7.5.3", () => {
    expect(presetsFile.presets.map((p) => p.id)).toEqual(["add_insurance_carrier", "deposit_seventy_five"]);
  });

  it("every preset applies, still parses as a blueprint, and stays lint-clean", () => {
    for (const p of presetsFile.presets) {
      const after = BlueprintSchema.parse(applyRelayPreset(blueprint, p));
      const errors = lintBlueprint(after).filter((i) => i.severity === "error");
      expect(errors, `${p.id}: ${JSON.stringify(errors)}`).toEqual([]);
      expect(() => compileRelay(after)).not.toThrow();
    }
  });

  it('"add a required field" adds exactly one required, ai_allowed field the AI must ask for', () => {
    const p = presetsFile.presets[0]!;
    const after = BlueprintSchema.parse(applyRelayPreset(blueprint, p));
    const added = after.fields.filter((f) => !blueprint.fields.some((b) => b.id === f.id));
    expect(added.map((f) => f.id)).toEqual(["insurance_carrier"]);
    expect(added[0]!.required).toBe(true);
    expect(added[0]!.setBy).toBe("ai_allowed");
    expect(added[0]!.qa.ask.length).toBeGreaterThan(0);
    expect(p.sim.answers.map((a) => a.field)).toEqual(["insurance_carrier"]);
  });

  it('"change the deposit" moves $50 to $75 everywhere the AI says it', () => {
    const after = BlueprintSchema.parse(applyRelayPreset(blueprint, presetsFile.presets[1]!));
    expect(after.values.find((v) => v.id === "deposit_due")!.ref).toEqual({ kind: "fixed", value: "75" });
    // The disclosure and the SMS read the named value, so nothing else has to change.
    expect(after.playbook.disclosures[0]!.text).toContain("{v.deposit_due|spoken_money}");
    const pay = after.connectors.find((c) => c.id === "deposit_link")!;
    expect("smsTemplate" in pay ? pay.smsTemplate : "").toContain("{v.deposit_due|spoken_money}");
  });

  it("every preset's sim answer names a field of the variant", () => {
    for (const p of presetsFile.presets) {
      const after = BlueprintSchema.parse(applyRelayPreset(blueprint, p));
      for (const a of p.sim.answers) expect(after.fields.some((f) => f.id === a.field)).toBe(true);
    }
  });
});

describe("src/generated/sim-calls.json (the pre-generated Dental sim)", () => {
  it("is content-addressed by the committed blueprint", () => {
    expect(sim).toBeDefined();
    expect(sim!.id).toMatch(SIM_CALL_ID_RE);
    const hash = blueprintHash(blueprint);
    expect(sim!.relay.blueprintHash).toBe(hash);
    expect(sim!.id).toBe(simCallIdFor({ kind: "audio", versionKey: `${SLUG}@${hash}`, sampleIndex: sim!.sampleIndex, salt: "gallery" }));
  });

  it("names every preset variant the same audio serves", () => {
    expect(sim!.variants.map((v) => v.presetId)).toEqual(presetsFile.presets.map((p) => p.id));
    for (const v of sim!.variants) {
      const expected = blueprintHash(BlueprintSchema.parse(applyRelayPreset(blueprint, presetsFile.presets.find((p) => p.id === v.presetId)!)));
      expect(v.blueprintHash).toBe(expected);
      expect(v.blueprintHash).not.toBe(sim!.relay.blueprintHash);
    }
  });

  it("is a simulated twilio8k entry whose decision point is the handoff line", () => {
    const e = sim!.entry;
    expect(e.callId).toBe(sim!.id);
    expect(e.scenarioId).toBe(`relay:${SLUG}`);
    expect(e.source).toBe("twilio8k");
    expect(e.format).toEqual({ encoding: "pcm_mulaw", sampleRate: 8000 });
    expect(e.picker).toBe("hidden");
    expect(e.inEval).toBe(false);
    expect(e.decisionPointMs).toBe(e.handoff!.lineStartMs);
    expect(e.durationMs).toBeLessThanOrEqual(90_000);
  });

  it("ends on the exact handoff line, with the acceptance right after it", () => {
    const turns = sim!.timeline;
    const handoff = turns[turns.length - 2]!;
    const accept = turns[turns.length - 1]!;
    expect(handoff.speaker).toBe("rep");
    expect(handoff.tag).toBe("handoff");
    expect(handoff.text).toBe(blueprint.handoff.repLine);
    expect(accept.speaker).toBe("customer");
    expect(accept.tag).toBe("accept");
    expect(accept.startMs - handoff.endMs).toBe(300);
    expect(sim!.entry.handoff!.lineStartMs).toBe(handoff.startMs);
  });

  it("carries the AI-half clips of the base script AND of every preset", () => {
    const keys = Object.keys(sim!.aiClips).sort();
    expect(keys).toContain("confirm");
    expect(keys).toContain("consent");
    expect(keys).toContain("close");
    for (const p of presetsFile.presets) for (const a of p.sim.answers) expect(keys).toContain(`answer:${a.field}`);
  });

  it("serves every asset as a committed static file under public/", () => {
    const e = sim!.entry;
    const files = [e.assets!.rep, e.assets!.customer, e.assets!.peaks, ...Object.values(sim!.aiClips).map((c) => c.url)];
    for (const url of files) {
      expect(url.startsWith(`/calls/sim-${SLUG}/`)).toBe(true);
      const path = join(root, "public", url.slice(1));
      expect(existsSync(path), url).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(0);
    }
    // 8 kHz µ-law, one byte per sample, both channels the same length as the call.
    for (const url of [e.assets!.rep, e.assets!.customer]) {
      expect(statSync(join(root, "public", url.slice(1))).size).toBe(e.durationMs * 8);
    }
    for (const [key, clip] of Object.entries(sim!.aiClips)) {
      expect(clip.url).toBe(`/calls/sim-${SLUG}/${simClipFile(clip.hash)}`);
      expect(clip.text.length, key).toBeGreaterThan(0);
    }
  });

  it("has 50 peaks per second of call on both channels (DESIGN §5.1.1)", () => {
    const peaks = PeaksSchema.parse(JSON.parse(readFileSync(join(root, "public", sim!.entry.assets!.peaks.slice(1)), "utf8")));
    const expected = Math.round((sim!.entry.durationMs / 1000) * peaks.ratePerSec);
    for (const ch of ["rep", "customer"] as const) {
      expect(Math.abs(peaks[ch].length - expected), ch).toBeLessThanOrEqual(1);
      for (const p of peaks[ch]) expect(p).toBeGreaterThanOrEqual(0);
      expect(Math.max(...peaks[ch]), ch).toBeGreaterThan(0.05);
    }
  });
});

/**
 * The gallery manifest is only useful if WP14b's seed reaches the SAME blueprints from the SAME files: `CallCatalog`
 * matches `relay.blueprintHash` (and each variant's) against the hash the registry stored for the seeded version.
 * WP14b reads the presets file with its own schema and applies the patches with its own applier, so both are checked
 * here rather than assumed (`wp14b-to-wp17.md` §1 and §4).
 */
describe("WP14b's seed reaches the same blueprints from the same files", () => {
  it("parses data/relays/dental-deposit.presets.json with WP14b's schema", () => {
    const parsed = Wp14bPresetsFileSchema.parse(readJson(`data/relays/${SLUG}.presets.json`));
    expect(parsed.map((p) => p.id)).toEqual(presetsFile.presets.map((p) => p.id));
    for (const p of parsed) expect(p.label.length).toBeGreaterThan(0);
  });

  it("reproduces every variant's blueprintHash with WP14b's patch applier and WP14a's hash", () => {
    const parsed = Wp14bPresetsFileSchema.parse(readJson(`data/relays/${SLUG}.presets.json`));
    expect(blueprintHash(blueprint)).toBe(sim!.relay.blueprintHash);
    for (const v of sim!.variants) {
      const def = parsed.find((p) => p.id === v.presetId)!;
      const patched = BlueprintSchema.parse(wp14bApplyJsonPatch(blueprint, def.patch));
      expect(blueprintHash(patched), v.presetId).toBe(v.blueprintHash);
      // …and WP17's own applier agrees with WP14b's, byte for byte.
      expect(patched).toEqual(BlueprintSchema.parse(applyRelayPreset(blueprint, presetsFile.presets.find((p) => p.id === v.presetId)!)));
    }
  });
});

describe("the Dental sim is labelled SIMULATED wherever it is resolved (PLATFORM §7.5, the provenance strip)", () => {
  it("resolves as a simulated gallery call, never a recorded take", async () => {
    const r = resolutionOfGallery(sim!);
    expect(r.simulated).toBe(true);
    expect(r.gallery).toBe(true);
    expect(r.relayVersionId).toBeNull();
    expect(r.entry.inEval).toBe(false);
    expect(r.entry.picker).toBe("hidden");
    expect(r.entry.title).toContain("simulated");
    const found = await new GallerySimCatalog({ entries: manifest }).get(sim!.id);
    expect(found).not.toBeNull();
    expect(resolutionOfGallery(found!).simulated).toBe(true);
  });

  it("is a sample relay, so the UI can say the call is fictional", () => {
    expect(blueprint.meta.sampleOnly).toBe(true);
    for (const d of blueprint.playbook.disclosures) expect(d.text.length).toBeGreaterThan(0);
  });
});

describe("the Express cache of the Dental sim (DESIGN §5.1.6)", () => {
  const path = join(root, "public", "data", "cached-turns", `${sim!.id}.json`);

  it("is committed as pc_ctx cached turns for this call id", () => {
    expect(existsSync(path)).toBe(true);
    const file = CachedTurnsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(file.callId).toBe(sim!.id);
    expect(file.variant).toBe("pc_ctx");
    expect(file.channels.rep.length).toBeGreaterThan(0);
    expect(file.channels.customer.length).toBeGreaterThan(0);
  });

  const file = CachedTurnsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const finals = (rows: typeof file.channels.rep, untilMs: number) => {
    const seen = new Set<number>();
    return rows.filter((r) => {
      const m = r.message as { end_of_turn?: boolean; turn_order?: number; transcript?: string };
      if (m.end_of_turn !== true || !m.transcript?.trim() || typeof m.turn_order !== "number" || seen.has(m.turn_order)) return false;
      seen.add(m.turn_order);
      return r.recvMs <= untilMs;
    });
  };

  it("covers the Express start (25 s before the pass) with finals from both channels", () => {
    const untilMs = Math.max(0, sim!.entry.decisionPointMs! - 25_000);
    expect(untilMs).toBeGreaterThan(5_000);
    expect(finals(file.channels.rep, untilMs).length).toBeGreaterThanOrEqual(3);
    expect(finals(file.channels.customer, untilMs).length).toBeGreaterThanOrEqual(3);
  });

  /**
   * The $0 offline half of TASKS-v2 §6 WP17 acceptance 2 ("the human half yields the script's facts at the pass").
   * It stops at the transcript: the extractor's own yield is the live check the deployed run records. If a rebuild
   * ever makes the TTS unintelligible, this fails before anyone watches a run.
   */
  it("transcribes the facts the script settles, at the pass", () => {
    const pass = sim!.entry.decisionPointMs!;
    const text = [...finals(file.channels.rep, pass), ...finals(file.channels.customer, pass)]
      .map((r) => (r.message as { transcript: string }).transcript).join(" ").toLowerCase();
    const sample = blueprint.context.samples[sim!.sampleIndex]!;
    const said = sim!.timeline.filter((t) => t.startMs < pass).map((t) => t.text).join(" ").toLowerCase();
    const wanted: [string, string[]][] = [
      ["patient name", [`${sample.customer.firstName} ${sample.customer.lastName}`.toLowerCase(), sample.customer.lastName.toLowerCase()]],
      ["org", [sample.org.name.toLowerCase()]],
      ["rep", [sample.org.repFirstName.toLowerCase()]],
      ["procedure", ["cleaning"]],
    ];
    const scored = wanted.filter(([, alts]) => alts.some((a) => said.includes(a)));
    expect(scored.length).toBeGreaterThanOrEqual(3);
    const missed = scored.filter(([, alts]) => !alts.some((a) => text.includes(a))).map(([l]) => l);
    expect(missed, `not transcribed: ${missed.join(", ")}`).toEqual([]);
    // The handoff line itself is spoken AT the pass, so it is never in the prefilled window.
    expect(text).not.toContain(blueprint.handoff.repLine.slice(0, 20).toLowerCase());
  });
});
