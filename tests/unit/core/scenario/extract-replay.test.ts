import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { deriveCaseState } from "../../../../src/core/case";
import type { NewFactEvent } from "../../../../src/core/contracts/case";
import { ExtractCacheFileSchema, VerifierCacheFileSchema } from "../../../../src/core/contracts/eval";
import type { ExtractTurnInput, ExtractTurnOutput } from "../../../../src/core/contracts/extract";
import { cachedTurnIdOf, type TurnInput } from "../../../../src/core/contracts/turns";
import { nextVerifyStart, replayExtraction, replayVerifier, type DeriveFn } from "../../../../src/core/scenario/extract-replay";
import { normalizeScenario } from "../../../../src/core/scenario/normalize";
import { loadScenarios, REPO_ROOT } from "../../../../scripts/calls/lib/kit-io";
import { extractorArtefactsOf } from "../../../../scripts/eval/extract";

const s01 = normalizeScenario(loadScenarios(join(REPO_ROOT, "data", "scenarios")).find((k) => k.id === "s01")!, null);

const t = (ch: "rep" | "customer", order: number, text: string, endMs: number): TurnInput => ({
  caseId: "eval-c", turnId: cachedTurnIdOf(ch, order), channel: ch, text, startMs: endMs - 800, endMs, words: [], source: "stt_cache", recvMs: endMs + 300, cut: false, late: false,
});
const TURNS = [t("rep", 0, "what's her name", 2000), t("customer", 0, "Maya Raman", 4000), t("customer", 1, "born March 14 2009", 7000)];

function fakeExtractor(o: { failFirst?: string } = {}) {
  const seen: { turnId: string; knownName: string | null; recent: number }[] = [];
  let failed = false;
  return {
    seen,
    async extractTurn(i: ExtractTurnInput): Promise<ExtractTurnOutput & { failedTurnIds: string[]; usd: number }> {
      const turn = i.newTurns[0]!;
      seen.push({ turnId: turn.turnId, knownName: i.state.fields.driver_full_name.value, recent: i.recent.length });
      if (o.failFirst === turn.turnId && !failed) {
        failed = true;
        return { events: [], ms: 900, usage: { input: 10, output: 0 }, model: "gpt-6-luna", extractorVersion: "vX", cached: false, failedTurnIds: [turn.turnId], usd: 0.00001 };
      }
      const ev = (field: "driver_full_name" | "driver_dob", valueRaw: string, valueNorm: string, index: number): NewFactEvent =>
        ({
          id: `${i.caseId}:${turn.turnId}:${index}`, caseId: i.caseId, turnId: turn.turnId, kind: "stated", field, valueRaw, valueNorm, party: "customer", acknowledgesTurnId: null,
          confidence: "high", evidence: { quote: turn.text, startMs: turn.startMs, endMs: turn.endMs, channel: turn.channel, turnId: turn.turnId, source: "stt_cache" },
          turnEndMs: turn.endMs, late: false, cut: false, extractor: "luna",
        }) satisfies NewFactEvent;
      const events = turn.turnId === "customer-c0" ? [ev("driver_full_name", "Maya Raman", "maya raman", 0)] : turn.turnId === "customer-c1" ? [ev("driver_dob", "March 14 2009", "2009-03-14", 0)] : [];
      return { events, ms: 1200, usage: { input: 100, output: 20 }, model: "gpt-6-luna", extractorVersion: "vX", cached: false, failedTurnIds: [], usd: 0.0001 };
    },
  };
}

describe("extraction replay", () => {
  it("sequential single-turn calls; each sees the state derived from the events so far; file keyed by cached turn id", async () => {
    const ex = fakeExtractor();
    const r = await replayExtraction(
      { callId: "c", version: "v3", variant: "pc_ctx", caseId: "eval-c", policy: s01.policy, callDate: s01.callDate, turns: TURNS, createdAt: "2026-09-25T00:00:00Z" },
      { extractor: ex, derive: deriveCaseState as unknown as DeriveFn },
    );
    expect(ex.seen).toEqual([
      { turnId: "rep-c0", knownName: null, recent: 0 },
      { turnId: "customer-c0", knownName: null, recent: 1 },
      { turnId: "customer-c1", knownName: "maya raman", recent: 2 },
    ]);
    const file = ExtractCacheFileSchema.parse(r.file);
    expect(file.turns.map((x) => [x.turnId, x.events.length, x.extractMs])).toEqual([["rep-c0", 0, 1200], ["customer-c0", 1, 1200], ["customer-c1", 1, 1200]]);
    expect(file.turns[1]!.events[0]).not.toHaveProperty("id");
    expect(file.turns[1]!.events[0]).not.toHaveProperty("caseId");
    expect([file.extractorVersion, file.model]).toEqual(["vX", "gpt-6-luna"]);
    expect(r.usage).toEqual({ input: 300, output: 60 });
  });

  it("retries a failed turn once; a turn that still fails is recorded with no events", async () => {
    const ex = fakeExtractor({ failFirst: "customer-c0" });
    const r = await replayExtraction(
      { callId: "c", version: "v3", variant: "pc_ctx", caseId: "eval-c", policy: s01.policy, callDate: s01.callDate, turns: TURNS, createdAt: "t" },
      { extractor: ex, derive: deriveCaseState as unknown as DeriveFn, retries: 1 },
    );
    expect(ex.seen.map((s) => s.turnId)).toEqual(["rep-c0", "customer-c0", "customer-c0", "customer-c1"]);
    expect(r.failedTurnIds).toEqual([]);
    expect(r.file.turns[1]!.events).toHaveLength(1);
  });

  it("per-version extractor artefacts: v1 = values-only prompt, v2/v3 = V3", () => {
    expect(extractorArtefactsOf("v1").version).not.toBe(extractorArtefactsOf("v3").version);
    expect(extractorArtefactsOf("v2").version).toBe(extractorArtefactsOf("v3").version);
  });

  it("verifier: 30 s cadence over finals received so far, runs never overlap, no rerun without new turns", async () => {
    const turns = [t("rep", 0, "a", 5000), t("customer", 0, "b", 20_000), t("customer", 1, "c", 70_000)];
    const calls: number[] = [];
    const r = await replayVerifier(
      { callId: "c", variant: "pc_ctx", caseId: "eval-c", policy: s01.policy, callDate: s01.callDate, turns, endMs: 120_000, createdAt: "t", model: "gpt-6-sol" },
      { verifier: { verifyCase: async (i) => (calls.push(i.turns.length), { uptoRecvMs: 0, fields: [], ms: 40_000, usd: 0.01 }) } },
    );
    expect(r.file.runs.map((x) => x.startMs)).toEqual([30_000, 90_000]);
    expect(calls).toEqual([2, 3]);
    expect(nextVerifyStart(30_000, 45_000)).toBe(90_000);
    expect(nextVerifyStart(30_000, 12_000)).toBe(60_000);
    expect(VerifierCacheFileSchema.safeParse(r.file).success).toBe(true);
  });
});
