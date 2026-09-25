/**
 * CaseSync (TASKS §2, WP4 acceptance 5): in-order POST /api/extract, dedupe, retries, newest-version state, and
 * `drain(2000)` under a slow extract stub.
 */
import { describe, expect, it } from "vitest";
import { HttpCaseSync } from "../../../../src/client/case/case-sync";
import type { ExtractResponse } from "../../../../src/core/contracts/api";
import type { TurnInput } from "../../../../src/core/contracts/turns";
import { caseState, factEvent, turn as turnFixture } from "../../contracts/fixtures";
import { Sink } from "../stt/fakes";

const turn = (id: string, ch: "rep" | "customer" = "rep"): TurnInput => ({ ...turnFixture, turnId: id, channel: ch });

/** A fake /api/extract: `delayMs(turnId)` per call, records arrival order and max concurrency. */
function extractStub(o: { delayMs?: (id: string) => number; status?: (id: string, attempt: number) => number } = {}) {
  const order: string[] = [];
  const attempts = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  let version = 7;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { turn: TurnInput };
    const id = body.turn.turnId;
    const a = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, a);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(id);
    await new Promise((r) => setTimeout(r, o.delayMs?.(id) ?? 1));
    inFlight--;
    const status = o.status?.(id, a) ?? 200;
    if (status !== 200) return new Response(JSON.stringify({ code: "E_INTERNAL", message: "x" }), { status });
    const res: ExtractResponse = { state: { ...caseState(), version: ++version }, events: [{ ...factEvent, turnId: id }], extractMs: 5 };
    return new Response(JSON.stringify(res), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, order, attempts, maxInFlight: () => maxInFlight };
}

describe("HttpCaseSync", () => {
  it("posts in enqueue order, one at a time, with the case token; dedupes turn ids; newest state wins", async () => {
    const stub = extractStub({ delayMs: (id) => (id === "rep-0" ? 60 : 5) });
    const sink = new Sink();
    let lastHeaders: Record<string, string> = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      lastHeaders = init.headers as Record<string, string>;
      return stub.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const cs = new HttpCaseSync({ caseToken: "CT", visitorToken: "VT", fetchImpl, sink, now: () => 1 });
    const states: number[] = [];
    cs.onState((s) => states.push(s.version));
    cs.enqueue(turn("rep-0"));
    cs.enqueue(turn("customer-0", "customer"));
    cs.enqueue(turn("rep-0"));
    cs.enqueue(turn("rep-1"));
    const d = await cs.drain(2000);
    expect(stub.order).toEqual(["rep-0", "customer-0", "rep-1"]);
    expect(stub.maxInFlight()).toBe(1);
    expect(d.completedTurnIds).toEqual(["rep-0", "customer-0", "rep-1"]);
    expect(d.pendingTurnIds).toEqual([]);
    expect(lastHeaders.authorization).toBe("Bearer CT");
    expect(lastHeaders["x-baton-visitor"]).toBe("VT");
    expect(states).toEqual([8, 9, 10]);
    expect(cs.state?.version).toBe(10);
    expect(sink.of("case.facts")).toHaveLength(3);
    expect(sink.of("case.state")).toHaveLength(3);
  });

  it("drain(2000) under a slow extract stub: returns at the timeout with the in-flight/queued turns pending", async () => {
    const stub = extractStub({ delayMs: (id) => (id === "rep-2" ? 5000 : 300) });
    const cs = new HttpCaseSync({ caseToken: "CT", fetchImpl: stub.fetchImpl });
    for (const id of ["rep-0", "customer-0", "rep-1", "rep-2", "customer-1"]) cs.enqueue(turn(id, id.startsWith("rep") ? "rep" : "customer"));
    const t0 = performance.now();
    const d = await cs.drain(2000);
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1990);
    expect(took).toBeLessThan(2300);
    expect(d.waitedMs).toBeGreaterThanOrEqual(1990);
    expect(d.completedTurnIds).toEqual(["rep-0", "customer-0", "rep-1"]);
    expect(d.pendingTurnIds).toEqual(["rep-2", "customer-1"]);
  }, 10_000);

  it("drain returns immediately when nothing is pending, and only waits for turns enqueued before it", async () => {
    const stub = extractStub({ delayMs: () => 50 });
    const cs = new HttpCaseSync({ caseToken: "CT", fetchImpl: stub.fetchImpl });
    const d0 = await cs.drain(2000);
    expect(d0.waitedMs).toBeLessThan(20);
    cs.enqueue(turn("rep-0"));
    const p = cs.drain(2000);
    cs.enqueue(turn("rep-1")); // after drain started: not awaited
    const d = await p;
    expect(d.completedTurnIds).toContain("rep-0");
    expect(d.waitedMs).toBeLessThan(95);
  });

  it("retries 429/5xx with backoff, gives up on 4xx, emits an error event", async () => {
    const stub = extractStub({ status: (id, a) => (id === "rep-0" && a < 3 ? 503 : id === "rep-1" ? 403 : 200) });
    const sink = new Sink();
    const cs = new HttpCaseSync({ caseToken: "CT", fetchImpl: stub.fetchImpl, sink, retryDelaysMs: [1, 1, 1], sleep: async () => undefined });
    cs.enqueue(turn("rep-0"));
    cs.enqueue(turn("rep-1"));
    cs.enqueue(turn("rep-2"));
    const d = await cs.drain(2000);
    expect(stub.attempts.get("rep-0")).toBe(3);
    expect(stub.attempts.get("rep-1")).toBe(1);
    expect(d.completedTurnIds).toEqual(["rep-0", "rep-2"]);
    expect(cs.outcomes.find((o) => o.turnId === "rep-1")!.status).toBe("failed");
    expect(sink.of("error")[0]!.code).toBe("E_CASE_STATE");
  });

  it("applyState ignores older versions", () => {
    const cs = new HttpCaseSync({ caseToken: "CT", fetchImpl: extractStub().fetchImpl, initialState: { ...caseState(), version: 5 } });
    cs.applyState({ ...caseState(), version: 4 });
    expect(cs.state!.version).toBe(5);
    cs.applyState({ ...caseState(), version: 6 });
    expect(cs.state!.version).toBe(6);
  });
});
