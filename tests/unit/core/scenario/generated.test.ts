/**
 * The committed build outputs (src/generated/*.json, public/calls, public/data/cached-turns) are consistent.
 * TASKS WP9 acceptance 1-3 against what is actually committed. While the takes are simulated stand-ins (WP9·2, no
 * recording session yet) the same rules hold, plus: every call says how it came to exist, and no simulated take is
 * ever counted as a recorded one (`inEval` false).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CachedTurnsFileSchema } from "../../../../src/core/contracts/eval";
import { CallProvenanceFileSchema, type CallProvenanceFile } from "../../../../src/core/contracts/ext/wp9-data";
import { CallManifestEntrySchema, ScenarioSchema, type CallManifestEntry } from "../../../../src/core/contracts/scenario";
import { REPO_ROOT } from "../../../../scripts/calls/lib/kit-io";

const read = (rel: string): unknown => JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
const calls = read("src/generated/calls.json") as CallManifestEntry[];
const provenance = read("src/generated/call-provenance.json") as CallProvenanceFile;

/**
 * WP17 owns `public/calls/sim-*` and `public/data/cached-turns/sim_*.json` (TASKS-v2 §4): the gallery's SIMULATED
 * calls live beside the recorded takes but are listed in `src/generated/sim-calls.json`, not in `calls.json`.
 * `tests/unit/server/sim/dental-gallery.test.ts` checks them. This rule is about the takes, so it skips them.
 */
const notSim = (name: string): boolean => !/^sim[-_]/.test(name);

describe("src/generated", () => {
  it("calls.json and scenarios.json match their contracts; one Scenario per kit scenario", () => {
    for (const c of calls) expect(CallManifestEntrySchema.safeParse(c).success, c.callId).toBe(true);
    const scenarios = read("src/generated/scenarios.json") as unknown[];
    const kitIds = readdirSync(join(REPO_ROOT, "data", "scenarios")).filter((f) => /^s\d{2}\.json$/.test(f)).map((f) => f.slice(0, 3));
    expect(scenarios.map((s) => ScenarioSchema.parse(s).id)).toEqual(kitIds);
  });

  it.skipIf(calls.length === 0)("exactly one featured entry: publishable, with its assets on disk", () => {
    const featured = calls.filter((c) => c.featured);
    expect(featured).toHaveLength(1);
    expect(featured[0]!.publishAudio).toBe(true);
    expect(featured[0]!.assets).not.toBeNull();
    expect(featured[0]!.scenarioId).toBe("s01");
  });

  it.skipIf(calls.length === 0)("the featured s01 take carries the hand-off label Express needs", () => {
    const f = calls.find((c) => c.featured)!;
    expect(f.handoff).not.toBeNull();
    expect(f.handoff!.acceptStartMs).not.toBeNull();
    expect(f.handoff!.acceptStartMs!).toBeGreaterThanOrEqual(f.handoff!.lineEndMs);
    expect(f.decisionPointMs).toBe(f.handoff!.lineStartMs);
  });

  it.skipIf(calls.length === 0)("every picker call has cached turns", () => {
    for (const c of calls.filter((x) => x.picker !== "hidden")) {
      expect(existsSync(join(REPO_ROOT, "public", "data", "cached-turns", `${c.callId}.json`)), c.callId).toBe(true);
    }
  });

  it.skipIf(calls.length === 0)("every take's hand-off label agrees with its scenario's customer_response", () => {
    for (const c of calls) {
      const scenario = JSON.parse(readFileSync(join(REPO_ROOT, "data", "scenarios", `${c.scenarioId}.json`), "utf8")) as {
        handoff: { customer_response: string };
      };
      const declines = scenario.handoff.customer_response !== "accepts";
      expect(c.handoff!.declined, c.callId).toBe(declines);
      // A declined call has no acceptance to point at; an accepted one must have one, after the line.
      if (declines) {
        expect(c.handoff!.acceptStartMs, c.callId).toBeNull();
        expect(c.handoff!.acceptEndMs, c.callId).toBeNull();
      } else {
        expect(c.handoff!.acceptStartMs, c.callId).not.toBeNull();
      }
    }
  });

  it.skipIf(calls.length === 0)("the picker covers both hand-off outcomes: at least one accepted and one declined take", () => {
    expect(calls.some((c) => c.handoff?.declined === false)).toBe(true);
    expect(calls.some((c) => c.handoff?.declined === true)).toBe(true);
  });

  it("call-provenance.json covers every call, and no simulated take is counted as a recorded one", () => {
    expect(CallProvenanceFileSchema.safeParse(provenance).success).toBe(true);
    expect(Object.keys(provenance).sort()).toEqual(calls.map((c) => c.callId).sort());
    for (const c of calls) {
      const p = provenance[c.callId]!;
      expect(p.detail.length).toBeGreaterThan(0);
      if (p.humanHalf !== "simulated") continue;
      expect(p.scriptModel, c.callId).not.toBeNull();
      expect(p.voices, c.callId).not.toBeNull();
      // §7.6 / JP-I3: recorded metrics come from recorded takes only.
      expect(c.inEval, `${c.callId} is simulated and must not be in the eval set`).toBe(false);
    }
  });

  it("public/calls holds exactly the publishable takes' assets; cached turns only for published calls", () => {
    const published = new Set(calls.filter((c) => c.publishAudio).map((c) => c.callId));
    for (const c of calls) {
      if (!c.publishAudio) expect(c.assets).toBeNull();
      else for (const url of Object.values(c.assets!)) expect(existsSync(join(REPO_ROOT, "public", url)), url).toBe(true);
    }
    const dir = join(REPO_ROOT, "public", "calls");
    expect(existsSync(dir) ? readdirSync(dir).filter(notSim).sort() : []).toEqual([...published].sort());
    const ct = join(REPO_ROOT, "public", "data", "cached-turns");
    for (const f of (existsSync(ct) ? readdirSync(ct) : []).filter(notSim)) {
      expect(published.has(f.replace(/\.json$/, ""))).toBe(true);
      expect(CachedTurnsFileSchema.safeParse(JSON.parse(readFileSync(join(ct, f), "utf8"))).success).toBe(true);
    }
  });
});
