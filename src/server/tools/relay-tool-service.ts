import "server-only";

import type { CaseState, ConflictCard, FieldId, NewFactEvent, Stage } from "../../core/contracts/case";
import { BatonError } from "../../core/contracts/errors";
import type { VaFunctionTool } from "../../core/contracts/tools";
import {
  workspaceOf,
  type AccountRecord, type Blueprint, type CompiledRelay, type RelayEngineFactory, type RelayToolContext,
  type RelayToolOutcome, type RelayToolService,
} from "../../core/contracts/v2";
import type { KernelRelay } from "../../core/relay/compile";
import { addDays, isIsoDate, resolveRelativeDate } from "../../core/case/dates";
import { makeScope, TemplateCache } from "../../core/relay/scope";
import { nextStepFor, openRequiredFor, readinessFor } from "../../core/relay/spec";
import { renderTemplate as renderAst } from "../../core/relay/template";
import { validateToolArgs, type ToolParams } from "../../core/relay/tool-args";
import { argsHash, DEDUPE_WINDOW_MS, type ConnectorCallLog } from "../connectors/call-log";
import { connectorForTool } from "../connectors/runtime";
import type { ConnectorExecuteInput } from "../connectors/runtime";
import { defaultConfirmationNumber } from "../connectors/text";
import { log as rootLog, type Logger } from "../log";
import type { PaymentService } from "../payments/service";
import { RELAY_DEMO_CUSTOMER_KEY } from "../payments/relay-account";
import type { PaymentRecord } from "../payments/store";
import type { ConnectorOutcome, ConnectorCtx } from "../../core/contracts/v2/services";
import type { RelayRunCase, RelayRunSource } from "./relay-run-source";
import { CONFLICT_INSTRUCTION, DISCLOSURE_INSTRUCTION, monthDay, toolEventId } from "./service";
import {
  overlayFlow, relayFlowCtxOf, type RelayDisclosureRecord, type RelayFlowCtx, type TakeoverRecord, type ToolStore,
} from "./store";
import type { CaseSink } from "./wiring";

/**
 * `RelayToolService` (PLATFORM §6.3): ONE tool service for every relay, Baton included.
 *
 * Every call runs the same six steps:
 *   1. load the case and its compiled relay (one read per call: the takeover row, the case, the payment);
 *   2. **the stage gate** — the tool must be in the SERVER's current stage list, or the answer is
 *      `{status:"not_available"}` and nothing executes. Fail-closed: a published agent carries all of its HTTP
 *      tools from the first second (T-D1-5), so an out-of-stage call reaches us and must be refused here;
 *   3. `validateToolArgs` against the tool's generated schema;
 *   4. dispatch: a built-in (`update_case_field`, `hand_back_to_rep`, `get_disclosure`, the field's confirm tool)
 *      or a connector, through `ConnectorRuntime.execute`;
 *   5. idempotency: `(takeoverId, call_id)` belongs to the route (`tool_calls`, as WP6 has today). The published
 *      gateway has no call id, so a connector tool also dedupes on `(takeoverId, tool, argsHash)` within 30 s here
 *      — a retried `payment_link` returns the stored answer and never opens a second checkout;
 *   6. `nextStage` from the blueprint exits, then the stage payload, and `nextStep` = the new stage's goal text
 *      when the stage changed (WP18's gateway puts it in the response body; `next_step` is the whole stage-change
 *      mechanism on published runs).
 *
 * The flow state that is not derivable from fact events lives where WP6 put it — `takeovers.metrics` (disclosures,
 * connectors, the confirmation number) and the `payments` rows — and is mirrored into `cases.state` with WP3's
 * `setCaseExtras` after every call, exactly as the legacy path does.
 *
 * Readiness and the next step are computed from the RELAY's spec (`readinessFor`, `nextStepFor`), never from the
 * legacy `state.readiness`, which is derived against Baton's required-field list until WP14b·3 injects the spec.
 */

export interface RelayToolConfig {
  deployId: string;
  /** DISCLOSURE_TAX_SUFFIX (`{?opt.tax_suffix}` in a disclosure template). */
  taxSuffix: boolean;
}

export interface RelayToolDeps {
  /** PLATFORM §6.3 `engines`; used when the run source does not resolve the version itself. */
  engines?: RelayEngineFactory;
  runs: RelayRunSource;
  cases: CaseSink;
  store: ToolStore;
  payments: Pick<PaymentService, "create">;
  connectors: { execute(i: ConnectorExecuteInput): Promise<ConnectorOutcome> };
  callLog: ConnectorCallLog;
  config: RelayToolConfig;
  clock?: () => number;
  confirmationNumber?: () => string;
  log?: Logger;
}

/** The run, loaded once per tool call. */
interface Ctx {
  ctx: RelayToolContext;
  c: RelayRunCase;
  compiled: CompiledRelay;
  blueprint: Blueprint;
  account: AccountRecord;
  tko: TakeoverRecord;
  pay: PaymentRecord | null;
  /** The derived case state with the flow overlay, and `stage` caught up to the forward-only rules. */
  state: CaseState;
  /** The DERIVED state as WP3 stores it (no flow overlay): what `setCaseExtras` is compared against. */
  raw: CaseState;
  flow: RelayFlowCtx;
  version: number;
  callDate: string;
}

interface HandlerOut {
  result: Record<string, unknown>;
  events?: NewFactEvent[];
  ui?: RelayToolOutcome["ui"];
  /** Also return the input mode of the next step (field updates and date confirmations). */
  withInputMode?: boolean;
  transcriptionMode?: RelayToolOutcome["transcriptionMode"];
  /** A `confirm_effective_date`-style result that wants `next` filled with the new stage id. */
  wantsNext?: boolean;
}

export const NOT_AVAILABLE_INSTRUCTION = "That is not the step you are on. Follow the current step instead.";

export class RelayToolServiceImpl implements RelayToolService {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly confNumber: () => string;

  constructor(private readonly deps: RelayToolDeps) {
    this.now = deps.clock ?? Date.now;
    this.log = (deps.log ?? rootLog).child({ component: "relay-tools" });
    this.confNumber = deps.confirmationNumber ?? defaultConfirmationNumber;
  }

  async handle(name: string, args: unknown, ctx: RelayToolContext): Promise<RelayToolOutcome> {
    const x = await this.load(ctx);
    const before = x.state.stage;

    // 2. The stage gate. Fail-closed: an unknown tool and an out-of-stage tool answer the same way.
    const def = x.compiled.tools(x.state.stage ?? firstStage(x)).find((t) => t.name === name);
    if (!def) {
      this.log.info("tool refused by the stage gate", { tool: name, stage: x.state.stage, takeoverId: ctx.takeoverId });
      return { result: { status: "not_available", instruction: NOT_AVAILABLE_INSTRUCTION }, nextStep: null };
    }

    // 3. Arguments.
    const parsed = validateToolArgs(paramsOfTool(def), args);
    if (!parsed.ok) {
      this.log.info("invalid tool args", { tool: name, errors: parsed.errors });
      return { result: invalidArgs(name, parsed.errors), nextStep: null };
    }
    const a = parsed.args as Record<string, unknown>;

    // 5a. The published-gateway dedupe, for connector tools only (the built-ins are pure over the case state).
    const connector = connectorForTool(x.compiled, name);
    if (connector && ctx.callId === null) {
      const stored = await this.recentResult(ctx.takeoverId, name, a);
      if (stored) {
        this.log.info("deduped connector call", { tool: name, takeoverId: ctx.takeoverId });
        return this.finish(x, before, { result: stored }, name);
      }
    }

    let out: HandlerOut;
    if (connector) {
      const outcome = await this.deps.connectors.execute({
        compiled: x.compiled,
        connectorId: connector.id,
        args: a,
        ctx: connectorCtx(x, ctx),
        run: this.runOf(x),
      });
      out = { result: outcome.result, ...(outcome.ui ? { ui: outcome.ui } : {}) };
    } else {
      out = await this.builtin(x, name, a);
    }

    return this.finish(x, before, out, name);
  }

  /**
   * A replayed `(takeoverId, callId)` (the browser retried): the stored result plus the CURRENT stage payload.
   * `nextStep` is null — the first attempt already delivered it.
   */
  async replay(name: string, stored: Record<string, unknown>, ctx: RelayToolContext): Promise<RelayToolOutcome> {
    const x = await this.load(ctx);
    const out: RelayToolOutcome = { result: stored, nextStep: null };
    if (x.state.stage) Object.assign(out, this.stagePayload(x, x.state.stage));
    const connector = connectorForTool(x.compiled, name);
    if (connector?.type === "payment_link" && x.pay) {
      const run = this.runOf(x);
      const link = `${payOrigin(ctx.origin)}/pay/${x.pay.id}`;
      out.ui = { sms: `${run.render(connector.smsTemplate)} ${link}`.trim(), link, paymentId: x.pay.id };
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ steps 5b, 6

  /** Apply the events, recompute the stage, build the payload and `nextStep`. */
  private async finish(x: Ctx, before: Stage | null, out: HandlerOut, name: string): Promise<RelayToolOutcome> {
    let state = x.state;
    let stored: CaseState = x.raw;
    if (out.events?.length) {
      const applied = await this.deps.cases.applyEvents(x.c.id, await this.caseVersion(x), out.events);
      stored = applied.state;
      x.raw = applied.state;
      state = await this.reload(x, applied.state);
      if (out.ui?.conflict === undefined) {
        const card = conflictFor(state, out.events.map((e) => e.field));
        if (card) out.ui = { ...(out.ui ?? {}), conflict: card };
      }
    } else {
      state = await this.reload(x, x.raw);
    }

    const outcome: RelayToolOutcome = { result: out.result, nextStep: null };
    if (out.ui) outcome.ui = out.ui;

    const next = x.compiled.nextStage(state.stage, stageInput(x, state));
    if (next !== before || (before !== null && next !== x.tko.stage)) {
      await this.deps.store.setStage(x.tko.id, next);
      Object.assign(outcome, this.stagePayload({ ...x, state }, next));
      if (out.wantsNext) out.result.next = next === before ? null : next;
    }
    if (next !== before) outcome.nextStep = goalOf(x.compiled, next, state, x.account);
    if (out.transcriptionMode) outcome.transcriptionMode = out.transcriptionMode;
    else if (out.withInputMode || outcome.stage) outcome.transcriptionMode = x.compiled.spec.inputModeFor(nextStepFor(x.compiled.spec, state)).mode;
    await this.syncExtras(x, stored);
    void name;
    return outcome;
  }

  private stagePayload(x: Pick<Ctx, "compiled" | "account" | "state">, stage: Stage): { stage: Stage; systemPrompt: string; tools: VaFunctionTool[] } {
    return {
      stage,
      systemPrompt: x.compiled.prompt(x.state, x.account, stage, { deployId: this.deps.config.deployId }),
      tools: x.compiled.tools(stage),
    };
  }

  /** Mirror the flow parts into `cases.state` (wp3-to-wp6 item 2). Best effort: never fails a tool answer. */
  private async syncExtras(x: Ctx, stored: CaseState): Promise<void> {
    if (!this.deps.cases.setCaseExtras) return;
    try {
      const tko = (await this.deps.store.getTakeover(x.tko.id)) ?? x.tko;
      const pay = await this.deps.store.latestPayment(x.tko.id);
      const flow = relayFlowCtxOf(disclosureOrder(x.blueprint), tko, pay);
      if (sameFlow(flow, stored)) return;
      const { connectorsSucceeded: _drop, ...patch } = flow;
      await this.deps.cases.setCaseExtras(x.c.id, patch);
    } catch (e) {
      this.log.warn("setCaseExtras failed", { caseId: x.c.id, err: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }

  // ------------------------------------------------------------------------------------------ built-in handlers

  private async builtin(x: Ctx, name: string, a: Record<string, unknown>): Promise<HandlerOut> {
    if (name === "update_case_field") return this.updateCaseField(x, a);
    if (name === "hand_back_to_rep") return this.handBack(x, a);
    if (name === "get_disclosure") return this.getDisclosure(x, a);
    const field = x.blueprint.fields.find((f) => f.confirmTool?.name === name);
    if (field?.confirmTool) return this.confirmDate(x, field.id, field.confirmTool.windowDays, a);
    // The stage gate already proved the tool exists on this relay, so this is unreachable in practice.
    throw new BatonError("E_BAD_REQUEST", `Unknown tool ${name}.`);
  }

  /** PLATFORM §4.5: normalize, then the conflict flow (as WP6). */
  private async updateCaseField(x: Ctx, a: Record<string, unknown>): Promise<HandlerOut> {
    const field = String(a.field);
    const raw = String(a.value ?? "");
    const spec = x.compiled.spec;
    const n = spec.normalize(field, raw, { callDate: x.callDate, account: x.account });
    if (!n) return { result: { result: "rejected", reason: "unparseable", field }, withInputMode: true };

    const fs = fieldStateOf(x.state, field);
    const attempts = x.tko.toolFlow.fieldAttempts?.[field] ?? 0;
    if (fs && fs.status === "VERIFIED" && fs.value !== null) {
      if (spec.compatible(field, fs.value, n.norm)) {
        return { result: { result: "accepted", field, status: "VERIFIED", value: fs.display ?? n.display }, withInputMode: true };
      }
      if (attempts === 0 || a.reason !== "customer_corrected") {
        await this.deps.store.mergeToolFlow(x.tko.id, { fieldAttempts: { ...(x.tko.toolFlow.fieldAttempts ?? {}), [field]: attempts + 1 } });
        const recorded = fs.display ?? fs.value;
        const card: ConflictCard = {
          field: field as FieldId,
          values: [
            { value: recorded, party: fs.source ?? "rep", evidence: fs.evidence[0] ?? null },
            { value: n.display, party: "customer", evidence: null },
          ],
          resolved: false,
        };
        return {
          result: { result: "conflict", field, recorded_value: recorded, instruction: CONFLICT_INSTRUCTION },
          ui: { conflict: card },
          withInputMode: true,
        };
      }
      // Second attempt with customer_corrected: accept; the derivation flags it.
    }
    return {
      result: { result: "accepted", field, status: "VERIFIED", value: n.display },
      events: [this.toolUpdate(x, field, raw, n.norm)],
      withInputMode: true,
    };
  }

  /** PLATFORM §4.5: as WP6 — never refuses, and the case is handed back. */
  private async handBack(x: Ctx, a: Record<string, unknown>): Promise<HandlerOut> {
    await this.deps.store.mergeToolFlow(x.tko.id, {
      handBack: { reason: String(a.reason ?? "other"), summary: String(a.summary ?? ""), at: new Date(this.now()).toISOString() },
    });
    await this.deps.store.setCaseStatus(x.c.id, "handed_back", ACTIVE);
    return { result: { status: "transferring", message: `Tell the customer ${x.account.org.repFirstName} is coming back on the line now.` } };
  }

  /**
   * PLATFORM §4.5 `get_disclosure`: renders `disclosures[id]` from the frozen case and the named values, enforces
   * `requiresReady` and `requiresAccepted`, and records the exact text read (WP8's verbatim check).
   */
  private async getDisclosure(x: Ctx, a: Record<string, unknown>): Promise<HandlerOut> {
    const id = String(a.kind);
    const d = x.blueprint.playbook.disclosures.find((y) => y.id === id);
    if (!d) return { result: { ok: false, reason: "unknown_disclosure" } };

    const existing = x.tko.relayDisclosures[id];
    if (existing) {
      return { result: { ok: true, disclosure_id: existing.id, text: existing.text, instruction: DISCLOSURE_INSTRUCTION }, transcriptionMode: "min_latency" };
    }
    if (d.requiresReady && !readinessFor(x.compiled.spec, x.state).ready) {
      return { result: { ok: false, reason: "not_ready", missing: openRequiredFor(x.compiled.spec, x.state) } };
    }
    if (d.requiresAccepted && !x.flow.disclosuresGiven.includes(d.requiresAccepted as never)) {
      return {
        result: {
          ok: false,
          reason: `${d.requiresAccepted}_first`,
          instruction: `Call get_disclosure with kind "${d.requiresAccepted}" first.`,
        },
      };
    }

    const text = x.compiled.disclosure(id, { snapshot: x.state, account: x.account, opts: { taxSuffix: this.deps.config.taxSuffix } });
    const values = x.compiled.values({ snapshot: x.state, account: x.account });
    const money = moneyValues(x.blueprint, values);
    const rec: RelayDisclosureRecord = {
      id: `dsc_${x.tko.id.slice(-8)}_${id}`,
      kind: id,
      text: text.text,
      criticalTokens: text.criticalTokens,
      monthlyUsd: money.monthlyUsd,
      dueTodayUsd: money.dueTodayUsd,
      premiumSource: "relay_value",
      dueSource: "relay_value",
      at: new Date(this.now()).toISOString(),
      values,
    };
    await this.deps.store.putRelayDisclosure(x.tko.id, rec);
    return { result: { ok: true, disclosure_id: rec.id, text: rec.text, instruction: DISCLOSURE_INSTRUCTION }, transcriptionMode: "min_latency" };
  }

  /**
   * PLATFORM §4.5, the field's confirm tool: the SERVER's resolution of `customer_words` wins over the model's
   * `date`, and the value must fall in `[callDate, callDate + windowDays]`.
   */
  private async confirmDate(x: Ctx, field: string, windowDays: number, a: Record<string, unknown>): Promise<HandlerOut> {
    const words = String(a.customer_words ?? "");
    const server = resolveRelativeDate(words, x.callDate);
    const llmRaw = String(a.date ?? "");
    const llm = isIsoDate(llmRaw) ? llmRaw : null;
    if (server && llm && server !== llm) this.log.info("confirm tool: server resolution wins", { takeoverId: x.tko.id, server, llm });
    const chosen = server ?? llm;
    const maxIso = addDays(x.callDate, windowDays);
    const allowed = `today to ${monthDay(maxIso)}`;
    if (!chosen) return { result: { accepted: false, reason: "unparseable", allowed }, withInputMode: true };
    if (chosen < x.callDate || chosen > maxIso) return { result: { accepted: false, reason: "out_of_range", allowed }, withInputMode: true };
    const n = x.compiled.spec.normalize(field, chosen, { callDate: x.callDate, account: x.account });
    const norm = n?.norm ?? chosen;
    return {
      result: { accepted: true, [field]: norm, spoken: x.compiled.spec.display(field, norm, x.account), next: null },
      events: [this.toolUpdate(x, field, words || chosen, norm)],
      withInputMode: true,
      wantsNext: true,
    };
  }

  // ------------------------------------------------------------------------------------------ context

  private async load(ctx: RelayToolContext): Promise<Ctx> {
    const tko = await this.deps.store.getTakeover(ctx.takeoverId);
    if (!tko) throw new BatonError("E_NOT_FOUND", "No such takeover.");
    if (tko.caseId !== ctx.caseId) throw new BatonError("E_FORBIDDEN", "The takeover belongs to another case.");
    const c = await this.deps.runs.loadCase(tko.caseId);
    if (!c) throw new BatonError("E_NOT_FOUND", "No such case.");
    const loaded = await this.deps.cases.load(tko.caseId);
    if (!loaded) throw new BatonError("E_NOT_FOUND", "No such case.");
    const compiled = await this.deps.runs.compiled(c.relayVersionId);
    if (!compiled.blueprint) throw new BatonError("E_INTERNAL", "This relay version has no blueprint.");
    const account = await this.deps.runs.account(compiled, c);
    const pay = await this.deps.store.latestPayment(tko.id);
    const flow = relayFlowCtxOf(disclosureOrder(compiled.blueprint), tko, pay);
    const x: Ctx = {
      ctx, c, compiled, blueprint: compiled.blueprint, account, tko, pay,
      state: loaded.state, raw: loaded.state, flow, version: loaded.version, callDate: account.callDate,
    };
    x.state = this.overlay(x, loaded.state, flow);
    return x;
  }

  /** The flow overlay plus the forward-only catch-up (as WP6's `overlay`). */
  private overlay(x: Pick<Ctx, "compiled">, state: CaseState, flow: RelayFlowCtx): CaseState {
    const base = overlayFlow(state, flow);
    const stage = x.compiled.nextStage(flow.stage, {
      readiness: readinessFor(x.compiled.spec, base),
      disclosuresGiven: base.disclosuresGiven,
      payment: base.payment,
      connectorsSucceeded: flow.connectorsSucceeded,
    });
    return { ...base, stage };
  }

  private async reload(x: Ctx, derived: CaseState): Promise<CaseState> {
    const tko = (await this.deps.store.getTakeover(x.tko.id)) ?? x.tko;
    const pay = await this.deps.store.latestPayment(x.tko.id);
    const flow = relayFlowCtxOf(disclosureOrder(x.blueprint), tko, pay);
    x.tko = tko;
    x.pay = pay;
    x.flow = flow;
    return this.overlay(x, derived, flow);
  }

  /** The case version to apply events against (re-read, because a connector may have written in between). */
  private async caseVersion(x: Ctx): Promise<number> {
    const loaded = await this.deps.cases.load(x.c.id);
    return loaded?.version ?? x.version;
  }

  private toolUpdate(x: Ctx, field: string, valueRaw: string, valueNorm: string): NewFactEvent {
    const callId = x.ctx.callId ?? `gw:${argsHash(field, valueNorm).slice(0, 16)}`;
    const tArm = x.tko.tArmMs;
    return {
      id: toolEventId(x.c.id, x.tko.id, callId),
      caseId: x.c.id,
      field: field as FieldId,
      kind: "tool_update",
      party: "ai",
      valueRaw,
      valueNorm,
      acknowledgesTurnId: null,
      confidence: "high",
      turnId: null,
      turnEndMs: tArm + Math.max(0, this.now() - x.tko.armedAt.getTime()),
      late: false,
      cut: false,
      evidence: null,
      extractor: "tool",
    };
  }

  /** Step 5: the stored answer of the same `(takeover, tool, args)` inside the 30 s window, or null. */
  private async recentResult(takeoverId: string, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try {
      const row = await this.deps.callLog.findRecent({
        takeoverId,
        toolName,
        argsHash: argsHash(toolName, args),
        since: new Date(this.now() - DEDUPE_WINDOW_MS),
      });
      return row?.result ?? null;
    } catch (e) {
      this.log.warn("dedupe lookup failed", { takeoverId, toolName, err: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      return null;
    }
  }

  /** The run a stateful connector executes in (PLATFORM §6.1). */
  private runOf(x: Ctx) {
    const values = x.compiled.values({ snapshot: x.state, account: x.account });
    return {
      caseId: x.c.id,
      takeoverId: x.tko.id,
      scenarioId: isBatonPolicyRun(x) ? x.c.scenarioId : RELAY_DEMO_CUSTOMER_KEY,
      account: x.account,
      snapshot: x.state,
      values,
      disclosuresGiven: x.flow.disclosuresGiven as readonly string[],
      succeeded: x.tko.connectors,
      payment: x.pay,
      confirmationNumber: x.tko.confirmationNumber,
      policy: isBatonPolicyRun(x) ? x.c.policy : null,
      render: (template: string, extra?: Readonly<Record<string, string | null>>) =>
        renderIn(x.blueprint, x.account, x.state, extra ? { ...values, ...extra } : values, template),
    };
  }
}

// ------------------------------------------------------------------------------------------ helpers

const ACTIVE = ["shadowing", "armed", "ai_active"] as const;

/** A recorded flagship run keeps its scenario's Polar demo customer and its real policy address. */
const isBatonPolicyRun = (x: Ctx): boolean => x.c.simCallId === null && x.compiled.ui.relay.flagship;

const disclosureOrder = (bp: Blueprint): string[] => bp.playbook.disclosures.map((d) => d.id);

/**
 * The `ConnectorCtx` of this tool call. `workspaceId` is the RELAY OWNER's workspace on a published run (WP18's
 * gateway resolves it from the relay row and hands it over on `ctx`), never the visitor's; on a test or live run
 * the two are the same workspace.
 */
function connectorCtx(x: Ctx, ctx: RelayToolContext): ConnectorCtx {
  const owner = (ctx as RelayToolContext & { workspaceId?: string }).workspaceId;
  return {
    mode: ctx.mode,
    caseId: x.c.id,
    takeoverId: x.tko.id,
    workspaceId: owner ?? workspaceOf(ctx.visitorId),
    origin: ctx.origin,
    publicationId: ctx.publicationId,
  };
}

const firstStage = (x: Ctx): Stage => x.compiled.ui.stages[0]?.kind ?? "confirm";

function fieldStateOf(s: CaseState, id: string) {
  return (s.fields as unknown as Record<string, CaseState["fields"][FieldId] | undefined>)[id];
}

function stageInput(x: Ctx, state: CaseState) {
  return {
    readiness: readinessFor(x.compiled.spec, state),
    disclosuresGiven: state.disclosuresGiven,
    payment: state.payment,
    connectorsSucceeded: x.flow.connectorsSucceeded,
  };
}

/** `KernelRelay.stageGoal` when the compiler is the kernel (it always is for a relay version). */
function goalOf(compiled: CompiledRelay, stage: Stage, snapshot: CaseState, account: AccountRecord): string | null {
  const k = compiled as Partial<KernelRelay>;
  return typeof k.stageGoal === "function" ? k.stageGoal(stage, snapshot, account) || null : null;
}

/** The generated tool schema as `validateToolArgs` takes it. */
function paramsOfTool(t: VaFunctionTool): ToolParams {
  return t.parameters as unknown as ToolParams;
}

/**
 * The invalid-argument answer. Baton's six tools keep their G0 texts, so the legacy suite passes unchanged; any
 * other tool gets the generic form.
 */
function invalidArgs(name: string, issues: readonly string[]): Record<string, unknown> {
  const known: Record<string, Record<string, unknown>> = {
    update_case_field: { result: "rejected", reason: "invalid_args" },
    confirm_effective_date: { accepted: false, reason: "unparseable" },
    get_disclosure: { ok: false, reason: "invalid_args" },
    send_confirmation: { ok: false, reason: "invalid_args" },
  };
  return known[name] ?? { status: "failed", reason: "invalid_args", instruction: `Call it again with ${issues[0] ?? "the declared arguments"}.` };
}

/**
 * `monthlyUsd` / `dueTodayUsd` for the stored disclosure record (WP8's `metrics.disclosures[kind]` shape). For a
 * relay they are its money-typed named values: the payment connector's amount is "due today", and the first other
 * money value is the recurring one. For Baton that reproduces `due_today` and `monthly_premium` exactly.
 */
function moneyValues(bp: Blueprint, values: Readonly<Record<string, string | null>>): { monthlyUsd: string; dueTodayUsd: string } {
  const pay = bp.connectors.find((c) => c.type === "payment_link");
  const dueId = pay?.type === "payment_link" ? pay.amount : null;
  const money = bp.values.filter((v) => v.type === "money");
  const monthlyId = money.find((v) => v.id !== dueId)?.id ?? dueId;
  return {
    dueTodayUsd: (dueId ? values[dueId] : null) ?? "0.00",
    monthlyUsd: (monthlyId ? values[monthlyId] : null) ?? "0.00",
  };
}

const templateCache = new TemplateCache();

/** Render a blueprint template in the run's scope (`{v.*}` also carries the connector's validated args). */
function renderIn(bp: Blueprint, account: AccountRecord, snapshot: CaseState, values: Readonly<Record<string, string | null>>, src: string): string {
  return renderAst(templateCache.get(src), makeScope({ bp, account, snapshot, values }));
}

function conflictFor(state: CaseState, fields: readonly FieldId[]): ConflictCard | null {
  const set = new Set<string>(fields as readonly string[]);
  return state.conflicts.find((c) => set.has(c.field) && !c.resolved) ?? null;
}

function sameFlow(f: RelayFlowCtx, s: Pick<CaseState, "stage" | "disclosuresGiven" | "payment" | "confirmationNumber">): boolean {
  return (
    f.stage === (s.stage ?? null) &&
    f.confirmationNumber === (s.confirmationNumber ?? null) &&
    (f.payment?.id ?? null) === (s.payment?.id ?? null) &&
    (f.payment?.status ?? null) === (s.payment?.status ?? null) &&
    f.disclosuresGiven.length === s.disclosuresGiven.length &&
    f.disclosuresGiven.every((d, i) => d === s.disclosuresGiven[i])
  );
}

const payOrigin = (origin: string): string => {
  try {
    return new URL(origin).origin;
  } catch {
    return "";
  }
};

