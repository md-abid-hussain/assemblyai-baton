/**
 * The drafting pipeline (PLATFORM §7.4 steps 2-6; WP17·3): the luna call, the repair rounds, the post-fixes and the
 * relay that comes out. The upstream and the ledger are fakes, so this whole file costs $0.
 */
import { describe, expect, it } from "vitest";

import { lintBlueprint } from "@/core/relay/lint";
import { DRAFT_EST_USD, DRAFT_MAX_OUTPUT_TOKENS, DRAFT_MODEL, buildDraftInput, draftOnce } from "@/server/openai/draft";
import { runDraftPipeline, type DraftPipelineDeps } from "@/server/draft/pipeline";
import { DESK_INPUT, draftFixture } from "../../core/relay-draft/helpers";
import { fakeLedger } from "../sim/helpers";
import { fakeLlm, kernel, type Reply, type Seen } from "./helpers";

const today = () => "2026-09-25";

/**
 * Legal for the draft schema, broken for the blueprint: an enum field with no values (lint L2). `expandDraft`
 * deliberately does not invent enum values - what a business's options are is not a mechanical default - so this is
 * a draft only the model can fix, which is exactly what a repair round is for.
 */
const lintBroken = () => draftFixture({
  fields: draftFixture().fields.map((f) => (f.id === "procedure" ? { ...f, enumValues: [] } : f)),
});

function deps(replies: Reply[], o: { ledger?: ReturnType<typeof fakeLedger> | null; seen?: Seen[]; create?: DraftPipelineDeps["create"] } = {}): DraftPipelineDeps & { steps: string[] } {
  const steps: string[] = [];
  return {
    llm: fakeLlm(replies, o.ledger ?? null, o.seen),
    kernel,
    create: o.create === undefined ? async () => "rl_created" : o.create,
    today,
    onStep: (s) => void steps.push(s),
    steps,
  };
}

// ============================================================================================ the call itself

describe("draftOnce", () => {
  it("pins the model, the strict format and the 8000-token budget (§7.4 step 2)", async () => {
    const seen: Seen[] = [];
    const out = await draftOnce(fakeLlm([draftFixture()], null, seen), { input: "x", refId: "drf_1" });
    expect(out.draft).not.toBeNull();
    const body = seen[0]!.body as { model: string; max_output_tokens: number; store: boolean; text: { format: { name: string; strict: boolean } } };
    expect(body.model).toBe(DRAFT_MODEL);
    expect(body.max_output_tokens).toBe(DRAFT_MAX_OUTPUT_TOKENS);
    expect(body.store).toBe(false);
    expect(body.text.format.name).toBe("draft_blueprint");
    expect(body.text.format.strict).toBe(true);
    expect(out.usd).toBeGreaterThan(0);
  });

  it("reserves and settles on the ledger, from usage", async () => {
    const ledger = fakeLedger();
    const out = await draftOnce(fakeLlm([draftFixture()], ledger), { input: "x", refId: "drf_1" });
    expect(ledger.calls.map((c) => c.op)).toEqual(["reserve", "settle"]);
    expect(ledger.calls[0]!.action).toBe("draft");
    expect(ledger.calls[0]!.estUsd).toBe(DRAFT_EST_USD);
    expect(ledger.calls[1]!.usd).toBeCloseTo(out.usd, 9);
  });

  it("raises E_BUDGET before any request when the reservation is refused", async () => {
    const ledger = fakeLedger({ refuse: true });
    const seen: Seen[] = [];
    await expect(draftOnce(fakeLlm([draftFixture()], ledger, seen), { input: "x", refId: "drf_1" })).rejects.toMatchObject({ code: "E_BUDGET" });
    expect(seen).toHaveLength(0);
  });

  it("treats an incomplete response as a repair, settles it (it was billed) and asks for less", async () => {
    const ledger = fakeLedger();
    const out = await draftOnce(fakeLlm(["incomplete"], ledger), { input: "x", refId: "drf_1" });
    expect(out.incomplete).toBe(true);
    expect(out.draft).toBeNull();
    expect(out.issues[0]).toContain("did not finish");
    expect(out.usd).toBe(DRAFT_EST_USD);
    expect(ledger.calls.map((c) => c.op)).toEqual(["reserve", "settle"]);
  });

  it("releases the reservation and rethrows when the transport fails", async () => {
    const ledger = fakeLedger();
    await expect(draftOnce(fakeLlm([new Error("socket")], ledger), { input: "x", refId: "drf_1" })).rejects.toThrow("socket");
    expect(ledger.calls.map((c) => c.op)).toEqual(["reserve", "release"]);
  });

  it("returns the shape problems rather than throwing, so the caller can repair", async () => {
    const out = await draftOnce(fakeLlm([{ meta: { slug: "x" } }]), { input: "x", refId: "drf_1" });
    expect(out.draft).toBeNull();
    expect(out.issues.length).toBeGreaterThan(0);
  });
});

describe("buildDraftInput", () => {
  it("carries every form answer, in words the model can use", () => {
    const input = buildDraftInput(DESK_INPUT);
    expect(input).toContain("Riverbend Dental");
    expect(input).toContain(DESK_INPUT.repHandles);
    expect(input).toContain("take a payment or a deposit through a link");
    expect(input).toContain("read something to the customer word for word");
    expect(input).toContain("non-refundable");
    expect(input).toContain("VOICE: alba");
  });

  it("says plainly when a step was skipped", () => {
    const input = buildDraftInput({ ...DESK_INPUT, businessName: null, verbatim: null, payment: null, voice: null });
    expect(input).toContain("invent a fictional one");
    expect(input).toContain("(nothing)");
    expect(input).toContain("(no payment)");
    expect(input).not.toContain("VOICE:");
  });
});

// ============================================================================================ the pipeline

describe("runDraftPipeline", () => {
  it("drafts, expands, lints clean and creates the relay in one round", async () => {
    const d = deps([draftFixture()]);
    const r = await runDraftPipeline(d, DESK_INPUT, "drf_1");
    expect(r.status).toBe("ok");
    expect(r.repairs).toBe(0);
    expect(r.relayId).toBe("rl_created");
    expect(r.lint.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.blueprint!.meta.origin).toBe("draft");
    expect(d.steps).toEqual(["drafting", "fixing", "creating"]);
  });

  it("keeps the model's notes and adds the post-fixes it applied", async () => {
    const r = await runDraftPipeline(deps([draftFixture()]), DESK_INPUT, "drf_1");
    expect(r.notes.slice(0, 2)).toEqual(draftFixture().notes);
    expect(r.notes.join(" ")).toContain("SAMPLE");
  });

  it("repairs a draft whose shape was illegal, and shows the model its own output", async () => {
    const seen: Seen[] = [];
    const r = await runDraftPipeline(deps([{ meta: { slug: "nope" } }, draftFixture()], { seen }), DESK_INPUT, "drf_1");
    expect(r.status).toBe("ok");
    expect(r.repairs).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.input).toContain("YOUR PREVIOUS DRAFT");
    expect(seen[1]!.input).toContain("WHAT IS WRONG WITH IT");
  });

  it("feeds the lint errors back as the repair's issue list", async () => {
    // A draft with no fields at all cannot expand into a legal blueprint: the lint errors must reach the model.
    const seen: Seen[] = [];
    const r = await runDraftPipeline(deps([lintBroken(), draftFixture()], { seen }), DESK_INPUT, "drf_1");
    expect(r.status).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(seen[1]!.input).toContain("[L2]");
    expect(seen[1]!.input).toContain("enumValues");
  });

  it("spends at most two repair rounds, then keeps the valid parts and reports them", async () => {
    const r = await runDraftPipeline(deps([lintBroken(), lintBroken(), lintBroken()]), DESK_INPUT, "drf_1");
    expect(r.repairs).toBe(2);
    expect(r.status).toBe("invalid");
    expect(r.blueprint).not.toBeNull();            // the valid parts are kept (§7.4 step 4)
    expect(r.relayId).toBe("rl_created");           // and the relay is still created, with its errors highlighted
    expect(r.lint.some((i) => i.severity === "error")).toBe(true);
  });

  it("counts an incomplete response as one of the two rounds", async () => {
    const r = await runDraftPipeline(deps(["incomplete", draftFixture()]), DESK_INPUT, "drf_1");
    expect(r.status).toBe("ok");
    expect(r.repairs).toBe(1);
    expect(r.usd).toBeGreaterThan(DRAFT_EST_USD);
  });

  it("gives up cleanly when no round ever produced a legal shape", async () => {
    const r = await runDraftPipeline(deps(["incomplete", "incomplete", "incomplete"]), DESK_INPUT, "drf_1");
    expect(r.status).toBe("invalid");
    expect(r.blueprint).toBeNull();
    expect(r.relayId).toBeNull();
    expect(r.usd).toBeCloseTo(3 * DRAFT_EST_USD, 9);
  });

  it("adds up what every round cost", async () => {
    const ledger = fakeLedger();
    const r = await runDraftPipeline(deps([{ meta: {} }, draftFixture()], { ledger }), DESK_INPUT, "drf_1");
    expect(ledger.calls.filter((c) => c.op === "reserve")).toHaveLength(2);
    expect(r.usd).toBeCloseTo(ledger.calls.filter((c) => c.op === "settle").reduce((a, c) => a + (c.usd ?? 0), 0), 9);
  });

  it("can run without creating a relay (the offline gallery path)", async () => {
    const r = await runDraftPipeline(deps([draftFixture()], { create: null }), DESK_INPUT, "drf_1");
    expect(r.status).toBe("ok");
    expect(r.relayId).toBeNull();
    expect(lintBlueprint(r.blueprint!).filter((i) => i.severity === "error")).toEqual([]);
  });
});
