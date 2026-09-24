import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { PaymentStatus } from "../../core/contracts/case";
import type { PaymentStatusSource } from "../../core/contracts/api";
import type { Db } from "../db/client";
import { payments, webhookEvents } from "../db/schema";
import { allowedFrom, type TransitionVia } from "./machine";

/** A `payments` row (DESIGN §4.2) with narrowed types. */
export interface PaymentRecord {
  id: string;
  caseId: string;
  takeoverId: string;
  provider: "polar" | "mock";
  checkoutId: string | null;
  checkoutUrl: string | null;
  /** What the disclosure said. */
  amountCents: number;
  /** Polar's own figures (null until a checkout exists; the mock provider copies amountCents). */
  totalAmountCents: number | null;
  taxAmountCents: number | null;
  simulated: boolean;
  status: PaymentStatus;
  statusSource: PaymentStatusSource | null;
  failureReason: string | null;
  esignConsentAt: Date | null;
  esignName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewPayment = Pick<PaymentRecord, "id" | "caseId" | "takeoverId" | "provider" | "amountCents"> &
  Partial<Pick<PaymentRecord, "checkoutId" | "checkoutUrl" | "totalAmountCents" | "taxAmountCents" | "status">>;

export interface TransitionPatch {
  statusSource?: PaymentStatusSource | null;
  failureReason?: string | null;
  totalAmountCents?: number | null;
  taxAmountCents?: number | null;
  simulated?: boolean;
  provider?: "polar" | "mock";
  checkoutId?: string | null;
  checkoutUrl?: string | null;
}

/** Persistence for payments and Polar webhook idempotency. Every status write is conditional (forward-only). */
export interface PaymentStore {
  insert(p: NewPayment): Promise<PaymentRecord>;
  get(id: string): Promise<PaymentRecord | null>;
  getByCheckout(checkoutId: string): Promise<PaymentRecord | null>;
  latestForTakeover(takeoverId: string): Promise<PaymentRecord | null>;
  /**
   * Move to `to` iff the current status is in `allowedFrom(to, via)` (and, when `notSimulated`, the payment was not
   * simulated). Returns the updated row, or null when nothing changed (not allowed / not found).
   */
  transition(id: string, to: PaymentStatus, via: TransitionVia, patch?: TransitionPatch, opts?: { notSimulated?: boolean }): Promise<PaymentRecord | null>;
  /** Non-status fields (checkout ids, Polar totals). */
  patch(id: string, patch: Omit<TransitionPatch, "statusSource" | "failureReason" | "simulated">): Promise<PaymentRecord | null>;
  esign(id: string, name: string, at: Date): Promise<PaymentRecord | null>;
  /** Insert `webhook_events` (`polar:<webhook-id>`). false = already seen (a replay). */
  recordWebhook(id: string, type: string, payload: Record<string, unknown>): Promise<boolean>;
  finishWebhook(id: string, error: string | null): Promise<void>;
}

type Row = typeof payments.$inferSelect;

export function toPaymentRecord(r: Row): PaymentRecord {
  return {
    id: r.id,
    caseId: r.caseId,
    takeoverId: r.takeoverId,
    provider: r.provider,
    checkoutId: r.checkoutId,
    checkoutUrl: r.checkoutUrl,
    amountCents: r.amountCents,
    totalAmountCents: r.totalAmountCents,
    taxAmountCents: r.taxAmountCents,
    simulated: r.simulated,
    status: r.status as PaymentStatus,
    statusSource: r.statusSource,
    failureReason: r.failureReason,
    esignConsentAt: r.esignConsentAt,
    esignName: r.esignName,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function patchCols(p: TransitionPatch): Partial<typeof payments.$inferInsert> {
  const out: Partial<typeof payments.$inferInsert> = {};
  if (p.statusSource !== undefined) out.statusSource = p.statusSource;
  if (p.failureReason !== undefined) out.failureReason = p.failureReason;
  if (p.totalAmountCents !== undefined) out.totalAmountCents = p.totalAmountCents;
  if (p.taxAmountCents !== undefined) out.taxAmountCents = p.taxAmountCents;
  if (p.simulated !== undefined) out.simulated = p.simulated;
  if (p.provider !== undefined) out.provider = p.provider;
  if (p.checkoutId !== undefined) out.checkoutId = p.checkoutId;
  if (p.checkoutUrl !== undefined) out.checkoutUrl = p.checkoutUrl;
  return out;
}

export class DbPaymentStore implements PaymentStore {
  constructor(private readonly db: Db) {}

  async insert(p: NewPayment): Promise<PaymentRecord> {
    const [r] = await this.db
      .insert(payments)
      .values({
        id: p.id,
        caseId: p.caseId,
        takeoverId: p.takeoverId,
        provider: p.provider,
        amountCents: p.amountCents,
        checkoutId: p.checkoutId ?? null,
        checkoutUrl: p.checkoutUrl ?? null,
        totalAmountCents: p.totalAmountCents ?? null,
        taxAmountCents: p.taxAmountCents ?? null,
        status: p.status ?? "created",
      })
      .returning();
    return toPaymentRecord(r!);
  }

  async get(id: string): Promise<PaymentRecord | null> {
    const [r] = await this.db.select().from(payments).where(eq(payments.id, id)).limit(1);
    return r ? toPaymentRecord(r) : null;
  }

  async getByCheckout(checkoutId: string): Promise<PaymentRecord | null> {
    const [r] = await this.db.select().from(payments).where(eq(payments.checkoutId, checkoutId)).limit(1);
    return r ? toPaymentRecord(r) : null;
  }

  async latestForTakeover(takeoverId: string): Promise<PaymentRecord | null> {
    const [r] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.takeoverId, takeoverId))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    return r ? toPaymentRecord(r) : null;
  }

  async transition(
    id: string,
    to: PaymentStatus,
    via: TransitionVia,
    patch: TransitionPatch = {},
    opts: { notSimulated?: boolean } = {},
  ): Promise<PaymentRecord | null> {
    const from = allowedFrom(to, via);
    if (from.length === 0) return null;
    const conds = [eq(payments.id, id), inArray(payments.status, [...from])];
    if (opts.notSimulated) conds.push(eq(payments.simulated, false));
    const [r] = await this.db
      .update(payments)
      .set({ ...patchCols(patch), status: to, updatedAt: sql`now()` })
      .where(and(...conds))
      .returning();
    return r ? toPaymentRecord(r) : null;
  }

  async patch(id: string, patch: Omit<TransitionPatch, "statusSource" | "failureReason" | "simulated">): Promise<PaymentRecord | null> {
    const cols = patchCols(patch);
    if (Object.keys(cols).length === 0) return this.get(id);
    const [r] = await this.db
      .update(payments)
      .set({ ...cols, updatedAt: sql`now()` })
      .where(eq(payments.id, id))
      .returning();
    return r ? toPaymentRecord(r) : null;
  }

  async esign(id: string, name: string, at: Date): Promise<PaymentRecord | null> {
    const [r] = await this.db
      .update(payments)
      .set({ esignConsentAt: at, esignName: name, updatedAt: sql`now()` })
      .where(eq(payments.id, id))
      .returning();
    return r ? toPaymentRecord(r) : null;
  }

  async recordWebhook(id: string, type: string, payload: Record<string, unknown>): Promise<boolean> {
    const r = await this.db
      .insert(webhookEvents)
      .values({ id, provider: "polar", type, payload })
      .onConflictDoNothing({ target: webhookEvents.id })
      .returning({ id: webhookEvents.id });
    return r.length === 1;
  }

  async finishWebhook(id: string, error: string | null): Promise<void> {
    await this.db.update(webhookEvents).set({ processedAt: sql`now()`, error }).where(eq(webhookEvents.id, id));
  }
}
