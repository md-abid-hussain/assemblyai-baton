/**
 * WP6 test fakes: in-memory stores (payments, takeovers/tool calls), a fake CaseRepository with a tiny derivation, a
 * fake WP1 core (ToolCore) and a fake Polar API. The fakes follow the contracts, not WP1's exact rules; the real WP1
 * functions are wired at G1 (docs/notes/wp6.md) and exercised by the integration run.
 */
import type {
  CaseState, CaseStatus, ConflictCard, FieldId, FieldState, NewFactEvent, PaymentStatus, PolicyRecord, Stage,
} from "@/core/contracts/case";
import type { CaseRepository } from "@/core/contracts/services";
import type { VaFunctionTool } from "@/core/contracts/tools";
import { FIELD_IDS, REQUIRED_FIELDS, SERVER_RESOLVABLE_SET } from "@/core/intents/add-driver.fields";
import { allowedFrom, type TransitionVia } from "@/server/payments/machine";
import type { NewPayment, PaymentRecord, PaymentStore, TransitionPatch } from "@/server/payments/store";
import type { PolarApi, PolarCheckout } from "@/server/polar/client";
import type { ToolCore } from "@/server/tools/core-port";
import type {
  BeginCall, ConnectorSuccessRecord, DisclosureRecord, RelayDisclosureRecord, TakeoverRecord, ToolFlowMetrics, ToolStore,
} from "@/server/tools/store";
import { policy as fixturePolicy } from "../../contracts/fixtures";

export const policy: PolicyRecord = fixturePolicy;

// ------------------------------------------------------------------------------------------ memory payment store

export class MemoryPaymentStore implements PaymentStore {
  rows = new Map<string, PaymentRecord>();
  webhooks = new Map<string, { type: string; payload: Record<string, unknown>; error: string | null; processed: boolean }>();
  private t = 0;
  private tick(): Date {
    this.t += 1;
    return new Date(Date.UTC(2026, 8, 25, 12, 0, 0) + this.t);
  }
  async insert(p: NewPayment): Promise<PaymentRecord> {
    const now = this.tick();
    const r: PaymentRecord = {
      id: p.id, caseId: p.caseId, takeoverId: p.takeoverId, provider: p.provider, amountCents: p.amountCents,
      checkoutId: p.checkoutId ?? null, checkoutUrl: p.checkoutUrl ?? null, totalAmountCents: p.totalAmountCents ?? null,
      taxAmountCents: p.taxAmountCents ?? null, simulated: false, status: p.status ?? "created", statusSource: null,
      failureReason: null, esignConsentAt: null, esignName: null, createdAt: now, updatedAt: now,
    };
    this.rows.set(r.id, r);
    return { ...r };
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  async getByCheckout(checkoutId: string) {
    for (const r of this.rows.values()) if (r.checkoutId === checkoutId) return { ...r };
    return null;
  }
  async latestForTakeover(takeoverId: string) {
    const rs = [...this.rows.values()].filter((r) => r.takeoverId === takeoverId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return rs[0] ? { ...rs[0] } : null;
  }
  async transition(id: string, to: PaymentStatus, via: TransitionVia, patch: TransitionPatch = {}, opts: { notSimulated?: boolean } = {}) {
    const r = this.rows.get(id);
    if (!r || !allowedFrom(to, via).includes(r.status)) return null;
    if (opts.notSimulated && r.simulated) return null;
    Object.assign(r, stripUndef(patch), { status: to, updatedAt: this.tick() });
    return { ...r };
  }
  async patch(id: string, patch: Omit<TransitionPatch, "statusSource" | "failureReason" | "simulated">) {
    const r = this.rows.get(id);
    if (!r) return null;
    Object.assign(r, stripUndef(patch), { updatedAt: this.tick() });
    return { ...r };
  }
  async esign(id: string, name: string, at: Date) {
    const r = this.rows.get(id);
    if (!r) return null;
    r.esignConsentAt = at;
    r.esignName = name;
    return { ...r };
  }
  async recordWebhook(id: string, type: string, payload: Record<string, unknown>) {
    const cur = this.webhooks.get(id);
    if (cur && cur.error === null) return false;
    this.webhooks.set(id, { type, payload, error: null, processed: false });
    return true;
  }
  async finishWebhook(id: string, error: string | null) {
    const w = this.webhooks.get(id);
    if (w) Object.assign(w, { error, processed: true });
  }
}

function stripUndef<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ------------------------------------------------------------------------------------------ memory tool store

export class MemoryToolStore implements ToolStore {
  takeovers = new Map<string, TakeoverRecord>();
  caseStatus = new Map<string, CaseStatus>();
  calls = new Map<string, { id: string; takeoverId: string; callId: string; name: string; args: unknown; result: Record<string, unknown> | null; status: string | null }>();
  constructor(private readonly payments: MemoryPaymentStore) {}

  addTakeover(t: Partial<TakeoverRecord> & { id: string; caseId: string }): TakeoverRecord {
    const rec: TakeoverRecord = {
      armedAt: new Date(Date.UTC(2026, 8, 25, 12, 0, 0)), tArmMs: 60_000, stage: null, phase: "active", outcome: null,
      disclosures: {}, relayDisclosures: {}, connectors: {}, confirmationNumber: null, toolFlow: {}, ...t,
    };
    this.takeovers.set(rec.id, rec);
    if (!this.caseStatus.has(rec.caseId)) this.caseStatus.set(rec.caseId, "ai_active");
    return rec;
  }
  async getTakeover(id: string) {
    const t = this.takeovers.get(id);
    return t ? structuredClone(t) : null;
  }
  async setStage(id: string, stage: Stage) {
    const t = this.takeovers.get(id);
    if (t) t.stage = stage;
  }
  async putDisclosure(id: string, d: DisclosureRecord) {
    const t = this.takeovers.get(id);
    if (t) {
      t.disclosures = { ...t.disclosures, [d.kind]: d };
      t.relayDisclosures = { ...t.relayDisclosures, [d.kind]: d };
    }
  }
  /** WP16·2: the same `metrics.disclosures` slot, by blueprint id. */
  async putRelayDisclosure(id: string, d: RelayDisclosureRecord) {
    const t = this.takeovers.get(id);
    if (t) t.relayDisclosures = { ...t.relayDisclosures, [d.kind]: d };
  }
  /** WP16·2: first writer wins, so a replay keeps its payment id. */
  async markConnector(id: string, r: ConnectorSuccessRecord) {
    const t = this.takeovers.get(id);
    if (!t) return r;
    t.connectors = { [r.connectorId]: r, ...t.connectors };
    return t.connectors[r.connectorId]!;
  }
  async putConfirmationNumber(id: string, n: string) {
    const t = this.takeovers.get(id)!;
    if (!t.confirmationNumber) t.confirmationNumber = n;
    return t.confirmationNumber;
  }
  async mergeToolFlow(id: string, patch: ToolFlowMetrics) {
    const t = this.takeovers.get(id);
    if (t) t.toolFlow = { ...t.toolFlow, ...patch };
  }
  async setCaseStatus(caseId: string, status: CaseStatus, from: readonly CaseStatus[]) {
    const cur = this.caseStatus.get(caseId);
    if (!cur || !from.includes(cur)) return false;
    this.caseStatus.set(caseId, status);
    return true;
  }
  async beginCall(i: { id: string; takeoverId: string; callId: string; name: string; args: Record<string, unknown> }): Promise<BeginCall> {
    const k = `${i.takeoverId}:${i.callId}`;
    const cur = this.calls.get(k);
    if (cur) return { fresh: false, id: cur.id, result: cur.result, status: cur.status };
    this.calls.set(k, { ...i, result: null, status: null });
    return { fresh: true, id: i.id };
  }
  async getCall(takeoverId: string, callId: string) {
    const c = this.calls.get(`${takeoverId}:${callId}`);
    return c ? { id: c.id, result: c.result, status: c.status } : null;
  }
  async finishCall(id: string, result: Record<string, unknown>, status: "ok" | "error" | "rejected") {
    for (const c of this.calls.values()) if (c.id === id && c.result === null) Object.assign(c, { result, status });
  }
  async abortCall(id: string) {
    for (const [k, c] of this.calls) if (c.id === id && c.result === null) this.calls.delete(k);
  }
  async latestPayment(takeoverId: string) {
    return this.payments.latestForTakeover(takeoverId);
  }
}

// ------------------------------------------------------------------------------------------ fake case repository

const readiness = (fields: Record<FieldId, FieldState>) => {
  let verified = 0, pending = 0, missing = 0, ready = true;
  for (const f of REQUIRED_FIELDS) {
    const st = fields[f]?.status ?? "MISSING";
    if (st === "VERIFIED") verified++;
    else if (st === "PENDING") pending++;
    else missing++;
    if (st !== "VERIFIED" && !SERVER_RESOLVABLE_SET.has(f)) ready = false;
  }
  return { verified, pending, missing, requiredTotal: REQUIRED_FIELDS.length, ready };
};

export function fieldState(field: FieldId, status: FieldState["status"] = "MISSING", value: string | null = null): FieldState {
  return {
    field, status, reason: status === "VERIFIED" ? "acknowledged" : status === "PENDING" ? "stated_once" : "absent",
    value, display: value, source: value ? "customer" : null, evidence: [], conflict: null, flags: [], updatedAtMs: 0,
  };
}

/** s01-like values (normalized); `statuses` override per field. */
export const S01_VALUES: Partial<Record<FieldId, string>> = {
  driver_full_name: "maya raman", driver_dob: "2009-03-14", driver_relation: "child", license_state: "OH",
  license_status: "provisional", vehicle_assignment: "veh1", operator_type: "primary", garaging_zip: "44107",
  effective_date: "2026-10-02", premium_new_monthly_usd: "142.00",
};

export function makeState(caseId: string, statuses: Partial<Record<FieldId, FieldState["status"]>> = {}): CaseState {
  const fields = Object.fromEntries(
    FIELD_IDS.map((f) => {
      const st = statuses[f] ?? (S01_VALUES[f] !== undefined ? "VERIFIED" : "MISSING");
      return [f, fieldState(f, st, st === "MISSING" ? null : (S01_VALUES[f] ?? null))];
    }),
  ) as Record<FieldId, FieldState>;
  return {
    caseId, intent: "add_driver", version: 0, callClockMs: 60_000, fields, readiness: readiness(fields), conflicts: [],
    stage: null, disclosuresGiven: [], payment: null, confirmationNumber: null,
  };
}

export class FakeCaseRepo implements Pick<CaseRepository, "load" | "applyEvents"> {
  cases = new Map<string, { state: CaseState; version: number; scenarioId: string; tArmMs: number | null; events: NewFactEvent[] }>();
  add(caseId: string, state: CaseState, scenarioId = "s01", tArmMs: number | null = 60_000) {
    this.cases.set(caseId, { state, version: 0, scenarioId, tArmMs, events: [] });
  }
  async load(caseId: string) {
    const c = this.cases.get(caseId);
    if (!c) return null;
    return {
      state: structuredClone(c.state), version: c.version, policy, status: "ai_active" as const, tArmMs: c.tArmMs,
      scenarioId: c.scenarioId, callId: "s01_take1", runPlan: null,
    };
  }
  async applyEvents(caseId: string, _expectedVersion: number, events: Omit<import("@/core/contracts/case").FactEvent, "seq">[]) {
    const c = this.cases.get(caseId)!;
    for (const e of events) {
      c.events.push(e);
      const fs = c.state.fields[e.field];
      if (!fs) continue;   // P§4.7: the field map is keyed by any id
      if (e.kind === "tool_update" && e.valueNorm !== null) {
        if (fs.status === "VERIFIED" && fs.value !== null && fs.value !== e.valueNorm) {
          fs.flags = [...fs.flags, "customer_corrected_verified"];
          const card: ConflictCard = {
            field: e.field,
            values: [{ value: fs.value, party: "rep", evidence: null }, { value: e.valueNorm, party: "ai", evidence: null }],
            resolved: false,
          };
          c.state.conflicts = [...c.state.conflicts, card];
        }
        Object.assign(fs, { status: "VERIFIED", reason: "ai_confirmed", value: e.valueNorm, display: e.valueNorm, source: "ai" });
      }
    }
    c.state.readiness = readiness(c.state.fields);
    c.version += 1;
    c.state.version = c.version;
    return { state: structuredClone(c.state), version: c.version };
  }
}

// ------------------------------------------------------------------------------------------ fake WP1 core

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const STAGE_TOOLS: Record<Stage, string[]> = {
  confirm: ["confirm_effective_date", "update_case_field", "hand_back_to_rep"],
  disclose: ["get_disclosure", "confirm_effective_date", "update_case_field", "hand_back_to_rep"],
  pay: ["send_esign_and_pay_link", "get_disclosure", "update_case_field", "hand_back_to_rep"],
  close: ["send_confirmation", "update_case_field", "hand_back_to_rep"],
};

export const fakeCore: ToolCore = {
  normalizeField(field, raw) {
    const r = raw.trim();
    if (!r || r.includes("??")) return null;
    if (field === "license_state") return /^[a-z]{2}$/i.test(r) ? { norm: r.toUpperCase(), display: r.toUpperCase() } : null;
    if (field === "effective_date" || field === "driver_dob") return /^\d{4}-\d{2}-\d{2}$/.test(r) ? { norm: r, display: r } : null;
    return { norm: r.toLowerCase(), display: r };
  },
  compatible: (_f, a, b) => a === b,
  resolveRelativeDate(words, callDate) {
    const s = words.toLowerCase();
    const iso = /\d{4}-\d{2}-\d{2}/.exec(s);
    if (iso) return iso[0];
    if (/\btomorrow\b/.test(s)) return addDays(callDate, 1);
    const wd = WEEKDAYS.findIndex((d) => s.includes(d));
    if (wd >= 0) {
      const today = new Date(`${callDate}T00:00:00Z`).getUTCDay();
      const delta = (wd - today + 7) % 7 || 7;
      return addDays(callDate, delta);
    }
    if (/\bnext month\b/.test(s)) return addDays(callDate, 45);
    return null;
  },
  spokenDate(iso) {
    const d = new Date(`${iso}T00:00:00Z`);
    const wd = WEEKDAYS[d.getUTCDay()]!;
    return `${wd[0]!.toUpperCase()}${wd.slice(1)}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  },
  disclosureText(kind, ctx) {
    if (kind === "esign_consent") {
      return { kind, text: `ESIGN ${ctx.policy.phoneOnFileLast4} electronically paper copy $${ctx.dueTodayUsd}`, criticalTokens: ["electronically", "paper copy"] };
    }
    return { kind, text: `PREMIUM $${ctx.monthlyUsd} a month, $${ctx.dueTodayUsd} due today`, criticalTokens: [`$${ctx.monthlyUsd}`, `$${ctx.dueTodayUsd}`] };
  },
  resolvePremium(snapshot, rating) {
    const p = snapshot.fields.premium_new_monthly_usd;
    if (p && p.status === "VERIFIED" && p.source === "rep" && p.value) return { monthlyUsd: p.value, source: "rep_quote" };
    return { monthlyUsd: rating.toFixed(2), source: "rating_tool" };
  },
  resolveDueToday(i) {
    if (i.scenarioDueTodayUsd !== null && i.scenarioDueTodayUsd !== undefined) return { dueTodayUsd: i.scenarioDueTodayUsd.toFixed(2), source: "scenario" };
    const cents = Math.max(50, Math.round((Number(i.newMonthlyUsd) - i.currentMonthlyUsd) * 0.2 * 100));
    return { dueTodayUsd: (cents / 100).toFixed(2), source: "prorated" };
  },
  toolsForStage: (stage, opts) =>
    STAGE_TOOLS[stage].map(
      (name) =>
        ({
          type: "function", name, description: `${name}${opts.payToolMode === "push" && name === "send_esign_and_pay_link" ? " (push)" : ""}`,
          parameters: { type: "object", properties: {} },
          execution_mode: name === "send_esign_and_pay_link" && opts.payToolMode !== "push" ? "hold" : "interactive",
          timeout_seconds: 10,
        }) as VaFunctionTool,
    ),
  compilePrompt: (_s, p, stage, o) => `PROMPT agency=${p.agencyName} stage=${stage} deploy=${o.deployId} pay=${o.payToolMode ?? "hold"}`,
  nextStage(current, s) {
    let stage: Stage = current ?? (s.readiness.ready ? "disclose" : "confirm");
    for (;;) {
      const before = stage;
      if (stage === "confirm" && s.readiness.ready) stage = "disclose";
      else if (stage === "disclose" && s.disclosuresGiven.includes("esign_consent")) stage = "pay";
      else if (stage === "pay" && s.payment?.status === "succeeded") stage = "close";
      if (stage === before) return stage;
    }
  },
  nextStepOf(snapshot) {
    for (const f of REQUIRED_FIELDS) if (snapshot.fields[f]?.status === "PENDING") return { kind: "confirm", field: f };
    for (const f of REQUIRED_FIELDS) if (!SERVER_RESOLVABLE_SET.has(f) && snapshot.fields[f]?.status === "MISSING") return { kind: "ask", field: f };
    return { kind: "none", field: null };
  },
  inputModeFor: (next) =>
    next.kind === "ask"
      ? next.field === "license_number"
        ? { mode: "max_accuracy", reason: "id_capture" }
        : { mode: "balanced", reason: "asks_entity" }
      : { mode: "min_latency", reason: next.kind === "disclosure" || next.kind === "consent" ? "disclosure" : "yes_no" },
};

// ------------------------------------------------------------------------------------------ fake Polar

export class FakePolar implements PolarApi {
  checkouts = new Map<string, PolarCheckout>();
  createCalls: unknown[] = [];
  getCalls = 0;
  failCreates = 0;
  /** Override Polar's total (to test the amount check); null = echo the ad-hoc price. */
  totalOverride: number | null = null;
  private n = 0;
  async createCheckout(req: Parameters<PolarApi["createCheckout"]>[0]): Promise<PolarCheckout> {
    this.createCalls.push(req);
    if (this.failCreates > 0) {
      this.failCreates--;
      throw new Error("polar 502");
    }
    const productId = req.products[0]!;
    const price = (req.prices?.[productId]?.[0] ?? { priceAmount: 0 }) as { priceAmount?: number };
    const id = `co_${++this.n}`;
    const total = this.totalOverride ?? price.priceAmount ?? 0;
    const co: PolarCheckout = {
      id, url: `https://sandbox.polar.sh/checkout/${id}`, status: "open", amount: total, totalAmount: total, taxAmount: 0,
      embedOrigin: req.embedOrigin ?? null, customerId: req.customerId ?? null, metadata: (req.metadata ?? {}) as Record<string, unknown>, expiresAt: null,
    };
    this.checkouts.set(id, co);
    return { ...co };
  }
  async getCheckout(id: string): Promise<PolarCheckout> {
    this.getCalls++;
    const co = this.checkouts.get(id);
    if (!co) throw new Error("404");
    return { ...co };
  }
  setStatus(id: string, status: string, totalAmount?: number) {
    const co = this.checkouts.get(id)!;
    co.status = status;
    if (totalAmount !== undefined) co.totalAmount = totalAmount;
  }
}

/** A settable clock. */
export function clock(start = Date.UTC(2026, 8, 25, 12, 0, 30)) {
  const c = { t: start, now: () => c.t, advance: (ms: number) => void (c.t += ms) };
  return c;
}
