/**
 * The luna extractor's call parameters, budget and retry rule (DESIGN §5.3), against a fake OpenAI client ($0).
 */
import type OpenAI from "openai";
import { APIConnectionTimeoutError, RateLimitError } from "openai";
import { describe, expect, it } from "vitest";

import { BatonError } from "@/core/contracts/errors";
import type { ExtractTurnInput } from "@/core/contracts/extract";
import { stubEngine } from "@/server/cases/engine-stub";
import { classify, extractTimeoutMs, OpenAIExtractor, sanitizePatch } from "@/server/openai/extractor";
import { buildVerifierInput, OpenAIVerifier } from "@/server/openai/verifier";
import { dialog, policyOf, turnOf } from "./helpers/fixtures";

type Body = Record<string, unknown> & { input: string; text: { format: Record<string, unknown> } };
type Step = (body: Body) => unknown;

function fakeClient(steps: Step[]) {
  const calls: { body: Body; opts: Record<string, unknown> | undefined }[] = [];
  const client = {
    responses: {
      create: async (body: Body, opts?: Record<string, unknown>) => {
        calls.push({ body, opts });
        const step = steps[calls.length - 1];
        if (!step) throw new Error("unexpected call");
        const r = step(body);
        if (r instanceof Error) throw r;
        return r;
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

const ok = (patch: unknown, status = "completed") => ({
  status, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(patch) }] }], output_text: JSON.stringify(patch),
  incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
  usage: { input_tokens: 1800, output_tokens: 120, output_tokens_details: { reasoning_tokens: 0 }, input_tokens_details: { cached_tokens: 0 } },
});

const patchFor = (turnIds: string[]) => ({
  no_facts: false,
  events: turnIds.flatMap((id) => {
    const f = dialog.turns.find((x) => x.turnId === id)!;
    return f.events.map((e) => ({ turn_id: id, field: e.field, kind: e.kind, value: e.value, quote: e.quote, acknowledges_turn_id: e.acknowledges_turn_id, confidence: "high" }));
  }),
});

function input(ids: string[]): ExtractTurnInput {
  const caseId = "case_x";
  return {
    caseId, policy: policyOf("s01"), callDate: "2026-09-25", state: stubEngine.emptyCaseState(caseId),
    recent: dialog.turns.slice(0, 2).map((f) => turnOf(caseId, f)),
    newTurns: ids.map((id) => turnOf(caseId, dialog.turns.find((f) => f.turnId === id)!)),
  };
}

describe("OpenAIExtractor (luna, §5.3)", () => {
  it("budget: timeoutMs = 1500 + maxOutputTokens/150 × 1000 ≈ 8.2 s at 1000 tokens", () => {
    expect(extractTimeoutMs()).toBe(8167);
    expect(extractTimeoutMs(300)).toBe(3500);
  });

  it("calls luna with effort none, temperature 0, 1000 tokens, store false, strict add_driver_patch, SDK retries off", async () => {
    const { client, calls } = fakeClient([(b) => ok(patchFor(JSON.parse(b.input).new_turns.map((t: { turn_id: string }) => t.turn_id)))]);
    const ex = new OpenAIExtractor({ client, engine: stubEngine });
    const r = await ex.extractTurn(input(["customer-1"]));
    expect(calls).toHaveLength(1);
    const { body, opts } = calls[0]!;
    expect(body).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "none" }, temperature: 0, max_output_tokens: 1000, store: false, instructions: stubEngine.extractor.prompt });
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "add_driver_patch", strict: true });
    expect(opts).toMatchObject({ timeout: 8167, maxRetries: 0 });
    const user = JSON.parse(body.input);
    expect(user.call_date).toBe("2026-09-25");
    expect(user.call_weekday).toBe("Friday");
    expect(user.new_turns).toEqual([{ turn_id: "customer-1", speaker: "CUSTOMER", text: dialog.turns[3]!.text }]);
    expect(user.recent_turns.map((t: { turn_id: string }) => t.turn_id)).toEqual(["rep-0", "customer-0"]);
    expect(r.events.map((e) => [e.field, e.kind, e.party])).toEqual([
      ["driver_full_name", "stated", "customer"], ["driver_dob", "stated", "customer"], ["driver_age", "stated", "customer"],
    ]);
    expect(r.events.every((e) => !("seq" in e))).toBe(true);
    expect(r).toMatchObject({ coveredTurnIds: ["customer-1"], failedTurnIds: [], attempts: 1, error: null, cached: false, extractorVersion: stubEngine.extractor.version });
    expect(r.usd).toBeCloseTo((1800 * 0.1 + 120 * 0.5) / 1e6, 10);
  });

  it("retries ONCE with only the newest turn (older new turns move into RECENT) and the same timeout", async () => {
    const { client, calls } = fakeClient([
      () => new APIConnectionTimeoutError(),
      (b) => ok(patchFor(JSON.parse(b.input).new_turns.map((t: { turn_id: string }) => t.turn_id))),
    ]);
    const ex = new OpenAIExtractor({ client, engine: stubEngine });
    const r = await ex.extractTurn(input(["customer-2", "customer-1", "rep-2"]));
    expect(calls).toHaveLength(2);
    const first = JSON.parse(calls[0]!.body.input);
    expect(first.new_turns.map((t: { turn_id: string }) => t.turn_id)).toEqual(["customer-1", "rep-2", "customer-2"]); // endMs order
    const second = JSON.parse(calls[1]!.body.input);
    expect(second.new_turns.map((t: { turn_id: string }) => t.turn_id)).toEqual(["customer-2"]);
    expect(second.recent_turns.map((t: { turn_id: string }) => t.turn_id)).toEqual(["rep-0", "customer-0", "customer-1", "rep-2"]);
    expect(calls[1]!.opts).toMatchObject({ timeout: 8167 });
    expect(r.coveredTurnIds).toEqual(["customer-2"]);
    expect(r.failedTurnIds).toEqual(["customer-1", "rep-2"]);
    expect(r.attempts).toBe(2);
    expect(r.events.every((e) => e.turnId === "customer-2")).toBe(true);
    expect(r.error?.code).toBe("E_OPENAI_TIMEOUT");
  });

  it("status incomplete is retried like a timeout; a refusal is not retried; two failures never throw", async () => {
    const inc = fakeClient([() => ok({ no_facts: true, events: [] }, "incomplete"), (b) => ok(patchFor(JSON.parse(b.input).new_turns.map((t: { turn_id: string }) => t.turn_id)))]);
    expect((await new OpenAIExtractor({ client: inc.client, engine: stubEngine }).extractTurn(input(["customer-2"]))).attempts).toBe(2);

    const refusal = { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], output_text: "", usage: {} };
    const ref = fakeClient([() => refusal]);
    const r = await new OpenAIExtractor({ client: ref.client, engine: stubEngine }).extractTurn(input(["customer-2"]));
    expect(ref.calls).toHaveLength(1);
    expect(r).toMatchObject({ events: [], failedTurnIds: ["customer-2"], error: { code: "E_OPENAI_REFUSAL" } });

    const both = fakeClient([() => new APIConnectionTimeoutError(), () => new APIConnectionTimeoutError()]);
    const r2 = await new OpenAIExtractor({ client: both.client, engine: stubEngine }).extractTurn(input(["customer-2"]));
    expect(r2).toMatchObject({ events: [], coveredTurnIds: [], failedTurnIds: ["customer-2"], attempts: 2 });
  });

  it("a 429 waits briefly before the retry; a missing key is a non-retried config error", async () => {
    const slept: number[] = [];
    const rl = fakeClient([() => new RateLimitError(429, undefined, "rate", new Headers()), () => ok({ no_facts: true, events: [] })]);
    const r = await new OpenAIExtractor({ client: rl.client, engine: stubEngine, sleep: async (ms) => void slept.push(ms) }).extractTurn(input(["rep-0"]));
    expect(slept).toEqual([750]);
    expect(r.attempts).toBe(2);
    expect(r.noFacts).toBe(true);

    let made = 0;
    const lazy = new OpenAIExtractor({ client: () => { made++; throw new BatonError("E_INTERNAL", "OPENAI_API_KEY is not configured"); }, engine: stubEngine });
    const r3 = await lazy.extractTurn(input(["rep-0"]));
    expect(r3).toMatchObject({ failedTurnIds: ["rep-0"], attempts: 1, error: { code: "E_INTERNAL" } });
    expect(made).toBe(1);
  });

  it("sanitizePatch keeps valid events and drops malformed ones", () => {
    const s = sanitizePatch({ no_facts: false, events: [{ turn_id: "rep-0", field: "nope" }, patchFor(["customer-0"]).events[0]] });
    expect(s?.dropped).toBe(1);
    expect(s?.patch.events).toHaveLength(1);
    expect(sanitizePatch("x")).toBeNull();
    expect(classify(new SyntaxError("x"), 1).retry).toBe(true);
  });
});

describe("OpenAIVerifier (sol, F2)", () => {
  it("sends every turn in call order with the policy, sol/low, strict audit schema; maps turn_ids and uptoRecvMs", async () => {
    const turns = dialog.turns.slice(0, 6).map((f) => turnOf("c", f));
    const { client, calls } = fakeClient([() => ok({ fields: [
      { field: "driver_dob", value: "2009-03-14", support: "stated_and_confirmed", turn_ids: ["customer-1", "rep-2", "ghost-9"], quote: "March 14th, 2009" },
    ] })]);
    const v = new OpenAIVerifier({ client });
    const r = await v.verifyCase({ caseId: "c", policy: policyOf("s01"), callDate: "2026-09-25", turns: [...turns].reverse() });
    const { body } = calls[0]!;
    expect(body).toMatchObject({ model: "gpt-6-sol", reasoning: { effort: "low" }, store: false });
    expect(body.text.format).toMatchObject({ name: "add_driver_audit", strict: true });
    expect(JSON.parse(body.input).turns.map((t: { turn_id: string }) => t.turn_id)).toEqual(turns.map((t) => t.turnId));
    expect(r.uptoRecvMs).toBe(Math.max(...turns.map((t) => t.recvMs)));
    expect(r.fields[0]!.turnIds).toEqual(["customer-1", "rep-2"]);
    expect(r.usd).toBeGreaterThan(0);
    expect(JSON.parse(buildVerifierInput({ callDate: "2026-09-25", policy: policyOf("s01"), turns })).policy.vehicles[0]).toEqual({ id: "veh1", label: "2021 Honda Civic" });
  });
});
