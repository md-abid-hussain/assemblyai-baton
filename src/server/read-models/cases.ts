import "server-only";

/**
 * `CasesReadModel` (SAAS §6.2): the evidence-linked case record behind `/app/runs/[id]` and `GET /api/v1/cases/{id}`.
 *
 * It reshapes the `CaseState` the engine already maintains (DESIGN §4.4) into the read-only rows the run detail
 * page renders — field, status, value, the reason in words, and up to three evidence quotes with their
 * timecodes. Nothing is recomputed here: a read model that re-derived status would eventually disagree with the
 * console, and the whole point of the page is that the two tell the same story.
 *
 * The verbatim disclosure results come from the verified QA result (`verifications.qa`), so a disclosure reads
 * "given and matched" only when the recording says so.
 */
import { DISCLOSURE_KINDS, type CaseState, type DisclosureKind, type Evidence, type FieldState } from "../../core/contracts/case";
import type { QaResult } from "../../core/contracts/events";
import type {
  CaseRecordView, DisclosureRowView, EvidenceView, FieldRowView, PaymentSummaryView,
} from "../../core/contracts/ext/wp20-app";
import { REQUIRED_FIELDS, fieldLabelOf } from "../../core/intents/add-driver.fields";
import type { FieldId } from "../../core/contracts/case";
import { getDb, type Db } from "../db";
import { and, desc, eq, sql } from "drizzle-orm";
import { payments } from "../db/schema";
import { casesOrgFilter } from "./tenant";

const WHO: Readonly<Record<Evidence["channel"], string>> = Object.freeze({
  rep: "the rep",
  customer: "the customer",
  ai: "the AI",
  customer_ai: "the customer (to the AI)",
});

const mmss = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * The same sentence WP7's `reasonText` shows in the console tooltip, resolved on the server so the read-only
 * page needs no store. Kept in sync by the shared `StatusReason` union: a new reason is a type error here.
 */
export function reasonSentence(f: FieldState): string {
  const ev = f.evidence[0];
  const at = ev ? ` at ${mmss(ev.startMs)}` : f.updatedAtMs ? ` at ${mmss(f.updatedAtMs)}` : "";
  const by = ev ? WHO[ev.channel] : "";
  const map: Record<FieldState["reason"], string> = {
    acknowledged: `Acknowledged by ${by || "the other party"}${at}.`,
    read_back: `Read back by ${by || "the rep"}${at}.`,
    both_stated: `Stated by both parties${at}.`,
    policy_record: "From the policy record.",
    ai_confirmed: "Confirmed by the customer to the AI.",
    stated_once: `Stated once by ${by || "one party"}${at}; not confirmed yet.`,
    late_turn: "Arrived after the pass; the AI did not rely on it.",
    conflict: "The parties said different things.",
    denied: `Denied${at}.`,
    verifier_disagrees: "The verifier disagrees, so it stays pending.",
    verifier_only: "Only the verifier heard it; the AI will confirm it.",
    rep_only_violation: "Only the rep can verify this field.",
    out_of_range: "Outside the allowed date window; the AI will confirm it.",
    absent: "Not mentioned yet.",
  };
  return map[f.reason];
}

const evidenceView = (e: Evidence): EvidenceView => ({
  channel: e.channel,
  startMs: e.startMs,
  endMs: e.endMs,
  quote: e.quote,
  source: e.source,
});

function fieldRow(f: FieldState, required: boolean): FieldRowView {
  return {
    field: f.field,
    label: fieldLabelOf(f.field),   // P§4.7 widening: `f.field` is any relay field id, not the closed Baton enum
    status: f.status,
    conflict: f.reason === "conflict" || (f.conflict !== null && f.status !== "VERIFIED"),
    value: f.display ?? f.value,
    reason: reasonSentence(f),
    evidence: f.evidence.map(evidenceView),
    required,
  };
}

function disclosureRows(state: CaseState, qa: QaResult | null): DisclosureRowView[] {
  const given = new Set<DisclosureKind>(state.disclosuresGiven);
  const checked = new Map(qa?.disclosures.map((d) => [d.kind, d]) ?? []);
  return DISCLOSURE_KINDS.filter((k) => given.has(k) || checked.has(k)).map((kind) => {
    const c = checked.get(kind);
    return {
      kind,
      given: given.has(kind),
      similarity: c ? c.similarity : null,
      ok: c ? c.ok : null,
      missingCritical: c ? [...c.missingCritical] : [],
    };
  });
}

/** The required fields first, in their canonical order, then any other field that actually carries a value. */
export function caseRecordOf(state: CaseState, qa: QaResult | null): CaseRecordView {
  const required = new Set<FieldId>(REQUIRED_FIELDS);
  const req = REQUIRED_FIELDS.map((id) => state.fields[id]).filter((f): f is FieldState => !!f);
  const extra = (Object.values(state.fields) as FieldState[]).filter(
    (f) => !required.has(f.field) && f.value !== null && f.status !== "MISSING",
  );
  return {
    caseId: state.caseId,
    intent: state.intent,
    stage: state.stage,
    readiness: {
      verified: state.readiness.verified,
      pending: state.readiness.pending,
      missing: state.readiness.missing,
      requiredTotal: state.readiness.requiredTotal,
      ready: state.readiness.ready,
    },
    fields: [...req.map((f) => fieldRow(f, true)), ...extra.map((f) => fieldRow(f, false))],
    disclosures: disclosureRows(state, qa),
    confirmationNumber: state.confirmationNumber,
  };
}

export class CasesReadModel {
  constructor(private readonly db: Db = getDb()) {}

  /**
   * The newest payment of a run this org owns. The tenant predicate is applied to the **case**, not the payment,
   * so a payment id from another org can never be reached by guessing (SAAS §10.1 rule 2).
   */
  async payment(orgId: string, caseId: string): Promise<PaymentSummaryView | null> {
    const tenant = await casesOrgFilter(this.db, orgId);
    const owns = await this.db.execute(sql`select 1 as ok from cases c where ${tenant} and c.id = ${caseId} limit 1`);
    if (owns.rows.length === 0) return null;
    const [p] = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.caseId, caseId)))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    if (!p) return null;
    return {
      id: p.id,
      status: p.status,
      amountCents: p.amountCents,
      totalAmountCents: p.totalAmountCents,
      provider: p.provider,
      simulated: p.simulated,
      statusSource: p.statusSource,
      failureReason: p.failureReason,
      updatedAt: p.updatedAt.toISOString(),
    };
  }
}

export const casesReadModel = (db?: Db): CasesReadModel => new CasesReadModel(db ?? getDb());
