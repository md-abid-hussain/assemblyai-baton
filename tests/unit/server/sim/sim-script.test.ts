/**
 * WP17·2: `src/server/openai/sim-script.ts` - the strict `sim_script` format, every §7.5 step 1 rule, and the one
 * regeneration. The blueprint is the shipped `data/relays/dental-deposit.json` and the happy-path script is the one
 * `build-gallery` committed, so this test is the offline twin of the live build. $0: the upstream is a fake.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

import { BatonError } from "@/core/contracts/errors";
import { SimScriptSchema, type SimScript } from "@/core/contracts/v2/api";
import { BlueprintSchema, type Blueprint } from "@/core/contracts/v2/blueprint";
import { assertStrictSchema, StrictSchemaError } from "@/core/relay/extractor";
import {
  aiAllowedRequired, allowedNameWords, buildSimScriptInput, foreignNames, generateSimScript, simScriptFormat,
  SimScriptInvalidError, SIM_HANDOFF_MIN_SIMILARITY, SIM_SCRIPT_EST_USD, SIM_SCRIPT_MAX_CHARS, SIM_SCRIPT_MODEL,
  trimSimScript, validateSimScript, SIM_SCRIPT_MIN_TURNS, type SimScriptContext,
} from "@/server/openai/sim-script";
import { repoRoot } from "../../../../scripts/lib/load-env";
import { fakeLedger } from "./helpers";

const root = repoRoot();
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(root, p), "utf8"));

const blueprint: Blueprint = BlueprintSchema.parse(readJson("data/relays/dental-deposit.json"));
/** The script `build-gallery` committed and voiced: a real luna answer that passed every rule. */
const good = (): SimScript => SimScriptSchema.parse(readJson("scripts/sim/scripts/dental-deposit.0.json"));
const ctx: SimScriptContext & { refId: string } = { blueprint, sampleIndex: 0, refId: "sim_test" };
const fieldIds = blueprint.fields.map((f) => f.id);

const turnsOf = (over: Partial<SimScript>): SimScript => ({ ...good(), ...over });
const issuesOf = (s: SimScript, c: SimScriptContext = ctx): string[] => validateSimScript(s, c).issues;

// ============================================================================================ the strict format

describe("simScriptFormat", () => {
  it("passes assertStrictSchema (TASKS-v2 §6 WP17 acceptance 6)", () => {
    expect(() => assertStrictSchema(simScriptFormat(fieldIds))).not.toThrow();
    expect(simScriptFormat(fieldIds).strict).toBe(true);
    expect(simScriptFormat(fieldIds).name).toBe("sim_script");
  });

  it("would fail assertStrictSchema if a key were left out of required (the guard is real)", () => {
    const f = simScriptFormat(fieldIds);
    (f.schema as { required: string[] }).required = ["turns"];
    expect(() => assertStrictSchema(f)).toThrow(StrictSchemaError);
  });

  it("enumerates the relay's own field ids, so no invented field can come back", () => {
    const props = (simScriptFormat(fieldIds).schema as { properties: Record<string, { items?: { enum?: string[] } }> }).properties;
    expect(props["left_for_ai"]!.items!.enum).toEqual(fieldIds);
    expect(fieldIds).toContain("appointment_time");
  });
});

// ============================================================================================ the prompt

describe("buildSimScriptInput", () => {
  it("settles every required ai_allowed field except the one left for the AI", () => {
    const leave = aiAllowedRequired(blueprint).slice(-1);
    const input = buildSimScriptInput({ blueprint, sampleIndex: 0 });
    const [settleBlock, aiBlock] = input.split("LEAVE FOR THE AI (never mentioned in your script)") as [string, string];
    expect(aiBlock).toContain(leave[0]!);
    for (const id of aiAllowedRequired(blueprint).filter((f) => !leave.includes(f))) expect(settleBlock).toContain(id);
  });

  it("gives the handoff line verbatim, the acceptance phrase and only the sample's names", () => {
    const input = buildSimScriptInput({ blueprint, sampleIndex: 0 });
    const sample = blueprint.context.samples[0]!;
    expect(input).toContain(blueprint.handoff.repLine);
    expect(input).toContain(blueprint.handoff.acceptance.phrase);
    expect(input).toContain(`${sample.customer.firstName} ${sample.customer.lastName}`);
    expect(input).toContain(sample.org.name);
    expect(input).toContain(blueprint.playbook.persona.tone);
  });

  it("refuses a sample index that does not exist", () => {
    expect(() => buildSimScriptInput({ blueprint, sampleIndex: 9 })).toThrow(RangeError);
  });
});

describe("foreignNames", () => {
  const allowed = allowedNameWords(blueprint.context.samples[0]!);

  it("licenses the sample's people, business and fact values", () => {
    const sample = blueprint.context.samples[0]!;
    expect(foreignNames(`Hi ${sample.customer.firstName} ${sample.customer.lastName}, this is ${sample.org.repFirstName} at ${sample.org.name}.`, allowed)).toEqual([]);
  });

  it("catches an invented person or brand", () => {
    expect(foreignNames("I'll pass you to Kevin Marchetti at Acme Dental.", allowed)).not.toEqual([]);
  });

  it("does not mistake a weekday or a sentence opener for a name", () => {
    expect(foreignNames("Tuesday morning works. Thanks Maya.", allowed)).toEqual([]);
  });
});

// ============================================================================================ validation

describe("validateSimScript", () => {
  it("accepts the committed Dental script", () => {
    const v = validateSimScript(good(), ctx);
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.script).not.toBeNull();
    expect(v.chars).toBeLessThanOrEqual(SIM_SCRIPT_MAX_CHARS);
    expect(v.handoffSimilarity!).toBeGreaterThanOrEqual(SIM_HANDOFF_MIN_SIMILARITY);
  });

  it("reports the shape and stops when the script does not parse (8-14 turns, 1-3 left_for_ai)", () => {
    for (const bad of [
      { turns: good().turns.slice(0, 6) },
      { turns: [...good().turns, ...good().turns] },
      { left_for_ai: [] },
      { left_for_ai: fieldIds.slice(0, 4) },
    ]) {
      const v = validateSimScript(turnsOf(bad as Partial<SimScript>), ctx);
      expect(v.ok, JSON.stringify(Object.keys(bad))).toBe(false);
      expect(v.script).toBeNull();
      expect(v.issues.length).toBeGreaterThan(0);
    }
    expect(validateSimScript({ nope: 1 }, ctx).script).toBeNull();
  });

  it("refuses a script over the character limit", () => {
    const turns = good().turns.map((t, i) => (i === 1 ? { ...t, text: "x".repeat(SIM_SCRIPT_MAX_CHARS) } : t));
    expect(issuesOf(turnsOf({ turns }))).toContainEqual(expect.stringContaining("the limit is 1200"));
  });

  it("refuses a script whose first turn is not the rep's", () => {
    const turns = good().turns.map((t, i) => (i === 0 ? { ...t, speaker: "customer" as const } : t));
    expect(issuesOf(turnsOf({ turns }))).toContain("the first turn must be the rep's");
  });

  it("refuses a handoff turn that paraphrases the line, and names the line in the issue", () => {
    const turns = [...good().turns];
    turns[turns.length - 2] = { speaker: "rep", text: "Let me get someone else on this for you.", tag: "handoff" };
    const issues = issuesOf(turnsOf({ turns }));
    expect(issues.some((i) => i.includes("similarity") && i.includes(blueprint.handoff.repLine))).toBe(true);
  });

  it("accepts a handoff turn that is only slightly reworded (≥ 0.85), since planSimLines puts the exact line in", () => {
    const turns = [...good().turns];
    turns[turns.length - 2] = { speaker: "rep", text: blueprint.handoff.repLine.replace("I'll", "I will"), tag: "handoff" };
    expect(issuesOf(turnsOf({ turns }))).toEqual([]);
  });

  it("refuses a last turn that does not accept the handover (checked with safeTest, never RegExp)", () => {
    const turns = [...good().turns];
    turns[turns.length - 1] = { speaker: "customer", text: "No, I'd rather not.", tag: "accept" };
    expect(issuesOf(turnsOf({ turns })).some((i) => i.includes("accept the handover"))).toBe(true);
    expect(blueprint.handoff.acceptance.patterns.length).toBeGreaterThan(0);
  });

  it("refuses a long digit run (the card-number guard) but allows prices and short numbers", () => {
    const withCard = good().turns.map((t, i) => (i === 3 ? { ...t, text: "It's 4111 1111 1111 1111." } : t));
    expect(issuesOf(turnsOf({ turns: withCard })).some((i) => i.includes("digit run"))).toBe(true);
    const withPrice = good().turns.map((t, i) => (i === 3 ? { ...t, text: "The deposit is $50, and my ZIP is 94014." } : t));
    expect(issuesOf(turnsOf({ turns: withPrice })).some((i) => i.includes("digit run"))).toBe(false);
  });

  it("refuses an invented name", () => {
    const turns = good().turns.map((t, i) => (i === 1 ? { ...t, text: "Sure, my dentist is Kevin Marchetti." } : t));
    expect(issuesOf(turnsOf({ turns })).some((i) => i.includes("not in the sample"))).toBe(true);
  });

  it("refuses a left_for_ai the AI may not set, and an answer that does not match it", () => {
    const notAiAllowed = blueprint.fields.find((f) => !aiAllowedRequired(blueprint).includes(f.id))!;
    expect(issuesOf(turnsOf({ left_for_ai: [notAiAllowed.id], ai_half_answers: [{ field: notAiAllowed.id, spoken: "Sure." }] }))
      .some((i) => i.includes("not a required field the AI may set"))).toBe(true);
    expect(issuesOf(turnsOf({ ai_half_answers: [] })).some((i) => i.includes("no spoken answer"))).toBe(true);
    expect(issuesOf(turnsOf({ ai_half_answers: [{ field: good().left_for_ai[0]!, spoken: "  " }] }))
      .some((i) => i.includes("is empty"))).toBe(true);
  });

  it("refuses an empty consent or closing phrase", () => {
    expect(issuesOf(turnsOf({ consent_phrase: " " }))).toContain("consent_phrase is empty");
    expect(issuesOf(turnsOf({ closing_phrase: "" }))).toContain("closing_phrase is empty");
  });

  it("honours an explicit leaveForAi", () => {
    const other = aiAllowedRequired(blueprint).find((f) => f !== good().left_for_ai[0])!;
    expect(issuesOf(good(), { blueprint, sampleIndex: 0, leaveForAi: [other] })
      .some((i) => i.includes("not a required field the AI may set"))).toBe(true);
  });
});

// ============================================================================================ the call

type Reply = SimScript | Record<string, unknown> | "incomplete" | Error;

function fakeOpenAI(replies: Reply[], seen: { input: string; body: unknown }[] = []): { openai: () => OpenAI; seen: typeof seen } {
  let n = 0;
  const client = {
    responses: {
      create: async (body: { input: string }) => {
        const reply = replies[n++];
        seen.push({ input: body.input, body });
        if (reply instanceof Error) throw reply;
        if (reply === "incomplete") {
          return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], output_text: "", usage: null };
        }
        return {
          status: "completed", output: [], output_text: JSON.stringify(reply),
          usage: { input_tokens: 1200, output_tokens: 400, output_tokens_details: { reasoning_tokens: 100 }, input_tokens_details: { cached_tokens: 0 } },
        };
      },
    },
  };
  return { openai: () => client as unknown as OpenAI, seen };
}

const deps = (replies: Reply[], ledger: ReturnType<typeof fakeLedger> | null = null, seen?: { input: string; body: unknown }[]) => ({
  ...fakeOpenAI(replies, seen),
  ledger: () => ledger,
  env: () => "test",
});

describe("generateSimScript", () => {
  it("returns the script, the model pins and the settled cost on the first attempt", async () => {
    const seen: { input: string; body: unknown }[] = [];
    const ledger = fakeLedger();
    const r = await generateSimScript(deps([good()], ledger, seen), ctx);
    expect(r.attempts).toBe(1);
    expect(r.script.turns).toHaveLength(good().turns.length);
    expect(r.usd).toBeGreaterThan(0);
    const body = seen[0]!.body as { model: string; text: { format: { name: string; strict: boolean } }; store: boolean; max_output_tokens: number };
    expect(body.model).toBe(SIM_SCRIPT_MODEL);
    expect(body.text.format.name).toBe("sim_script");
    expect(body.text.format.strict).toBe(true);
    expect(body.store).toBe(false);
    expect(ledger.calls.map((c) => c.op)).toEqual(["reserve", "settle"]);
    expect(ledger.calls[0]!.action).toBe("sim_script");
    expect(ledger.calls[0]!.provider).toBe("openai");
    expect(ledger.calls[0]!.refId).toBe("sim_test");
    expect(ledger.calls[1]!.usd).toBeCloseTo(r.usd, 9);
  });

  it("regenerates ONCE, showing the model its own output and the issue list", async () => {
    const seen: { input: string; body: unknown }[] = [];
    const badTurns = [...good().turns];
    badTurns[badTurns.length - 2] = { speaker: "rep", text: "Hold on, I'll grab a colleague.", tag: "handoff" };
    const ledger = fakeLedger();
    const r = await generateSimScript(deps([{ ...good(), turns: badTurns }, good()], ledger, seen), ctx);
    expect(r.attempts).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.input).toContain("YOUR PREVIOUS SCRIPT");
    expect(seen[1]!.input).toContain("Hold on, I'll grab a colleague.");
    expect(seen[1]!.input).toContain("similarity");
    expect(ledger.calls.map((c) => c.op)).toEqual(["reserve", "settle", "reserve", "settle"]);
  });

  it("fails with the issue list after the second attempt is still wrong", async () => {
    const short = { ...good(), turns: good().turns.slice(0, 5) };
    await expect(generateSimScript(deps([short, short]), ctx)).rejects.toBeInstanceOf(SimScriptInvalidError);
    await generateSimScript(deps([short, short]), ctx).catch((e: unknown) => {
      expect((e as SimScriptInvalidError).attempts).toBe(2);
      expect((e as SimScriptInvalidError).issues.length).toBeGreaterThan(0);
    });
  });

  it("treats an incomplete response as the one regeneration, and settles it (it was billed)", async () => {
    const ledger = fakeLedger();
    const seen: { input: string; body: unknown }[] = [];
    const r = await generateSimScript(deps(["incomplete", good()], ledger, seen), ctx);
    expect(r.attempts).toBe(2);
    expect(seen[1]!.input).toContain("it did not finish; make it shorter");
    expect(ledger.calls.map((c) => c.op)).toEqual(["reserve", "settle", "reserve", "settle"]);
    expect(ledger.calls[1]!.usd).toBe(SIM_SCRIPT_EST_USD);
    expect(r.usd).toBeGreaterThanOrEqual(SIM_SCRIPT_EST_USD);
  });

  it("gives up after two incomplete responses", async () => {
    await expect(generateSimScript(deps(["incomplete", "incomplete"]), ctx)).rejects.toBeInstanceOf(SimScriptInvalidError);
  });

  it("releases the reservation and rethrows when the transport fails", async () => {
    const ledger = fakeLedger();
    await expect(generateSimScript(deps([new Error("socket hang up")], ledger), ctx)).rejects.toThrow("socket hang up");
    expect(ledger.calls.map((c) => c.op)).toEqual(["reserve", "release"]);
  });

  it("throws E_BUDGET before any request when the ledger refuses", async () => {
    const ledger = fakeLedger({ refuse: true });
    const seen: { input: string; body: unknown }[] = [];
    await expect(generateSimScript(deps([good()], ledger, seen), ctx)).rejects.toMatchObject({ code: "E_BUDGET" });
    await expect(generateSimScript(deps([good()], ledger), ctx)).rejects.toBeInstanceOf(BatonError);
    expect(seen).toHaveLength(0);
  });

  it("runs with no ledger at all (unit path): no reservation, still a cost", async () => {
    const r = await generateSimScript(deps([good()], null), ctx);
    expect(r.usd).toBeGreaterThan(0);
    expect(r.attempts).toBe(1);
  });
});

// ============================================================================================ WP17·3: the trim

describe("trimSimScript (WP17·3)", () => {
  const long = (n: number): SimScript => {
    const base = good();
    const filler = { speaker: "customer" as const, text: "x".repeat(120), tag: "other" as const };
    return { ...base, turns: [base.turns[0]!, ...Array.from({ length: n }, () => filler), ...base.turns.slice(1)] };
  };

  it("leaves a script that already fits exactly as it is", () => {
    const r = trimSimScript(good());
    expect(r.dropped).toBe(0);
    expect(r.script).toEqual(good());
  });

  it("drops middle asides until the script fits, and no further", () => {
    const over = long(3);
    expect(over.turns.reduce((n, t) => n + t.text.length, 0)).toBeGreaterThan(SIM_SCRIPT_MAX_CHARS);
    const r = trimSimScript(over);
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.script.turns.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(SIM_SCRIPT_MAX_CHARS);
  });

  it("never drops the opening, the handoff or the acceptance", () => {
    const over = long(4);
    const r = trimSimScript(over);
    expect(r.script.turns[0]).toEqual(over.turns[0]);
    expect(r.script.turns.at(-1)!.tag).toBe("accept");
    expect(r.script.turns.at(-2)!.tag).toBe("handoff");
  });

  it("never goes below the minimum turn count, even if it cannot fit", () => {
    const base = good();
    const huge = { ...base, turns: base.turns.map((t) => ({ ...t, text: "y".repeat(300) })) };
    const r = trimSimScript(huge);
    expect(r.script.turns.length).toBeGreaterThanOrEqual(SIM_SCRIPT_MIN_TURNS);
  });

  it("generateSimScript salvages a script whose only fault is a few characters", async () => {
    const over = long(1);
    const r = await generateSimScript(deps([over, over]), ctx);
    expect(r.attempts).toBe(2);
    expect(r.chars).toBeLessThanOrEqual(SIM_SCRIPT_MAX_CHARS);
    expect(r.script.turns.length).toBeGreaterThanOrEqual(SIM_SCRIPT_MIN_TURNS);
  });

  it("but never salvages a script that breaks a rule as well", async () => {
    const over = long(1);
    const broken = { ...over, turns: [...over.turns.slice(0, -1), { speaker: "customer" as const, text: "Actually, no.", tag: "accept" as const }] };
    await expect(generateSimScript(deps([broken, broken]), ctx)).rejects.toBeInstanceOf(SimScriptInvalidError);
  });
});
