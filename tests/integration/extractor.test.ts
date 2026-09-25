/**
 * Live extractor integration (TASKS WP3 acceptance 1; DESIGN §5.3, §9.2). RUN_LIVE=1 only; OpenAI luna, no
 * AssemblyAI ($0 AAI). Cost ≈ $0.0003 per luna call.
 *
 * Local mode (default): the 12-turn s01 fixture (tests/fixtures/extract/s01-dialog.json) posted turn by turn, in call
 * order as CaseSync does, through the production F1 path (ExtractService + OpenAIExtractor + Postgres), then
 * - accuracy: the 10 labelled events (scored:true) must be found in the extractor's output for their turn (≥ 9/10);
 * - latency: `extractMs` per luna call over WP3_PASSES passes (default 3) → p50/p95, printed as one JSON line.
 *
 * Remote mode (EXTRACT_BASE_URL=https://<app>.zerops.app): the same turns posted to the DEPLOYED /api/cases +
 * /api/extract, to measure p50/p95 `extractMs` from the Zerops host (the D1 measurement for WP9b and DRAIN_MAX_MS).
 *
 *   npx tsx scripts/lib/run-with-env.mjs RUN_LIVE=1 -- vitest run tests/integration/extractor.test.ts
 *   EXTRACT_BASE_URL=https://… (same command)
 */
import { appendFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CreateCaseResponseSchema, ExtractResponseSchema } from "@/core/contracts/api";
import type { FactEvent } from "@/core/contracts/case";
import { MemoryCaseDataSource } from "@/server/data";
import { stubEngine } from "@/server/cases/engine-stub";
import type { CaseEngine } from "@/server/cases/engine";
import { ExtractService } from "@/server/cases/extract-service";
import { PgCaseRepository } from "@/server/cases/repository";
import { createOpenAI } from "@/server/openai/client";
import { OpenAIExtractor } from "@/server/openai/extractor";
import { OpenAIVerifier } from "@/server/openai/verifier";
import { loadEnv } from "../../scripts/lib/load-env";
import { dialog, policyOf, turnOf, type FixtureEvent, type FixtureTurn } from "../unit/server/cases/helpers/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "../unit/server/cases/helpers/test-db";

loadEnv();
const LIVE = process.env.RUN_LIVE === "1" && !!process.env.OPENAI_API_KEY;
const BASE = process.env.EXTRACT_BASE_URL?.replace(/\/+$/, "") ?? "";
const PASSES = Math.max(1, Number(process.env.WP3_PASSES ?? 3));
const liveTurns: FixtureTurn[] = dialog.turns.slice(0, dialog.liveTurns);

// ---------------------------------------------------------------------------------------------- scoring

const MONEY = new Set(["premium_new_monthly_usd", "premium_change_monthly_usd", "amount_due_today_usd"]);
function scoreValue(field: string, v: string | null): string | null {
  if (v === null) return null;
  const s = v.trim().toLowerCase();
  if (MONEY.has(field)) {
    const n = Number(s.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n.toFixed(2) : s;
  }
  if (field === "license_state") return s.replace(/^ohio$/, "oh");
  return s.replace(/\s+/g, " ");
}

interface Scored { turnId: string; field: string; kind: string; value: string | null; hit: boolean; got: string[] }

function scoreTurn(f: FixtureTurn, events: Pick<FactEvent, "field" | "kind" | "valueRaw">[]): Scored[] {
  return f.events.filter((e: FixtureEvent) => e.scored).map((e) => {
    const want = scoreValue(e.field, e.value);
    const hit = events.some((x) => x.field === e.field && x.kind === e.kind && scoreValue(x.field, x.valueRaw) === want);
    return { turnId: f.turnId, field: e.field, kind: e.kind, value: e.value, hit, got: events.filter((x) => x.field === e.field).map((x) => `${x.kind}:${x.valueRaw}`) };
  });
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? NaN;
};
/** One JSON line per run: stdout, plus WP3_RESULTS_FILE when set (vitest may buffer stdout). */
function report(out: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...out });
  console.log(`[wp3-live] ${line}`);
  if (process.env.WP3_RESULTS_FILE) appendFileSync(process.env.WP3_RESULTS_FILE, `${line}
`);
}
const summary = (xs: number[]) => ({ n: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), min: Math.round(Math.min(...xs)), max: Math.round(Math.max(...xs)) });

// ---------------------------------------------------------------------------------------------- local

describe.skipIf(!LIVE || !!BASE || !HAS_DB)("extractor, live luna, local F1 path", () => {
  let t: TestDb;
  const engine: CaseEngine = stubEngine;
  beforeAll(async () => {
    t = await createTestDb("wp3_live");
  });
  afterAll(async () => {
    await t?.drop();
  });

  it(`12-turn fixture: ≥ 9/10 labelled events; extractMs p50/p95 over ${PASSES} pass(es)`, async () => {
    const data = new MemoryCaseDataSource({ policies: { s01: policyOf("s01") } });
    const repo = new PgCaseRepository({ db: t.db, engine, policyOf: (id) => data.getPolicy(id) });
    const extractor = new OpenAIExtractor({ client: createOpenAI(process.env.OPENAI_API_KEY!, { maxRetries: 0 }), engine });
    let usd = 0;
    let failed = 0;
    const svc = new ExtractService({ repo, engine, extractor, data, recordSpend: async (e) => void (usd += e.usd) });
    const ms: number[] = [];
    const passes: { hits: number; total: number; misses: Scored[] }[] = [];
    for (let p = 0; p < PASSES; p++) {
      const { caseId } = await repo.create({ mode: "synthetic", callId: null, scenarioId: "s01", visitorId: "v_live", ipKey: "ip_live" });
      const scored: Scored[] = [];
      for (const f of liveTurns) {
        const r = await svc.handle(turnOf(caseId, f));
        if (r.status === "failed") failed++;
        ms.push(r.extractMs);
        scored.push(...scoreTurn(f, r.events));
      }
      passes.push({ hits: scored.filter((s) => s.hit).length, total: scored.length, misses: scored.filter((s) => !s.hit) });
    }
    const out = {
      mode: "local", host: process.env.COMPUTERNAME ? "windows-laptop" : "local", engine: engine.impl, extractorVersion: engine.extractor.version,
      passes: passes.map((p) => `${p.hits}/${p.total}`), misses: passes.flatMap((p) => p.misses), extractMs: summary(ms), llmCalls: svc.llmCalls, failed,
      usd: Number(usd.toFixed(5)),
    };
    report(out);
    expect(passes[0]!.total).toBe(10);
    for (const p of passes) expect(p.hits).toBeGreaterThanOrEqual(9);
    expect(failed).toBe(0);
  }, 300_000);

  it("batched NEW TURNS (3 per call, §5.3): same labels, per-call latency", async () => {
    const extractor = new OpenAIExtractor({ client: createOpenAI(process.env.OPENAI_API_KEY!, { maxRetries: 0 }), engine });
    const policy = policyOf("s01");
    const ms: number[] = [];
    const scored: Scored[] = [];
    let usd = 0;
    for (let i = 0; i < liveTurns.length; i += 3) {
      const batch = liveTurns.slice(i, i + 3);
      const turns = batch.map((f) => turnOf("case_batch", f));
      const recent = liveTurns.slice(Math.max(0, i - 6), i).map((f) => turnOf("case_batch", f));
      const r = await extractor.extractTurn({ caseId: "case_batch", policy, callDate: policy.callDate, state: engine.emptyCaseState("case_batch"), recent, newTurns: turns });
      ms.push(r.ms);
      usd += r.usd;
      expect(r.failedTurnIds).toEqual([]);
      for (const f of batch) scored.push(...scoreTurn(f, r.events.filter((e) => e.turnId === f.turnId)));
    }
    report({ mode: "local-batched", engine: engine.impl, batches: ms.length, labels: `${scored.filter((s) => s.hit).length}/${scored.length}`, misses: scored.filter((s) => !s.hit), extractMs: summary(ms), usd: Number(usd.toFixed(5)) });
    // A measurement, not the acceptance: batches found 7-9/10 (vs 10/10 single-turn), which is why batching is backlog-only.
    expect(scored.filter((s) => s.hit).length).toBeGreaterThanOrEqual(7);
  }, 300_000);

  it("sol verifier: one background run over the 20-turn call (F2 timing and cost)", async () => {
    const verifier = new OpenAIVerifier({ client: createOpenAI(process.env.OPENAI_API_KEY!, { maxRetries: 0 }) });
    const policy = policyOf("s01");
    const turns = dialog.turns.map((f) => turnOf("case_ver", f));
    const r = await verifier.verifyCase({ caseId: "case_ver", policy, callDate: policy.callDate, turns });
    const by = new Map(r.fields.map((f) => [f.field, f]));
    report({ mode: "verifier", ms: Math.round(r.ms), usd: Number(r.usd.toFixed(5)), fields: r.fields.map((f) => `${f.field}=${f.value}:${f.support}`) });
    expect(by.get("driver_dob")?.value).toBe("2009-03-14");
    expect(by.get("vehicle_assignment")?.value).toBe("veh1");
    expect(r.uptoRecvMs).toBe(Math.max(...turns.map((t) => t.recvMs)));
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------- remote (deployed)

describe.skipIf(!(process.env.RUN_LIVE === "1") || !BASE)("extractor, deployed /api/extract (Zerops host measurement)", () => {
  it(`posts the fixture turns to ${BASE || "(unset)"} and reports server extractMs p50/p95`, async () => {
    const server: number[] = [];
    const rtt: number[] = [];
    const passes: string[] = [];
    for (let p = 0; p < PASSES; p++) {
      const cr = await fetch(`${BASE}/api/cases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "live" }) });
      expect(cr.status).toBe(200);
      const c = CreateCaseResponseSchema.parse(await cr.json());
      const headers = { "content-type": "application/json", authorization: `Bearer ${c.caseToken}`, ...(c.visitorToken ? { "x-baton-visitor": c.visitorToken } : {}) };
      const scored: Scored[] = [];
      for (const f of liveTurns) {
        const t0 = performance.now();
        const r = await fetch(`${BASE}/api/extract`, { method: "POST", headers, body: JSON.stringify({ turn: turnOf(c.caseId, f) }) });
        rtt.push(performance.now() - t0);
        expect(r.status).toBe(200);
        const body = ExtractResponseSchema.parse(await r.json());
        server.push(body.extractMs);
        scored.push(...scoreTurn(f, body.events));
      }
      passes.push(`${scored.filter((s) => s.hit).length}/${scored.length}`);
    }
    report({ mode: "remote", base: BASE, passes, extractMs: summary(server), roundTripMs: summary(rtt) });
  }, 300_000);
});
