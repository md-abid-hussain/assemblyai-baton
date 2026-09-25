/**
 * Spec-injection PARITY (WP14a·3; TASKS-v2 §2 rule 9, PLATFORM §4.1, §4.6): every WP1 core function that gained an
 * optional trailing `spec?: IntentSpec` returns the same result
 *   (a) without a spec (today's code),
 *   (b) with `LEGACY_BATON_SPEC` (hand-written over today's code), and
 *   (c) with the compiled Baton blueprint's spec (`compileRelay(baton).spec`),
 * over the parity corpus: 22 scenarios, the named and 200 random snapshots (scripts/relay/parity-corpus.ts), 300
 * seeded random event streams through applyExtraction → deriveCaseState, and generated agent sentences for QA.
 * Also: `buildIntentSpec(baton)` equals `LEGACY_BATON_SPEC` function by function (the field-semantics half of the proof).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CaseState, FactKind, FieldId, NewFactEvent, Party, PolicyRecord, RawPatch, TurnInput } from "@/core/contracts";
import { BlueprintSchema, type IntentSpec } from "@/core/contracts/v2";
import { deriveCaseState, deriveV1 } from "@/core/case/derive";
import { applyExtraction, verifierDisagreementEvents } from "@/core/case/apply";
import { deriveField, verifierViewOf } from "@/core/case/status-rules";
import { emptyCaseState, emptyFields, readinessOf } from "@/core/case/state";
import { compileGreeting } from "@/core/compiler/greeting";
import { caseStateJson } from "@/core/compiler/prompt";
import { disclosureText, resolveDueToday, resolvePremium } from "@/core/compiler/disclosures";
import {
  DEFAULT_VA_CAP_ENV, inputModeFor, nextStepOf, openRequiredFields, staticInputMode, vaSessionCapMs,
} from "@/core/compiler/stages";
import { suggestReplies } from "@/core/compiler/suggest";
import { buildSttParams } from "@/core/aai/stt-params";
import { computeQa, type QaInput } from "@/core/qa";
import { classifySentence, isAdvice, valueBearing } from "@/core/qa/reask";
import { LEGACY_BATON_SPEC } from "@/core/intents/baton-legacy-spec";
import { askPhrase, confirmPhrase, normalizeField } from "@/core/intents/add-driver";
import { FIELD_IDS, REQUIRED_FIELDS } from "@/core/intents/add-driver.fields";
import { greetingPhraseCtx } from "@/core/compiler/greeting";
import { accountFor, accountToPolicy, policyFor, policyToAccount } from "@/core/relay/account";
import { compileRelay } from "@/core/relay/compile";
import { buildIntentSpec } from "@/core/relay/spec";
import { kernelOrLegacy, LEGACY_SPEC_HASH } from "@/core/relay/spec-link";
import {
  mulberry32, namedSnapshots, normalizeInputs, policyOf, randomSnapshots, ratingOf, SCENARIO_IDS, truthOf,
} from "../../../../scripts/relay/parity-corpus";

const ROOT = process.cwd();
const bp = BlueprintSchema.parse(JSON.parse(readFileSync(join(ROOT, "data", "relays", "baton-add-driver.json"), "utf8")));
const compiled = compileRelay(bp, { flagship: true });
const BARE = buildIntentSpec(bp);
/** The three ways to call a legacy function: no spec, the hand-written legacy spec, the compiled Baton spec. */
const SPECS: [string, IntentSpec | undefined][] = [["none", undefined], ["legacy", LEGACY_BATON_SPEC], ["compiled", compiled.spec]];
const same = <T,>(f: (spec: IntentSpec | undefined) => T): void => {
  const want = f(undefined);
  for (const [name, spec] of SPECS.slice(1)) expect({ spec: name, got: f(spec) }).toEqual({ spec: name, got: want });
};

const snaps = [...namedSnapshots(), ...randomSnapshots()];
const policies = Object.fromEntries(SCENARIO_IDS.map((id) => [id, policyOf(id)])) as Record<string, PolicyRecord>;

// ============================================================================================ spec vs spec

describe("buildIntentSpec(baton) equals LEGACY_BATON_SPEC", () => {
  const L = LEGACY_BATON_SPEC;
  const K = compiled.spec;

  it("sets, orders and labels", () => {
    expect(L.hash).toBe(LEGACY_SPEC_HASH);
    expect(K.id).toBe(L.id);
    expect([...K.fieldIds]).toEqual([...L.fieldIds]);
    for (const k of ["required", "repOnly", "adviceDomain", "serverResolvable", "entityFields"] as const) {
      expect({ k, v: [...K[k]].sort() }).toEqual({ k, v: [...L[k]].sort() });
    }
    expect([...K.aiSettable]).toEqual([...L.aiSettable]);
    expect([...K.priority]).toEqual([...L.priority]);
    for (const f of FIELD_IDS) expect(K.label(f)).toBe(L.label(f));
  });

  it("normalize and display on every scenario fact, its spoken words and a fuzz list", () => {
    const fuzz = ["", "  ", "n/a", "none", "yes", "no", "tomorrow", "next friday", "october 2nd", "10/02/2026", "2026-13-40",
      "142", "$142.50", "-12.5", "minus twelve fifty", "OH", "ohio", "Wisconsin", "4 4 1 0 7", "441070", "the civic", "honda",
      "all of them", "my roommate", "girlfriend", "daughter", "a permit", "probationary", "full license", "every day", "sometimes",
      "one speeding ticket", "A1234567", "d-4471-02", "seventeen", "17", "true", "false", "Maya Raman", "maya", "MAYA  RAMAN"];
    let n = 0;
    for (const { scenario, field, raw } of normalizeInputs()) {
      const account = accountFor(policies[scenario]!);
      const ctx = { callDate: account.callDate, account };
      const inputs = [raw, ...(n++ % 7 === 0 ? fuzz : [])];
      for (const r of inputs) {
        for (const f of n % 5 === 0 ? FIELD_IDS : [field]) {
          const a = L.normalize(f, r, ctx), b = K.normalize(f, r, ctx);
          expect({ f, r, b }).toEqual({ f, r, b: a });
          if (a) {
            expect(K.display(f, a.norm, account, r)).toBe(L.display(f, a.norm, account, r));
            expect(K.spokenForms(f, a.norm, account)).toEqual(L.spokenForms(f, a.norm, account));
            expect(K.inRange(f, a.norm, account.callDate)).toBe(L.inRange(f, a.norm, account.callDate));
          }
        }
      }
    }
  });

  it("compatible, merge, phrases, targeting, advice and input modes", () => {
    const truths = SCENARIO_IDS.map((id) => truthOf(id));
    for (const f of FIELD_IDS) {
      const vals = [...new Set(truths.map((t) => t[f]).filter((v): v is string => !!v))];
      for (const a of vals) for (const b of vals.slice(0, 6)) {
        expect(K.compatible(f, a, b)).toBe(L.compatible(f, a, b));
        expect(K.merge(f, a, b)).toBe(L.merge(f, a, b));
      }
      for (const kind of ["confirm", "ask", "disclosure", "consent", "none"] as const) {
        expect(K.inputModeFor({ kind, field: f })).toEqual(L.inputModeFor({ kind, field: f }));
      }
    }
    for (const s of snaps.slice(0, 80)) {
      const account = accountFor(policies[s.scenario]!);
      for (const f of FIELD_IDS) {
        const st = s.state.fields[f];
        const pc = { account, snapshot: s.state, raw: st?.display ?? null };
        if (st?.value) expect(K.confirmPhrase(f, st.value, pc)).toBe(L.confirmPhrase(f, st.value, pc));
        expect(K.askPhrase(f, pc)).toBe(L.askPhrase(f, pc));
      }
    }
    for (const sentence of agentSentences().slice(0, 600)) {
      expect({ sentence, t: K.targetedFields(sentence) }).toEqual({ sentence, t: L.targetedFields(sentence) });
      expect(isAdvice(sentence, K)).toBe(isAdvice(sentence, L));
    }
  });
});

// ============================================================================================ corpus helpers

/** Agent sentences: greeting lines, confirm/ask phrases in several frames, disclosures, advice and chit-chat. */
function agentSentences(): string[] {
  const out: string[] = [];
  for (const s of snaps.slice(0, 60)) {
    const policy = policies[s.scenario]!;
    out.push(...compileGreeting(s.state, policy).text.split(/(?<=[.?!])\s+/));
    const pc = greetingPhraseCtx(s.state, policy);
    for (const f of REQUIRED_FIELDS) {
      const st = s.state.fields[f];
      if (st?.value) out.push(`Just to confirm, ${confirmPhrase(f, st.value, { ...pc, raw: st.display })}?`, `So ${confirmPhrase(f, st.value, pc)}, right?`);
      out.push(`I just need ${askPhrase(f, pc)}.`, `Could you tell me ${askPhrase(f, pc)}?`);
    }
  }
  out.push("I'd recommend raising your liability limits.", "You should add the good student discount.", "Your deductible stays the same.",
    "What's the ZIP code where the car is kept overnight?", "Which car will she mainly drive?", "Is that everything?",
    "Can you spell the last name?", "How old is she?", "Great, thanks.", "Is there anything else about this change?");
  return out;
}

const WORD_MS = 240;
type Say = { channel: "rep" | "customer"; text: string; events: Omit<RawPatch["events"][number], "turn_id">[] };

/** A seeded random call: turns with raw extractor events (truth values, wrong values, spoken words, junk). */
function randomCall(seed: number): { scenario: string; policy: PolicyRecord; turns: TurnInput[]; patch: RawPatch } {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const scenario = pick(SCENARIO_IDS);
  const policy = policies[scenario]!;
  const truths = SCENARIO_IDS.map((id) => truthOf(id));
  const n = 2 + Math.floor(rnd() * 22);
  const says: Say[] = [];
  const kinds = ["stated", "stated", "readback", "ack", "corrected", "denied", "question"] as const;
  for (let i = 0; i < n; i++) {
    const field = rnd() < 0.7 ? pick(REQUIRED_FIELDS) : pick(FIELD_IDS);
    const kind = pick(kinds);
    const donor = pick(truths.filter((t) => t[field] !== undefined).concat([truthOf(scenario)]));
    let value: string | null = donor[field] ?? null;
    if (field === "vehicle_assignment" && rnd() < 0.5) value = pick([...policy.vehicles.map((v) => v.model), "all of them", "the truck"]);
    if (field === "effective_date" && rnd() < 0.3) value = pick(["2027-06-01", "2025-01-15", "January 5th"]);   // out of range
    if (rnd() < 0.08) value = pick(["", "not sure", "12/34/5678", "maybe"]);
    if (kind === "ack" || kind === "denied") value = rnd() < 0.6 ? null : value;
    const text = `${value ?? "Yes"} ${pick(["ok", "right", "sure", "so"])}.`;
    const ack = kind === "ack" && says.length && rnd() < 0.7 ? `t${Math.floor(rnd() * says.length)}` : null;
    says.push({ channel: pick(["rep", "customer"] as const), text, events: [{ field, kind, value, quote: text.slice(0, 12), acknowledges_turn_id: ack, confidence: pick(["high", "medium", "low"] as const) }] });
  }
  let t = 0;
  const turns: TurnInput[] = says.map((s, i) => {
    const words = s.text.split(/\s+/).map((w, j) => ({ text: w, startMs: t + j * WORD_MS, endMs: t + (j + 1) * WORD_MS - 20, confidence: 0.9 }));
    const turn: TurnInput = {
      caseId: `case_${seed}`, turnId: `t${i}`, channel: s.channel, text: s.text, startMs: t, endMs: words.at(-1)!.endMs, words,
      source: "stt_live", recvMs: words.at(-1)!.endMs + 300, cut: rnd() < 0.05, late: rnd() < 0.05,
    };
    t = turn.endMs + 200;
    return turn;
  });
  const patch: RawPatch = { no_facts: false, events: says.flatMap((s, i) => s.events.map((e) => ({ ...e, turn_id: `t${i}` }))) };
  return { scenario, policy, turns, patch };
}

/** Extra non-extractor events: policy facts, AI tool updates and a verifier run. */
function extraEvents(seed: number, policy: PolicyRecord, caseId: string, lastMs: number): NewFactEvent[] {
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const truth = truthOf(SCENARIO_IDS[seed % SCENARIO_IDS.length]!);
  const out: NewFactEvent[] = [];
  const add = (field: FieldId, kind: FactKind, party: Party, raw: string, ms: number) => {
    const norm = normalizeField(field, raw, { policy, callDate: policy.callDate })?.norm ?? null;
    out.push({ id: `${caseId}:x${out.length}`, caseId, field, kind, party, valueRaw: raw, valueNorm: norm, acknowledgesTurnId: null,
      confidence: "high", turnId: null, turnEndMs: ms, late: false, cut: false, evidence: null,
      extractor: kind === "policy" ? "policy" : kind === "verifier" ? "sol" : "tool" });
  };
  for (const f of ["driver_full_name", "vehicle_assignment", "effective_date", "premium_new_monthly_usd"] as FieldId[]) {
    const v = truth[f];
    if (!v || rnd() > 0.35) continue;
    add(f, pick3(rnd, ["tool_update", "policy", "verifier"] as const), "ai", v, Math.floor(rnd() * (lastMs + 1000)));
    out.at(-1)!.party = out.at(-1)!.kind === "policy" ? "policy" : out.at(-1)!.kind === "verifier" ? "verifier" : "ai";
  }
  return out;
}
const pick3 = <T,>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

const CALLS = Array.from({ length: 300 }, (_, i) => {
  const c = randomCall(1000 + i);
  const caseId = `case_${1000 + i}`;
  const events = [...applyExtraction(c.patch, c.turns, { caseId, policy: c.policy }), ...extraEvents(i, c.policy, caseId, c.turns.at(-1)?.endMs ?? 0)]
    .map((e, k) => ({ ...e, seq: k + 1 }));
  return { ...c, caseId, events };
});

// ============================================================================================ derive, status rules, apply

describe("case pipeline with a spec equals the legacy pipeline", () => {
  it("applyExtraction and verifierDisagreementEvents (300 random calls)", () => {
    for (const c of CALLS) {
      same((spec) => applyExtraction(c.patch, c.turns, { caseId: c.caseId, policy: c.policy }, spec));
      const state = deriveCaseState(c.policy, c.events, { caseId: c.caseId });
      const truth = truthOf(c.scenario);
      const result = {
        uptoRecvMs: 99_000,
        fields: (Object.keys(truth) as FieldId[]).slice(0, 6).map((field, k) => ({
          field, value: k % 3 === 0 ? "something else" : truth[field]!, support: (["stated_once", "stated_and_confirmed", "conflicting", "absent"] as const)[k % 4]!,
          turnIds: c.turns.slice(0, 1).map((t) => t.turnId), quote: "x",
        })),
      };
      same((spec) => verifierDisagreementEvents(result, state, c.turns, { caseId: c.caseId, policy: c.policy }, spec));
      same((spec) => verifierViewOf(c.events, result, { policy: c.policy, callDate: c.policy.callDate }, spec));
    }
  });

  it("deriveCaseState, deriveV1 and deriveField under every rule switch (300 random calls)", () => {
    for (const [i, c] of CALLS.entries()) {
      const tArmMs = i % 3 === 0 ? (c.turns[Math.floor(c.turns.length / 2)]?.endMs ?? null) : null;
      const rules = i % 4 === 0 ? { lateCut: false } : i % 4 === 1 ? { verifierOverlay: false } : undefined;
      same((spec) => deriveCaseState(c.policy, c.events, { caseId: c.caseId, tArmMs, rules }, spec));
      same((spec) => deriveV1(c.policy, c.events, { caseId: c.caseId }, spec));
      if (i % 10 === 0) {
        const verifier = verifierViewOf(c.events, null, { policy: c.policy, callDate: c.policy.callDate });
        for (const f of FIELD_IDS) {
          same((spec) => deriveField(f, c.events.filter((e) => e.field === f), { policy: c.policy, callDate: c.policy.callDate, tArmMs, lateCut: true, verifier }, spec));
        }
      }
    }
  });

  it("the corpus exercises the interesting branches", () => {
    const reasons = new Set<string>();
    for (const c of CALLS) for (const st of Object.values(deriveCaseState(c.policy, c.events, { caseId: c.caseId }).fields)) reasons.add(st.reason);
    for (const r of ["acknowledged", "read_back", "both_stated", "stated_once", "conflict", "denied", "ai_confirmed", "policy_record", "rep_only_violation", "late_turn", "out_of_range"]) {
      expect({ r, seen: reasons.has(r) }).toEqual({ r, seen: true });
    }
  });

  it("state constructors and readiness", () => {
    same((spec) => emptyFields(spec));
    same((spec) => emptyCaseState("c1", spec));
    for (const s of snaps) same((spec) => readinessOf(s.state.fields, spec));
  });
});

// ============================================================================================ compiler

describe("compiler functions with a spec equal the legacy ones", () => {
  const derived = CALLS.slice(0, 120).map((c) => ({ scenario: c.scenario, state: deriveCaseState(c.policy, c.events, { caseId: c.caseId }) }));
  const states = [...snaps, ...derived];

  it("nextStepOf, openRequiredFields, staticInputMode, vaSessionCapMs, inputModeFor", () => {
    for (const s of states) {
      same((spec) => nextStepOf(s.state, spec));
      same((spec) => openRequiredFields(s.state, spec));
      same((spec) => staticInputMode(s.state, spec));
      same((spec) => vaSessionCapMs(s.state as CaseState, DEFAULT_VA_CAP_ENV, spec));
      same((spec) => inputModeFor(nextStepOf(s.state), spec));
    }
    for (const f of FIELD_IDS) for (const kind of ["confirm", "ask", "disclosure", "consent", "none"] as const) same((spec) => inputModeFor({ kind, field: f }, spec));
  });

  it("caseStateJson (named, random and derived snapshots)", () => {
    for (const s of states) same((spec) => caseStateJson(s.state, policies[s.scenario]!, spec));
  });

  it("disclosureText: both kinds × tax suffix, money from the rating", () => {
    for (const s of states) {
      const policy = policies[s.scenario]!;
      const r = ratingOf(s.scenario);
      const monthlyUsd = resolvePremium(s.state, r.newMonthlyUsd).monthlyUsd;
      const dueTodayUsd = resolveDueToday({ snapshot: s.state, newMonthlyUsd: monthlyUsd, currentMonthlyUsd: policy.currentMonthlyPremiumUsd, scenarioDueTodayUsd: r.dueTodayUsd, callDate: policy.callDate }).dueTodayUsd;
      for (const kind of ["premium_change", "esign_consent"] as const) {
        for (const taxSuffix of [false, true]) same((spec) => disclosureText(kind, { snapshot: s.state, policy, monthlyUsd, dueTodayUsd }, { taxSuffix }, spec));
      }
    }
  });

  it("buildSttParams: 22 scenarios × 2 channels × 8/16 kHz × Hinglish", () => {
    for (const id of SCENARIO_IDS) {
      for (const channel of ["rep", "customer"] as const) {
        for (const format of [{ encoding: "pcm_mulaw", sampleRate: 8000 }, { encoding: "pcm_s16le", sampleRate: 16000 }] as const) {
          for (const language of ["en", "hinglish"] as const) {
            same((spec) => buildSttParams({ format: { ...format, channels: 2 } as never, language, scenarioId: id }, policies[id]!, channel, {}, spec));
          }
        }
      }
    }
  });

  it("suggestReplies on s01 (the add_driver phrase set is kept)", () => {
    const policy = policies.s01!;
    const snap = snaps.find((s) => s.id === "s01@handoff")!.state;
    const lines = [...agentSentences().slice(0, 120), "I've texted the link.", "Great, thanks.", "Is there anything else about this change?"];
    for (const lastAgentText of lines) {
      for (const stage of ["confirm", "disclose", "pay", "close"] as const) {
        same((spec) => suggestReplies({ lastAgentText, snapshot: snap, truth: truthOf("s01"), stage, paymentStatus: null, policy, offerTry: true }, spec));
      }
    }
  });
});

// ============================================================================================ QA

describe("QA with a spec equals the legacy QA", () => {
  it("classifySentence and valueBearing on generated agent sentences × snapshots", () => {
    const sentences = agentSentences();
    for (const [i, s] of snaps.slice(0, 40).entries()) {
      const policy = policies[s.scenario]!;
      for (const sentence of sentences.slice(i * 20, i * 20 + 60)) {
        same((spec) => classifySentence(sentence, s.state, policy, spec));
        for (const f of REQUIRED_FIELDS) {
          const v = s.state.fields[f]?.value;
          if (v) same((spec) => valueBearing(sentence, f, v, policy, spec));
        }
      }
    }
  });

  it("computeQa over greeting + agent turns + disclosures (named and random snapshots)", () => {
    const sentences = agentSentences();
    for (const [i, s] of snaps.slice(0, 60).entries()) {
      const policy = policies[s.scenario]!;
      const g = compileGreeting(s.state, policy).text;
      const disc = disclosureText("premium_change", { snapshot: s.state, policy, monthlyUsd: "142.00", dueTodayUsd: "23.40" });
      const ch2 = [
        ...sentences.slice(i * 7, i * 7 + 12).map((text, k) => ({ text, startMs: 1000 + k * 4000 })),
        { text: i % 2 ? disc.text : disc.text.replace("prorated", "pro rated").replace("go ahead", "proceed"), startMs: 90_000 },
      ];
      const input: QaInput = {
        provisional: i % 3 === 0, snapshot: s.state, policy, ch2, toolCalls: [],
        disclosures: [{ kind: "premium_change", text: disc.text, criticalTokens: disc.criticalTokens, atMs: i % 2 ? 90_000 : null }],
        greeting: g, prependGreeting: true, payment: "unpaid", handedBack: false, aiSeconds: 60,
      };
      same((spec) => computeQa(input, spec));
    }
  });
});

// ============================================================================================ seams

describe("the spec seam", () => {
  it("a bare buildIntentSpec() spec is refused by the blueprint-level functions (no silent Baton fallback)", () => {
    const s = snaps[0]!;
    const policy = policies[s.scenario]!;
    expect(() => caseStateJson(s.state, policy, BARE)).toThrow(/compileRelay\(bp\)\.spec/);
    expect(() => kernelOrLegacy(BARE, "x")).toThrow();
    expect(kernelOrLegacy(undefined, "x")).toBeNull();
    expect(kernelOrLegacy(LEGACY_BATON_SPEC, "x")).toBeNull();
    expect(kernelOrLegacy(compiled.spec, "x")).not.toBeNull();
    // Field-level functions accept any spec.
    expect(nextStepOf(s.state, BARE)).toEqual(nextStepOf(s.state));
  });

  it("accountToPolicy inverts policyToAccount; accountFor/policyFor accept either record", () => {
    for (const id of SCENARIO_IDS) {
      const p = policies[id]!;
      const a = policyToAccount(p);
      expect(accountToPolicy(a)).toEqual(p);
      expect(policyToAccount(accountToPolicy(a))).toEqual(a);
      expect(accountFor(p)).toEqual(a);
      expect(accountFor(a)).toEqual(a);
      expect(accountFor({ $kind: "account", ...a } as never)).toEqual(a);
      expect(policyFor(a)).toEqual(p);
      expect(policyFor(p)).toBe(p);
    }
  });
});
