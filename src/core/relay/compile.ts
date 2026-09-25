/**
 * relay/compile.ts - `compileRelay(bp)` → `CompiledRelay` (PLATFORM §4.1): the kernel that runs any relay from its
 * blueprint (greeting, prompt, tools, disclosures, named values, stages, extractor, listening, UI spec and the
 * takeover's first update). WP14a. Pure and isomorphic (the Studio compiles in the browser for its live preview).
 *
 * For the Baton blueprint (`data/relays/baton-add-driver.json`, compiled with `flagship: true`) every output equals
 * the legacy compiler's (parity suite, PLATFORM §4.6), except the listed differences: `promptVersion` is
 * `relay:<hash8>`. Non-flagship relays get the kernel safety block in every prompt (PLATFORM §4.4).
 */
import type { CaseState, Stage } from "../contracts/case";
import type { CompiledTakeover } from "../contracts/takeover";
import type { VaFunctionTool } from "../contracts/tools";
import type { AccountRecord, Blueprint, Connector } from "../contracts/v2/blueprint";
import {
  STAGE_KIND_TO_STAGE, type CompiledListening, type CompileTakeoverOptions, type DisclosureText, type GreetingResult,
  type UiSpec,
} from "../contracts/v2/relay";
import type { CompiledRelay } from "../contracts/v2/services";
import { LIMITS } from "../aai/streaming";
import { resolveDueToday, resolvePremium } from "../compiler/disclosures";
import { buildFirstUpdate, KEYTERM_MAX_CHARS, KEYTERMS_MAX, validateFirstUpdate } from "../compiler/first-update";
import { deployMarkerLine, deployMarkerOf } from "../compiler/prompt";
import { compileExtractor } from "./extractor";
import { formatValue } from "./formatters";
import { blueprintHash, hash8 } from "./migrate";
import { DEFAULT_PROMPT_HEAD, DEFAULT_PROMPT_TAIL, defaultRulesBlock } from "./prompt-default";
import { safetyBlock } from "./safety";
import {
  fieldState, knownValue, lookupTableOf, makeScope, renderIn, renderTracked, type Fields, type ScopeSlots,
} from "./scope";
import { buildIntentSpec, nextStepFor, readinessFor, sessionCapMsFor, type BlueprintSpec } from "./spec";

export interface CompileRelayOptions {
  /** The relay version id (null for an unsaved draft or the Studio preview). */
  versionId?: string | null;
  relayId?: string | null;
  /** Precomputed blueprint hash (else computed). */
  hash?: string;
  /** The flagship Baton: exempt from the safety block (PROMPT_V3 carries the rules). Set by the registry only. */
  flagship?: boolean;
  /** The run is a simulated call (UiSpec provenance). */
  simulated?: boolean;
}

/** Built-in tool texts (PLATFORM §4.5; the defaults are today's Baton texts). */
export const BUILTIN_TOOL_TEXT = {
  update_case_field: "Record a field value the customer just confirmed, corrected or newly provided.",
  hand_back_to_rep: "Return the call to the human representative. After calling it, say one short sentence that the rep is coming back.",
  get_disclosure: "Get disclosure text that you must read to the customer word for word.",
  customer_words_agreeing: "The customer's exact words agreeing",
  customer_words: "The customer's exact words",
  hand_back_summary: "One sentence for the rep",
} as const;
export const UPDATE_FIELD_REASONS_V2 = ["customer_confirmed", "customer_corrected", "newly_provided"] as const;
export const HAND_BACK_REASONS_KERNEL = ["advice_requested", "customer_request", "conflict", "customer_declined", "out_of_scope", "payment_problem", "other"] as const;
/** Every kernel tool is interactive with this timeout (push-mode payment included, T-D1-1). */
export const KERNEL_TOOL_TIMEOUT_S = 10;
const CONFIRM_TOOL_EXAMPLE = "2026-10-02";
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const dedupeTerms = (terms: readonly string[], max: number, maxChars: number): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t || t.length > maxChars || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
};

/** Consecutive `table.<t>.<col>` paths of one table expand row by row (legacy: make, model, "make model" per vehicle). */
function expandPaths(paths: readonly string[], one: (path: string) => string[], table: (t: string, cols: string[]) => string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const m = /^table\.([a-z0-9_]+)\.([a-z0-9_]+)$/.exec(paths[i]!);
    if (!m) { out.push(...one(paths[i]!)); continue; }
    const cols = [m[2]!];
    while (i + 1 < paths.length) {
      const n = /^table\.([a-z0-9_]+)\.([a-z0-9_]+)$/.exec(paths[i + 1]!);
      if (!n || n[1] !== m[1]) break;
      cols.push(n[2]!);
      i++;
    }
    out.push(...table(m[1]!, cols));
  }
  return out;
}

function accountPath(path: string, account: AccountRecord): string[] {
  const c = account.customer;
  switch (path) {
    case "customer.firstName": return [c.firstName];
    case "customer.lastName": return [c.lastName];
    case "customer.fullName": return [`${c.firstName} ${c.lastName}`];
    case "org.name": return [account.org.name];
    case "org.repFirstName": return [account.org.repFirstName];
    default: return path.startsWith("fact.") ? [account.facts[path.slice(5)] ?? ""] : [];
  }
}

const tableCols = (account: AccountRecord) => (t: string, cols: string[]): string[] =>
  (account.tables[t] ?? []).flatMap((r) => cols.map((c) => r[c] ?? ""));

/** `CompiledRelay` plus the kernel extras the tests, the Studio preview and WP14b use. */
export interface KernelRelay extends CompiledRelay {
  spec: BlueprintSpec;
  blueprint: Blueprint;
  caseJson(snapshot: Fields, account: AccountRecord): string;
  vaKeyterms(snapshot: Fields, account: AccountRecord): string[];
  initialStage(snapshot: Fields): Stage;
  stageGoal(stage: Stage, snapshot: Fields, account: AccountRecord): string;
  /** Every tool name any stage lists (the first-update whitelist of this relay). */
  toolNames(): string[];
}

export function compileRelay(bp: Blueprint, opts: CompileRelayOptions = {}): KernelRelay {
  const hash = opts.hash ?? blueprintHash(bp);
  const spec = buildIntentSpec(bp, { hash });
  const T = spec.templates;
  const flagship = opts.flagship ?? false;
  const disclosures = new Map(bp.playbook.disclosures.map((d) => [d.id, d]));
  const connectorsById = new Map(bp.connectors.map((c) => [c.id, c]));
  const stageByRuntime = new Map(bp.playbook.stages.map((s) => [STAGE_KIND_TO_STAGE[s.kind] as Stage, s]));
  const runtimeStages = bp.playbook.stages.map((s) => STAGE_KIND_TO_STAGE[s.kind] as Stage);
  const extractor = compileExtractor(bp, spec);

  // ------------------------------------------------------------------------------------------ named values
  const values = (ctx: { snapshot: Fields; account: AccountRecord }): Record<string, string | null> => {
    const out: Record<string, string | null> = {};
    const facts = ctx.account.facts;
    const evalRef = (ref: Blueprint["values"][number]["ref"]): string | null => {
      switch (ref.kind) {
        case "field": {
          const st = fieldState(ctx.snapshot, ref.field);
          return st && st.status === "VERIFIED" && st.value !== null && (!ref.requireRep || st.source === "rep") ? st.value : null;
        }
        case "fact": return facts[ref.key] ?? null;
        case "fixed": return ref.value;
        case "lookup": {
          const key = knownValue(ctx.snapshot, ref.keyField);
          const def = bp.context.tables.find((t) => t.id === ref.table);
          if (key === null || !def) return null;
          return (ctx.account.tables[ref.table] ?? []).find((r) => r[def.idColumn] === key)?.[ref.column] ?? null;
        }
        case "builtin": {
          const rating = facts.rating_new_monthly_usd;
          if (rating === undefined || !Number.isFinite(Number(rating))) return null;
          if (ref.id === "insurance.monthly_premium") return Number(rating).toFixed(2);
          const monthly = resolvePremium(ctx.snapshot as Pick<CaseState, "fields">, Number(rating)).monthlyUsd;
          const due = facts.scenario_due_today_usd;
          return resolveDueToday({
            snapshot: ctx.snapshot as Pick<CaseState, "fields">,
            newMonthlyUsd: monthly,
            currentMonthlyUsd: Number(facts.current_monthly_premium_usd ?? 0),
            scenarioDueTodayUsd: due !== undefined && Number.isFinite(Number(due)) ? Number(due) : null,
            callDate: ctx.account.callDate,
          }).dueTodayUsd;
        }
        case "first_of": {
          for (const r of ref.refs) { const v = evalRef(r); if (v !== null) return v; }
          return null;
        }
      }
    };
    for (const v of bp.values) out[v.id] = evalRef(v.ref);
    return out;
  };

  const baseSlots = (snapshot: Fields, account: AccountRecord): ScopeSlots => ({ subject: () => spec.subject(snapshot, account) });

  // ------------------------------------------------------------------------------------------ case JSON
  const caseJson = (snapshot: Fields, account: AccountRecord): string => {
    const cfg = bp.playbook.caseJson;
    const header: Record<string, unknown> = {};
    for (const h of cfg.header) {
      const scope = makeScope({ bp, account, snapshot });
      const ref = /^fact\.(.+)$/.exec(h.from);
      header[h.key] = ref ? (account.facts[ref[1]!] ?? null) : renderIn(T, `{${h.from}}`, scope);
    }
    const tables: Record<string, Record<string, string>> = {};
    for (const t of cfg.tables) {
      const def = bp.context.tables.find((x) => x.id === t.table);
      tables[t.key] = Object.fromEntries((account.tables[t.table] ?? []).map((r) => [r[def?.idColumn ?? "id"] ?? "", r[def?.labelColumn ?? "label"] ?? ""]));
    }
    const fields: Record<string, { status: string; value?: string }> = {};
    const optional: string[] = [];
    const decided: Record<string, string> = {};
    for (const f of bp.fields) {
      const st = fieldState(snapshot, f.id);
      if (!st) continue;
      if (f.adviceDomain) {
        if (st.status !== "MISSING" && st.value !== null) decided[f.id] = st.display ?? st.value;
        continue;
      }
      if (f.promptVisibility === "rep_verified_only") {
        if (st.status === "VERIFIED" && st.source === "rep" && st.value !== null) {
          fields[f.id] = { status: "VERIFIED", value: st.display ?? st.value };
          if (!f.required) optional.push(f.id);
        }
        continue;
      }
      if (f.required || f.promptVisibility === "always" || st.status !== "MISSING") {
        fields[f.id] = st.status === "MISSING" || st.value === null ? { status: "MISSING" } : { status: st.status, value: st.display ?? st.value };
        if (!f.required) optional.push(f.id);
      }
    }
    const render = () => JSON.stringify({
      intent: bp.meta.intent.id, ...header, ...tables, fields,
      ...(Object.keys(decided).length ? { decided_by_rep: decided } : {}),
    });
    let json = render();
    // Over the cap: drop optional fields (last first), then rep decisions, then shorten long values (legacy order).
    while (json.length > cfg.maxChars && optional.length) { delete fields[optional.pop()!]; json = render(); }
    for (const k of Object.keys(decided).reverse()) { if (json.length <= cfg.maxChars) break; delete decided[k]; json = render(); }
    for (const max of [60, 30, 12]) {
      if (json.length <= cfg.maxChars) break;
      for (const v of Object.values(fields)) if (v.value && v.value.length > max) v.value = `${v.value.slice(0, max - 1)}…`;
      json = render();
    }
    return json;
  };

  // ------------------------------------------------------------------------------------------ greeting
  const wordsIn = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

  const greeting = (snapshot: Fields, account: AccountRecord): GreetingResult => {
    const g = bp.playbook.greeting;
    const step = nextStepFor(spec, snapshot);
    let phrase: ScopeSlots["phrase"] = {};
    if (step.kind === "confirm" && step.field) {
      const st = fieldState(snapshot, step.field)!;
      phrase = { confirm: spec.confirmPhrase(step.field, st.value!, { account, snapshot, raw: st.display }) };
    } else if (step.kind === "ask" && step.field) {
      phrase = { ask: spec.askPhrase(step.field, { account, snapshot }) };
    }
    const nextSrc = step.kind === "confirm" ? g.next.confirm : step.kind === "ask" ? g.next.ask : g.next.ready;
    const clauses = new Map(g.clauses.map((c) => [c.id, c]));
    const dropOrder = [...g.clauses].filter((c) => c.dropOrder !== null).sort((a, b) => a.dropOrder! - b.dropOrder!);
    const dropped: string[] = [];

    const build = (): { text: string; asserted: string[] } => {
      const asserted: string[] = [];
      const scope = makeScope({
        bp, account, snapshot,
        slots: {
          // `{subject}` states a field too (e.g. the VERIFIED name), so it is rendered tracked here.
          subject: () => renderTracked(T.get(bp.playbook.subject), makeScope({ bp, account, snapshot }), asserted),
          clause: (id) => {
            const c = clauses.get(id);
            return c && !dropped.includes(id) ? renderTracked(T.get(c.text), scope, asserted) : null;
          },
        },
      });
      const parts = [
        renderTracked(T.get(g.opening), scope, asserted),
        renderTracked(T.get(g.summary), scope, asserted),
        renderTracked(T.get(g.optOut), scope, asserted),
        renderIn(T, nextSrc, makeScope({ bp, account, snapshot, slots: { ...baseSlots(snapshot, account), phrase } })),
      ];
      return { text: parts.map((p) => p.trim()).filter(Boolean).join(" "), asserted };
    };
    const clauseText = (id: string): string => {
      const c = clauses.get(id);
      return c ? renderIn(T, c.text, makeScope({ bp, account, snapshot, slots: baseSlots(snapshot, account) })) : "";
    };

    let r = build();
    for (const c of dropOrder) {
      if (wordsIn(r.text) <= g.maxWords) break;
      if (!clauseText(c.id)) continue;
      dropped.push(c.id);
      r = build();
    }
    return {
      text: r.text,
      wordCount: wordsIn(r.text),
      asserted: r.asserted,
      asks: step.kind === "ask" ? step.field : null,
      confirms: step.kind === "confirm" ? step.field : null,
      nextStep: step,
      dropped,
    };
  };

  // ------------------------------------------------------------------------------------------ prompt
  const stageGoal = (stage: Stage, snapshot: Fields, account: AccountRecord): string => {
    const s = stageByRuntime.get(stage);
    return s ? renderIn(T, s.goal, makeScope({ bp, account, snapshot, slots: baseSlots(snapshot, account) })) : "";
  };

  const prompt = (snapshot: Fields, account: AccountRecord, stage: Stage, o: { deployId: string }): string => {
    const slots: ScopeSlots = {
      ...baseSlots(snapshot, account),
      stage: { name: stage, goal: stageGoal(stage, snapshot, account) },
      caseJson: caseJson(snapshot, account),
    };
    const scope = makeScope({ bp, account, snapshot, slots });
    const body = bp.playbook.promptTemplate !== null
      ? renderIn(T, bp.playbook.promptTemplate, scope)
      : [renderIn(T, DEFAULT_PROMPT_HEAD, scope), defaultRulesBlock(account.org.repFirstName, bp.playbook.persona.extraRules), renderIn(T, DEFAULT_PROMPT_TAIL, scope)].join("\n\n");
    const safety = flagship ? "" : `\n\n${safetyBlock(bp, account)}`;
    return `${body}${safety}\n\n${deployMarkerLine(o.deployId)}`;
  };

  // ------------------------------------------------------------------------------------------ tools
  const updateHint = (): string => {
    const custom = bp.playbook.builtinToolText.updateCaseFieldValueHint;
    if (custom !== null) return custom;
    const ai = bp.fields.filter((f) => f.setBy === "ai_allowed");
    const parts = ["As spoken"];
    if (ai.some((f) => f.type === "date")) parts.push("dates as YYYY-MM-DD");
    if (ai.some((f) => f.type === "state")) parts.push("states as 2 letters");
    if (ai.some((f) => f.type === "zip")) parts.push("ZIP codes as 5 digits");
    if (ai.some((f) => f.type === "phone")) parts.push("phone numbers as 10 digits");
    for (const f of ai.filter((x) => x.type === "enum" && x.enumValues)) parts.push(`${f.id} as one of ${f.enumValues!.map((e) => e.value).join(", ")}`);
    return parts.join("; ").slice(0, 300);
  };

  const fn = (name: string, description: string, parameters: Record<string, unknown>): VaFunctionTool =>
    ({ type: "function", name, execution_mode: "interactive", timeout_seconds: KERNEL_TOOL_TIMEOUT_S, description, parameters } as unknown as VaFunctionTool);

  const connectorTool = (c: Connector): VaFunctionTool | null => {
    switch (c.type) {
      case "payment_link":
      case "esign_mock": {
        const esign = c.type === "esign_mock" || c.esign;
        const props: Record<string, unknown> = { customer_agreed_to_text: { type: "boolean" } };
        if (esign) props.paper_copy_requested = { type: "boolean" };
        props.customer_words = { type: "string", description: BUILTIN_TOOL_TEXT.customer_words_agreeing };
        return fn(c.toolName, c.description, { type: "object", required: Object.keys(props), properties: props });
      }
      case "confirmation": return fn(c.toolName, c.description, { type: "object", required: [], properties: {} });
      case "sms_mock":
      case "http_action": return fn(c.toolName, c.description, { type: "object", required: [...c.params.required], properties: JSON.parse(JSON.stringify(c.params.properties)) as Record<string, unknown> });
      case "lookup_table": return fn(c.toolName, c.description, {
        type: "object", required: ["key"], properties: { key: { type: "string", description: `The ${c.keyColumn.replace(/_/g, " ")} to look up` } },
      });
      case "completion_webhook": return null;
    }
  };

  const toolByName = (name: string): VaFunctionTool | null => {
    if (name === "update_case_field") {
      return fn(name, BUILTIN_TOOL_TEXT.update_case_field, {
        type: "object", required: ["field", "value", "reason"],
        properties: {
          field: { type: "string", enum: [...spec.aiSettable] },
          value: { type: "string", description: updateHint() },
          reason: { type: "string", enum: [...UPDATE_FIELD_REASONS_V2] },
        },
      });
    }
    if (name === "hand_back_to_rep") {
      return fn(name, BUILTIN_TOOL_TEXT.hand_back_to_rep, {
        type: "object", required: ["reason", "summary"],
        properties: {
          reason: { type: "string", enum: [...HAND_BACK_REASONS_KERNEL] },
          summary: { type: "string", description: BUILTIN_TOOL_TEXT.hand_back_summary },
        },
      });
    }
    if (name === "get_disclosure") {
      return fn(name, BUILTIN_TOOL_TEXT.get_disclosure, { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: bp.playbook.disclosures.map((d) => d.id) } } });
    }
    const cf = bp.fields.find((f) => f.confirmTool?.name === name);
    if (cf?.confirmTool) {
      const example = cf.examples.find((e) => ISO_RE.test(e)) ?? CONFIRM_TOOL_EXAMPLE;
      return fn(name, cf.confirmTool.description, {
        type: "object", required: ["date", "customer_words"],
        properties: {
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD", examples: [example] },
          customer_words: { type: "string", description: BUILTIN_TOOL_TEXT.customer_words },
        },
      });
    }
    const c = bp.connectors.find((x) => "toolName" in x && x.toolName === name);
    return c ? connectorTool(c) : null;
  };

  const tools = (stage: Stage): VaFunctionTool[] => {
    const s = stageByRuntime.get(stage);
    return (s?.tools ?? []).map(toolByName).filter((t): t is VaFunctionTool => t !== null);
  };

  const allToolNames = (): string[] => [...new Set(bp.playbook.stages.flatMap((s) => s.tools))];

  // ------------------------------------------------------------------------------------------ disclosures
  const disclosure = (id: string, ctx: { snapshot: Fields; account: AccountRecord; opts: { taxSuffix: boolean } }): DisclosureText => {
    const d = disclosures.get(id);
    if (!d) throw new Error(`unknown disclosure "${id}"`);
    const scope = makeScope({
      bp, account: ctx.account, snapshot: ctx.snapshot, values: values(ctx),
      opts: { tax_suffix: ctx.opts.taxSuffix }, slots: baseSlots(ctx.snapshot, ctx.account),
    });
    return {
      kind: id,
      text: renderIn(T, d.text, scope),
      criticalTokens: d.criticalTokens.map((t) => renderIn(T, t, scope)).filter((t) => t.trim() !== ""),
    };
  };

  // ------------------------------------------------------------------------------------------ stages
  const exitMet = (stage: Stage, s: Pick<CaseState, "readiness" | "disclosuresGiven" | "payment"> & { connectorsSucceeded: string[] }): boolean => {
    const def = stageByRuntime.get(stage);
    if (!def) return false;
    const e = def.exit;
    switch (e.kind) {
      case "all_required_verified": return s.readiness.ready;
      case "disclosure_accepted": return (s.disclosuresGiven as readonly string[]).includes(e.disclosure);
      case "connector_succeeded": {
        if (s.connectorsSucceeded.includes(e.connector)) return true;
        return connectorsById.get(e.connector)?.type === "payment_link" && s.payment?.status === "succeeded";
      }
      case "end": return false;
    }
  };

  /** Forward-only (legacy `nextStage`): from the current stage (or the first), advance while the exit is met. */
  const nextStage = (current: Stage | null, s: Pick<CaseState, "readiness" | "disclosuresGiven" | "payment"> & { connectorsSucceeded: string[] }): Stage => {
    let idx = current === null ? 0 : Math.max(0, runtimeStages.indexOf(current));
    if (current !== null && runtimeStages.indexOf(current) < 0) return current;
    while (idx < runtimeStages.length - 1 && exitMet(runtimeStages[idx]!, s)) idx++;
    return runtimeStages[idx]!;
  };

  /** The takeover's first stage (legacy `initialStage`): past the first stage only if its exit is "all required verified" and the case is ready. */
  const initialStage = (snapshot: Fields): Stage => {
    const first = bp.playbook.stages[0]!;
    const ready = readinessFor(spec, snapshot).ready;
    if (first.exit.kind === "all_required_verified" && ready && runtimeStages.length > 1) return runtimeStages[1]!;
    return runtimeStages[0]!;
  };

  // ------------------------------------------------------------------------------------------ listening, keyterms, UI
  const listening = (account: AccountRecord): CompiledListening => {
    const l = bp.listening;
    const ctxTerms = expandPaths(l.contextKeyterms, (p) => accountPath(p, account), tableCols(account));
    return {
      keyterms: dedupeTerms([...ctxTerms, ...l.keyterms], LIMITS.keyterms, LIMITS.keytermChars),
      prompt: l.scenarioPrompt,
      languageCodes: [...l.languageCodes],
      tuning: l.tuning,
    };
  };

  const fieldTerms = (id: string, snapshot: Fields, account: AccountRecord): string[] => {
    const st = fieldState(snapshot, id);
    const fd = spec.field(id);
    if (!st || st.status === "MISSING" || !st.value || !fd) return [];
    const ctx = { account, field: fd, raw: st.display, table: lookupTableOf(bp, account, fd) };
    if (fd.type === "person_name") return [st.display ?? st.value, formatValue("first_name", st.value, ctx)];
    if (fd.normalizer === "insurance.relation") return [formatValue("insurance.relation_word", st.value, ctx)];
    if (fd.type === "enum") return [formatValue("enum_word", st.value, ctx)];
    if (fd.type === "lookup") return [formatValue("lookup_label", st.value, ctx)];
    return [st.display ?? st.value];
  };

  const vaKeyterms = (snapshot: Fields, account: AccountRecord): string[] =>
    dedupeTerms(expandPaths(bp.playbook.vaKeyterms, (p) => (p.startsWith("f.") ? fieldTerms(p.slice(2), snapshot, account) : accountPath(p, account)), tableCols(account)), KEYTERMS_MAX, KEYTERM_MAX_CHARS);

  const payment = bp.connectors.find((c) => c.type === "payment_link");
  const ui: UiSpec = {
    relay: {
      id: opts.relayId ?? null, versionId: opts.versionId ?? null, slug: bp.meta.slug, title: bp.meta.title,
      flagship, simulated: opts.simulated ?? false,
    },
    fields: bp.fields.map((f) => ({
      id: f.id, label: f.label, required: f.required, group: f.ui.group, hidden: f.ui.hidden, type: f.type,
      repOnly: f.setBy === "rep_only", advice: f.adviceDomain,
    })),
    stages: bp.playbook.stages.map((s) => ({ kind: STAGE_KIND_TO_STAGE[s.kind], label: s.label })),
    disclosures: bp.playbook.disclosures.map((d) => ({ id: d.id, title: d.title })),
    connectors: bp.connectors.map((c) => ({ id: c.id, type: c.type, label: c.label })),
    phone: {
      payment: !!payment,
      esign: (payment?.type === "payment_link" && payment.esign) || bp.connectors.some((c) => c.type === "esign_mock"),
      smsSender: bp.context.samples[0]?.org.name ?? bp.meta.title,
    },
  };

  // ------------------------------------------------------------------------------------------ takeover
  const promptVersion = `relay:${hash8(hash)}`;
  const takeover = (snapshot: CaseState, account: AccountRecord, o: CompileTakeoverOptions): CompiledTakeover => {
    const stage = o.stage ?? initialStage(snapshot);
    const g = greeting(snapshot, account);
    const keytermsEnabled = o.keytermsEnabled ?? false;
    const compiled: CompiledTakeover = {
      greeting: g.text,
      systemPrompt: prompt(snapshot, account, stage, { deployId: o.deployId }),
      keyterms: keytermsEnabled ? vaKeyterms(snapshot, account) : [],
      tools: tools(stage),
      stage,
      snapshot,
      voice: o.voice ?? bp.playbook.voice,
      transcriptionMode: spec.inputModeFor(g.nextStep).mode,
      vaSessionCapMs: sessionCapMsFor(spec, bp, snapshot, o.capEnv),
      promptVersion,
      deployMarker: deployMarkerOf(o.deployId),
      compiledBy: o.compiledBy ?? "server",
    };
    validateFirstUpdate(buildFirstUpdate(compiled), { keytermsEnabled, toolNames: allToolNames() });
    return compiled;
  };

  return {
    versionId: opts.versionId ?? null,
    hash,
    blueprint: bp,
    spec,
    ui,
    listening,
    extractor,
    greeting,
    prompt,
    tools,
    disclosure,
    values,
    nextStage,
    takeover,
    caseJson,
    vaKeyterms,
    initialStage,
    stageGoal,
    toolNames: allToolNames,
  };
}

/** `compileRelayTakeover(compiled, snapshot, account, opts)`: the takeover of a compiled relay (runs `validateFirstUpdate`). */
export const compileRelayTakeover = (compiled: CompiledRelay, snapshot: CaseState, account: AccountRecord, opts: CompileTakeoverOptions): CompiledTakeover =>
  compiled.takeover(snapshot, account, opts);
