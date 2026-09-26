import "server-only";

import type { CaseState, CaseStatus, PolicyRecord } from "../../core/contracts/case";
import type { AccountRecord, Connector } from "../../core/contracts/v2/blueprint";
import type { ConnectorCtx, ConnectorOutcome } from "../../core/contracts/v2/services";
import type { Logger } from "../log";
import { usdToCents } from "../payments/machine";
import { POLAR_UNAVAILABLE_LABEL } from "../payments/service";
import { clampPaymentCents, RELAY_DEMO_CUSTOMER_KEY, relayPaymentPolicy } from "../payments/relay-account";
import type { PaymentRecord } from "../payments/store";
import type { ConnectorSuccessRecord } from "../tools/store";
import { defaultConfirmationNumber, payLinkOf, spokenChars } from "./text";

/**
 * The built-in connectors that need the RUN (PLATFORM §6.1): `payment_link`, `confirmation`, `sms_mock` and
 * `esign_mock`. `lookup_table` and `http_action` are stateless and live in `runtime.ts`.
 *
 * Each handler is pure over its inputs plus two injected side effects (create a payment, write a takeover metric),
 * so the connector runtime, the published gateway and the test console all reach the same code. They never throw
 * for a refusal: a refusal is an outcome the agent can act on (`{status:"not_sent", reason}` / `{ok:false, reason}`),
 * exactly as WP6's handlers answer today (docs/notes/wp6.md "Handler contract").
 */

export type PaymentLinkConnector = Extract<Connector, { type: "payment_link" }>;
export type ConfirmationConnector = Extract<Connector, { type: "confirmation" }>;
export type SmsMockConnector = Extract<Connector, { type: "sms_mock" }>;
export type EsignMockConnector = Extract<Connector, { type: "esign_mock" }>;

/** Everything a stateful built-in reads about the run it executes in. */
export interface ConnectorRun {
  caseId: string;
  takeoverId: string;
  /** The Baton scenario id, or `RELAY_DEMO_CUSTOMER_KEY` for a generic relay (PLATFORM §6.1 "Adapter"). */
  scenarioId: string;
  account: AccountRecord;
  snapshot: Pick<CaseState, "fields">;
  /** `compiled.values({snapshot, account})`: the named values, resolved for this snapshot. */
  values: Readonly<Record<string, string | null>>;
  /** Blueprint disclosure ids already read out, in blueprint order. */
  disclosuresGiven: readonly string[];
  /** Connector ids that already succeeded in this takeover. */
  succeeded: Readonly<Record<string, ConnectorSuccessRecord>>;
  /** The takeover's latest payment row, or null. */
  payment: PaymentRecord | null;
  confirmationNumber: string | null;
  /** A Baton run keeps its real `PolicyRecord`; a generic relay leaves it null and the §6.1 adapter builds one. */
  policy?: PolicyRecord | null;
  /** Renders a blueprint template in this run's scope; `extra` adds `{v.<name>}` entries (connector args). */
  render(template: string, extra?: Readonly<Record<string, string | null>>): string;
}

/** What the built-ins are allowed to change. */
export interface BuiltinConnectorDeps {
  payments: {
    create(i: {
      caseId: string; takeoverId: string; scenarioId: string; amountCents: number; policy: PolicyRecord; origin: string;
    }): Promise<{ payment: PaymentRecord; label: string | null }>;
  };
  store: {
    markConnector(takeoverId: string, r: ConnectorSuccessRecord): Promise<ConnectorSuccessRecord>;
    putConfirmationNumber(takeoverId: string, n: string): Promise<string>;
    setCaseStatus(caseId: string, status: CaseStatus, from: readonly CaseStatus[]): Promise<boolean>;
  };
  now?: () => number;
  confirmationNumber?: () => string;
  log?: Logger;
}

/** The statuses a run may still be in when a connector completes it. */
export const ACTIVE_CASE_STATUSES: readonly CaseStatus[] = ["shadowing", "armed", "ai_active"];

const ok = (result: Record<string, unknown>, ui?: ConnectorOutcome["ui"]): ConnectorOutcome =>
  ui ? { status: "ok", succeeded: true, result, ui } : { status: "ok", succeeded: true, result };
/** A refusal: the agent gets an answer it can act on, and nothing was executed. */
const refused = (result: Record<string, unknown>): ConnectorOutcome => ({ status: "refused", succeeded: false, result });

export const DISCLOSURE_REQUIRED_INSTRUCTION = "Read the required disclosure first (get_disclosure), then call this tool again.";

// ------------------------------------------------------------------------------------------- payment_link

/**
 * PLATFORM §6.1 `payment_link`, push mode (T-D1-1): consent, then the required disclosure, then one payment per
 * takeover for the named amount, clamped to $1–$999. A Polar failure has already fallen back to Simulate inside
 * `PaymentService.create` (label "Simulated payment (Polar unavailable)"), and the agent's answer does not change:
 * a provider outage is not something the caller can act on. The payment ROW carries the fallback (`provider:"mock"`,
 * then `simulated`), and the pay page and the console read it from the payment view, so `ConnectorOutcome.ui` needs
 * no field of its own. We only log it for the owner.
 */
export async function runPaymentLink(
  c: PaymentLinkConnector,
  args: Record<string, unknown>,
  run: ConnectorRun,
  ctx: ConnectorCtx,
  d: BuiltinConnectorDeps,
): Promise<ConnectorOutcome> {
  if (args.customer_agreed_to_text !== true) return refused({ status: "not_sent", reason: "consent_required" });
  if (c.requiresDisclosure && !run.disclosuresGiven.includes(c.requiresDisclosure)) {
    return refused({ status: "not_sent", reason: "disclosure_required", instruction: DISCLOSURE_REQUIRED_INSTRUCTION });
  }

  const raw = run.values[c.amount];
  if (raw === undefined || raw === null || raw === "") {
    return refused({ status: "not_sent", reason: "amount_unavailable", instruction: "The amount is not known yet; ask for what is missing, or hand back to the rep." });
  }
  let requested: number;
  try {
    requested = usdToCents(raw);
  } catch {
    return refused({ status: "not_sent", reason: "amount_unavailable", instruction: "The amount is not known yet; ask for what is missing, or hand back to the rep." });
  }
  const amount = clampPaymentCents(requested);
  const log = d.log;
  if (amount.clamped) log?.warn("payment amount clamped", { connectorId: c.id, requestedCents: amount.requestedCents, cents: amount.cents });

  // One payment per takeover: reuse the open one, re-create only after it failed or expired (as WP6).
  let p = run.payment;
  let label: string | null = null;
  if (!p || p.status === "failed" || p.status === "expired") {
    const created = await d.payments.create({
      caseId: run.caseId,
      takeoverId: run.takeoverId,
      scenarioId: run.scenarioId,
      amountCents: amount.cents,
      policy: policyFor(run),
      origin: ctx.origin,
    });
    p = created.payment;
    label = created.label;
  }
  // NOT `markConnector`: "the link was sent" is not "the payment succeeded". The kernel's `connector_succeeded`
  // exit for a `payment_link` reads `payment.status === "succeeded"` (compile.ts `exitMet`), so the act stage must
  // stay open while the customer signs and pays — otherwise the pay tool leaves the stage list mid-payment and a
  // retry would come back `not_available`. The payment row is the truth here, and it is already persistent.
  const link = payLinkOf(ctx.origin, p.id);
  const sms = `${run.render(c.smsTemplate)} ${link}`.trim();
  const ui: NonNullable<ConnectorOutcome["ui"]> = { sms, link, paymentId: p.id };
  if (c.esign) ui.esignId = p.id;
  if (label === POLAR_UNAVAILABLE_LABEL) log?.info("payment fell back to Simulate", { paymentId: p.id, connectorId: c.id });
  return ok({ status: "link_sent" }, ui);
}

/**
 * The `PolicyRecord` the payment layer takes. A Baton run keeps its real policy (the scenario's demo customer and
 * address); a generic relay maps its `AccountRecord` through the §6.1 adapter.
 */
function policyFor(run: ConnectorRun): PolicyRecord {
  return run.policy ?? relayPaymentPolicy(run.account);
}

// ------------------------------------------------------------------------------------------- confirmation

/**
 * PLATFORM §6.1 `confirmation`: refuses unless every `requires` connector succeeded. A `payment_link` requirement
 * is stricter than "the tool returned ok" — the payment must be `succeeded` AND server-verified (webhook, server
 * poll or mock), never a client claim (WP6 acceptance 2, fail-closed).
 */
export async function runConfirmation(
  c: ConfirmationConnector,
  run: ConnectorRun,
  d: BuiltinConnectorDeps,
  connectorTypeOf: (id: string) => Connector["type"] | null,
): Promise<ConnectorOutcome> {
  const missing: string[] = [];
  let paymentPending = false;
  for (const id of c.requires) {
    if (connectorTypeOf(id) === "payment_link") {
      if (!paymentConfirmed(run.payment)) {
        paymentPending = true;
        missing.push(id);
      }
      continue;
    }
    if (!run.succeeded[id]) missing.push(id);
  }
  if (paymentPending) return refused({ ok: false, reason: "payment_not_confirmed" });
  if (missing.length > 0) {
    return refused({ ok: false, reason: "requirement_not_met", missing, instruction: "That step has not finished yet; wait for it or hand back to the rep." });
  }

  const n = await d.store.putConfirmationNumber(run.takeoverId, run.confirmationNumber ?? (d.confirmationNumber ?? defaultConfirmationNumber)());
  await d.store.markConnector(run.takeoverId, { connectorId: c.id, toolName: c.toolName, at: new Date((d.now ?? Date.now)()).toISOString() });
  await d.store.setCaseStatus(run.caseId, "completed", ACTIVE_CASE_STATUSES);
  const sms = run.render(c.smsTemplate, { confirmation_number: n });
  return ok({ ok: true, confirmation_number: n, spoken: spokenChars(n), sms_sent: true }, { sms: `${sms} ${n}`.trim() });
}

/** Server-verified success only (`status_source` ∈ webhook / server_poll / mock). */
export function paymentConfirmed(p: PaymentRecord | null): boolean {
  return !!p && p.status === "succeeded" && (p.statusSource === "webhook" || p.statusSource === "server_poll" || p.statusSource === "mock");
}

// ------------------------------------------------------------------------------------------- sms_mock

/**
 * PLATFORM §6.1 `sms_mock`: renders the template with the args plus the case and delivers it to the MockPhone.
 * The validated args are exposed to the template as `{v.<param>}` (see docs/notes/wp16.md, WP16·2 decisions).
 */
export async function runSmsMock(c: SmsMockConnector, args: Record<string, unknown>, run: ConnectorRun, d: BuiltinConnectorDeps): Promise<ConnectorOutcome> {
  const sms = run.render(c.template, argsAsValues(args));
  await d.store.markConnector(run.takeoverId, { connectorId: c.id, toolName: c.toolName, at: new Date((d.now ?? Date.now)()).toISOString() });
  return ok({ status: "sent" }, { sms });
}

/** Connector args as template values (strings; a boolean renders as "yes"/"", a number as its decimal form). */
export function argsAsValues(args: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number") out[k] = String(v);
    else if (typeof v === "boolean") out[k] = v ? "yes" : "";
    else out[k] = null;
  }
  return out;
}

// ------------------------------------------------------------------------------------------- esign_mock

/**
 * PLATFORM §6.1 `esign_mock` (SHOULD): sends the e-sign sheet to the MockPhone. `requiresDisclosure` is enforced,
 * and the sheet is bound to the takeover, so the phone's mock signature completes it. No payment is created.
 */
export async function runEsignMock(
  c: EsignMockConnector,
  args: Record<string, unknown>,
  run: ConnectorRun,
  ctx: ConnectorCtx,
  d: BuiltinConnectorDeps,
): Promise<ConnectorOutcome> {
  if (args.customer_agreed_to_text !== true) return refused({ status: "not_sent", reason: "consent_required" });
  if (c.requiresDisclosure && !run.disclosuresGiven.includes(c.requiresDisclosure)) {
    return refused({ status: "not_sent", reason: "disclosure_required", instruction: DISCLOSURE_REQUIRED_INSTRUCTION });
  }
  const esignId = `esg_${run.takeoverId}_${c.id}`;
  await d.store.markConnector(run.takeoverId, { connectorId: c.id, toolName: c.toolName, at: new Date((d.now ?? Date.now)()).toISOString() });
  const title = run.render(c.documentTitle);
  const sms = run.render(c.smsTemplate);
  void ctx;
  return ok({ status: "sent", document: title }, { sms, esignId });
}
