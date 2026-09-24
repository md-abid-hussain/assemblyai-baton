/**
 * WP3 unit-test fixtures: the s01 dialog (tests/fixtures/extract/s01-dialog.json), turn builders, a deterministic
 * fake extractor (its patch = the fixture's `events`), a fake verifier and a case-service harness on a test DB.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CallManifestEntry } from "@/core/contracts/scenario";
import type { PolicyRecord } from "@/core/contracts/case";
import type { ExtractTurnInput, RawPatchEvent, VerifierResult } from "@/core/contracts/extract";
import type { Extractor, Verifier } from "@/core/contracts/services";
import type { TurnInput } from "@/core/contracts/turns";
import { MemoryCaseDataSource, type CaseDataSource } from "@/server/data";
import { policyFromKitScenario } from "@/server/data/kit-policy";
import type { CaseEngine } from "@/server/cases/engine";
import { stubEngine } from "@/server/cases/engine-stub";
import { ExtractService } from "@/server/cases/extract-service";
import { buildPrefill } from "@/server/cases/prefill";
import { PgCaseRepository } from "@/server/cases/repository";
import { VerifierRunner } from "@/server/cases/verifier-runner";
import type { ExtractTurnResult } from "@/server/openai/extractor";
import type { TestDb } from "./test-db";

export const ROOT = resolve(fileURLToPath(new URL("../../../../..", import.meta.url)));

export interface FixtureEvent extends Omit<RawPatchEvent, "turn_id" | "confidence"> { scored?: boolean; confidence?: RawPatchEvent["confidence"] }
export interface FixtureTurn { turnId: string; channel: "rep" | "customer"; startMs: number; endMs: number; text: string; events: FixtureEvent[] }
export interface DialogFixture { scenarioId: string; callDate: string; liveTurns: number; turns: FixtureTurn[] }

export const dialog: DialogFixture = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "extract", "s01-dialog.json"), "utf8")) as DialogFixture;

export function policyOf(scenarioId = "s01"): PolicyRecord {
  return policyFromKitScenario(JSON.parse(readFileSync(join(ROOT, "data", "scenarios", `${scenarioId}.json`), "utf8")));
}

/** Words spread evenly over [startMs, endMs] (enough for evidence alignment). */
export function turnOf(caseId: string, f: FixtureTurn, o: { source?: TurnInput["source"]; turnId?: string; late?: boolean; cut?: boolean; recvMs?: number } = {}): TurnInput {
  const toks = f.text.split(/\s+/).filter(Boolean);
  const span = (f.endMs - f.startMs) / Math.max(1, toks.length);
  return {
    caseId, turnId: o.turnId ?? f.turnId, channel: f.channel, text: f.text,
    words: toks.map((t, i) => ({ text: t, startMs: f.startMs + i * span, endMs: f.startMs + (i + 1) * span - 20, confidence: 0.95 })),
    startMs: f.startMs, endMs: f.endMs, recvMs: o.recvMs ?? f.endMs + 420.125, source: o.source ?? "stt_live", cut: o.cut ?? false, late: o.late ?? false,
  };
}

/** Cached-id twin of a fixture turn (`rep-3` → `rep-c3`, source stt_cache). */
export const cachedIdOf = (turnId: string): string => turnId.replace(/-(\d+)$/, "-c$1");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic luna stand-in: the patch of a turn is its fixture `events`, whatever the context. */
export class FakeExtractor implements Extractor {
  calls = 0;
  batchSizes: number[] = [];
  inputs: ExtractTurnInput[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  constructor(
    private readonly engine: CaseEngine,
    private readonly o: { latencyMs?: (turnIds: string[]) => number; failTurnIds?: Set<string> } = {},
  ) {}

  async extractTurn(input: ExtractTurnInput): Promise<ExtractTurnResult> {
    this.calls++;
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    this.batchSizes.push(input.newTurns.length);
    this.inputs.push(input);
    try {
      const ids = input.newTurns.map((t) => t.turnId);
      const ms = this.o.latencyMs?.(ids) ?? 5;
      await sleep(ms);
      const failed = ids.filter((id) => this.o.failTurnIds?.has(id));
      const covered = input.newTurns.filter((t) => !failed.includes(t.turnId));
      const events: RawPatchEvent[] = [];
      for (const t of covered) {
        const f = dialog.turns.find((x) => x.turnId === t.turnId || cachedIdOf(x.turnId) === t.turnId);
        for (const e of f?.events ?? []) {
          events.push({ turn_id: t.turnId, field: e.field, kind: e.kind, value: e.value, quote: e.quote, acknowledges_turn_id: e.acknowledges_turn_id, confidence: e.confidence ?? "high" });
        }
      }
      const out = this.engine.applyExtraction({ no_facts: events.length === 0, events }, covered, { caseId: input.caseId, policy: input.policy, callDate: input.callDate });
      return {
        events: out, ms, usage: { input: 100, output: 20 }, model: "fake-luna", extractorVersion: this.engine.extractor.version, cached: false,
        coveredTurnIds: covered.map((t) => t.turnId), failedTurnIds: failed, attempts: 1, usd: 0, error: failed.length ? { code: "E_OPENAI_TIMEOUT", message: "fake" } : null,
        noFacts: events.length === 0,
      };
    } finally {
      this.concurrent--;
    }
  }
}

export class FakeVerifier implements Verifier {
  calls = 0;
  concurrent = 0;
  maxConcurrent = 0;
  constructor(public result: (turns: TurnInput[]) => VerifierResult["fields"], public latencyMs = 5) {}
  async verifyCase(input: { caseId: string; turns: TurnInput[] }): Promise<VerifierResult & { ms: number; usd: number }> {
    this.calls++;
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      await sleep(this.latencyMs);
      return { uptoRecvMs: input.turns.reduce((m, t) => Math.max(m, t.recvMs), 0), fields: this.result(input.turns), ms: this.latencyMs, usd: 0.01 };
    } finally {
      this.concurrent--;
    }
  }
}

export function callEntry(callId = "s01_take1", o: Partial<CallManifestEntry> = {}): CallManifestEntry {
  return {
    callId, scenarioId: "s01", title: "Add Maya", source: "twilio8k", language: "en", durationMs: 120_000,
    format: { encoding: "pcm_mulaw", sampleRate: 8000 }, publishAudio: true, inEval: true, featured: true, picker: "main",
    decisionPointMs: 95_000, handoff: null, recordedAiBundle: null, customerTailPack: null,
    assets: { rep: `/calls/${callId}/rep.1234abcd.ulaw`, customer: `/calls/${callId}/customer.1234abcd.ulaw`, peaks: `/calls/${callId}/peaks.1234abcd.json` },
    ...o,
  };
}

export interface Harness {
  engine: CaseEngine;
  data: CaseDataSource;
  repo: PgCaseRepository;
  extractor: FakeExtractor;
  service: ExtractService;
  verifier: FakeVerifier;
  runner: VerifierRunner;
  deferred: Promise<unknown>[];
  clock: { t: number };
}

export function harness(t: TestDb, o: {
  data?: CaseDataSource; latencyMs?: (ids: string[]) => number; failTurnIds?: Set<string>;
  verifierFields?: (turns: TurnInput[]) => VerifierResult["fields"]; verifierLatencyMs?: number; withVerifier?: boolean;
} = {}): Harness {
  const engine = stubEngine;
  const data = o.data ?? new MemoryCaseDataSource({ policies: { s01: policyOf("s01") }, calls: [callEntry()] });
  const clock = { t: Date.parse("2026-09-25T12:00:00Z") };
  const repo = new PgCaseRepository({
    db: t.db, engine, policyOf: (id) => data.getPolicy(id),
    prefillPlan: (i) => buildPrefill(data, { ...i, extractorVersion: engine.extractor.version }),
    now: () => clock.t,
  });
  const extractor = new FakeExtractor(engine, { ...(o.latencyMs ? { latencyMs: o.latencyMs } : {}), ...(o.failTurnIds ? { failTurnIds: o.failTurnIds } : {}) });
  const verifier = new FakeVerifier(o.verifierFields ?? (() => []), o.verifierLatencyMs ?? 5);
  const runner = new VerifierRunner({ repo, engine, verifier, now: () => clock.t });
  const deferred: Promise<unknown>[] = [];
  const service = new ExtractService({
    repo, engine, extractor, data,
    defer: (fn) => void deferred.push(fn()),
    ...(o.withVerifier ? { maybeRunVerifier: (caseId: string) => runner.maybeRun(caseId) } : {}),
    now: () => clock.t,
  });
  return { engine, data, repo, extractor, service, verifier, runner, deferred, clock };
}

export async function newCase(h: Harness, o: { callId?: string | null; prefillUntilMs?: number } = {}): Promise<string> {
  const c = await h.repo.create({
    mode: "watch", callId: o.callId === undefined ? "s01_take1" : o.callId, scenarioId: "s01", visitorId: "v_test", ipKey: "ip_test",
    ...(o.prefillUntilMs !== undefined ? { prefillUntilMs: o.prefillUntilMs } : {}),
  });
  return c.caseId;
}

/** Deterministic shuffle (mulberry32). */
export function shuffled<T>(xs: readonly T[], seed = 42): T[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export { sleep };
