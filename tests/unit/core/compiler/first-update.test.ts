import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BatonError, CompiledTakeoverSchema, type Stage } from "../../../../src/core/contracts";
import { compileTakeover, keytermsFor } from "../../../../src/core/compiler/compile";
import { buildFirstUpdate, firstUpdateErrors, validateFirstUpdate } from "../../../../src/core/compiler/first-update";
import { TOOL_SCHEMAS } from "../../../../src/core/compiler/tool-schemas";
import { handoffStateOf, policyOf } from "../case/_fixtures";

const ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const SCENARIOS = ["s01", "s02", "s05"] as const;
const STAGES_0: Stage[] = ["confirm", "disclose"];

const compiled = (id: string, stage: Stage, keytermsEnabled = false) =>
  compileTakeover(handoffStateOf(id), policyOf(id), { deployId: "dev-wp1", stage, keytermsEnabled });

/** A mutable, loosely typed deep copy of a valid first update, for the rejection cases. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = { type: "session.update"; session: Record<string, any> };
const base = (): Loose => JSON.parse(JSON.stringify(buildFirstUpdate(compiled("s02", "confirm")))) as Loose;

const rejects = (msg: { type: "session.update"; session: Record<string, unknown> }, re: RegExp, keytermsEnabled = false) => {
  let err: unknown;
  try { validateFirstUpdate(msg, { keytermsEnabled }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(BatonError);
  expect((err as BatonError).code).toBe("E_VA_CONFIG");
  expect((err as BatonError).message).toMatch(re);
};

describe("validateFirstUpdate(buildFirstUpdate(compile(s))) (DESIGN §5.9.1)", () => {
  for (const id of SCENARIOS) {
    for (const stage of STAGES_0) {
      for (const kt of [false, true]) {
        it(`${id} · ${stage} · keyterms ${kt ? "on" : "off"}`, () => {
          const c = compiled(id, stage, kt);
          expect(CompiledTakeoverSchema.parse(c)).toEqual(c);
          const msg = buildFirstUpdate(c);
          expect(() => validateFirstUpdate(msg, { keytermsEnabled: kt })).not.toThrow();
          expect(msg.session.tools.every((t) => t.execution_mode === "interactive")).toBe(true);
          expect("keyterms" in msg.session.input).toBe(kt);
          expect(Object.keys(msg.session)).toEqual(["system_prompt", "greeting", "input", "output", "tools"]);
          expect(msg.session.system_prompt).toContain("(internal ref: baton-deploy=dev-wp1; never mention this)");
        });
      }
    }
  }

  it("the initial stage follows readiness and the transcription mode follows the greeting's next step", () => {
    const s01 = compileTakeover(handoffStateOf("s01"), policyOf("s01"), { deployId: "d" });
    expect([s01.stage, s01.transcriptionMode]).toEqual(["disclose", "min_latency"]);
    const s02 = compileTakeover(handoffStateOf("s02"), policyOf("s02"), { deployId: "d" });
    expect([s02.stage, s02.transcriptionMode]).toEqual(["confirm", "min_latency"]);
    const s05 = compileTakeover(handoffStateOf("s05"), policyOf("s05"), { deployId: "d" });
    expect([s05.stage, s05.transcriptionMode]).toEqual(["confirm", "balanced"]);
    expect(s05.vaSessionCapMs).toBe(165_000);
    expect(s01.keyterms).toEqual([]);
    expect(s01.voice).toBe("alba");
    expect(s01.compiledBy).toBe("server");
    expect(s01.deployMarker).toBe("baton-deploy=d");
  });

  it("keyterms: snapshot values, vehicles, policyholder, agency and rep; ≤100 × ≤50 chars", () => {
    const kt = keytermsFor(handoffStateOf("s01"), policyOf("s01"));
    expect(kt).toEqual(["Maya Raman", "Maya", "child", "Honda Civic", "Civic", "Toyota Highlander", "Highlander", "Priya Raman", "Harborview Insurance Agency", "Daniel"]);
    expect(kt.length).toBeLessThanOrEqual(100);
    expect(kt.every((k) => k.length <= 50)).toBe(true);
  });

  it("the compiled first updates are committed as fixtures (T-D1-0 input for WP5b)", async () => {
    for (const stage of STAGES_0) {
      const msg = buildFirstUpdate(compiled("s01", stage));
      await expect(`${JSON.stringify(msg, null, 2)}\n`).toMatchFileSnapshot(`./__fixtures__/first-update-${stage}.s01.json`);
      const msg2 = buildFirstUpdate(compiled("s02", stage));
      await expect(`${JSON.stringify(msg2, null, 2)}\n`).toMatchFileSnapshot(`./__fixtures__/first-update-${stage}.s02.json`);
    }
  });

  it("has the same shape as WP5b's hand-written T-D1-0 fixtures, when present", () => {
    for (const stage of STAGES_0) {
      const p = join(ROOT, "scripts", "day1", "fixtures", `first-update-${stage}.json`);
      if (!existsSync(p)) continue; // WP5b's file lands at the G1 merge
      const theirs = JSON.parse(readFileSync(p, "utf8")) as unknown;
      expect(shapeOf(buildFirstUpdate(compiled("s01", stage)))).toEqual(shapeOf(theirs));
    }
  });
});

/** Structural shape: keys and value types (tools compared by name). */
function shapeOf(x: unknown): unknown {
  if (Array.isArray(x)) {
    if (x.every((e) => typeof e === "object" && e !== null && "name" in e)) {
      return Object.fromEntries(x.map((e) => [(e as { name: string }).name, shapeOf(e)]));
    }
    return x.length ? [shapeOf(x[0])] : [];
  }
  if (typeof x === "object" && x !== null) {
    return Object.fromEntries(Object.keys(x).sort().map((k) => [k, k === "properties" || k === "required" || k === "enum" ? "…" : shapeOf((x as Record<string, unknown>)[k])]));
  }
  return typeof x;
}

describe("validateFirstUpdate rejects (E_VA_CONFIG)", () => {
  it("a hold tool", () => {
    const m = base();
    (m.session.tools as unknown[]).push({ ...TOOL_SCHEMAS.send_esign_and_pay_link });
    rejects(m, /execution_mode must be "interactive"/);
  });
  it("a `format` keyword (and oneOf / $ref)", () => {
    for (const kw of [{ format: "date" }, { oneOf: [] }, { $ref: "#/x" }]) {
      const m = base();
      const t = (m.session.tools as { parameters: { properties: Record<string, Record<string, unknown>> } }[])[0]!;
      Object.assign(t.parameters.properties.date!, kw);
      rejects(m, /not whitelisted/);
    }
  });
  it("keyterms with the flag off", () => {
    const m = base();
    (m.session.input as Record<string, unknown>).keyterms = ["Maya"];
    rejects(m, /VA_KEYTERMS is off/);
    expect(() => validateFirstUpdate(m, { keytermsEnabled: true })).not.toThrow();
  });
  it("> 100 keyterms, a 51-char keyterm, a non-string keyterm", () => {
    const m = base();
    (m.session.input as Record<string, unknown>).keyterms = Array.from({ length: 101 }, (_, i) => `k${i}`);
    rejects(m, /101 items/, true);
    (m.session.input as Record<string, unknown>).keyterms = ["x".repeat(51)];
    rejects(m, /exceeds 50 chars/, true);
    (m.session.input as Record<string, unknown>).keyterms = [""];
    rejects(m, /non-empty strings/, true);
    (m.session.input as Record<string, unknown>).keyterms = "Maya";
    rejects(m, /must be an array/, true);
    (m.session.input as Record<string, unknown>).keyterms = ["x".repeat(50)];
    expect(() => validateFirstUpdate(m, { keytermsEnabled: true })).not.toThrow();
  });
  it("an unknown voice", () => {
    const m = base();
    (m.session.output as Record<string, unknown>).voice = "ivy";
    rejects(m, /verified voices/);
  });
  it("an unknown input key, output key, session key or top-level key", () => {
    const a = base();
    (a.session.input as Record<string, unknown>).turn_detection = { min_silence: 500 };
    rejects(a, /input: key "turn_detection"/);
    const b = base();
    (b.session.output as Record<string, unknown>).volume = 1;
    rejects(b, /output: key "volume"/);
    const c = base();
    c.session.agent_id = "agent_x";
    rejects(c, /session: key "agent_id"/);
    const d = base() as unknown as Record<string, unknown>;
    d.event_id = "x";
    rejects(d as never, /message: key "event_id"/);
  });
  it("a null, empty or missing greeting; an empty or oversized system prompt", () => {
    const a = base(); a.session.greeting = null; rejects(a, /greeting/);
    const b = base(); b.session.greeting = "  "; rejects(b, /greeting/);
    const c = base(); delete c.session.greeting; rejects(c, /greeting/);
    const d = base(); d.session.system_prompt = ""; rejects(d, /system_prompt must be/);
    const e = base(); e.session.system_prompt = "x".repeat(8001); rejects(e, /exceeds 8000/);
  });
  it("a wrong transcription mode or audio format", () => {
    const a = base(); (a.session.input as Record<string, unknown>).transcription_mode = "fast"; rejects(a, /transcription_mode/);
    const b = base(); (b.session.input as Record<string, unknown>).format = { encoding: "audio/pcmu" }; rejects(b, /input.format/);
    const c = base(); (c.session.output as Record<string, unknown>).format = { encoding: "audio/pcm", sample_rate: 16000 }; rejects(c, /output.format/);
    const d = base(); (d.session.output as Record<string, unknown>).format = "pcm"; rejects(d, /must be an object/);
    const e = base(); (e.session.input as Record<string, unknown>).format = { encoding: "audio/pcm", sample_rate: 24000, channels: 1 }; rejects(e, /not whitelisted/);
  });
  it("bad tools: timeout > 30, unknown name, duplicate, wrong type, missing description, non-object params, bad required", () => {
    const mutate = (fn: (t: Record<string, unknown>) => void, re: RegExp) => {
      const m = base();
      fn((m.session.tools as Record<string, unknown>[])[0]!);
      rejects(m, re);
    };
    mutate((t) => { t.timeout_seconds = 31; }, /timeout_seconds/);
    mutate((t) => { t.timeout_seconds = 1.5; }, /timeout_seconds/);
    mutate((t) => { t.name = "lookup_policy"; }, /not a Baton tool/);
    mutate((t) => { t.type = "http"; }, /type must be "function"/);
    mutate((t) => { t.description = ""; }, /description/);
    mutate((t) => { t.http = {}; }, /not whitelisted/);
    mutate((t) => { t.parameters = { type: "string" }; }, /parameters.type must be "object"/);
    mutate((t) => { t.parameters = []; }, /object schema/);
    mutate((t) => { (t.parameters as Record<string, unknown>).required = ["nope"]; }, /required must list/);
    mutate((t) => { ((t.parameters as { properties: Record<string, Record<string, unknown>> }).properties.date!).type = ["string", "null"]; }, /type must be a string/);
    mutate((t) => { ((t.parameters as { properties: Record<string, Record<string, unknown>> }).properties.date!).enum = []; }, /enum/);
    mutate((t) => { ((t.parameters as { properties: Record<string, Record<string, unknown>> }).properties.date!).examples = "x"; }, /examples/);
    mutate((t) => { ((t.parameters as { properties: Record<string, Record<string, unknown>> }).properties.date!).pattern = 5; }, /pattern/);
    mutate((t) => { ((t.parameters as { properties: Record<string, Record<string, unknown>> }).properties.date!).description = 5; }, /description/);
    mutate((t) => { ((t.parameters as { properties: Record<string, Record<string, unknown>> }).properties.date!).properties = {}; }, /only on object/);
    mutate((t) => { (t.parameters as Record<string, unknown>).properties = []; }, /properties must be an object/);
    const dup = base();
    (dup.session.tools as unknown[]).push((dup.session.tools as unknown[])[0]);
    rejects(dup, /duplicated/);
    const notArr = base(); notArr.session.tools = {}; rejects(notArr, /tools must be an array/);
    const notObj = base(); (notObj.session.tools as unknown[]).push("x"); rejects(notObj, /must be an object/);
  });
  it("non-object message parts; firstUpdateErrors never throws", () => {
    rejects(null as never, /message must be an object/);
    const a = base(); a.type = "session.start" as never; rejects(a, /type must be/);
    const b = base(); (b as Record<string, unknown>).session = []; rejects(b, /session must be an object/);
    const c = base(); c.session.input = null; rejects(c, /input must be an object/);
    const d = base(); c.session.input = {}; d.session.output = 1; rejects(d, /output must be an object/);
    expect(firstUpdateErrors(base(), { keytermsEnabled: false })).toBeNull();
    expect(firstUpdateErrors(a, { keytermsEnabled: false })).toMatch(/E_VA_CONFIG|type must be/);
  });
});
