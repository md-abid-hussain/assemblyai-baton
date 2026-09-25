/**
 * relay/lint.ts - `lintBlueprint(bp) → LintIssue[]` (PLATFORM §3.4). WP14a. Pure and isomorphic: the Studio runs it
 * in the browser on every change (debounced) and the server re-runs it on save, run and publish.
 * Errors block a run or publish; warnings don't.
 *
 * Every PLATFORM §3.4 rule: L1, L2, L3, G1, C1, S1, X3 (WP14a·1), C2, S2, S3, F1, F2, X1, X2, G2, W3, B1, K1, K2, W2
 * (WP14a·3). The compiled rules (G2, W3, X1, X2) compile the relay (`compileRelay`) and render it for every sample ×
 * the 4 canned states (relay/canned.ts); they run only when the structural rules (L1-L3, S1, X3) pass.
 * `lintBlueprintJson(json)` also maps `BlueprintSchema` parse failures to issues (`SCHEMA`, or `X3` for an unsafe
 * regex, naming the offending group). K1, K2 and W2 need context from outside the blueprint (visibility, pinned
 * publications, the workspace's secret ids, the sims' sample rate): pass `LintOptions`.
 *
 * Every blueprint regex is checked through contracts/v2/regex.ts and matched only through `safeTest()`.
 */
import type { ZodError } from "zod";
import {
  BlueprintSchema, FORMATTERS, type AccountRecord, type Blueprint, type BlueprintField, type SecretRef, type ValueRef,
} from "../contracts/v2/blueprint";
import { checkSafeRegexSource, checkSafeToolPattern, safeTest } from "../contracts/v2/regex";
import { CANNED_STATES, REQUIRED_STAGE_TOOLS, SECONDS_PER_WORD, STAGE_KIND_ORDER, STAGE_KIND_TO_STAGE, type LintIssue } from "../contracts/v2/relay";
import type { Stage } from "../contracts/case";
import {
  parseTemplatePath, renderTemplate, TEMPLATE_OPTIONS, templateConds, templateVars, tryParseTemplate,
  type PathKind, type PathRef, type RenderScope, type TemplateCond, type TemplateNode,
} from "./template";
import { formatValue } from "./formatters";
import { BRAND_LIST_LABEL, findDenylistedBrands, type BrandSite } from "./brand-denylist";
import { cannedSnapshot, type CannedState } from "./canned";
import { compileRelay, mergedListeningKeyterms, type KernelRelay } from "./compile";
import { assertStrictSchema, STRICT_ENUM_MAX, StrictSchemaError } from "./extractor";
import { makeScope, type Fields } from "./scope";

export const LINT_RULES_IMPLEMENTED = [
  "SCHEMA", "L1", "L2", "L3", "G1", "C1", "C2", "S1", "S2", "S3", "F1", "F2", "X1", "X2", "X3", "G2", "W3", "B1", "K1", "K2", "W2",
] as const;
/** Every PLATFORM §3.4 rule is implemented (WP14a·3). Kept for callers that checked it. */
export const LINT_RULES_PENDING = [] as const;

type Path = (string | number)[];
const err = (code: string, path: Path, message: string): LintIssue => ({ code, severity: "error", path, message });
const warn = (code: string, path: Path, message: string): LintIssue => ({ code, severity: "warn", path, message });
const key = (path: Path): string => JSON.stringify(path);
const wordsOf = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);
const normText = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

export const hasLintErrors = (issues: readonly LintIssue[]): boolean => issues.some((i) => i.severity === "error");

// ============================================================================================ template sites

/** Where a template is used decides which path kinds it may reference (lint L3). */
export type TemplateSite =
  | "greeting" | "greeting_summary" | "greeting_next_confirm" | "greeting_next_ask" | "subject" | "phrase"
  | "stage_goal" | "disclosure" | "sms" | "prompt";

const BASE: readonly PathKind[] = ["customer", "org", "rep", "call", "fact", "value", "field"];
const SITE_KINDS: Readonly<Record<TemplateSite, readonly PathKind[]>> = {
  greeting: [...BASE, "subject"],
  greeting_summary: [...BASE, "subject", "clause"],
  greeting_next_confirm: [...BASE, "subject", "phrase"],
  greeting_next_ask: [...BASE, "subject", "phrase"],
  subject: BASE,
  phrase: [...BASE, "subject"],
  stage_goal: [...BASE, "subject", "intent", "roles"],
  disclosure: [...BASE, "subject"],
  sms: [...BASE, "subject"],
  prompt: [...BASE, "subject", "intent", "roles", "persona", "stage", "case_json"],
};

export interface TemplateUse { path: Path; src: string; site: TemplateSite }

/** Every template in a blueprint, with its JSON path and site. */
export function blueprintTemplates(bp: Blueprint): TemplateUse[] {
  const out: TemplateUse[] = [];
  const add = (path: Path, src: string | null | undefined, site: TemplateSite) => { if (typeof src === "string") out.push({ path, src, site }); };
  bp.fields.forEach((f, i) => {
    add(["fields", i, "phrases", "ask"], f.phrases.ask, "phrase");
    add(["fields", i, "phrases", "confirm"], f.phrases.confirm, "phrase");
    f.enumValues?.forEach((ev, j) => {
      add(["fields", i, "enumValues", j, "confirm"], ev.confirm, "phrase");
      ev.confirmIfRaw?.forEach((c, k) => add(["fields", i, "enumValues", j, "confirmIfRaw", k, "text"], c.text, "phrase"));
    });
  });
  const pb = bp.playbook;
  add(["playbook", "subject"], pb.subject, "subject");
  const g = pb.greeting;
  add(["playbook", "greeting", "opening"], g.opening, "greeting");
  add(["playbook", "greeting", "summary"], g.summary, "greeting_summary");
  g.clauses.forEach((c, i) => add(["playbook", "greeting", "clauses", i, "text"], c.text, "greeting"));
  add(["playbook", "greeting", "optOut"], g.optOut, "greeting");
  add(["playbook", "greeting", "next", "confirm"], g.next.confirm, "greeting_next_confirm");
  add(["playbook", "greeting", "next", "ask"], g.next.ask, "greeting_next_ask");
  add(["playbook", "greeting", "next", "ready"], g.next.ready, "greeting");
  add(["playbook", "promptTemplate"], pb.promptTemplate, "prompt");
  pb.stages.forEach((s, i) => add(["playbook", "stages", i, "goal"], s.goal, "stage_goal"));
  pb.disclosures.forEach((d, i) => {
    add(["playbook", "disclosures", i, "text"], d.text, "disclosure");
    d.criticalTokens.forEach((t, j) => add(["playbook", "disclosures", i, "criticalTokens", j], t, "disclosure"));
  });
  bp.connectors.forEach((c, i) => {
    if (c.type === "payment_link" || c.type === "esign_mock" || c.type === "confirmation") add(["connectors", i, "smsTemplate"], c.smsTemplate, "sms");
    if (c.type === "esign_mock") add(["connectors", i, "documentTitle"], c.documentTitle, "sms");
    if (c.type === "sms_mock") add(["connectors", i, "template"], c.template, "sms");
  });
  return out;
}

export interface RegexUse { path: Path; src: string; tool: boolean }

/** Every regex source and tool-parameter pattern in a blueprint (lint X3). */
export function blueprintRegexes(bp: Blueprint): RegexUse[] {
  const out: RegexUse[] = [];
  const add = (path: Path, src: string | undefined, tool = false) => { if (typeof src === "string") out.push({ path, src, tool }); };
  bp.fields.forEach((f, i) => {
    f.enumValues?.forEach((ev, j) => {
      ev.synonyms.forEach((s, k) => add(["fields", i, "enumValues", j, "synonyms", k], s));
      ev.confirmIfRaw?.forEach((c, k) => add(["fields", i, "enumValues", j, "confirmIfRaw", k, "pattern"], c.pattern));
    });
    add(["fields", i, "validation", "pattern"], f.validation.pattern);
    f.qa.ask.forEach((s, k) => add(["fields", i, "qa", "ask", k], s));
    f.qa.weak.forEach((s, k) => add(["fields", i, "qa", "weak", k], s));
  });
  bp.handoff.repLinePatterns.forEach((s, k) => add(["handoff", "repLinePatterns", k], s));
  bp.handoff.acceptance.patterns.forEach((s, k) => add(["handoff", "acceptance", "patterns", k], s));
  bp.qa.adviceLexicon.forEach((s, k) => add(["qa", "adviceLexicon", k], s));
  bp.compliance.aiDisclosurePatterns.forEach((s, k) => add(["compliance", "aiDisclosurePatterns", k], s));
  add(["compliance", "recordingNoticePattern"], bp.compliance.recordingNoticePattern);
  bp.connectors.forEach((c, i) => {
    if (c.type !== "sms_mock" && c.type !== "http_action") return;
    for (const [name, p] of Object.entries(c.params.properties)) add(["connectors", i, "params", "properties", name, "pattern"], p.pattern, true);
  });
  return out;
}

// ============================================================================================ lookups

interface Index {
  fields: Map<string, BlueprintField>;
  facts: Set<string>;
  values: Set<string>;
  tables: Map<string, Set<string>>;
  clauses: Set<string>;
  disclosures: Set<string>;
  connectors: Map<string, Blueprint["connectors"][number]>;
  tools: Set<string>;
}

function indexOf(bp: Blueprint): Index {
  const tools = new Set<string>(["update_case_field", "hand_back_to_rep"]);
  if (bp.playbook.disclosures.length > 0) tools.add("get_disclosure");
  for (const f of bp.fields) if (f.confirmTool) tools.add(f.confirmTool.name);
  for (const c of bp.connectors) if ("toolName" in c) tools.add(c.toolName);
  return {
    fields: new Map(bp.fields.map((f) => [f.id, f])),
    facts: new Set(bp.context.facts.map((f) => f.key)),
    values: new Set(bp.values.map((v) => v.id)),
    tables: new Map(bp.context.tables.map((t) => [t.id, new Set(t.columns)])),
    clauses: new Set(bp.playbook.greeting.clauses.map((c) => c.id)),
    disclosures: new Set(bp.playbook.disclosures.map((d) => d.id)),
    connectors: new Map(bp.connectors.map((c) => [c.id, c])),
    tools,
  };
}

// ============================================================================================ L1 ids unique

function lintL1(bp: Blueprint): LintIssue[] {
  const out: LintIssue[] = [];
  const seen = new Map<string, string>();
  const claim = (id: string, what: string, path: Path) => {
    const prev = seen.get(id);
    if (prev) out.push(err("L1", path, `id "${id}" is used by ${prev} and ${what}; ids must be unique across fields, stages, disclosures, connectors, values and tables`));
    else seen.set(id, what);
  };
  bp.fields.forEach((f, i) => claim(f.id, `field #${i + 1}`, ["fields", i, "id"]));
  bp.playbook.stages.forEach((s, i) => claim(s.id, `stage #${i + 1}`, ["playbook", "stages", i, "id"]));
  bp.playbook.disclosures.forEach((d, i) => claim(d.id, `disclosure #${i + 1}`, ["playbook", "disclosures", i, "id"]));
  bp.connectors.forEach((c, i) => claim(c.id, `connector #${i + 1}`, ["connectors", i, "id"]));
  bp.values.forEach((v, i) => claim(v.id, `value #${i + 1}`, ["values", i, "id"]));
  bp.context.tables.forEach((t, i) => claim(t.id, `table #${i + 1}`, ["context", "tables", i, "id"]));

  const tools = new Map<string, string>();
  for (const b of ["update_case_field", "hand_back_to_rep", "get_disclosure"] as const) tools.set(b, "a built-in tool");
  const claimTool = (name: string, what: string, path: Path) => {
    const prev = tools.get(name);
    if (prev) out.push(err("L1", path, `tool name "${name}" is used by ${prev} and ${what}`));
    else tools.set(name, what);
  };
  bp.fields.forEach((f, i) => { if (f.confirmTool) claimTool(f.confirmTool.name, `the confirm tool of field "${f.id}"`, ["fields", i, "confirmTool", "name"]); });
  bp.connectors.forEach((c, i) => { if ("toolName" in c) claimTool(c.toolName, `connector "${c.id}"`, ["connectors", i, "toolName"]); });

  const dupes = <T>(items: readonly T[], key: (t: T) => string, path: (i: number) => Path, what: string) => {
    const s = new Set<string>();
    items.forEach((it, i) => {
      const k = key(it);
      if (s.has(k)) out.push(err("L1", path(i), `duplicate ${what} "${k}"`));
      s.add(k);
    });
  };
  dupes(bp.context.facts, (f) => f.key, (i) => ["context", "facts", i, "key"], "fact key");
  dupes(bp.playbook.greeting.clauses, (c) => c.id, (i) => ["playbook", "greeting", "clauses", i, "id"], "greeting clause id");
  bp.fields.forEach((f, fi) => {
    if (f.enumValues) dupes(f.enumValues, (e) => e.value, (i) => ["fields", fi, "enumValues", i, "value"], `enum value of "${f.id}"`);
  });
  return out;
}

// ============================================================================================ L2 type/normalizer

type FieldType = BlueprintField["type"];
type Normalizer = BlueprintField["normalizer"];
/** Which normalizers each field type accepts. `insurance.*` wrap the legacy add-driver functions (Baton only). */
export const TYPE_NORMALIZERS: Readonly<Record<FieldType, readonly Normalizer[]>> = {
  text: ["text", "free_text_lower", "insurance.incidents"],
  person_name: ["person_name"],
  date: ["date", "date_future", "date_of_birth"],
  number: ["number", "insurance.age"],
  integer: ["integer", "insurance.age"],
  money: ["money"],
  signed_money: ["signed_money"],
  enum: ["enum", "insurance.relation", "insurance.license_status", "insurance.discount"],
  phone: ["us_phone"],
  zip: ["us_zip5"],
  state: ["us_state"],
  boolean: ["boolean"],
  email: ["email"],
  id_code: ["id_code", "text"],
  lookup: ["lookup", "insurance.vehicle"],
};

function lintL2(bp: Blueprint, ix: Index): LintIssue[] {
  const out: LintIssue[] = [];
  bp.fields.forEach((f, i) => {
    const p: Path = ["fields", i];
    if (!TYPE_NORMALIZERS[f.type].includes(f.normalizer)) {
      out.push(err("L2", [...p, "normalizer"], `field "${f.id}" of type "${f.type}" cannot use normalizer "${f.normalizer}" (allowed: ${TYPE_NORMALIZERS[f.type].join(", ")})`));
    }
    const isEnum = f.type === "enum";
    const hasEnum = (f.enumValues?.length ?? 0) > 0;
    if (isEnum && !hasEnum) out.push(err("L2", [...p, "enumValues"], `enum field "${f.id}" needs enumValues`));
    if (!isEnum && f.enumValues !== undefined) out.push(err("L2", [...p, "enumValues"], `only enum fields take enumValues ("${f.id}" is ${f.type})`));
    const isLookup = f.type === "lookup";
    if (isLookup && !f.lookup) out.push(err("L2", [...p, "lookup"], `lookup field "${f.id}" needs a lookup table`));
    if (!isLookup && f.lookup) out.push(err("L2", [...p, "lookup"], `only lookup fields take a lookup table ("${f.id}" is ${f.type})`));
    if (f.lookup) {
      const cols = ix.tables.get(f.lookup.table);
      if (!cols) out.push(err("L2", [...p, "lookup", "table"], `unknown table "${f.lookup.table}"`));
      else f.lookup.matchColumns.forEach((c, j) => {
        if (!cols.has(c)) out.push(err("L2", [...p, "lookup", "matchColumns", j], `table "${f.lookup!.table}" has no column "${c}"`));
      });
    }
  });
  bp.context.tables.forEach((t, i) => {
    const cols = new Set(t.columns);
    if (!cols.has(t.idColumn)) out.push(err("L2", ["context", "tables", i, "idColumn"], `idColumn "${t.idColumn}" is not a column of "${t.id}"`));
    if (!cols.has(t.labelColumn)) out.push(err("L2", ["context", "tables", i, "labelColumn"], `labelColumn "${t.labelColumn}" is not a column of "${t.id}"`));
  });
  return out;
}

// ============================================================================================ L3 references resolve

const FORMATTER_SET: ReadonlySet<string> = new Set(FORMATTERS);
const OPTION_SET: ReadonlySet<string> = new Set(TEMPLATE_OPTIONS);

function refProblem(ref: PathRef, ix: Index): string | null {
  switch (ref.kind) {
    case "fact": return ix.facts.has(ref.key) ? null : `unknown fact "${ref.key}"`;
    case "value": return ix.values.has(ref.id) ? null : `unknown value "${ref.id}"`;
    case "field": return ix.fields.has(ref.id) ? null : `unknown field "${ref.id}"`;
    case "clause": return ix.clauses.has(ref.id) ? null : `unknown greeting clause "${ref.id}"`;
    default: return null;
  }
}

function condProblem(c: TemplateCond, ix: Index): string | null {
  switch (c.kind) {
    case "field_status": return ix.fields.has(c.field) ? null : `unknown field "${c.field}" in a condition`;
    case "field_eq": {
      const f = ix.fields.get(c.field);
      if (!f) return `unknown field "${c.field}" in a condition`;
      if (f.type === "enum" && f.enumValues && !f.enumValues.some((e) => e.value === c.value)) return `"${c.value}" is not a value of enum field "${c.field}"`;
      return null;
    }
    case "value": return ix.values.has(c.id) ? null : `unknown value "${c.id}" in a condition`;
    case "opt": return OPTION_SET.has(c.id) ? null : `unknown option "${c.id}" (known: ${TEMPLATE_OPTIONS.join(", ")})`;
  }
}

function lintTemplate(use: TemplateUse, ix: Index): { issues: LintIssue[]; nodes: TemplateNode[] | null } {
  const parsed = tryParseTemplate(use.src);
  if (!parsed.ok) return { issues: [err("L3", use.path, `template does not parse: ${parsed.message}`)], nodes: null };
  const issues: LintIssue[] = [];
  const allowed = SITE_KINDS[use.site];
  for (const v of templateVars(parsed.nodes)) {
    if (!allowed.includes(v.ref.kind)) issues.push(err("L3", use.path, `"{${v.path}}" cannot be used here`));
    const p = refProblem(v.ref, ix);
    if (p) issues.push(err("L3", use.path, p));
    if (v.formatter !== null && !FORMATTER_SET.has(v.formatter)) issues.push(err("L3", use.path, `unknown formatter "${v.formatter}"`));
    if (v.ref.kind === "phrase" && use.site !== `greeting_next_${v.ref.which}`) issues.push(err("L3", use.path, `"{${v.path}}" is only allowed in greeting.next.${v.ref.which}`));
  }
  for (const c of templateConds(parsed.nodes)) {
    const p = condProblem(c, ix);
    if (p) issues.push(err("L3", use.path, p));
  }
  return { issues, nodes: parsed.nodes };
}

const KEYTERM_PATH_RE = /^(customer\.(firstName|lastName|fullName)|org\.(name|repFirstName)|fact\.[a-z0-9_]+|table\.[a-z0-9_]+\.[a-z0-9_]+)$/;

function keytermPathProblem(path: string, ix: Index, allowFieldRefs: boolean): string | null {
  if (allowFieldRefs && path.startsWith("f.")) return ix.fields.has(path.slice(2)) ? null : `unknown field "${path.slice(2)}"`;
  if (!KEYTERM_PATH_RE.test(path)) return `"${path}" is not a keyterm path`;
  if (path.startsWith("fact.")) return ix.facts.has(path.slice(5)) ? null : `unknown fact "${path.slice(5)}"`;
  if (path.startsWith("table.")) {
    const [, t, c] = path.split(".");
    const cols = ix.tables.get(t!);
    if (!cols) return `unknown table "${t}"`;
    return cols.has(c!) ? null : `table "${t}" has no column "${c}"`;
  }
  return null;
}

function valueRefProblems(ref: ValueRef, ix: Index, path: Path, out: LintIssue[]): void {
  switch (ref.kind) {
    case "field": if (!ix.fields.has(ref.field)) out.push(err("L3", [...path, "field"], `unknown field "${ref.field}"`)); break;
    case "fact": if (!ix.facts.has(ref.key)) out.push(err("L3", [...path, "key"], `unknown fact "${ref.key}"`)); break;
    case "lookup": {
      const cols = ix.tables.get(ref.table);
      if (!cols) out.push(err("L3", [...path, "table"], `unknown table "${ref.table}"`));
      else if (!cols.has(ref.column)) out.push(err("L3", [...path, "column"], `table "${ref.table}" has no column "${ref.column}"`));
      if (!ix.fields.has(ref.keyField)) out.push(err("L3", [...path, "keyField"], `unknown field "${ref.keyField}"`));
      break;
    }
    case "first_of": ref.refs.forEach((r, i) => valueRefProblems(r, ix, [...path, "refs", i], out)); break;
    default: break;
  }
}

const FROM_KINDS: readonly PathKind[] = ["customer", "org", "rep", "call", "fact", "value", "intent"];

function lintL3(bp: Blueprint, ix: Index, parsed: Map<string, TemplateNode[]>): LintIssue[] {
  const out: LintIssue[] = [];
  for (const use of blueprintTemplates(bp)) {
    const r = lintTemplate(use, ix);
    out.push(...r.issues);
    if (r.nodes) parsed.set(JSON.stringify(use.path), r.nodes);
  }
  const fromPath = (from: string, path: Path) => {
    const ref = parseTemplatePath(from);
    if (!ref || !FROM_KINDS.includes(ref.kind)) { out.push(err("L3", path, `"${from}" is not a context path`)); return; }
    const p = refProblem(ref, ix);
    if (p) out.push(err("L3", path, p));
  };
  bp.playbook.caseJson.header.forEach((h, i) => fromPath(h.from, ["playbook", "caseJson", "header", i, "from"]));
  bp.extraction.context.forEach((c, i) => {
    const path: Path = ["extraction", "context", i, "from"];
    // PLATFORM §5: `table.<id>` → [{id,label}] and `table.<id>.<col>` → a string list are context paths too.
    const tm = /^table\.([a-z][a-z0-9_]*)(?:\.([a-z0-9_]+))?$/.exec(c.from);
    if (!tm) { fromPath(c.from, path); return; }
    const cols = ix.tables.get(tm[1]!);
    if (!cols) out.push(err("L3", path, `unknown table "${tm[1]}"`));
    else if (tm[2] !== undefined && !cols.has(tm[2])) out.push(err("L3", path, `table "${tm[1]}" has no column "${tm[2]}"`));
  });
  bp.playbook.caseJson.tables.forEach((t, i) => { if (!ix.tables.has(t.table)) out.push(err("L3", ["playbook", "caseJson", "tables", i, "table"], `unknown table "${t.table}"`)); });
  bp.listening.contextKeyterms.forEach((k, i) => { const p = keytermPathProblem(k, ix, false); if (p) out.push(err("L3", ["listening", "contextKeyterms", i], p)); });
  bp.playbook.vaKeyterms.forEach((k, i) => { const p = keytermPathProblem(k, ix, true); if (p) out.push(err("L3", ["playbook", "vaKeyterms", i], p)); });
  bp.values.forEach((v, i) => valueRefProblems(v.ref, ix, ["values", i, "ref"], out));
  const needField = (id: string, path: Path) => { if (!ix.fields.has(id)) out.push(err("L3", path, `unknown field "${id}"`)); };
  bp.handoff.allowedWhen.requireVerified.forEach((f, i) => needField(f, ["handoff", "allowedWhen", "requireVerified", i]));
  bp.qa.reaskTargets.forEach((f, i) => needField(f, ["qa", "reaskTargets", i]));
  bp.fields.forEach((f, i) => {
    if (f.serverResolvable && !ix.values.has(f.serverResolvable.value)) out.push(err("L3", ["fields", i, "serverResolvable", "value"], `unknown value "${f.serverResolvable.value}"`));
  });
  bp.playbook.stages.forEach((s, i) => {
    const e = s.exit;
    if (e.kind === "disclosure_accepted" && !ix.disclosures.has(e.disclosure)) out.push(err("L3", ["playbook", "stages", i, "exit", "disclosure"], `unknown disclosure "${e.disclosure}"`));
    if (e.kind === "connector_succeeded" && !ix.connectors.has(e.connector)) out.push(err("L3", ["playbook", "stages", i, "exit", "connector"], `unknown connector "${e.connector}"`));
  });
  bp.playbook.disclosures.forEach((d, i) => {
    if (d.requiresAccepted !== null && !ix.disclosures.has(d.requiresAccepted)) out.push(err("L3", ["playbook", "disclosures", i, "requiresAccepted"], `unknown disclosure "${d.requiresAccepted}"`));
  });
  bp.connectors.forEach((c, i) => {
    const p: Path = ["connectors", i];
    if (c.type === "payment_link" && !ix.values.has(c.amount)) out.push(err("L3", [...p, "amount"], `unknown value "${c.amount}"`));
    if ((c.type === "payment_link" || c.type === "esign_mock") && c.requiresDisclosure !== null && !ix.disclosures.has(c.requiresDisclosure)) {
      out.push(err("L3", [...p, "requiresDisclosure"], `unknown disclosure "${c.requiresDisclosure}"`));
    }
    if (c.type === "confirmation") c.requires.forEach((r, j) => { if (!ix.connectors.has(r)) out.push(err("L3", [...p, "requires", j], `unknown connector "${r}"`)); });
    if (c.type === "lookup_table" && !ix.tables.has(c.table)) out.push(err("L3", [...p, "table"], `unknown table "${c.table}"`));
  });
  return out;
}

// ============================================================================================ G1 greeting safety

const isGuardFor = (field: string) => (g: { cond: TemplateCond; branch: "then" | "else" }): boolean =>
  g.cond.kind === "field_status" && g.cond.field === field && (g.cond.status === "verified" || g.cond.status === "rep")
  && (g.branch === "then") !== g.cond.negate;

/**
 * DESIGN §5.6 invariant, statically: in the greeting (and the subject it embeds) every `f.X` var sits inside a
 * `{?f.X.verified}` or `{?f.X.rep}` section (or the `{:}` branch of its negation); `next.*` never names a field
 * directly (`next.confirm` carries the one PENDING value only through `{phrase.confirm}`).
 */
function lintG1(bp: Blueprint, parsed: Map<string, TemplateNode[]>): LintIssue[] {
  const out: LintIssue[] = [];
  const guarded: Path[] = [["playbook", "subject"], ["playbook", "greeting", "opening"], ["playbook", "greeting", "summary"],
    ...bp.playbook.greeting.clauses.map((_, i): Path => ["playbook", "greeting", "clauses", i, "text"]), ["playbook", "greeting", "optOut"]];
  for (const path of guarded) {
    const nodes = parsed.get(JSON.stringify(path));
    if (!nodes) continue;
    for (const v of templateVars(nodes)) {
      if (v.ref.kind !== "field") continue;
      if (!v.guards.some(isGuardFor(v.ref.id))) {
        out.push(err("G1", path, `"{${v.path}}" must sit inside {?f.${v.ref.id}.verified} or {?f.${v.ref.id}.rep}: the greeting states only VERIFIED values`));
      }
    }
  }
  for (const which of ["confirm", "ask", "ready"] as const) {
    const path: Path = ["playbook", "greeting", "next", which];
    const nodes = parsed.get(JSON.stringify(path));
    if (!nodes) continue;
    for (const v of templateVars(nodes)) {
      if (v.ref.kind === "field") out.push(err("G1", path, `"{${v.path}}" is not allowed in greeting.next.${which}: a field reaches the next-step sentence only through {phrase.confirm} (the one PENDING value) or {phrase.ask}`));
    }
  }
  return out;
}

// ============================================================================================ C1 AI disclosure

/**
 * A render scope over a sample account with NOTHING known about the case: every condition is false, every field,
 * value, subject, clause and phrase renders empty. Enough for the greeting opening (lint C1). Formatters are the
 * kernel's (relay/formatters.ts).
 */
export function sampleOpeningScope(account: AccountRecord): RenderScope {
  return {
    resolve(ref) {
      switch (ref.kind) {
        case "customer":
          return ref.key === "fullName" ? `${account.customer.firstName} ${account.customer.lastName}` : account.customer[ref.key];
        case "org": return account.org.name;
        case "rep": return account.org.repFirstName;
        case "call": return account.callDate;
        case "fact": return account.facts[ref.key] ?? null;
        default: return null;
      }
    },
    test: () => false,
    format: (formatter, value) => formatValue(formatter, value, { account }),
  };
}

function lintC1(bp: Blueprint, parsed: Map<string, TemplateNode[]>): LintIssue[] {
  const path: Path = ["playbook", "greeting", "opening"];
  const nodes = parsed.get(JSON.stringify(path));
  const sample = bp.context.samples[0];
  if (!nodes || !sample) return [];
  const text = renderTemplate(nodes, sampleOpeningScope(sample)).replace(/\s+/g, " ").trim();
  const out: LintIssue[] = [];
  bp.compliance.aiDisclosurePatterns.forEach((p, i) => {
    if (!safeTest(p, text)) out.push(err("C1", path, `the greeting opening ("${text}") does not match AI-disclosure pattern #${i + 1} /${p}/`));
  });
  if (!safeTest(bp.compliance.recordingNoticePattern, text)) {
    out.push(err("C1", path, `the greeting opening ("${text}") does not match the recording notice /${bp.compliance.recordingNoticePattern}/`));
  }
  return out;
}

// ============================================================================================ S1 stages

function lintS1(bp: Blueprint, ix: Index): LintIssue[] {
  const out: LintIssue[] = [];
  let lastRank = -1;
  bp.playbook.stages.forEach((s, i) => {
    const p: Path = ["playbook", "stages", i];
    const rank = STAGE_KIND_ORDER.indexOf(s.kind);
    if (rank <= lastRank) out.push(err("S1", [...p, "kind"], `stage kinds must follow ${STAGE_KIND_ORDER.join(" < ")} with no repeats ("${s.kind}" comes after "${STAGE_KIND_ORDER[lastRank]}")`));
    lastRank = Math.max(lastRank, rank);
    for (const t of REQUIRED_STAGE_TOOLS) if (!s.tools.includes(t)) out.push(err("S1", [...p, "tools"], `stage "${s.id}" must list ${t}`));
    const seen = new Set<string>();
    s.tools.forEach((t, j) => {
      if (seen.has(t)) out.push(err("S1", [...p, "tools", j], `stage "${s.id}" lists "${t}" twice`));
      seen.add(t);
      if (!ix.tools.has(t)) {
        const why = t === "get_disclosure" ? " (the relay has no disclosures)" : "";
        out.push(err("S1", [...p, "tools", j], `stage "${s.id}" lists an unknown tool "${t}"${why}`));
      }
    });
  });
  return out;
}

// ============================================================================================ C2 disclosures

/**
 * Every disclosure asks the customer ("?") and carries a critical token that its text contains. `consent: true`
 * exactly when an act stage follows: the disclosure that gates the act stage (the exit of the stage just before it,
 * or the `requiresDisclosure` of its payment/e-sign connectors) must set it, and a disclosure read where no act stage
 * follows must not. Baton: `esign_consent` (gate) true, `premium_change` false.
 */
function lintC2(bp: Blueprint): LintIssue[] {
  const out: LintIssue[] = [];
  const stages = bp.playbook.stages;
  const actIdx = stages.findIndex((s) => s.kind === "act");
  const byTool = connectorsByTool(bp);
  const gates = new Set<string>();
  if (actIdx >= 0) {
    const prev = stages[actIdx - 1];
    if (prev?.exit.kind === "disclosure_accepted") gates.add(prev.exit.disclosure);
    for (const t of stages[actIdx]!.tools) {
      const c = byTool.get(t);
      if ((c?.type === "payment_link" || c?.type === "esign_mock") && c.requiresDisclosure) gates.add(c.requiresDisclosure);
    }
  }
  bp.playbook.disclosures.forEach((d, i) => {
    const p: Path = ["playbook", "disclosures", i];
    if (!d.text.includes("?")) out.push(err("C2", [...p, "text"], `disclosure "${d.id}" must ask the customer a question ("?"), so a yes answers it`));
    if (d.criticalTokens.length === 0) out.push(err("C2", [...p, "criticalTokens"], `disclosure "${d.id}" needs at least one critical token (the verbatim check)`));
    else if (!d.criticalTokens.some((t) => normText(t) !== "" && normText(d.text).includes(normText(t)))) {
      out.push(err("C2", [...p, "criticalTokens"], `none of the critical tokens of "${d.id}" appears in its text`));
    }
    const acceptedAt = stages.findIndex((s) => s.exit.kind === "disclosure_accepted" && s.exit.disclosure === d.id);
    const readAt = acceptedAt >= 0 ? acceptedAt : stages.findIndex((s) => s.tools.includes("get_disclosure"));
    const actFollows = actIdx >= 0 && readAt >= 0 && actIdx > readAt;
    if (d.consent && !actFollows) out.push(err("C2", [...p, "consent"], `disclosure "${d.id}" sets consent: true but no act stage follows the stage that reads it`));
    if (!d.consent && gates.has(d.id)) out.push(err("C2", [...p, "consent"], `disclosure "${d.id}" gates the act stage, so it must set consent: true (a yes to it is the consent to act)`));
  });
  if (actIdx >= 0 && !bp.playbook.disclosures.some((d) => d.consent)) {
    out.push(err("C2", ["playbook", "stages", actIdx], `the act stage "${stages[actIdx]!.id}" needs a disclosure with consent: true accepted before it`));
  }
  return out;
}

// ============================================================================================ S2, S3 stages × connectors

type AnyConnector = Blueprint["connectors"][number];
function connectorsByTool(bp: Blueprint): Map<string, AnyConnector> {
  const m = new Map<string, AnyConnector>();
  for (const c of bp.connectors) if ("toolName" in c) m.set(c.toolName, c);
  return m;
}
const acts = (c: AnyConnector | undefined): boolean =>
  c?.type === "payment_link" || c?.type === "esign_mock" || (c?.type === "http_action" && c.sideEffect);

/** `connector_succeeded` exits name a connector the stage lists; an act stage acts; `confirmation.requires` names connectors that can succeed first. */
function lintS2(bp: Blueprint, ix: Index): LintIssue[] {
  const out: LintIssue[] = [];
  const byTool = connectorsByTool(bp);
  bp.playbook.stages.forEach((s, i) => {
    const p: Path = ["playbook", "stages", i];
    if (s.exit.kind === "connector_succeeded") {
      const c = ix.connectors.get(s.exit.connector);
      if (c && !("toolName" in c)) out.push(err("S2", [...p, "exit", "connector"], `connector "${c.id}" has no tool, so stage "${s.id}" cannot wait for it to succeed`));
      else if (c && "toolName" in c && !s.tools.includes(c.toolName)) {
        out.push(err("S2", [...p, "exit", "connector"], `stage "${s.id}" exits when connector "${c.id}" succeeds, so it must list its tool "${c.toolName}"`));
      }
    }
    if (s.kind === "act" && !s.tools.some((t) => acts(byTool.get(t)))) {
      out.push(err("S2", [...p, "tools"], `the act stage "${s.id}" must list a payment, e-sign or side-effect HTTP connector tool`));
    }
  });
  bp.connectors.forEach((c, i) => {
    if (c.type !== "confirmation") return;
    c.requires.forEach((r, j) => {
      const t = ix.connectors.get(r);
      if (r === c.id) out.push(err("S2", ["connectors", i, "requires", j], `confirmation "${c.id}" cannot require itself`));
      else if (t?.type === "completion_webhook") out.push(err("S2", ["connectors", i, "requires", j], `"${r}" is a completion webhook: it fires after the case closes, so a confirmation cannot wait for it`));
    });
  });
  return out;
}

/** A side-effect `http_action` runs only in act or close stages. (`completion_webhook` has no tool name by schema.) */
function lintS3(bp: Blueprint): LintIssue[] {
  const out: LintIssue[] = [];
  const effects = new Map(bp.connectors.filter((c) => c.type === "http_action" && c.sideEffect).map((c) => [(c as { toolName: string }).toolName, c.id]));
  bp.playbook.stages.forEach((s, i) => {
    if (s.kind === "act" || s.kind === "close") return;
    s.tools.forEach((t, j) => {
      const id = effects.get(t);
      if (id) out.push(err("S3", ["playbook", "stages", i, "tools", j], `"${t}" has side effects (connector "${id}"), so only act or close stages may list it ("${s.id}" is ${s.kind})`));
    });
  });
  return out;
}

// ============================================================================================ F1, F2 fields

export const REQUIRED_FIELDS_MIN = 1;
export const REQUIRED_FIELDS_MAX = 12;

/**
 * 1–12 required fields; the AI never writes a rep decision: `adviceDomain` fields are never `ai_allowed`, and a
 * `rep_only` field has no confirm tool (`update_case_field`'s enum is the `ai_allowed` fields, so rep_only fields are
 * never in it by construction); `serverResolvable.value` names a money value.
 */
function lintF1(bp: Blueprint): LintIssue[] {
  const out: LintIssue[] = [];
  const required = bp.fields.filter((f) => f.required).length;
  if (required < REQUIRED_FIELDS_MIN || required > REQUIRED_FIELDS_MAX) {
    out.push(err("F1", ["fields"], `a relay needs ${REQUIRED_FIELDS_MIN}–${REQUIRED_FIELDS_MAX} required fields (this one has ${required})`));
  }
  const values = new Map(bp.values.map((v) => [v.id, v]));
  bp.fields.forEach((f, i) => {
    const p: Path = ["fields", i];
    if (f.setBy === "rep_only" && f.confirmTool) out.push(err("F1", [...p, "confirmTool"], `rep-only field "${f.id}" cannot have a confirm tool: the AI must never set it`));
    if (f.adviceDomain && f.setBy === "ai_allowed") out.push(err("F1", [...p, "setBy"], `"${f.id}" is a rep decision (adviceDomain), so it cannot be ai_allowed`));
    const v = f.serverResolvable ? values.get(f.serverResolvable.value) : undefined;
    if (v && v.type !== "money") out.push(err("F1", [...p, "serverResolvable", "value"], `value "${v.id}" is ${v.type}; serverResolvable must name a money value`));
  });
  return out;
}

/** Every required `ai_allowed` field can be asked and confirmed. */
function lintF2(bp: Blueprint): LintIssue[] {
  const out: LintIssue[] = [];
  bp.fields.forEach((f, i) => {
    if (!f.required || f.setBy !== "ai_allowed") return;
    for (const k of ["ask", "confirm"] as const) {
      if (!f.phrases[k] || f.phrases[k].trim() === "") out.push(err("F2", ["fields", i, "phrases", k], `required field "${f.id}" needs a ${k} phrase (the AI ${k}s it in the greeting)`));
    }
  });
  return out;
}

// ============================================================================================ X3 safe regex grammar

function lintX3(bp: Blueprint): LintIssue[] {
  const out: LintIssue[] = [];
  for (const r of blueprintRegexes(bp)) {
    const c = r.tool ? checkSafeToolPattern(r.src) : checkSafeRegexSource(r.src);
    if (!c.ok) out.push(err("X3", r.path, `${r.tool ? "tool pattern" : "regex"} /${r.src}/: ${c.message}`));
  }
  return out;
}

// ============================================================================================ compiled rules: G2, W3, X1, X2, W2

export const OPENING_MAX_WORDS = 14;
export const FIRST_FACT_MAX_WORD = 24;
export const PROMPT_LINT_MAX_CHARS = 6000;
export const CASE_JSON_MAX_CHARS = 2400;
export const KEYTERMS_LINT_MAX = 100;
export const KEYTERM_LINT_MAX_CHARS = 50;
export const SCENARIO_PROMPT_MAX_CHARS = 1750;
export const DISCLOSURE_WARN_WORDS = 60;
const LINT_DEPLOY_ID = "lint0000000";

const MARK = "\u0001";

/**
 * The 0-based word index of the first field value the greeting states (W3), or null when it states none. Renders
 * the opening and the summary (with its subject and kept clauses) through a scope that marks every field value.
 */
export function greetingFirstFactWord(bp: Blueprint, snapshot: Fields, account: AccountRecord, dropped: readonly string[] = []): number | null {
  const nodes = (src: string): TemplateNode[] | null => { const r = tryParseTemplate(src); return r.ok ? r.nodes : null; };
  const g = bp.playbook.greeting;
  const clauses = new Map(g.clauses.map((c) => [c.id, c.text]));
  let marked: RenderScope | null = null;
  const render = (src: string | undefined): string => { const n = src === undefined ? null : nodes(src); return n && marked ? renderTemplate(n, marked) : ""; };
  const base = makeScope({
    bp, account, snapshot,
    slots: {
      subject: () => render(bp.playbook.subject),
      clause: (id) => (dropped.includes(id) || !clauses.has(id) ? null : render(clauses.get(id))),
    },
  });
  const m: RenderScope = {
    resolve: (ref) => { const v = base.resolve(ref); return ref.kind === "field" && v !== null ? MARK + v : v; },
    test: (c) => base.test(c),
    format: (f, v, ref) => (ref.kind === "field" && v.startsWith(MARK) ? MARK + base.format(f, v.slice(1), ref) : base.format(f, v, ref)),
  };
  marked = m;
  const text = [render(g.opening), render(g.summary)].map((t) => t.trim()).filter(Boolean).join(" ");
  const idx = wordsOf(text).findIndex((w) => w.includes(MARK));
  return idx >= 0 ? idx : null;
}

interface Render { sample: number; state: CannedState; snapshot: Fields; account: AccountRecord }

function renders(bp: Blueprint, k: KernelRelay): Render[] {
  const out: Render[] = [];
  bp.context.samples.forEach((account, sample) => {
    for (const state of CANNED_STATES) out.push({ sample, state, account, snapshot: cannedSnapshot(bp, state, account, k.spec) });
  });
  return out;
}

const where = (r: Render) => `sample #${r.sample + 1}, ${r.state.replace(/_/g, " ")}`;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * G2: the greeting fits `maxWords` after drops for every sample × canned state, the opening is ≤ 14 words, and the
 * next-step sentences carry the one PENDING value (`{phrase.confirm}`) and the one ask (`{phrase.ask}`).
 * W3 (warn): the first VERIFIED value is within the first 24 words.
 */
function lintG2W3(bp: Blueprint, k: KernelRelay, parsed: Map<string, TemplateNode[]>, rs: readonly Render[]): LintIssue[] {
  const out: LintIssue[] = [];
  const g = bp.playbook.greeting;
  const opening = parsed.get(key(["playbook", "greeting", "opening"]));
  if (opening) {
    let worst: { n: number; text: string; sample: number } | null = null;
    bp.context.samples.forEach((a, sample) => {
      const text = renderTemplate(opening, sampleOpeningScope(a)).replace(/\s+/g, " ").trim();
      const n = wordsOf(text).length;
      if (n > OPENING_MAX_WORDS && (!worst || n > worst.n)) worst = { n, text, sample };
    });
    const w = worst as { n: number; text: string; sample: number } | null;
    if (w) out.push(err("G2", ["playbook", "greeting", "opening"], `the opening is ${w.n} words for sample #${w.sample + 1} ("${w.text}"); keep it ≤ ${OPENING_MAX_WORDS} words with the AI disclosure`));
  }
  for (const which of ["confirm", "ask"] as const) {
    const nodes = parsed.get(key(["playbook", "greeting", "next", which]));
    if (nodes && !templateVars(nodes).some((v) => v.ref.kind === "phrase" && v.ref.which === which)) {
      out.push(err("G2", ["playbook", "greeting", "next", which], `greeting.next.${which} must use {phrase.${which}}: the greeting ends with the single ${which === "confirm" ? "PENDING value to confirm" : "missing fact to ask for"}`));
    }
  }
  let over: { r: Render; words: number; text: string } | null = null;
  let overCount = 0;
  let late: { r: Render; word: number } | null = null;
  for (const r of rs) {
    let res: ReturnType<KernelRelay["greeting"]>;
    try { res = k.greeting(r.snapshot, r.account); } catch (e) {
      out.push(err("G2", ["playbook", "greeting"], `the greeting does not render (${where(r)}): ${message(e)}`));
      return out;
    }
    if (res.wordCount > g.maxWords) { overCount++; if (!over || res.wordCount > over.words) over = { r, words: res.wordCount, text: res.text }; }
    if (res.asserted.length > 0) {
      const w = greetingFirstFactWord(bp, r.snapshot, r.account, res.dropped);
      if (w !== null && w >= FIRST_FACT_MAX_WORD && (!late || w > late.word)) late = { r, word: w };
    }
  }
  if (over) {
    out.push(err("G2", ["playbook", "greeting"], `the greeting is ${over.words} words (${where(over.r)}; ${overCount} of ${rs.length} canned renders over) after drops; the limit is maxWords = ${g.maxWords} (≈ ${(g.maxWords * SECONDS_PER_WORD).toFixed(0)} s): "${over.text}"`));
  }
  if (late) {
    out.push(warn("W3", ["playbook", "greeting", "summary"], `the first VERIFIED fact is word ${late.word + 1} (${where(late.r)}, ≈ ${(late.word * SECONDS_PER_WORD).toFixed(1)} s); put it within the first ${FIRST_FACT_MAX_WORD} words`));
  }
  return out;
}

/** X1: extractor enum ≤ 24 and a strict schema; the compiled prompt ≤ 6000 chars at its longest stage; case JSON cap ≤ 2400. */
function lintX1(bp: Blueprint, k: KernelRelay, rs: readonly Render[]): LintIssue[] {
  const out: LintIssue[] = [];
  if (bp.fields.length > STRICT_ENUM_MAX) out.push(err("X1", ["fields"], `the extractor field enum has ${bp.fields.length} values; keep it ≤ ${STRICT_ENUM_MAX}`));
  try { assertStrictSchema(k.extractor.format); } catch (e) {
    if (e instanceof StrictSchemaError) out.push(err("X1", ["fields"], `the extractor format is not a valid strict schema: ${e.message}`));
    else throw e;
  }
  if (bp.playbook.caseJson.maxChars > CASE_JSON_MAX_CHARS) out.push(err("X1", ["playbook", "caseJson", "maxChars"], `caseJson.maxChars is ${bp.playbook.caseJson.maxChars}; keep it ≤ ${CASE_JSON_MAX_CHARS}`));
  let longest: { len: number; stage: number; r: Render } | null = null;
  for (const r of rs) {
    if (r.state !== "all_verified" && r.state !== "nothing") continue;
    bp.playbook.stages.forEach((s, i) => {
      const len = k.prompt(r.snapshot, r.account, STAGE_KIND_TO_STAGE[s.kind] as Stage, { deployId: LINT_DEPLOY_ID }).length;
      if (!longest || len > longest.len) longest = { len, stage: i, r };
    });
  }
  const l = longest as { len: number; stage: number; r: Render } | null;
  if (l && l.len > PROMPT_LINT_MAX_CHARS) {
    const s = bp.playbook.stages[l.stage]!;
    out.push(err("X1", bp.playbook.promptTemplate !== null ? ["playbook", "promptTemplate"] : ["playbook", "stages", l.stage, "goal"],
      `the compiled prompt is ${l.len} characters at stage "${s.id}" (${where(l.r)}); keep it ≤ ${PROMPT_LINT_MAX_CHARS} (the Voice Agent cap is 8000)`));
  }
  return out;
}

/** X2: ≤ 100 merged keyterms (fixed + the sample's context terms) of ≤ 50 characters; `scenarioPrompt` ≤ 1750. */
function lintX2(bp: Blueprint): LintIssue[] {
  const out: LintIssue[] = [];
  let most: { n: number; sample: number } | null = null;
  let long: { term: string; sample: number } | null = null;
  bp.context.samples.forEach((a, sample) => {
    const terms = mergedListeningKeyterms(bp, a);
    if (terms.length > KEYTERMS_LINT_MAX && (!most || terms.length > most.n)) most = { n: terms.length, sample };
    const t = terms.find((x) => x.length > KEYTERM_LINT_MAX_CHARS);
    if (t && !long) long = { term: t, sample };
  });
  const m = most as { n: number; sample: number } | null;
  const lg = long as { term: string; sample: number } | null;
  if (m) out.push(err("X2", ["listening", "keyterms"], `${m.n} keyterms after merging the context terms of sample #${m.sample + 1}; keep it ≤ ${KEYTERMS_LINT_MAX}`));
  if (lg) {
    const fixed = bp.listening.keyterms.findIndex((k) => k.trim() === lg.term);
    out.push(err("X2", fixed >= 0 ? ["listening", "keyterms", fixed] : ["listening", "contextKeyterms"],
      `keyterm "${lg.term.slice(0, 60)}" (sample #${lg.sample + 1}) is ${lg.term.length} characters; keyterms are ≤ ${KEYTERM_LINT_MAX_CHARS}`));
  }
  if (bp.listening.scenarioPrompt.length > SCENARIO_PROMPT_MAX_CHARS) {
    out.push(err("X2", ["listening", "scenarioPrompt"], `scenarioPrompt is ${bp.listening.scenarioPrompt.length} characters; keep it ≤ ${SCENARIO_PROMPT_MAX_CHARS}`));
  }
  return out;
}

/**
 * W2 (warn): a disclosure over 60 words (rendered with the first sample, all required fields VERIFIED, tax suffix
 * on), an `id_code` field with no `examples`, and a `wideband_16k` tuning when the relay's simulated calls are 8 kHz.
 */
function lintW2(bp: Blueprint, k: KernelRelay | null, opts: LintOptions): LintIssue[] {
  const out: LintIssue[] = [];
  const account = bp.context.samples[0];
  bp.playbook.disclosures.forEach((d, i) => {
    let text = d.text;
    if (k && account) {
      try { text = k.disclosure(d.id, { snapshot: cannedSnapshot(bp, "all_verified", account, k.spec), account, opts: { taxSuffix: true } }).text; } catch { /* keep the source */ }
    }
    const n = wordsOf(text).length;
    if (n > DISCLOSURE_WARN_WORDS) out.push(warn("W2", ["playbook", "disclosures", i, "text"], `disclosure "${d.id}" is ${n} words when read; over ${DISCLOSURE_WARN_WORDS} words loses the customer`));
  });
  bp.fields.forEach((f, i) => {
    if (f.type === "id_code" && f.examples.length === 0) out.push(warn("W2", ["fields", i, "examples"], `id_code field "${f.id}" has no examples; the extractor and the confirm tool read codes better with one`));
  });
  if (bp.listening.tuning === "wideband_16k" && opts.simSampleRateHz !== undefined && opts.simSampleRateHz < 16_000) {
    out.push(warn("W2", ["listening", "tuning"], `the wideband_16k preset on a relay whose simulated calls are ${opts.simSampleRateHz / 1000} kHz; use telephony_8k`));
  }
  return out;
}

// ============================================================================================ B1 brand denylist

export interface BrandTextUse { path: Path; text: string; site: BrandSite; template: boolean }

/**
 * The author-written texts B1 checks (PLATFORM §3.4): each sample's `org.name` (a business name) and, as prose,
 * `meta.title`/`tagline`, `persona.tone`/`extraRules`, the subject and greeting templates, the disclosures (title,
 * text, critical tokens), the prompt template, the handoff lines and the connectors' SMS/document templates: every
 * text the agent speaks, sends or shows as the business. Field phrases, stage goals and sample data are not checked
 * (a telecom port-in may name the carrier the customer leaves). The drafting post-fix walks the same list.
 */
export function blueprintBrandTexts(bp: Blueprint): BrandTextUse[] {
  const out: BrandTextUse[] = [];
  const plain = (path: Path, text: string, site: BrandSite = "prose") => out.push({ path, text, site, template: false });
  const tpl = (path: Path, text: string | null | undefined) => { if (typeof text === "string") out.push({ path, text, site: "prose", template: true }); };
  bp.context.samples.forEach((s, i) => plain(["context", "samples", i, "org", "name"], s.org.name, "name"));
  plain(["meta", "title"], bp.meta.title);
  plain(["meta", "tagline"], bp.meta.tagline);
  const pb = bp.playbook;
  plain(["playbook", "persona", "tone"], pb.persona.tone);
  pb.persona.extraRules.forEach((r, i) => plain(["playbook", "persona", "extraRules", i], r));
  tpl(["playbook", "subject"], pb.subject);
  const g = pb.greeting;
  tpl(["playbook", "greeting", "opening"], g.opening);
  tpl(["playbook", "greeting", "summary"], g.summary);
  g.clauses.forEach((c, i) => tpl(["playbook", "greeting", "clauses", i, "text"], c.text));
  tpl(["playbook", "greeting", "optOut"], g.optOut);
  for (const k of ["confirm", "ask", "ready"] as const) tpl(["playbook", "greeting", "next", k], g.next[k]);
  pb.disclosures.forEach((d, i) => {
    plain(["playbook", "disclosures", i, "title"], d.title);
    tpl(["playbook", "disclosures", i, "text"], d.text);
    d.criticalTokens.forEach((t, j) => tpl(["playbook", "disclosures", i, "criticalTokens", j], t));
  });
  tpl(["playbook", "promptTemplate"], pb.promptTemplate);
  plain(["handoff", "repLine"], bp.handoff.repLine);
  plain(["handoff", "repReturnLine"], bp.handoff.repReturnLine);
  bp.connectors.forEach((c, i) => {
    if (c.type === "payment_link" || c.type === "esign_mock" || c.type === "confirmation") tpl(["connectors", i, "smsTemplate"], c.smsTemplate);
    if (c.type === "esign_mock") tpl(["connectors", i, "documentTitle"], c.documentTitle);
    if (c.type === "sms_mock") tpl(["connectors", i, "template"], c.template);
  });
  return out;
}

/**
 * The literal text runs of a template: a `{var}` ends a run (its value is sample data, not author text); a section
 * boundary does not ("Wells{?x}{/?} Fargo" is still one run).
 */
export function templateTextRuns(nodes: readonly TemplateNode[]): string[] {
  const runs: string[] = [""];
  const add = (t: string) => { runs[runs.length - 1] += t; };
  const walk = (ns: readonly TemplateNode[]) => {
    for (const n of ns) {
      if (n.type === "text") add(n.text);
      else if (n.type === "var") runs.push("");
      else {
        add(" ");
        walk(n.then);
        add(" ");
        if (n.else) { walk(n.else); add(" "); }
      }
    }
  };
  walk(nodes);
  return runs.filter((r) => r.trim() !== "");
}

const TEMPLATE_TAG_RE = /\{[^{}]*\}/;

function lintB1(bp: Blueprint, parsed: Map<string, TemplateNode[]>): LintIssue[] {
  const out: LintIssue[] = [];
  for (const use of blueprintBrandTexts(bp)) {
    let runs: string[] = [use.text];
    if (use.template) {
      let nodes = parsed.get(JSON.stringify(use.path)) ?? null;
      if (!nodes) { const r = tryParseTemplate(use.text); nodes = r.ok ? r.nodes : null; }
      runs = nodes ? templateTextRuns(nodes) : use.text.split(TEMPLATE_TAG_RE);
    }
    const seen = new Set<string>();
    for (const run of runs) {
      for (const h of findDenylistedBrands(run, use.site)) {
        if (seen.has(h.brand)) continue;
        seen.add(h.brand);
        out.push(err("B1", use.path, `"${h.text}" is a real brand (${BRAND_LIST_LABEL[h.list]}: ${h.brand}); a relay must use a fictional business and never name a real company`));
      }
    }
  }
  return out;
}

// ============================================================================================ K1/K2 secrets

/** A secret-ref slot in a connector (K1, K2). `required`: a null ref fails K2 when the connector is used. */
export interface SecretSlot {
  path: Path;
  connector: string;
  kind: "header" | "hmac";
  header: string | null;
  ref: SecretRef | null;
  used: boolean;
  required: boolean;
}

/** Every secret-ref slot in a blueprint's connectors, and whether its connector is used. */
export function blueprintSecretSlots(bp: Blueprint): SecretSlot[] {
  const stageTools = new Set(bp.playbook.stages.flatMap((s) => s.tools));
  const out: SecretSlot[] = [];
  bp.connectors.forEach((c, i) => {
    if (c.type === "http_action") {
      const used = stageTools.has(c.toolName);
      c.headers.forEach((h, j) => {
        if (typeof h.value === "string") return;
        out.push({ path: ["connectors", i, "headers", j, "value"], connector: c.id, kind: "header", header: h.name, ref: h.value, used, required: true });
      });
      // An http_action's HMAC signing is optional: null means unsigned.
      out.push({ path: ["connectors", i, "hmacSecret"], connector: c.id, kind: "hmac", header: null, ref: c.hmacSecret, used, required: false });
    }
    // A completion webhook fires at the end of every case (it has no tool name), so it is always used and always signed.
    if (c.type === "completion_webhook") {
      out.push({ path: ["connectors", i, "hmacSecret"], connector: c.id, kind: "hmac", header: null, ref: c.hmacSecret, used: true, required: true });
    }
  });
  return out;
}

/** Context that lives outside the blueprint: the relay row, its publications, its workspace's secrets. */
export interface LintOptions {
  /** The relay's visibility. K1: a `gallery` relay carries no secret refs. */
  visibility?: "private" | "unlisted" | "gallery";
  /** True when a pinned publication uses this version. K1: no secret refs either. */
  pinnedPublication?: boolean;
  /**
   * The ids of the secrets that exist and have not expired in the relay's workspace (or org). K2 then also fails a
   * ref to a missing or expired secret. Omitted (the Studio's client-side lint): only null refs fail.
   */
  secretIds?: ReadonlySet<string> | readonly string[];
  /** The relay row's flagship flag (Baton): its prompt is exempt from the kernel safety block, which X1 measures. */
  flagship?: boolean;
  /** The sample rate of the relay's simulated calls, when known. W2 warns on `wideband_16k` over 8 kHz sims. */
  simSampleRateHz?: number;
}

function lintK1(bp: Blueprint, opts: LintOptions): LintIssue[] {
  const gallery = opts.visibility === "gallery";
  if (!gallery && !opts.pinnedPublication) return [];
  const where = gallery ? "a gallery relay" : "a version a pinned publication uses";
  const who = gallery ? "gallery relays" : "pinned publications";
  return blueprintSecretSlots(bp).filter((s) => s.ref !== null).map((s) =>
    err("K1", s.path, `secret refs are not allowed in ${where} (connector "${s.connector}"): secrets expire after 7 days and ${who} must keep working until Oct 21; use plain headers or the unsigned demo echo`));
}

function lintK2(bp: Blueprint, opts: LintOptions): LintIssue[] {
  const known = opts.secretIds === undefined ? null : new Set(opts.secretIds);
  const out: LintIssue[] = [];
  for (const s of blueprintSecretSlots(bp)) {
    if (!s.used) continue;
    const what = s.kind === "header" ? `header "${s.header}" of connector "${s.connector}"` : `connector "${s.connector}"`;
    if (s.ref === null) {
      if (!s.required) continue;
      out.push(err("K2", s.path, s.kind === "hmac"
        ? `Set a signing secret for ${what}: a completion webhook is always signed (cloning a relay drops its secrets)`
        : `Set the secret for ${what} (cloning a relay drops its secrets)`));
    } else if (known && !known.has(s.ref.$secret)) {
      out.push(err("K2", s.path, `the secret for ${what} is missing or expired (secrets expire after 7 days); set it again`));
    }
  }
  return out;
}

// ============================================================================================ entry points

/** Rules whose errors mean the relay cannot be compiled meaningfully; the compiled rules wait for them. */
const STRUCTURAL: ReadonlySet<string> = new Set(["L1", "L2", "L3", "S1", "X3"]);

/**
 * The compiled rules (G2, W3, X1, X2, and W2's rendered disclosure length) compile the relay and render it for every
 * sample × canned state. They run only when the structural rules pass.
 */
function lintCompiled(bp: Blueprint, parsed: Map<string, TemplateNode[]>, opts: LintOptions): { k: KernelRelay | null; issues: LintIssue[] } {
  let k: KernelRelay;
  try { k = compileRelay(bp, { flagship: opts.flagship ?? false }); } catch (e) {
    return { k: null, issues: [err("X1", ["playbook"], `the relay does not compile: ${message(e)}`)] };
  }
  let rs: Render[];
  try { rs = renders(bp, k); } catch (e) {
    return { k, issues: [err("G2", ["context", "samples"], `the canned snapshots cannot be built: ${message(e)}`)] };
  }
  const issues: LintIssue[] = [];
  const guard = (code: string, path: Path, f: () => LintIssue[]) => {
    try { issues.push(...f()); } catch (e) { issues.push(err(code, path, `this check could not run: ${message(e)}`)); }
  };
  guard("G2", ["playbook", "greeting"], () => lintG2W3(bp, k, parsed, rs));
  guard("X1", ["playbook"], () => lintX1(bp, k, rs));
  guard("X2", ["listening"], () => lintX2(bp));
  return { k, issues };
}

/**
 * Lint a parsed blueprint (PLATFORM §3.4). Never throws. Issue order follows the rule table: L1, L2, L3, G1, C1, C2,
 * S1, S2, S3, F1, F2, X1, X2, X3, G2, W3, B1, K1, K2, W2. `opts` carries the context that is not in the blueprint
 * (K1, K2, W2's sim rate, the flagship exemption X1 measures); the client-side Studio lint may omit it.
 */
export function lintBlueprint(bp: Blueprint, opts: LintOptions = {}): LintIssue[] {
  const ix = indexOf(bp);
  const parsed = new Map<string, TemplateNode[]>();
  const head = [
    ...lintL1(bp),
    ...lintL2(bp, ix),
    ...lintL3(bp, ix, parsed),
    ...lintG1(bp, parsed),
    ...lintC1(bp, parsed),
    ...lintC2(bp),
    ...lintS1(bp, ix),
    ...lintS2(bp, ix),
    ...lintS3(bp),
    ...lintF1(bp),
    ...lintF2(bp),
  ];
  const x3 = lintX3(bp);
  const blocked = [...head, ...x3].some((i) => i.severity === "error" && STRUCTURAL.has(i.code));
  const compiled = blocked ? { k: null, issues: [] } : lintCompiled(bp, parsed, opts);
  const pick = (...codes: string[]) => compiled.issues.filter((i) => codes.includes(i.code));
  return [
    ...head,
    ...pick("X1", "X2"),
    ...x3,
    ...pick("G2", "W3"),
    ...lintB1(bp, parsed),
    ...lintK1(bp, opts),
    ...lintK2(bp, opts),
    ...lintW2(bp, compiled.k, opts),
  ];
}

const getAt = (json: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<PropertyKey, unknown>)[k] : undefined), json);

/** Maps `BlueprintSchema` issues to lint issues; a failed regex refinement becomes X3 naming the offending group. */
export function schemaIssuesToLint(json: unknown, issues: ZodError["issues"]): LintIssue[] {
  return issues.map((iss) => {
    const path = iss.path.filter((k): k is string | number => typeof k !== "symbol");
    const value = getAt(json, iss.path);
    if (iss.code === "custom" && typeof value === "string" && /unsafe or invalid (regex|pattern)/.test(iss.message)) {
      const c = iss.message.includes("pattern") ? checkSafeToolPattern(value) : checkSafeRegexSource(value);
      return err("X3", path, `${iss.message.includes("pattern") ? "tool pattern" : "regex"} /${value}/: ${c.ok ? iss.message : c.message}`);
    }
    return err("SCHEMA", path, iss.message);
  });
}

/** Parse + lint any JSON (the Studio's Advanced tab, saveDraft, imports). */
export function lintBlueprintJson(json: unknown, opts: LintOptions = {}): { blueprint: Blueprint | null; issues: LintIssue[] } {
  const r = BlueprintSchema.safeParse(json);
  if (!r.success) return { blueprint: null, issues: schemaIssuesToLint(json, r.error.issues) };
  return { blueprint: r.data, issues: lintBlueprint(r.data, opts) };
}

