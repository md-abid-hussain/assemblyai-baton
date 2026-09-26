import "server-only";

import { createHash } from "node:crypto";

import type { CaseState, Evidence, FieldId, FieldState, NewFactEvent, PolicyRecord, Readiness } from "../../core/contracts/case";
import type { RawPatch, VerifierResult } from "../../core/contracts/extract";
import type { TurnInput } from "../../core/contracts/turns";
import { FIELD_IDS, REQUIRED_FIELDS, REQUIRED_SET, SERVER_RESOLVABLE_SET } from "../../core/intents/add-driver.fields";
import type { CaseEngine, EngineApplyCtx, EngineDeriveCtx, EngineEvent, ExtractorArtefacts } from "./engine";

/**
 * PRE-G1 STAND-IN for WP1's case engine (`src/core/case/**` on wp/wp1). It exists so WP3's repository, services and
 * routes run and are tested before the merge; it is NOT the product derivation. It keeps WP1's contracts where WP3
 * depends on them (event ids `${caseId}:${turnId}:${index}`, (turnEndMs, seq) ordering, verifier encoding, "sol never
 * upgrades"), and simplifies the rest (normalization = trimmed lower case; no age rule, no REP_ONLY check).
 * The extractor prompt and schema are DESIGN §5.3 verbatim (identical to WP1's `EXTRACTOR_PROMPT_V3` /
 * `ADD_DRIVER_PATCH_FORMAT`), so the live extractor test measures the real prompt.
 */

export const STUB_EXTRACTOR_PROMPT_V3 = `You extract facts for an insurance policy-change case from a phone call between an agency REP and a policyholder CUSTOMER.
Intent: add a driver to a personal auto policy. You see the current case, recent turns, and one or more NEW TURNS.
Emit events ONLY for what the NEW TURNS say. Never repeat facts from earlier turns unless a NEW TURN restates, reads back,
confirms, corrects or denies them. Never invent values. If nothing relevant is said, return {"events": [], "no_facts": true}.

Fields (value formats):
- driver_full_name: the new driver's name as spoken ("Maya", "Maya Raman").
- driver_dob: YYYY-MM-DD.            - driver_age: integer years ("17").
- driver_relation: one of spouse, domestic_partner, child, stepchild, parent, sibling, other_relative,
  non_relative_resident, non_relative_nonresident.
- license_state: 2-letter US state code ("OH").   - license_number: as spoken, digits/letters only.
- license_status: one of learner_permit, provisional (probationary), full.
- incidents_3y: "none", or a short description of tickets/accidents/claims in the last 3 years.
- vehicle_assignment: the policy vehicle the new driver will mainly drive, as its id from POLICY VEHICLES ("veh1").
- operator_type: primary or occasional (for that vehicle).
- garaging_zip: 5-digit ZIP where that vehicle is kept overnight.
- effective_date: YYYY-MM-DD. Resolve relative dates ("tomorrow", "next Friday") against CALL DATE.
- good_student_discount, driver_training_discount, distant_student_discount, mature_driver_discount:
  eligible, not_eligible or pending_proof.
- coverage_change: short text of what the customer decided about coverage ("keep current limits").
- underwriting_review: "true" or "false".
- premium_new_monthly_usd, premium_change_monthly_usd, amount_due_today_usd: dollars with cents ("142.00", "-12.50").
  Only the REP can state these.
Event kinds:
- stated: the speaker gives a value, or proposes one in a question ("Is that the Civic?").
- readback: the speaker repeats a value the OTHER party gave, to check it.
- ack: the speaker affirms the other party's latest statement/readback ("yes", "that's right", "correct"). Set
  acknowledges_turn_id to that turn; value = the value being affirmed (or null if unclear).
- corrected: the speaker replaces an earlier value with a new one.
- denied: the speaker says an earlier value is wrong without giving a new one (value null).
- question: the speaker asks for a field without proposing a value (value null).
quote: the shortest exact span of the NEW TURN (verbatim, same casing) that carries the event.
turn_id: the id of the NEW TURN the event comes from.`;

export const STUB_PATCH_FORMAT = {
  name: "add_driver_patch",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["events", "no_facts"],
    properties: {
      no_facts: { type: "boolean" },
      events: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["turn_id", "field", "kind", "value", "quote", "acknowledges_turn_id", "confidence"],
          properties: {
            turn_id: { type: "string" },
            field: { type: "string", enum: [...FIELD_IDS] },
            kind: { type: "string", enum: ["stated", "readback", "ack", "corrected", "denied", "question"] },
            value: { type: ["string", "null"] },
            quote: { type: "string" },
            acknowledges_turn_id: { type: ["string", "null"] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
        },
      },
    },
  } as Record<string, unknown>,
};

const sha12 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);

export const STUB_EXTRACTOR: ExtractorArtefacts = {
  prompt: STUB_EXTRACTOR_PROMPT_V3,
  format: STUB_PATCH_FORMAT,
  model: "gpt-6-luna",
  effort: "none",
  version: sha12(STUB_EXTRACTOR_PROMPT_V3 + JSON.stringify(STUB_PATCH_FORMAT.schema) + "gpt-6-luna" + "none"),
  maxNewTurns: 3,
  recentTurns: 6,
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const norm = (v: string): string => v.trim().toLowerCase().replace(/\s+/g, " ");
const compatible = (a: string, b: string): boolean => norm(a) === norm(b);

function emptyField(field: FieldId): FieldState {
  return { field, status: "MISSING", reason: "absent", value: null, display: null, source: null, evidence: [], conflict: null, flags: [], updatedAtMs: 0 };
}

function readinessOf(fields: Record<FieldId, FieldState>): Readiness {
  let verified = 0, pending = 0, missing = 0, ready = true;
  for (const f of REQUIRED_FIELDS) {
    const st = fields[f]?.status ?? "MISSING";
    if (st === "VERIFIED") verified++;
    else if (st === "PENDING") pending++;
    else missing++;
    if (st !== "VERIFIED" && !SERVER_RESOLVABLE_SET.has(f)) ready = false;
  }
  return { verified, pending, missing, requiredTotal: REQUIRED_FIELDS.length, ready };
}

function emptyCaseState(caseId: string): CaseState {
  const fields = Object.fromEntries(FIELD_IDS.map((f) => [f, emptyField(f)])) as Record<FieldId, FieldState>;
  return {
    caseId, intent: "add_driver", version: 0, callClockMs: 0, fields, readiness: readinessOf(fields), conflicts: [],
    stage: null, disclosuresGiven: [], payment: null, confirmationNumber: null,
  };
}

function sortEvents<E extends EngineEvent>(events: readonly E[]): E[] {
  return events.map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.turnEndMs - b.e.turnEndMs || (a.e.seq ?? a.i) - (b.e.seq ?? b.i) || a.i - b.i)
    .map((x) => x.e);
}

const HUMAN = new Set(["stated", "readback", "ack", "corrected", "denied"]);

function deriveCaseState(policy: PolicyRecord, events: readonly EngineEvent[], ctx: EngineDeriveCtx): CaseState {
  void policy;
  const sorted = sortEvents(events);
  const tArm = ctx.tArmMs ?? null;
  const st = emptyCaseState(ctx.caseId);
  for (const field of FIELD_IDS) {
    let cur: { value: string; party: string; supports: EngineEvent[] } | null = null;
    let confirmed: EngineEvent | null = null;
    let ai = false;
    for (const e of sorted) {
      if (e.field !== field || e.kind === "question" || e.kind === "verifier") continue;
      if (e.valueNorm === null && e.kind !== "ack" && e.kind !== "denied") continue;
      if (e.kind === "tool_update" || e.kind === "policy") {
        cur = { value: e.valueNorm!, party: e.party, supports: [e] };
        confirmed = e;
        ai = e.kind === "tool_update";
      } else if (e.kind === "ack") {
        if (cur && e.party !== cur.party && (e.valueNorm === null || compatible(cur.value, e.valueNorm))) confirmed ??= e;
      } else if (e.kind === "denied") {
        if (cur && e.party !== cur.party) confirmed = null;
      } else if (!cur || !compatible(cur.value, e.valueNorm!)) {
        cur = { value: e.valueNorm!, party: e.party, supports: [e] };
        confirmed = null;
        ai = false;
      } else {
        cur.supports.push(e);
        if (e.party !== cur.party && !confirmed) confirmed = e;
      }
    }
    if (!cur) continue;
    const involved = [...cur.supports, ...(confirmed ? [confirmed] : [])];
    const late = !ai && involved.some((x) => x.late || x.cut || (tArm !== null && HUMAN.has(x.kind) && x.turnEndMs > tArm));
    const ver = ctx.verifier?.fields.find((f) => f.field === field && f.support !== "absent" && f.value !== null);
    const disagrees = !ai && !!ver && !compatible(ver.value!, cur.value);
    const evidence = involved.map((x) => x.evidence).filter((x): x is Evidence => !!x).reverse().slice(0, 3);
    const status = confirmed && !late && !disagrees ? "VERIFIED" : "PENDING";
    st.fields[field] = {
      field, status,
      reason: status === "VERIFIED" ? (ai ? "ai_confirmed" : confirmed!.kind === "ack" ? "acknowledged" : confirmed!.kind === "readback" ? "read_back" : "both_stated")
        : !confirmed ? "stated_once" : late ? "late_turn" : "verifier_disagrees",
      value: cur.value, display: cur.value, source: cur.party as FieldState["source"], evidence, conflict: null,
      flags: [...(late ? (["late_turn"] as const) : []), ...(disagrees ? (["verifier_disagrees"] as const) : [])],
      updatedAtMs: Math.max(...involved.map((x) => x.turnEndMs)),
    };
  }
  st.readiness = readinessOf(st.fields);
  st.version = ctx.version ?? 0;
  st.callClockMs = ctx.callClockMs ?? (sorted.length ? Math.max(...sorted.map((e) => e.turnEndMs)) : 0);
  st.stage = ctx.stage ?? null;
  st.disclosuresGiven = ctx.disclosuresGiven ?? [];
  st.payment = ctx.payment ?? null;
  st.confirmationNumber = ctx.confirmationNumber ?? null;
  return st;
}

const evidenceOf = (turn: TurnInput, quote: string): Evidence => ({
  channel: turn.channel, turnId: turn.turnId, startMs: turn.startMs, endMs: turn.endMs,
  quote: (quote.trim() || turn.text).slice(0, 200), source: turn.source === "stt_cache" ? "stt_cache" : "stt_live",
});

function applyExtraction(raw: RawPatch, turns: readonly TurnInput[], ctx: EngineApplyCtx): NewFactEvent[] {
  const byId = new Map(turns.map((t) => [t.turnId, t]));
  const out: NewFactEvent[] = [];
  raw.events.forEach((e, index) => {
    const turn = byId.get(e.turn_id);
    if (!turn) return;
    if (e.kind !== "question" && e.kind !== "ack" && e.kind !== "denied" && (e.value === null || !e.value.trim())) return;
    const value = e.kind === "question" ? null : e.value;
    out.push({
      id: ctx.newId ? ctx.newId(turn.turnId, index) : `${ctx.caseId}:${turn.turnId}:${index}`,
      caseId: ctx.caseId, field: e.field, kind: e.kind, party: turn.channel, valueRaw: value,
      valueNorm: value === null ? null : norm(value), acknowledgesTurnId: e.acknowledges_turn_id, confidence: e.confidence,
      turnId: turn.turnId, turnEndMs: turn.endMs, late: turn.late, cut: turn.cut, evidence: evidenceOf(turn, e.quote), extractor: "luna",
    });
  });
  return out;
}

const SUPPORT_CONFIDENCE = { stated_and_confirmed: "high", stated_once: "medium", conflicting: "low" } as const;

function verifierDisagreementEvents(result: VerifierResult, state: Pick<CaseState, "fields">, turns: readonly TurnInput[], ctx: EngineApplyCtx): NewFactEvent[] {
  const byId = new Map(turns.map((t) => [t.turnId, t]));
  const out: NewFactEvent[] = [];
  for (const f of result.fields) {
    if (f.support === "absent" || f.value === null) continue;
    const cur = state.fields[f.field];
    if (cur && cur.value !== null && compatible(cur.value, f.value)) continue;
    const cited = f.turnIds.map((id) => byId.get(id)).find((t): t is TurnInput => !!t);
    out.push({
      id: `${ctx.caseId}:verifier@${result.uptoRecvMs}:${f.field}`, caseId: ctx.caseId, field: f.field, kind: "verifier", party: "verifier",
      valueRaw: f.value, valueNorm: norm(f.value), acknowledgesTurnId: null, confidence: SUPPORT_CONFIDENCE[f.support], turnId: null,
      turnEndMs: result.uptoRecvMs, late: false, cut: false, evidence: cited ? evidenceOf(cited, f.quote) : null, extractor: "sol",
    });
  }
  return out;
}

function buildExtractorInput(i: Parameters<CaseEngine["buildExtractorInput"]>[0]): string {
  const [y, m, d] = i.callDate.split("-").map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  const caseObj: Record<string, { value: string | null; status: string }> = {};
  for (const f of FIELD_IDS) {
    const s = i.state.fields[f];
    if (s && s.status !== "MISSING") caseObj[f] = { value: s.value, status: s.status };
    else if (REQUIRED_SET.has(f)) caseObj[f] = { value: null, status: "MISSING" };
  }
  const sp = (t: { channel: string }) => (t.channel === "rep" ? "REP" : "CUSTOMER");
  return JSON.stringify({
    call_date: i.callDate,
    call_weekday: weekday,
    policy: {
      policyholder: `${i.policy.policyholder.firstName} ${i.policy.policyholder.lastName}`,
      vehicles: i.policy.vehicles.map((v) => ({ id: v.id, label: v.label })),
      address_zip: i.policy.address.zip,
      existing_drivers: i.policy.existingDrivers.map((x) => x.name),
    },
    case: caseObj,
    recent_turns: i.recent.slice(-STUB_EXTRACTOR.recentTurns).map((t) => ({ turn_id: t.turnId, speaker: sp(t), text: t.text })),
    new_turns: i.newTurns.map((t) => ({ turn_id: t.turnId, speaker: sp(t), text: t.text })),
  });
}

export const stubEngine: CaseEngine = {
  impl: "stub",
  emptyCaseState,
  deriveCaseState,
  applyExtraction,
  verifierDisagreementEvents,
  buildExtractorInput,
  extractor: STUB_EXTRACTOR,
};
