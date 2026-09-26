/**
 * Express prefill and cached events (TASKS WP3 acceptance 4; DESIGN §5.1.6, §5.1.10, §6.3 version pinning).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CaseState } from "@/core/contracts/case";
import type { CachedTurnsFile, ExtractCacheFile } from "@/core/contracts/eval";
import { MemoryCaseDataSource, cachedFinalTurns } from "@/server/data";
import { stubEngine } from "@/server/cases/engine-stub";
import { cachedIdOf, callEntry, dialog, harness, newCase, policyOf, turnOf } from "./helpers/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "./helpers/test-db";

const CALL = "s01_take1";
const comparable = (s: CaseState) => ({ fields: s.fields, readiness: s.readiness, conflicts: s.conflicts, callClockMs: s.callClockMs });

function cachedFiles(o: { extractorVersion?: string; drop?: string[] } = {}): { turns: CachedTurnsFile; cache: ExtractCacheFile } {
  const policy = policyOf("s01");
  const channels: CachedTurnsFile["channels"] = { rep: [], customer: [] };
  const entries: ExtractCacheFile["turns"] = [];
  for (const f of dialog.turns) {
    const order = Number(f.turnId.split("-")[1]);
    const t = turnOf("X", f, { source: "stt_cache", turnId: cachedIdOf(f.turnId) });
    const words = t.words.map((w) => ({ text: w.text, start: w.startMs, end: w.endMs, confidence: w.confidence, word_is_final: true }));
    // an unformatted final first, then the formatted one (the last end-of-turn message of a turn_order wins)
    channels[f.channel].push({ recvMs: t.recvMs - 200, message: { type: "Turn", turn_order: order, end_of_turn: false, turn_is_formatted: false, transcript: f.text.toLowerCase(), words } });
    channels[f.channel].push({ recvMs: t.recvMs, message: { type: "Turn", turn_order: order, end_of_turn: true, turn_is_formatted: true, transcript: f.text, words } });
    if (o.drop?.includes(t.turnId)) continue;
    const raw = { no_facts: false, events: f.events.map((e) => ({ turn_id: t.turnId, field: e.field, kind: e.kind, value: e.value, quote: e.quote, acknowledges_turn_id: e.acknowledges_turn_id, confidence: e.confidence ?? ("high" as const) })) };
    const events = stubEngine.applyExtraction(raw, [t], { caseId: "X", policy }).map(({ id: _i, caseId: _c, ...rest }) => rest);
    entries.push({ turnId: t.turnId, channel: f.channel, recvMs: t.recvMs, endMs: t.endMs, extractMs: 1234, events });
  }
  return {
    turns: { callId: CALL, variant: "pc_ctx", transcribedAt: "2026-09-26", channels },
    cache: { callId: CALL, version: "v3", variant: "pc_ctx", extractorVersion: o.extractorVersion ?? stubEngine.extractor.version, model: "gpt-6-luna", createdAt: "2026-09-26T00:00:00Z", turns: entries },
  };
}

function source(o: Parameters<typeof cachedFiles>[0] = {}) {
  const f = cachedFiles(o);
  return new MemoryCaseDataSource({ policies: { s01: policyOf("s01") }, calls: [callEntry(CALL)], cachedTurns: { [CALL]: f.turns }, extractCaches: { [CALL]: f.cache } });
}

describe.skipIf(!HAS_DB)("Express prefill and cached events", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("wp3_prefill");
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("cachedFinalTurns keeps finals only, with cached ids, source stt_cache and word timings", () => {
    const f = cachedFiles();
    const turns = cachedFinalTurns(f.turns, "case1");
    expect(turns).toHaveLength(dialog.turns.length);
    expect(turns[0]).toMatchObject({ turnId: "rep-c0", source: "stt_cache", channel: "rep", text: dialog.turns[0]!.text });
    expect(turns.every((x, i) => i === 0 || x.recvMs >= turns[i - 1]!.recvMs)).toBe(true);
  });

  it("acceptance 4: prefill makes 0 OpenAI calls and equals the live-replayed state", async () => {
    const until = 64_500; // after customer-4 (ends 64200), before rep-5
    const hp = harness(t, { data: source() });
    const prefilled = await newCase(hp, { callId: CALL, prefillUntilMs: until });
    expect(hp.extractor.calls).toBe(0);
    const a = (await hp.repo.loadRow(prefilled))!;
    const aTurns = await hp.repo.listTurns(prefilled);
    expect(aTurns.map((x) => x.turnId)).toEqual(dialog.turns.filter((f) => f.endMs <= until).map((f) => cachedIdOf(f.turnId)));
    expect(aTurns.every((x) => x.extractStatus === "done" && x.source === "stt_cache")).toBe(true);
    expect(a.state.fields.driver_dob?.status).toBe("VERIFIED");

    // the same cached finals replayed one by one through /api/extract's service (source stt_cache → cached events)
    const hr = harness(t, { data: source() });
    const replayed = await newCase(hr, { callId: CALL });
    const file = cachedFiles().turns;
    for (const turn of cachedFinalTurns(file, replayed).filter((x) => x.endMs <= until)) {
      const r = await hr.service.handle(turn);
      expect(r.extractMs).toBe(0);
    }
    expect(hr.extractor.calls).toBe(0);
    const b = (await hr.repo.loadRow(replayed))!;
    expect(comparable(a.state)).toEqual(comparable(b.state));
    const strip = (id: string, caseId: string) => id.replace(caseId, "");
    const fa = (await hp.repo.listFacts(prefilled)).map((e) => ({ ...e, id: strip(e.id, prefilled), caseId: "", seq: 0 }));
    const fb = (await hr.repo.listFacts(replayed)).map((e) => ({ ...e, id: strip(e.id, replayed), caseId: "", seq: 0 }));
    expect(fa).toEqual(fb);
  });

  it("a cached turn missing from the cache falls back to luna; a version mismatch is never served", async () => {
    const h1 = harness(t, { data: source({ drop: ["customer-c1"] }) });
    const c1 = await newCase(h1, { callId: CALL });
    const turns = cachedFinalTurns(cachedFiles().turns, c1);
    await h1.service.handle(turns.find((x) => x.turnId === "customer-c0")!);
    expect(h1.extractor.calls).toBe(0);
    await h1.service.handle(turns.find((x) => x.turnId === "customer-c1")!);
    expect(h1.extractor.calls).toBe(1);

    const h2 = harness(t, { data: source({ extractorVersion: "000000000000" }) });
    const c2 = await newCase(h2, { callId: CALL, prefillUntilMs: 30_000 });
    expect(h2.extractor.calls).toBe(0);
    const t2 = await h2.repo.listTurns(c2);
    expect(t2.length).toBeGreaterThan(0);
    expect(t2.every((x) => x.extractStatus === "skipped")).toBe(true); // stored, not extracted, no LLM in a prefill
    expect(await h2.repo.listFacts(c2)).toEqual([]);
    await h2.service.handle(cachedFinalTurns(cachedFiles().turns, c2).find((x) => x.turnId === "rep-c5")!);
    expect(h2.extractor.calls).toBe(1);
  });
});
