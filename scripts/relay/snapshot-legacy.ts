/**
 * scripts/relay/snapshot-legacy.ts - the Baton parity ORACLE (PLATFORM §4.6). WP14a. $0 (no network).
 *
 * Runs the LEGACY Baton code (src/core/{compiler,intents,case,aai}) over the parity corpus and writes
 * tests/fixtures/relay-parity/baton/*.json. The kernel parity suite (tests/unit/core/relay/parity-baton.test.ts)
 * compiles data/relays/baton-add-driver.json and must reproduce these files with 0 diffs. Run it after a deliberate
 * legacy change (and once at G2 on merged main):
 *
 *   npx tsx scripts/relay/snapshot-legacy.ts            # write the fixtures
 *   npx tsx scripts/relay/snapshot-legacy.ts --check    # exit 1 if the written fixtures differ from a fresh run
 *
 * Prompts of the 200 random snapshots are stored as sha256 (plus their case JSON) to keep the fixtures small; the
 * named snapshots store full texts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseState, FieldId, PolicyRecord, Stage } from "../../src/core/contracts/case";
import { STAGES } from "../../src/core/contracts/case";
import { keytermsFromPolicy } from "../../src/core/aai/stt-params";
import { sha256Hex } from "../../src/core/case/sha256";
import {
  ADD_DRIVER_PATCH_FORMAT, buildExtractorInput, EXTRACTOR_PROMPT_V3, EXTRACTOR_VERSION_V3,
} from "../../src/core/case/extractor";
import { compileTakeover } from "../../src/core/compiler/compile";
import { disclosureText, resolveDueToday, resolvePremium } from "../../src/core/compiler/disclosures";
import { buildFirstUpdate } from "../../src/core/compiler/first-update";
import { compileGreeting, GREETING_MAX_WORDS, greetingPhraseCtx } from "../../src/core/compiler/greeting";
import { caseStateJson, compilePrompt, PROMPT_VERSION } from "../../src/core/compiler/prompt";
import { inputModeFor, nextStage, nextStepOf, vaSessionCapMs, DEFAULT_VA_CAP_ENV } from "../../src/core/compiler/stages";
import { toolsForStage } from "../../src/core/compiler/tool-schemas";
import { askPhrase, confirmPhrase, displayValue, normalizeField, spokenForms } from "../../src/core/intents/add-driver";
import { FIELD_IDS, fieldKindOf } from "../../src/core/intents/add-driver.fields";
import {
  compactFields, namedSnapshots, normalizeInputs, policyOf, randomSnapshots, ratingOf, ROOT, SCENARIO_IDS, stateOf, truthOf,
  type NamedSnapshot,
} from "./parity-corpus";

export const PARITY_DIR = join(ROOT, "tests", "fixtures", "relay-parity", "baton");
export const DEPLOY_ID = "parity";

const sha = (s: string): string => sha256Hex(s);

function moneyOf(state: CaseState, id: string) {
  const rating = ratingOf(id);
  const policy = policyOf(id);
  const monthly = resolvePremium(state, rating.newMonthlyUsd).monthlyUsd;
  const due = resolveDueToday({ snapshot: state, newMonthlyUsd: monthly, currentMonthlyUsd: policy.currentMonthlyPremiumUsd, scenarioDueTodayUsd: rating.dueTodayUsd, callDate: policy.callDate }).dueTodayUsd;
  return { monthly_premium: monthly, due_today: due };
}

function disclosuresOf(state: CaseState, id: string) {
  const policy = policyOf(id);
  const m = moneyOf(state, id);
  const ctx = { snapshot: state, policy, monthlyUsd: m.monthly_premium, dueTodayUsd: m.due_today };
  const out: Record<string, unknown> = {};
  for (const kind of ["premium_change", "esign_consent"] as const) {
    for (const taxSuffix of [false, true]) out[`${kind}${taxSuffix ? "+tax" : ""}`] = disclosureText(kind, ctx, { taxSuffix });
  }
  return out;
}

function named(s: NamedSnapshot) {
  const policy = policyOf(s.scenario);
  const prompts = Object.fromEntries(STAGES.map((stage) => [stage, compilePrompt(s.state, policy, stage, { deployId: DEPLOY_ID, payToolMode: "push" })]));
  const firstUpdates = Object.fromEntries((["confirm", "disclose"] as const).map((stage) => {
    const c = compileTakeover(s.state, policy, { deployId: DEPLOY_ID, keytermsEnabled: true, payToolMode: "push", stage });
    return [stage, buildFirstUpdate(c)];
  }));
  const dflt = compileTakeover(s.state, policy, { deployId: DEPLOY_ID, keytermsEnabled: false, payToolMode: "push" });
  return {
    id: s.id, scenario: s.scenario, caseId: s.state.caseId, readiness: s.state.readiness, fields: compactFields(s.state),
    greeting: compileGreeting(s.state, policy),
    caseJson: caseStateJson(s.state, policy),
    prompts,
    firstUpdates,
    takeover: { stage: dflt.stage, transcriptionMode: dflt.transcriptionMode, vaSessionCapMs: dflt.vaSessionCapMs, voice: dflt.voice, keyterms: dflt.keyterms },
    nextStep: nextStepOf(s.state),
    values: moneyOf(s.state, s.scenario),
    disclosures: disclosuresOf(s.state, s.scenario),
  };
}

function random(s: NamedSnapshot) {
  const policy = policyOf(s.scenario);
  return {
    id: s.id, scenario: s.scenario, caseId: s.state.caseId, readiness: s.state.readiness, fields: compactFields(s.state),
    greeting: compileGreeting(s.state, policy),
    caseJson: caseStateJson(s.state, policy),
    promptSha: Object.fromEntries(STAGES.map((stage) => [stage, sha(compilePrompt(s.state, policy, stage, { deployId: DEPLOY_ID, payToolMode: "push" }))])),
    capMs: vaSessionCapMs(s.state, DEFAULT_VA_CAP_ENV),
    transcriptionMode: inputModeFor(nextStepOf(s.state)).mode,
    values: moneyOf(s.state, s.scenario),
    disclosureSha: sha(JSON.stringify(disclosuresOf(s.state, s.scenario))),
  };
}

/** Phrase table: every field × every enum value × {verified name, no name} × {raw with and without "roommate"}. */
function phrases() {
  const policy = policyOf("s01");
  const t = truthOf("s01");
  const withName = stateOf(policy, { driver_full_name: { status: "VERIFIED", value: "maya raman" }, vehicle_assignment: { status: "VERIFIED", value: "veh1" } }, "case_phr_a");
  const noName = stateOf(policy, {}, "case_phr_b");
  const valuesOf = (f: FieldId): string[] => {
    const k = fieldKindOf(f);
    if (k?.t === "enum") return [...k.values];
    if (f === "vehicle_assignment") return ["veh1", "veh2", "all"];
    if (f === "incidents_3y") return ["none", "one speeding ticket, March 2025"];
    if (f === "license_number") return ["RM123456"];
    if (f === "underwriting_review") return ["true", "false"];
    if (f === "coverage_change") return ["keep current limits"];
    return t[f] !== undefined ? [t[f]!] : [];
  };
  const out: unknown[] = [];
  for (const [label, snap] of [["verified_name", withName], ["no_name", noName]] as const) {
    const pc = greetingPhraseCtx(snap, policy);
    for (const f of FIELD_IDS) {
      out.push({ snapshot: label, field: f, kind: "ask", text: askPhrase(f, pc) });
      for (const v of valuesOf(f)) {
        for (const raw of [null, "my roommate", "child (daughter)"]) {
          out.push({ snapshot: label, field: f, value: v, raw, kind: "confirm", text: confirmPhrase(f, v, { ...pc, raw }) });
        }
      }
    }
  }
  return { snapshots: { verified_name: compactFields(withName), no_name: compactFields(noName) }, phrases: out };
}

function staticPart() {
  const policies: Record<string, PolicyRecord> = {};
  const ratings: Record<string, unknown> = {};
  const listeningKeyterms: Record<string, string[]> = {};
  for (const id of SCENARIO_IDS) { policies[id] = policyOf(id); ratings[id] = ratingOf(id); listeningKeyterms[id] = keytermsFromPolicy(policyOf(id)); }
  const flags = [false, true];
  const nextStageTable: unknown[] = [];
  for (const current of [null, ...STAGES] as (Stage | null)[]) for (const ready of flags) for (const esign of flags) for (const paid of flags) {
    const s = {
      readiness: { verified: 0, pending: 0, missing: 0, requiredTotal: 10, ready },
      disclosuresGiven: esign ? ["premium_change", "esign_consent"] as ("premium_change" | "esign_consent")[] : [],
      payment: paid ? { id: "pay_1", status: "succeeded" as const, amountCents: 100, provider: "mock" as const } : null,
    };
    nextStageTable.push({ current, ready, esign, paid, next: nextStage(current, s as never) });
  }
  return {
    policies, ratings, listeningKeyterms,
    tools: Object.fromEntries(STAGES.map((stage) => [stage, toolsForStage(stage, { payToolMode: "push" })])),
    extractor: { prompt: EXTRACTOR_PROMPT_V3, format: ADD_DRIVER_PATCH_FORMAT, versionId: EXTRACTOR_VERSION_V3 },
    nextStageTable,
  };
}

function normalizeCorpus() {
  return normalizeInputs().map((i) => {
    const policy = policyOf(i.scenario);
    const r = normalizeField(i.field, i.raw, { policy, callDate: policy.callDate });
    return {
      ...i, result: r,
      spokenForms: r ? spokenForms(i.field, r.norm, policy) : null,
      display: r ? displayValue(i.field, r.norm, policy, i.raw) : null,
    };
  });
}

function extractorInputs() {
  const fx = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "extract", "s01-dialog.json"), "utf8")) as {
    callDate: string; turns: { turnId: string; channel: "rep" | "customer"; text: string }[];
  };
  const out: unknown[] = [];
  const states: [string, NamedSnapshot][] = namedSnapshots().filter((s) => s.scenario === "s01" && s.id.startsWith("s01")).map((s) => [s.id, s]);
  for (const [label, s] of states) {
    for (let i = 0; i < fx.turns.length; i += 3) {
      const newTurns = fx.turns.slice(i, i + 3);
      const recent = fx.turns.slice(0, i);
      out.push({ state: label, from: i, input: buildExtractorInput({ callDate: fx.callDate, policy: policyOf("s01"), state: s.state, recent, newTurns }) });
    }
  }
  return out;
}

export function buildOracle(): Record<string, unknown> {
  const namedList = namedSnapshots();
  const randomList = randomSnapshots();
  const meta = {
    oracle: "scripts/relay/snapshot-legacy.ts (legacy Baton code)",
    deployId: DEPLOY_ID, payToolMode: "push",
    promptVersion: PROMPT_VERSION, extractorVersion: EXTRACTOR_VERSION_V3, greetingMaxWords: GREETING_MAX_WORDS,
    counts: { named: namedList.length, random: randomList.length },
  };
  return {
    "meta.json": meta,
    "static.json": staticPart(),
    "named.json": namedList.map(named),
    "random.json": randomList.map(random),
    "phrases.json": phrases(),
    "normalize.json": normalizeCorpus(),
    "extractor-inputs.json": extractorInputs(),
  };
}

const isMain = process.argv[1] && /snapshot-legacy\.ts$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  const files = buildOracle();
  const check = process.argv.includes("--check");
  let diffs = 0;
  mkdirSync(PARITY_DIR, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    const text = `${JSON.stringify(data, null, 1)}\n`;
    const path = join(PARITY_DIR, name);
    if (check) {
      let old = "";
      try { old = readFileSync(path, "utf8"); } catch { /* missing */ }
      if (old !== text) { diffs++; console.error(`DIFF ${name}`); }
    } else {
      writeFileSync(path, text);
      console.log(`wrote ${name} (${text.length} chars)`);
    }
  }
  if (check) { console.log(diffs ? `${diffs} file(s) differ` : "oracle up to date"); process.exit(diffs ? 1 : 0); }
}
