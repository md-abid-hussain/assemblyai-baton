/**
 * The committed build outputs (src/generated/*.json, public/calls, public/data/cached-turns) are consistent.
 * TASKS WP9 acceptance 1: exactly one featured entry that is publishable and has its assets on disk. Until the first
 * real takes are built the manifest is empty and that check is skipped (the synthetic e2e test covers the rule).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CachedTurnsFileSchema } from "../../../../src/core/contracts/eval";
import { CallManifestEntrySchema, ScenarioSchema, type CallManifestEntry } from "../../../../src/core/contracts/scenario";
import { REPO_ROOT } from "../../../../scripts/calls/lib/kit-io";

const read = (rel: string): unknown => JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
const calls = read("src/generated/calls.json") as CallManifestEntry[];

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
  });

  it("public/calls holds exactly the publishable takes' assets; cached turns only for published calls", () => {
    const published = new Set(calls.filter((c) => c.publishAudio).map((c) => c.callId));
    for (const c of calls) {
      if (!c.publishAudio) expect(c.assets).toBeNull();
      else for (const url of Object.values(c.assets!)) expect(existsSync(join(REPO_ROOT, "public", url)), url).toBe(true);
    }
    const dir = join(REPO_ROOT, "public", "calls");
    expect(existsSync(dir) ? readdirSync(dir).sort() : []).toEqual([...published].sort());
    const ct = join(REPO_ROOT, "public", "data", "cached-turns");
    for (const f of existsSync(ct) ? readdirSync(ct) : []) {
      expect(published.has(f.replace(/\.json$/, ""))).toBe(true);
      expect(CachedTurnsFileSchema.safeParse(JSON.parse(readFileSync(join(ct, f), "utf8"))).success).toBe(true);
    }
  });
});
