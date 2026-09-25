import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { CasePayment, CaseState, CaseStatus, DisclosureKind, Stage } from "../../core/contracts/case";
import type { Db } from "../db/client";
import { cases, payments, takeovers, toolCalls } from "../db/schema";
import type { PaymentRecord } from "../payments/store";
import { toPaymentRecord } from "../payments/store";

/**
 * What the tool layer persists (DESIGN §4.2, §5.8):
 * - `takeovers.stage` (the server's stage; WP5's compile sets the initial one);
 * - `takeovers.metrics.disclosures[kind]` (the exact text read, for the verbatim check), `metrics.confirmationNumber`,
 *   `metrics.toolFlow` (per-field update attempts, hand-back, pay-link details). Always MERGED into `metrics`
 *   (WP5 writes HUD numbers and provisional QA there too);
 * - `tool_calls` rows (idempotency on `(takeover_id, call_id)`);
 * - `cases.status` (`completed` on send_confirmation, `handed_back` on hand_back_to_rep).
 */

export interface DisclosureRecord {
  id: string;
  kind: DisclosureKind;
  text: string;
  criticalTokens: string[];
  monthlyUsd: string;
  dueTodayUsd: string;
  premiumSource: string;
  dueSource: string;
  at: string;
}

export interface ToolFlowMetrics {
  /** update_case_field attempts per field in this takeover (the conflict flow's "first attempt"). */
  fieldAttempts?: Record<string, number>;
  handBack?: { reason: string; summary: string; at: string };
  payLink?: { paymentId: string; paperCopyRequested: boolean; customerWords: string; at: string };
}

export interface TakeoverRecord {
  id: string;
  caseId: string;
  armedAt: Date;
  tArmMs: number;
  stage: Stage | null;
  phase: string;
  outcome: string | null;
  disclosures: Partial<Record<DisclosureKind, DisclosureRecord>>;
  confirmationNumber: string | null;
  toolFlow: ToolFlowMetrics;
}

export type BeginCall =
  | { fresh: true; id: string }
  | { fresh: false; id: string; result: Record<string, unknown> | null; status: string | null };

export interface ToolStore {
  getTakeover(id: string): Promise<TakeoverRecord | null>;
  setStage(id: string, stage: Stage): Promise<void>;
  putDisclosure(id: string, d: DisclosureRecord): Promise<void>;
  /** Set the confirmation number once; returns the stored one (first writer wins). */
  putConfirmationNumber(id: string, n: string): Promise<string>;
  mergeToolFlow(id: string, patch: ToolFlowMetrics): Promise<void>;
  setCaseStatus(caseId: string, status: CaseStatus, from: readonly CaseStatus[]): Promise<boolean>;
  beginCall(i: { id: string; takeoverId: string; callId: string; name: string; args: Record<string, unknown> }): Promise<BeginCall>;
  getCall(takeoverId: string, callId: string): Promise<{ id: string; result: Record<string, unknown> | null; status: string | null } | null>;
  finishCall(id: string, result: Record<string, unknown>, status: "ok" | "error" | "rejected"): Promise<void>;
  /** Drop an in-progress call whose handler threw, so a retry of the same call_id runs again. */
  abortCall(id: string): Promise<void>;
  latestPayment(takeoverId: string): Promise<PaymentRecord | null>;
}

type TkoRow = typeof takeovers.$inferSelect;

function toTakeoverRecord(r: TkoRow): TakeoverRecord {
  const m = (r.metrics ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    caseId: r.caseId,
    armedAt: r.armedAt,
    tArmMs: r.tArmMs,
    stage: (r.stage as Stage | null) ?? null,
    phase: r.phase,
    outcome: r.outcome ?? null,
    disclosures: (m.disclosures ?? {}) as TakeoverRecord["disclosures"],
    confirmationNumber: typeof m.confirmationNumber === "string" ? m.confirmationNumber : null,
    toolFlow: (m.toolFlow ?? {}) as ToolFlowMetrics,
  };
}

export class DbToolStore implements ToolStore {
  constructor(private readonly db: Db) {}

  async getTakeover(id: string): Promise<TakeoverRecord | null> {
    const [r] = await this.db.select().from(takeovers).where(eq(takeovers.id, id)).limit(1);
    return r ? toTakeoverRecord(r) : null;
  }

  async setStage(id: string, stage: Stage): Promise<void> {
    await this.db.update(takeovers).set({ stage }).where(eq(takeovers.id, id));
  }

  async putDisclosure(id: string, d: DisclosureRecord): Promise<void> {
    await this.db
      .update(takeovers)
      .set({
        metrics: sql`coalesce(${takeovers.metrics}, '{}'::jsonb) || jsonb_build_object('disclosures',
          coalesce(${takeovers.metrics}->'disclosures', '{}'::jsonb) || jsonb_build_object(${d.kind}::text, ${JSON.stringify(d)}::jsonb))`,
      })
      .where(eq(takeovers.id, id));
  }

  async putConfirmationNumber(id: string, n: string): Promise<string> {
    const [r] = await this.db
      .update(takeovers)
      .set({ metrics: sql`coalesce(${takeovers.metrics}, '{}'::jsonb) || jsonb_build_object('confirmationNumber', ${n}::text)` })
      .where(and(eq(takeovers.id, id), sql`(${takeovers.metrics}->>'confirmationNumber') is null`))
      .returning({ metrics: takeovers.metrics });
    if (r) return n;
    const cur = await this.getTakeover(id);
    return cur?.confirmationNumber ?? n;
  }

  async mergeToolFlow(id: string, patch: ToolFlowMetrics): Promise<void> {
    await this.db
      .update(takeovers)
      .set({
        metrics: sql`coalesce(${takeovers.metrics}, '{}'::jsonb) || jsonb_build_object('toolFlow',
          coalesce(${takeovers.metrics}->'toolFlow', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
      })
      .where(eq(takeovers.id, id));
  }

  async setCaseStatus(caseId: string, status: CaseStatus, from: readonly CaseStatus[]): Promise<boolean> {
    const r = await this.db
      .update(cases)
      .set({ status, updatedAt: sql`now()` })
      .where(and(eq(cases.id, caseId), inArray(cases.status, [...from])))
      .returning({ id: cases.id });
    return r.length === 1;
  }

  async beginCall(i: { id: string; takeoverId: string; callId: string; name: string; args: Record<string, unknown> }): Promise<BeginCall> {
    const r = await this.db
      .insert(toolCalls)
      .values({ id: i.id, takeoverId: i.takeoverId, callId: i.callId, name: i.name, args: i.args })
      .onConflictDoNothing({ target: [toolCalls.takeoverId, toolCalls.callId] })
      .returning({ id: toolCalls.id });
    if (r.length === 1) return { fresh: true, id: i.id };
    const cur = await this.getCall(i.takeoverId, i.callId);
    return { fresh: false, id: cur?.id ?? i.id, result: cur?.result ?? null, status: cur?.status ?? null };
  }

  async getCall(takeoverId: string, callId: string) {
    const [r] = await this.db
      .select({ id: toolCalls.id, result: toolCalls.result, status: toolCalls.status })
      .from(toolCalls)
      .where(and(eq(toolCalls.takeoverId, takeoverId), eq(toolCalls.callId, callId)))
      .limit(1);
    return r ? { id: r.id, result: (r.result ?? null) as Record<string, unknown> | null, status: r.status ?? null } : null;
  }

  async finishCall(id: string, result: Record<string, unknown>, status: "ok" | "error" | "rejected"): Promise<void> {
    await this.db.update(toolCalls).set({ result, status, finishedAt: sql`now()` }).where(and(eq(toolCalls.id, id), isNull(toolCalls.finishedAt)));
  }

  async abortCall(id: string): Promise<void> {
    await this.db.delete(toolCalls).where(and(eq(toolCalls.id, id), isNull(toolCalls.finishedAt)));
  }

  async latestPayment(takeoverId: string): Promise<PaymentRecord | null> {
    const [r] = await this.db.select().from(payments).where(eq(payments.takeoverId, takeoverId)).orderBy(desc(payments.createdAt)).limit(1);
    return r ? toPaymentRecord(r) : null;
  }
}

// ------------------------------------------------------------------------------------------ flow overlay

/** The CaseState parts that are not derivable from fact events (WP1 `DeriveCtx.stage/disclosuresGiven/payment/confirmationNumber`). */
export interface FlowCtx {
  stage: Stage | null;
  disclosuresGiven: DisclosureKind[];
  payment: CasePayment | null;
  confirmationNumber: string | null;
}

export function casePaymentOf(p: PaymentRecord | null): CasePayment | null {
  if (!p) return null;
  return { id: p.id, status: p.status, amountCents: p.amountCents, totalAmountCents: p.totalAmountCents, provider: p.provider, simulated: p.simulated };
}

export function flowCtxOf(t: TakeoverRecord | null, p: PaymentRecord | null): FlowCtx {
  const order: DisclosureKind[] = ["premium_change", "esign_consent"];
  return {
    stage: t?.stage ?? null,
    disclosuresGiven: t ? order.filter((k) => t.disclosures[k] !== undefined) : [],
    payment: casePaymentOf(p),
    confirmationNumber: t?.confirmationNumber ?? null,
  };
}

/** Put the flow parts onto a derived state (pure). */
export function overlayFlow(state: CaseState, flow: FlowCtx): CaseState {
  return { ...state, stage: flow.stage, disclosuresGiven: flow.disclosuresGiven, payment: flow.payment, confirmationNumber: flow.confirmationNumber };
}

/**
 * For WP3's `recompute`/`applyEvents` (request wp6-to-wp3): the flow context of a case = its latest takeover + that
 * takeover's latest payment. Pass the result as WP1 `DeriveCtx.{stage, disclosuresGiven, payment, confirmationNumber}`.
 */
export async function loadFlowCtx(db: Db, caseId: string): Promise<FlowCtx> {
  const [t] = await db.select().from(takeovers).where(eq(takeovers.caseId, caseId)).orderBy(desc(takeovers.armedAt)).limit(1);
  if (!t) return flowCtxOf(null, null);
  const rec = toTakeoverRecord(t);
  const [p] = await db.select().from(payments).where(eq(payments.takeoverId, t.id)).orderBy(desc(payments.createdAt)).limit(1);
  return flowCtxOf(rec, p ? toPaymentRecord(p) : null);
}
