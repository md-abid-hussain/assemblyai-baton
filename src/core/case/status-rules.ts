/**
 * case/status-rules.ts - `deriveField` (DESIGN §5.4.2) and the verifier overlay (§5.4.3). Pure.
 *
 * Applied per field over the case's events sorted by `(turnEndMs, seq)`. VERIFIED needs a cross-party
 * confirmation (ack, read-back, both stated), a policy record or an accepted AI tool update; the verifier (sol)
 * can only downgrade or fill a MISSING field as PENDING, never upgrade.
 *
 * WP14a·3: every export takes an optional trailing `spec?: IntentSpec` (TASKS-v2 §2 rule 9). Without it the Baton
 * functions run unchanged; with it, normalize/display/compare/rep-only/range come from the spec (case/field-ops.ts).
 */
import type {
  ConflictCard, Evidence, FactEvent, FieldId, FieldState, Party, PolicyRecord, StatusReason,
} from "../contracts/case";
import type { VerifierResult } from "../contracts/extract";
import type { IntentSpec } from "../contracts/v2/relay";
import { compatible } from "../intents/add-driver";
import { fieldOps } from "./field-ops";
import { emptyFieldState } from "./state";

/** A fact event as derivation needs it: `seq` is optional (cached/sweep events have none; array order breaks ties). */
export type DerivableEvent = Omit<FactEvent, "seq"> & { seq?: number };

type FieldFlag = FieldState["flags"][number];

/** The verifier's latest opinion about one field (normalized). */
export interface VerifierOpinion {
  valueNorm: string | null;
  support: "stated_and_confirmed" | "stated_once" | "conflicting";
  evidence: Evidence | null;
  turnEndMs: number;
}
export type VerifierView = ReadonlyMap<FieldId, VerifierOpinion>;

export interface FieldDeriveCtx {
  policy: PolicyRecord;
  callDate: string;
  /** When set, human (extractor) events whose turn ended after the arm point count as late (§5.5.4 rule 2). */
  tArmMs: number | null;
  /** The §5.5 late/cut rule (v2 disables it, §6.4). */
  lateCut: boolean;
  /** The latest verifier run (empty map = no run, or the `verifier_off` ablation). */
  verifier: VerifierView;
}

export interface FieldDerivation {
  state: FieldState;
  card: ConflictCard | null;
}

const HUMAN_KINDS = new Set(["stated", "readback", "ack", "corrected", "denied"]);

export function isLate(e: DerivableEvent, tArmMs: number | null): boolean {
  return e.late || (tArmMs !== null && HUMAN_KINDS.has(e.kind) && e.turnEndMs > tArmMs);
}

const SUPPORT_OF_CONFIDENCE: Record<FactEvent["confidence"], VerifierOpinion["support"]> = {
  high: "stated_and_confirmed", medium: "stated_once", low: "conflicting",
};

/**
 * The verifier view: from the latest `VerifierResult` when the caller has it (preferred: a run that agrees
 * inserts no events, so only the result can clear an older disagreement), else from the `kind:"verifier"` events
 * of the latest run (all events of one run share `turnEndMs = uptoRecvMs`).
 */
export function verifierViewOf(
  events: readonly DerivableEvent[],
  result: VerifierResult | null | undefined,
  ctx: { policy: PolicyRecord; callDate: string },
  spec?: IntentSpec,
): Map<FieldId, VerifierOpinion> {
  const view = new Map<FieldId, VerifierOpinion>();
  if (result) {
    const ops = fieldOps(ctx, spec);
    for (const f of result.fields) {
      if (f.support === "absent") continue;
      const n = f.value === null ? null : (ops.normalize(f.field, f.value)?.norm ?? null);
      view.set(f.field, { valueNorm: n, support: f.support, evidence: null, turnEndMs: result.uptoRecvMs });
    }
    return view;
  }
  const ver = events.filter((e) => e.kind === "verifier");
  if (!ver.length) return view;
  const latest = Math.max(...ver.map((e) => e.turnEndMs));
  for (const e of ver) {
    if (e.turnEndMs !== latest) continue;
    view.set(e.field, { valueNorm: e.valueNorm, support: SUPPORT_OF_CONFIDENCE[e.confidence], evidence: e.evidence, turnEndMs: e.turnEndMs });
  }
  return view;
}

/** §5.4.3: sol reports a non-absent support with a value not compatible with `v`. */
export function verifierDisagrees(field: FieldId, v: string, view: VerifierView, spec?: IntentSpec): boolean {
  const o = view.get(field);
  return !!o && o.valueNorm !== null && !(spec ? spec.compatible(field, v, o.valueNorm) : compatible(field, v, o.valueNorm));
}

function reasonOf(e: DerivableEvent): StatusReason {
  switch (e.kind) {
    case "policy": return "policy_record";
    case "tool_update": return "ai_confirmed";
    case "ack": return "acknowledged";
    case "readback": return "read_back";
    default: return "both_stated";
  }
}

const evidenceOf = (evs: readonly DerivableEvent[]): Evidence[] => {
  const seen = new Set<string>();
  const out: { ev: Evidence; at: number; seq: number }[] = [];
  evs.forEach((e, i) => {
    if (!e.evidence) return;
    const key = `${e.evidence.turnId}|${e.evidence.startMs}|${e.evidence.endMs}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ev: e.evidence, at: e.turnEndMs, seq: e.seq ?? i });
  });
  return out.sort((a, b) => b.at - a.at || b.seq - a.seq).slice(0, 3).map((x) => x.ev);
};

/**
 * `deriveField(field, evs, ctx)` (§5.4.2). `evs` = this field's events in `(turnEndMs, seq)` order; `question`
 * events are ignored; `verifier` events are read only through `ctx.verifier`.
 */
export function deriveField(field: FieldId, evs: readonly DerivableEvent[], ctx: FieldDeriveCtx, spec?: IntentSpec): FieldDerivation {
  const ops = fieldOps(ctx, spec);
  let cur: { value: string; party: Party; supports: DerivableEvent[] } | null = null;
  let confirmedBy: DerivableEvent | null = null;
  let conflict: DerivableEvent[] = [];
  let denied = false;
  let aiConfirmed = false;
  let corrected: { old: { value: string; party: Party; supports: DerivableEvent[] }; by: DerivableEvent } | null = null;
  let updatedAtMs = 0;

  for (const e of evs) {
    if (e.kind === "question" || e.kind === "verifier") continue;
    updatedAtMs = Math.max(updatedAtMs, e.turnEndMs);
    if (e.valueNorm === null && e.kind !== "ack" && e.kind !== "denied") continue;
    switch (e.kind) {
      case "policy":
        cur = { value: e.valueNorm!, party: "policy", supports: [e] };
        confirmedBy = e;
        break;
      case "tool_update": // an accepted update_case_field / confirm_effective_date in the AI half (§5.8)
        if (cur && confirmedBy && !ops.compatible(field, cur.value, e.valueNorm)) corrected = { old: cur, by: e };
        cur = { value: e.valueNorm!, party: "ai", supports: [e] };
        confirmedBy = e; aiConfirmed = true; conflict = []; denied = false;
        break;
      case "stated":
      case "readback":
      case "corrected": {
        const v = e.valueNorm!;
        if (!cur || !ops.compatible(field, cur.value, v)) {
          if (cur && e.kind !== "corrected" && e.party !== cur.party && !confirmedBy) conflict = [...cur.supports, e];
          if (e.kind === "corrected" || !cur || confirmedBy === null || e.party === cur.party) {
            cur = { value: v, party: e.party, supports: [e] }; confirmedBy = null; denied = false;
            if (e.kind === "corrected") conflict = [];
          } else if (e.party !== cur.party) {
            // A new value contradicting a CONFIRMED value by the other party → conflict only (keep cur).
            conflict = [...cur.supports, e];
          }
        } else {
          cur.supports.push(e);
          cur.value = ops.merge(field, cur.value, v);
          if (e.party !== cur.party && !confirmedBy) confirmedBy = e; // read_back / both_stated
        }
        break;
      }
      case "ack":
        if (cur && e.party !== cur.party && (e.valueNorm === null || ops.compatible(field, cur.value, e.valueNorm))
            && (e.acknowledgesTurnId === null || cur.supports.some((s) => s.turnId === e.acknowledgesTurnId))) {
          confirmedBy ??= e;
        }
        break;
      case "denied":
        if (cur && e.party !== cur.party) { denied = true; confirmedBy = null; }
        break;
    }
  }

  const base = emptyFieldState(field);
  const flags = new Set<FieldFlag>();
  let card: ConflictCard | null = null;

  if (!cur) {
    const o = ctx.verifier.get(field);
    if (o && o.valueNorm !== null) {
      return {
        state: {
          ...base, status: "PENDING", reason: "verifier_only", value: o.valueNorm,
          display: ops.display(field, o.valueNorm), source: "verifier",
          evidence: o.evidence ? [o.evidence] : [], updatedAtMs: Math.max(updatedAtMs, o.turnEndMs),
        },
        card: null,
      };
    }
    return { state: { ...base, updatedAtMs }, card: null };
  }

  const c = cur;
  const involved = confirmedBy ? [confirmedBy, ...c.supports] : [...c.supports];
  if (involved.some((x) => isLate(x, ctx.tArmMs))) flags.add("late_turn");
  if (involved.some((x) => x.cut)) flags.add("cut_turn");
  const disagrees = verifierDisagrees(field, c.value, ctx.verifier, spec);
  if (disagrees) flags.add("verifier_disagrees");
  if (corrected) {
    flags.add("customer_corrected_verified");
    card = {
      field,
      values: [
        { value: corrected.old.value, party: corrected.old.party, evidence: corrected.old.supports.at(-1)?.evidence ?? null },
        { value: c.value, party: "ai", evidence: corrected.by.evidence },
      ],
      resolved: false,
      resolution: "ai_recorded_customer_correction",
    };
  }

  let status: FieldState["status"] = "PENDING";
  let reason: StatusReason;
  let conflictState: FieldState["conflict"] = null;
  if (ops.repOnly(field) && !c.supports.some((s) => s.party === "rep" || s.party === "ai")) reason = "rep_only_violation";
  else if (conflict.length && !aiConfirmed) {
    reason = "conflict";
    const values = [...new Set(conflict.map((e) => e.valueNorm!))];
    conflictState = { values, evidence: conflict.flatMap((e) => (e.evidence ? [e.evidence] : [])).slice(-3) };
    card = {
      field,
      values: conflict.map((e) => ({ value: e.valueNorm!, party: e.party, evidence: e.evidence })),
      resolved: false,
    };
  } else if (denied) reason = "denied";
  else if (!confirmedBy) reason = "stated_once";
  else if (ctx.lateCut && !aiConfirmed && involved.some((x) => isLate(x, ctx.tArmMs) || x.cut)) reason = "late_turn";
  else if (disagrees && !aiConfirmed) reason = "verifier_disagrees";
  else { status = "VERIFIED"; reason = reasonOf(confirmedBy); }

  if (!ops.inRange(field, c.value)) {
    flags.add("out_of_range");
    status = "PENDING";
    reason = "out_of_range";
  }

  const rawOf = [...c.supports].reverse().find((s) => s.valueRaw !== null)?.valueRaw ?? null;
  return {
    state: {
      field,
      status,
      reason,
      value: c.value,
      display: ops.display(field, c.value, rawOf),
      source: c.party,
      evidence: evidenceOf([...(confirmedBy ? [confirmedBy] : []), ...c.supports, ...conflict]),
      conflict: conflictState,
      flags: [...flags],
      updatedAtMs,
    },
    card,
  };
}
