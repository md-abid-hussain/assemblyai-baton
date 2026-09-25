import "server-only";

import { desc, eq } from "drizzle-orm";

import {
  PaymentStatusSourceSchema, type CaseView, type PaymentView, type TakeoverView,
} from "../../core/contracts/api";
import { PaymentProviderKindSchema, PaymentStatusSchema, StageSchema } from "../../core/contracts/case";
import { BatonError } from "../../core/contracts/errors";
import { TakeoverPhaseSchema } from "../../core/contracts/events";
import { TakeoverOutcomeSchema } from "../../core/contracts/takeover";
import { payments, takeovers } from "../db/schema";
import { plainTurn, type PgCaseRepository } from "./repository";

/**
 * Route #4 `CaseView {state, turns, facts, takeover, payment}` (DESIGN §4.4). `takeover`/`payment` are the case's
 * latest rows, read-only summaries: WP5's routes own the takeover lifecycle and WP6's route #15 is the authoritative
 * payment view (it polls Polar and adds `toolResult`/`embed`); here `embed` is null and `toolResult` absent.
 */

type TakeoverRow = typeof takeovers.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;

export function takeoverViewOf(t: TakeoverRow): TakeoverView {
  const phase = TakeoverPhaseSchema.safeParse(t.phase);
  const stage = StageSchema.safeParse(t.stage);
  const outcome = TakeoverOutcomeSchema.safeParse(t.outcome);
  return {
    id: t.id,
    phase: phase.success ? phase.data : "armed",
    tArmMs: t.tArmMs,
    midUtterance: t.midUtterance,
    stage: stage.success ? stage.data : null,
    greeting: t.greeting,
    vaSessionId: t.vaSessionId,
    retries: t.retries,
    outcome: outcome.success ? outcome.data : null,
    armedAt: t.armedAt.toISOString(),
    endedAt: t.endedAt ? t.endedAt.toISOString() : null,
  };
}

export function paymentViewOf(p: PaymentRow): PaymentView {
  const status = PaymentStatusSchema.safeParse(p.status);
  const source = PaymentStatusSourceSchema.safeParse(p.statusSource);
  const provider = PaymentProviderKindSchema.safeParse(p.provider);
  return {
    id: p.id,
    status: status.success ? status.data : "none",
    statusSource: source.success ? source.data : null,
    amountCents: p.amountCents,
    totalAmountCents: p.totalAmountCents,
    provider: provider.success ? provider.data : "mock",
    simulated: p.simulated,
    ...(p.checkoutUrl ? { checkoutUrl: p.checkoutUrl } : {}),
    embed: null,
    ...(p.failureReason ? { failureReason: p.failureReason } : {}),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function buildCaseView(repo: PgCaseRepository, caseId: string): Promise<CaseView> {
  const row = await repo.loadRow(caseId);
  if (!row) throw new BatonError("E_NOT_FOUND", "Unknown case.");
  const [turnRows, facts, tko, pay] = await Promise.all([
    repo.listTurns(caseId),
    repo.listFacts(caseId),
    repo.db.select().from(takeovers).where(eq(takeovers.caseId, caseId)).orderBy(desc(takeovers.armedAt)).limit(1),
    repo.db.select().from(payments).where(eq(payments.caseId, caseId)).orderBy(desc(payments.createdAt)).limit(1),
  ]);
  return {
    state: row.state,
    turns: turnRows.map(plainTurn),
    facts,
    takeover: tko[0] ? takeoverViewOf(tko[0]) : null,
    payment: pay[0] ? paymentViewOf(pay[0]) : null,
  };
}
