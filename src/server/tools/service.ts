import "server-only";

import type { CaseState, CaseStatus, ConflictCard, FieldId, PolicyRecord, Stage } from "../../core/contracts/case";
import { BatonError } from "../../core/contracts/errors";
import type { EsignSummary, StagePayload } from "../../core/contracts/ext/wp6-payments";
import type { NewFactEvent } from "../../core/contracts/case";
import type { CaseRepository, ToolContext, ToolOutcome, ToolService } from "../../core/contracts/services";
import { payLinkOf, spokenChars } from "../connectors/text";
import type { CaseSink } from "./wiring";
import type { TranscriptionMode } from "../../core/contracts/takeover";
import type { ToolArgs, ToolName } from "../../core/contracts/tools";
import { REQUIRED_FIELDS } from "../../core/intents/add-driver.fields";
import { newRef } from "../../lib/ids";
import { log as rootLog, type Logger } from "../log";
import { formatUsd, usdToCents } from "../payments/machine";
import type { PaymentService } from "../payments/service";
import type { PaymentRecord } from "../payments/store";
import type { RatingSource } from "../rating";
import type { ToolCore } from "./core-port";
import { flowCtxOf, overlayFlow, type DisclosureRecord, type FlowCtx, type TakeoverRecord, type ToolStore } from "./store";

/**
 * The six Voice Agent tool handlers (DESIGN §5.8), server side. They gate the flow:
 * confirm → disclose (ready) → pay (esign_consent read) → close (payment succeeded, server-verified).
 *
 * Every handler works on the case state DERIVED by WP1 from the fact events (via WP3's `CaseRepository`), with the
 * non-derivable flow parts (stage, disclosures given, payment, confirmation number) overlaid from our tables.
 * Accepted field updates become `tool_update` fact events (G0: `turnEndMs = cases.t_arm_ms + (now − armed_at)`) with
 * the deterministic id `${caseId}:tool:${takeoverId}:${callId}` (wp3-to-wp6 item 1), so a retried call is a no-op at
 * the event level too. After each call the flow parts are mirrored into `cases.state` with WP3's `setCaseExtras`
 * (wp3-to-wp6 item 2; only when they changed); our tables stay authoritative for the handlers.
 */

export const EFFECTIVE_DATE_TOOL_MAX_DAYS = 30;
export const CONFLICT_INSTRUCTION =
  "Read back the recorded value and ask which is right. If the customer says the new value is right, call update_case_field again with reason customer_corrected.";
export const DISCLOSURE_INSTRUCTION = "Read this exactly, then wait for the answer.";

export interface ToolServiceConfig {
  deployId: string;
  payToolMode: "hold" | "push";
  /** DISCLOSURE_TAX_SUFFIX=1 (§5.8 "Tax"; only if T-D1-9 shows the totals cannot be made equal). */
  taxSuffix: boolean;
}

export interface ToolServiceDeps {
  cases: CaseSink;
  store: ToolStore;
  payments: PaymentService;
  core: () => ToolCore;
  rating: RatingSource;
  config: ToolServiceConfig;
  now?: () => number;
  /** Unused since the tool_update ids became deterministic per call (kept for callers that still pass it). */
  newId?: () => string;
  /** "END-" + 5 digits. */
  confirmationNumber?: () => string;
  log?: Logger;
}

type Loaded = NonNullable<Awaited<ReturnType<CaseRepository["load"]>>>;

interface Ctx {
  /** The VA call id of this tool call (route #14 `callId`). */
  callId: string;
  tko: TakeoverRecord;
  c: Loaded;
  pay: PaymentRecord | null;
  /** Derived state with the flow overlay; `stage` is the effective (caught-up) stage. */
  state: CaseState;
  policy: PolicyRecord;
  callDate: string;
  core: ToolCore;
}

interface HandlerOut {
  result: Record<string, unknown>;
  events?: NewFactEvent[];
  ui?: ToolOutcome["ui"];
  /** Also return the input mode of the next step (field updates and date confirmations). */
  withInputMode?: boolean;
  transcriptionMode?: TranscriptionMode;
}

export class Wp6ToolService implements ToolService {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly confNumber: () => string;

  constructor(private readonly deps: ToolServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = (deps.log ?? rootLog).child({ component: "tools" });
    this.confNumber = deps.confirmationNumber ?? (() => `END-${String(Math.floor(10000 + Math.random() * 90000))}`);
  }

  async handle<N extends ToolName>(name: N, args: ToolArgs[N], ctx: ToolContext): Promise<ToolOutcome> {
    const x = await this.load(ctx);
    const before = x.state.stage;
    let out: HandlerOut;
    switch (name) {
      case "confirm_effective_date":
        out = await this.confirmEffectiveDate(x, args as ToolArgs["confirm_effective_date"]);
        break;
      case "update_case_field":
        out = await this.updateCaseField(x, args as ToolArgs["update_case_field"]);
        break;
      case "get_disclosure":
        out = await this.getDisclosure(x, args as ToolArgs["get_disclosure"]);
        break;
      case "send_esign_and_pay_link":
        out = await this.sendPayLink(x, args as ToolArgs["send_esign_and_pay_link"], ctx);
        break;
      case "send_confirmation":
        out = await this.sendConfirmation(x);
        break;
      case "hand_back_to_rep":
        out = await this.handBack(x, args as ToolArgs["hand_back_to_rep"]);
        break;
      default:
        throw new BatonError("E_BAD_REQUEST", `Unknown tool ${String(name)}.`);
    }

    // Apply accepted field updates, then re-derive (WP3 re-derives if newer events landed).
    let state = x.state;
    let stored: CaseState = x.c.state;
    if (out.events?.length) {
      const applied = await this.deps.cases.applyEvents(x.tko.caseId, x.c.version, out.events);
      stored = applied.state;
      state = await this.reload(x, applied.state);
      if (out.ui?.conflict === undefined) {
        const card = conflictFor(state, out.events.map((e) => e.field));
        if (card) out.ui = { ...(out.ui ?? {}), conflict: card };
      }
    } else if (name === "get_disclosure" || name === "send_confirmation") {
      state = await this.reload(x, x.c.state);
    }

    const outcome: ToolOutcome = { result: out.result };
    if (out.ui) outcome.ui = out.ui;
    const next = x.core.nextStage(state.stage, state);
    if (next !== before || (before !== null && next !== x.tko.stage)) {
      await this.deps.store.setStage(x.tko.id, next);
      Object.assign(outcome, this.stagePayload(x, state, next));
      if (name === "confirm_effective_date" && out.result.accepted === true) out.result.next = next === "disclose" ? "disclose" : null;
    }
    if (out.transcriptionMode) outcome.transcriptionMode = out.transcriptionMode;
    else if (out.withInputMode || outcome.stage) outcome.transcriptionMode = x.core.inputModeFor(x.core.nextStepOf(state)).mode;
    await this.syncExtras(x.tko.caseId, x.tko.id, stored);
    return outcome;
  }

  /**
   * Mirror the flow parts (stage, disclosures given, payment, confirmation number) into `cases.state` through WP3's
   * `setCaseExtras` when they differ from what the case row holds. Best effort: a failure is logged, never thrown
   * (the handlers read our own tables, and route #4 builds its payment summary from the payments row).
   */
  private async syncExtras(caseId: string, takeoverId: string, stored: CaseState): Promise<void> {
    if (!this.deps.cases.setCaseExtras) return;
    try {
      const tko = await this.deps.store.getTakeover(takeoverId);
      const pay = await this.deps.store.latestPayment(takeoverId);
      const flow = flowCtxOf(tko, pay);
      if (sameFlow(flow, stored)) return;
      await this.deps.cases.setCaseExtras(caseId, flow);
    } catch (e) {
      this.log.warn("setCaseExtras failed", { caseId, takeoverId, err: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }

  /**
   * A replayed `(takeoverId, callId)` (the browser retried): the stored `tool.result`, plus the CURRENT stage payload
   * (re-sending the same stage is harmless) and, for the pay tool, the payment's `ui`.
   */
  async replay(name: ToolName, stored: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const x = await this.load(ctx);
    const out: ToolOutcome = { result: stored };
    if (x.state.stage) Object.assign(out, this.stagePayload(x, x.state, x.state.stage));
    if (name === "send_esign_and_pay_link" && x.pay) {
      const link = payLinkOf(ctx.origin, x.pay.id);
      out.ui = { sms: smsPayLink(x.policy, link), link, paymentId: x.pay.id };
    }
    return out;
  }

  /** The phone's SMS text and e-sign summary for a payment (PaymentView `sms`, `summary`). */
  async extrasFor(p: PaymentRecord, origin: string | null): Promise<{ sms?: string; summary?: EsignSummary } | null> {
    const tko = await this.deps.store.getTakeover(p.takeoverId);
    if (!tko) return null;
    const c = await this.deps.cases.load(tko.caseId);
    if (!c) return null;
    const f = c.state.fields;
    const disp = (k: keyof typeof f) => f[k]?.display ?? f[k]?.value ?? null;
    const d = tko.disclosures.premium_change ?? tko.disclosures.esign_consent;
    const pol = c.policy;
    const summary: EsignSummary = {
      policyNumber: pol.policyNumber,
      agencyName: pol.agencyName,
      policyholderName: `${pol.policyholder.firstName} ${pol.policyholder.lastName}`,
      phoneLast4: pol.phoneOnFileLast4,
      driver: disp("driver_full_name"),
      relation: disp("driver_relation"),
      vehicle: disp("vehicle_assignment"),
      effectiveDate: disp("effective_date"),
      monthlyUsd: d?.monthlyUsd ?? null,
      dueTodayUsd: d?.dueTodayUsd ?? null,
    };
    const out: { sms?: string; summary?: EsignSummary } = { summary };
    if (origin) out.sms = smsPayLink(pol, payLinkOf(origin, p.id));
    return out;
  }

  /** The close-stage payload for a succeeded payment (PaymentView.stagePayload; request wp5b-to-wp6 item 2). */
  async stagePayloadFor(p: PaymentRecord): Promise<StagePayload | null> {
    if (p.status !== "succeeded") return null;
    const tko = await this.deps.store.getTakeover(p.takeoverId);
    if (!tko) return null;
    const c = await this.deps.cases.load(tko.caseId);
    if (!c) return null;
    const core = this.deps.core();
    const state = overlayFlow(c.state, flowCtxOf(tko, p));
    const stage = core.nextStage(tko.stage ?? "pay", state);
    if (stage !== tko.stage) await this.deps.store.setStage(tko.id, stage);
    const x = { core, policy: c.policy } as Pick<Ctx, "core" | "policy">;
    const sp = this.stagePayload(x, state, stage);
    await this.syncExtras(tko.caseId, tko.id, c.state);
    return { ...sp, transcriptionMode: "min_latency" };
  }

  // ---------------------------------------------------------------------------------------------- context

  private async load(ctx: ToolContext): Promise<Ctx> {
    const tko = await this.deps.store.getTakeover(ctx.takeoverId);
    if (!tko) throw new BatonError("E_NOT_FOUND", "No such takeover.");
    if (tko.caseId !== ctx.caseId) throw new BatonError("E_FORBIDDEN", "The takeover belongs to another case.");
    const c = await this.deps.cases.load(tko.caseId);
    if (!c) throw new BatonError("E_NOT_FOUND", "No such case.");
    const pay = await this.deps.store.latestPayment(tko.id);
    const core = this.deps.core();
    const x: Ctx = { callId: ctx.callId, tko, c, pay, state: c.state, policy: c.policy, callDate: c.policy.callDate, core };
    x.state = this.overlay(x, c.state);
    return x;
  }

  private overlay(x: Pick<Ctx, "tko" | "pay" | "core" | "c">, state: CaseState): CaseState {
    const flow = flowCtxOf(x.tko, x.pay);
    const base = overlayFlow(state, flow);
    // Catch up with the forward-only rules (e.g. the case became ready while shadowing drained).
    const stage = x.core.nextStage(flow.stage, base);
    return { ...base, stage };
  }

  private async reload(x: Ctx, derived: CaseState): Promise<CaseState> {
    const tko = (await this.deps.store.getTakeover(x.tko.id)) ?? x.tko;
    const pay = await this.deps.store.latestPayment(x.tko.id);
    return this.overlay({ tko, pay, core: x.core, c: x.c }, derived);
  }

  private stagePayload(x: Pick<Ctx, "core" | "policy">, state: CaseState, stage: Stage): { stage: Stage; systemPrompt: string; tools: StagePayload["tools"] } {
    const mode = this.deps.config.payToolMode;
    return {
      stage,
      systemPrompt: x.core.compilePrompt(state, x.policy, stage, { deployId: this.deps.config.deployId, payToolMode: mode }),
      tools: x.core.toolsForStage(stage, { payToolMode: mode }),
    };
  }

  /** G0: tool_update `turnEndMs` = cases.t_arm_ms + (server now − takeovers.armed_at), on the call clock. */
  private turnEndMs(x: Ctx): number {
    const tArm = x.c.tArmMs ?? x.tko.tArmMs;
    return tArm + Math.max(0, this.now() - x.tko.armedAt.getTime());
  }

  private toolUpdate(x: Ctx, field: FieldId, valueRaw: string, valueNorm: string): NewFactEvent {
    return {
      id: toolEventId(x.tko.caseId, x.tko.id, x.callId),
      caseId: x.tko.caseId,
      field,
      kind: "tool_update",
      party: "ai",
      valueRaw,
      valueNorm,
      acknowledgesTurnId: null,
      confidence: "high",
      turnId: null,
      turnEndMs: this.turnEndMs(x),
      late: false,
      cut: false,
      evidence: null,
      extractor: "tool",
    };
  }

  // ---------------------------------------------------------------------------------------------- handlers

  /** §5.8: server-side date resolution (server wins over the LLM's date), 30-day guardrail, tool_update, → disclose. */
  private async confirmEffectiveDate(x: Ctx, a: ToolArgs["confirm_effective_date"]): Promise<HandlerOut> {
    const server = x.core.resolveRelativeDate(a.customer_words, x.callDate);
    const llm = isIsoDate(a.date) ? a.date : null;
    if (server && llm && server !== llm) this.log.info("effective date: server resolution wins", { takeoverId: x.tko.id, server, llm });
    const chosen = server ?? llm;
    const maxIso = addDaysIso(x.callDate, EFFECTIVE_DATE_TOOL_MAX_DAYS);
    const allowed = `today to ${monthDay(maxIso)}`;
    if (!chosen) return { result: { accepted: false, reason: "unparseable", allowed }, withInputMode: true };
    if (chosen < x.callDate || chosen > maxIso) return { result: { accepted: false, reason: "out_of_range", allowed }, withInputMode: true };
    const norm = x.core.normalizeField("effective_date", chosen, { policy: x.policy, callDate: x.callDate });
    const valueNorm = norm?.norm ?? chosen;
    return {
      result: { accepted: true, effective_date: valueNorm, spoken: x.core.spokenDate(valueNorm), next: null },
      events: [this.toolUpdate(x, "effective_date", a.customer_words || chosen, valueNorm)],
      withInputMode: true,
    };
  }

  /** §5.8 update_case_field rules (conflict on the first incompatible update of a VERIFIED field). */
  private async updateCaseField(x: Ctx, a: ToolArgs["update_case_field"]): Promise<HandlerOut> {
    const n = x.core.normalizeField(a.field, a.value, { policy: x.policy, callDate: x.callDate });
    if (!n) return { result: { result: "rejected", reason: "unparseable", field: a.field }, withInputMode: true };
    const fs = x.state.fields[a.field];
    // Conflicts already returned for this field in this takeover (the §5.8 "first attempt").
    const conflictsSoFar = x.tko.toolFlow.fieldAttempts?.[a.field] ?? 0;

    if (fs && fs.status === "VERIFIED" && fs.value !== null) {
      if (x.core.compatible(a.field, fs.value, n.norm)) {
        return { result: { result: "accepted", field: a.field, status: "VERIFIED", value: fs.display ?? n.display }, withInputMode: true };
      }
      if (conflictsSoFar === 0 || a.reason !== "customer_corrected") {
        await this.deps.store.mergeToolFlow(x.tko.id, { fieldAttempts: { ...(x.tko.toolFlow.fieldAttempts ?? {}), [a.field]: conflictsSoFar + 1 } });
        const recorded = fs.display ?? fs.value;
        const card: ConflictCard = {
          field: a.field,
          values: [
            { value: recorded, party: fs.source ?? "rep", evidence: fs.evidence[0] ?? null },
            { value: n.display, party: "customer", evidence: null },
          ],
          resolved: false,
        };
        return {
          result: { result: "conflict", field: a.field, recorded_value: recorded, instruction: CONFLICT_INSTRUCTION },
          ui: { conflict: card },
          withInputMode: true,
        };
      }
      // Second attempt, customer_corrected: accept; WP1's derivation flags customer_corrected_verified + a card.
    }
    const ev = this.toolUpdate(x, a.field, a.value, n.norm);
    return { result: { result: "accepted", field: a.field, status: "VERIFIED", value: n.display }, events: [ev], withInputMode: true };
  }

  /** §5.8 get_disclosure: only when ready and in disclose/pay; premium from a VERIFIED rep quote, else the rating tool. */
  private async getDisclosure(x: Ctx, a: ToolArgs["get_disclosure"]): Promise<HandlerOut> {
    const stage = x.state.stage;
    if (!x.state.readiness.ready || (stage !== "disclose" && stage !== "pay")) {
      const missing = REQUIRED_FIELDS.filter((f) => x.state.fields[f]?.status !== "VERIFIED");
      return { result: { ok: false, reason: "not_ready", missing } };
    }
    const existing = x.tko.disclosures[a.kind];
    if (existing) {
      return { result: { ok: true, disclosure_id: existing.id, text: existing.text, instruction: DISCLOSURE_INSTRUCTION }, transcriptionMode: "min_latency" };
    }
    if (a.kind === "esign_consent" && !x.tko.disclosures.premium_change) {
      return { result: { ok: false, reason: "premium_change_first", instruction: 'Call get_disclosure with kind "premium_change" first.' } };
    }
    const amounts = x.tko.disclosures.premium_change ?? (await this.amounts(x));
    const d = x.core.disclosureText(
      a.kind,
      { snapshot: x.state, policy: x.policy, monthlyUsd: amounts.monthlyUsd, dueTodayUsd: amounts.dueTodayUsd },
      { taxSuffix: this.deps.config.taxSuffix },
    );
    const rec: DisclosureRecord = {
      id: newRef("dsc"),
      kind: a.kind,
      text: d.text,
      criticalTokens: d.criticalTokens,
      monthlyUsd: amounts.monthlyUsd,
      dueTodayUsd: amounts.dueTodayUsd,
      premiumSource: amounts.premiumSource,
      dueSource: amounts.dueSource,
      at: new Date(this.now()).toISOString(),
    };
    await this.deps.store.putDisclosure(x.tko.id, rec);
    return { result: { ok: true, disclosure_id: rec.id, text: rec.text, instruction: DISCLOSURE_INSTRUCTION }, transcriptionMode: "min_latency" };
  }

  private async amounts(x: Ctx): Promise<Pick<DisclosureRecord, "monthlyUsd" | "dueTodayUsd" | "premiumSource" | "dueSource">> {
    const rating = await this.deps.rating(x.c.scenarioId);
    if (!rating) throw new BatonError("E_CASE_STATE", `No rating for scenario ${x.c.scenarioId}.`);
    const premium = x.core.resolvePremium(x.state, rating.newMonthlyUsd);
    const due = x.core.resolveDueToday({
      snapshot: x.state,
      newMonthlyUsd: premium.monthlyUsd,
      currentMonthlyUsd: x.policy.currentMonthlyPremiumUsd,
      scenarioDueTodayUsd: rating.dueTodayUsd,
      callDate: x.callDate,
    });
    return { monthlyUsd: premium.monthlyUsd, dueTodayUsd: due.dueTodayUsd, premiumSource: premium.source, dueSource: due.source };
  }

  /** §5.8 send_esign_and_pay_link: consent required; creates (or reuses) the payment; returns at once with ui.*. */
  private async sendPayLink(x: Ctx, a: ToolArgs["send_esign_and_pay_link"], ctx: ToolContext): Promise<HandlerOut> {
    if (a.customer_agreed_to_text !== true) return { result: { status: "not_sent", reason: "consent_required" } };
    const disc = x.tko.disclosures.premium_change ?? x.tko.disclosures.esign_consent;
    if (!disc || !x.tko.disclosures.esign_consent) {
      return { result: { status: "not_sent", reason: "disclosure_required", instruction: "Read the premium and e-sign disclosures first (get_disclosure)." } };
    }
    let p = x.pay;
    if (!p || p.status === "failed" || p.status === "expired") {
      const created = await this.deps.payments.create({
        caseId: x.tko.caseId,
        takeoverId: x.tko.id,
        scenarioId: x.c.scenarioId,
        amountCents: usdToCents(disc.dueTodayUsd),
        policy: x.policy,
        origin: ctx.origin,
      });
      p = created.payment;
      await this.deps.store.mergeToolFlow(x.tko.id, {
        payLink: { paymentId: p.id, paperCopyRequested: a.paper_copy_requested, customerWords: a.customer_words, at: new Date(this.now()).toISOString() },
      });
    }
    const link = payLinkOf(ctx.origin, p.id);
    return {
      result: { status: "link_sent" },
      ui: { sms: smsPayLink(x.policy, link), link, paymentId: p.id },
    };
  }

  /** §5.8 send_confirmation: server-authoritative on payments.status (webhook, server poll or mock). */
  private async sendConfirmation(x: Ctx): Promise<HandlerOut> {
    const p = await this.deps.store.latestPayment(x.tko.id);
    const confirmed = !!p && p.status === "succeeded" && (p.statusSource === "webhook" || p.statusSource === "server_poll" || p.statusSource === "mock");
    if (!confirmed) return { result: { ok: false, reason: "payment_not_confirmed" } };
    const n = await this.deps.store.putConfirmationNumber(x.tko.id, x.tko.confirmationNumber ?? this.confNumber());
    await this.deps.store.setCaseStatus(x.tko.caseId, "completed", ACTIVE_CASE_STATUSES);
    return {
      result: { ok: true, confirmation_number: n, spoken: spokenChars(n), sms_sent: true },
      ui: { sms: `Payment received. Confirmation ${n}` },
    };
  }

  /** §5.8 hand_back_to_rep: interactive, returns at once; case → handed_back. */
  private async handBack(x: Ctx, a: ToolArgs["hand_back_to_rep"]): Promise<HandlerOut> {
    await this.deps.store.mergeToolFlow(x.tko.id, { handBack: { reason: a.reason, summary: a.summary, at: new Date(this.now()).toISOString() } });
    await this.deps.store.setCaseStatus(x.tko.caseId, "handed_back", ACTIVE_CASE_STATUSES);
    return { result: { status: "transferring", message: `Tell the customer ${x.policy.repFirstName} is coming back on the line now.` } };
  }
}

const ACTIVE_CASE_STATUSES: readonly CaseStatus[] = ["shadowing", "armed", "ai_active"];

/** wp3-to-wp6 item 1: one tool call yields at most one fact event, keyed by the call. */
export const toolEventId = (caseId: string, takeoverId: string, callId: string): string => `${caseId}:tool:${takeoverId}:${callId}`;

function sameFlow(f: FlowCtx, s: Pick<CaseState, "stage" | "disclosuresGiven" | "payment" | "confirmationNumber">): boolean {
  return (
    f.stage === (s.stage ?? null) &&
    f.confirmationNumber === (s.confirmationNumber ?? null) &&
    JSON.stringify(f.disclosuresGiven) === JSON.stringify(s.disclosuresGiven ?? []) &&
    JSON.stringify(f.payment) === JSON.stringify(s.payment ?? null)
  );
}

function conflictFor(state: CaseState, fields: FieldId[]): ConflictCard | null {
  for (const f of fields) {
    const c = state.conflicts.find((k) => k.field === f && !k.resolved);
    if (c) return c;
    const fs = state.fields[f];
    if (fs?.flags.includes("customer_corrected_verified") && fs.conflict) {
      return { field: f, values: fs.conflict.values.map((v, i) => ({ value: v, party: i === 0 ? "rep" : "ai", evidence: fs.conflict?.evidence[i] ?? null })), resolved: false };
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------ small pure helpers

export const isIsoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export function addDaysIso(iso: string, n: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
}
/** "2026-10-25" → "October 25th". */
export function monthDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${ordinal(d)}`;
}

/** WP16·2: one implementation, shared with the generic connector built-ins (`connectors/text.ts`). */
export { payLinkOf, spokenChars };

/** S6:"Harborview: Review & sign your change to policy NBM-4418207: <link>". */
export function smsPayLink(policy: Pick<PolicyRecord, "agencyName" | "policyNumber">, link: string): string {
  const brand = policy.agencyName.split(/\s+/)[0] ?? policy.agencyName;
  return `${brand}: Review & sign your change to policy ${policy.policyNumber}: ${link}`;
}

export { formatUsd };
