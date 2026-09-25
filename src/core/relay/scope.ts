/**
 * relay/scope.ts - the kernel's template render scope (PLATFORM §3.3) and small case-state readers. WP14a.
 * Pure and isomorphic.
 *
 * A scope binds a parsed template to one render: the blueprint, the account, the (frozen) case fields, the named
 * values, runtime options, and the slots only some sites fill (`{subject}`, `{clause.*}`, `{phrase.*}`, `{stage}`,
 * `{case.json}`). Conditions (PLATFORM §3.3):
 *   f.X.verified = VERIFIED with a value; f.X.pending = PENDING; f.X.missing = MISSING (or absent);
 *   f.X.known = not MISSING, with a value; f.X.rep = VERIFIED from the REP; f.X=v = the current value is v;
 *   v.X = the named value resolved non-empty; opt.X = the runtime option is on.
 * `{f.X.raw}` and a field formatter's "raw" words are the case's display (the words behind the value), as in the
 * legacy phrase context. A phrase render can override ONE field's value (the value being confirmed).
 */
import type { CaseState, FieldState } from "../contracts/case";
import type { AccountRecord, Blueprint, BlueprintField } from "../contracts/v2/blueprint";
import { formatValue, type LookupTable } from "./formatters";
import { parseTemplate, renderTemplate, type PathRef, type RenderScope, type TemplateCond, type TemplateNode } from "./template";

export type Fields = Pick<CaseState, "fields">;

/** The state of a field by string id (absent → undefined). */
export const fieldState = (s: Fields, id: string): FieldState | undefined =>
  (s.fields as unknown as Record<string, FieldState | undefined>)[id];

export const verifiedValue = (s: Fields, id: string): string | null => {
  const st = fieldState(s, id);
  return st && st.status === "VERIFIED" && st.value !== null ? st.value : null;
};
export const knownValue = (s: Fields, id: string): string | null => {
  const st = fieldState(s, id);
  return st && st.status !== "MISSING" && st.value !== null ? st.value : null;
};

/** Parses templates once per compiled relay (templates are immutable blueprint strings). */
export class TemplateCache {
  private readonly cache = new Map<string, TemplateNode[]>();
  get(src: string): TemplateNode[] {
    let nodes = this.cache.get(src);
    if (!nodes) { nodes = parseTemplate(src); this.cache.set(src, nodes); }
    return nodes;
  }
}

export interface ScopeSlots {
  subject?: () => string;
  /** `{clause.<id>}`: renders a (kept) greeting clause, or null. */
  clause?: (id: string) => string | null;
  phrase?: { confirm?: string; ask?: string };
  stage?: { name: string; goal: string };
  caseJson?: string;
}

export interface ScopeInput {
  bp: Blueprint;
  account: AccountRecord;
  snapshot: Fields;
  values?: Readonly<Record<string, string | null>>;
  opts?: Readonly<Record<string, boolean>>;
  /** A phrase render: this field's value (and raw words) replace the snapshot's for vars and `f.X=v`. */
  override?: { field: string; value: string; raw: string | null } | null;
  slots?: ScopeSlots;
}

/** The lookup table of a field (blueprint table def + the account's rows), or null. */
export function lookupTableOf(bp: Blueprint, account: AccountRecord, field: BlueprintField | undefined | null): LookupTable | null {
  const id = field?.lookup?.table;
  if (!id) return null;
  const def = bp.context.tables.find((t) => t.id === id);
  if (!def) return null;
  return { label: def.label, idColumn: def.idColumn, labelColumn: def.labelColumn, rows: account.tables[id] ?? [] };
}

export function makeScope(i: ScopeInput): RenderScope & { fieldDef(id: string): BlueprintField | undefined } {
  const fieldsById = new Map(i.bp.fields.map((f) => [f.id, f]));
  const cur = (id: string): { value: string | null; raw: string | null; display: string | null } => {
    if (i.override && i.override.field === id) {
      return { value: i.override.value, raw: i.override.raw, display: null };
    }
    const st = fieldState(i.snapshot, id);
    const value = st && st.status !== "MISSING" ? st.value : null;
    const display = st && st.status !== "MISSING" ? (st.display ?? st.value) : null;
    return { value, raw: display, display };
  };
  const scope = {
    fieldDef: (id: string) => fieldsById.get(id),
    resolve(ref: PathRef): string | null {
      switch (ref.kind) {
        case "customer": {
          const c = i.account.customer;
          return ref.key === "fullName" ? `${c.firstName} ${c.lastName}` : c[ref.key];
        }
        case "org": return i.account.org.name;
        case "rep": return i.account.org.repFirstName;
        case "call": return i.account.callDate;
        case "fact": return i.account.facts[ref.key] ?? null;
        case "value": return i.values?.[ref.id] ?? null;
        case "field": {
          const c = cur(ref.id);
          if (c.value === null) return null;
          if (ref.part === "raw") return c.raw ?? c.value;
          if (ref.part === "display") {
            if (c.display !== null) return c.display;
            const def = fieldsById.get(ref.id);
            return def ? formatValue(def.display, c.value, { account: i.account, field: def, raw: c.raw, table: lookupTableOf(i.bp, i.account, def) }) : c.value;
          }
          return c.value;
        }
        case "subject": return i.slots?.subject ? i.slots.subject() : null;
        case "clause": return i.slots?.clause ? i.slots.clause(ref.id) : null;
        case "phrase": return i.slots?.phrase?.[ref.which] ?? null;
        case "stage": return i.slots?.stage ? (ref.part === "name" ? i.slots.stage.name : i.slots.stage.goal) : null;
        case "case_json": return i.slots?.caseJson ?? null;
        case "intent": return i.bp.meta.intent.summary;
        case "roles": return i.bp.meta.roles[ref.key];
        case "persona": return i.bp.playbook.persona.tone;
      }
    },
    test(cond: TemplateCond): boolean {
      switch (cond.kind) {
        case "field_status": {
          const st = fieldState(i.snapshot, cond.field);
          const hasValue = !!st && st.value !== null;
          switch (cond.status) {
            case "verified": return !!st && st.status === "VERIFIED" && hasValue;
            case "pending": return !!st && st.status === "PENDING";
            case "missing": return !st || st.status === "MISSING";
            case "known": return !!st && st.status !== "MISSING" && hasValue;
            case "rep": return !!st && st.status === "VERIFIED" && st.source === "rep" && hasValue;
          }
          return false;
        }
        case "field_eq": return cur(cond.field).value === cond.value;
        case "value": { const v = i.values?.[cond.id]; return v !== null && v !== undefined && v !== ""; }
        case "opt": return i.opts?.[cond.id] === true;
      }
    },
    format(formatter: string, value: string, ref: PathRef): string {
      if (ref.kind === "field") {
        const def = fieldsById.get(ref.id);
        return formatValue(formatter, value, { account: i.account, field: def ?? null, raw: cur(ref.id).raw, table: lookupTableOf(i.bp, i.account, def) });
      }
      return formatValue(formatter, value, { account: i.account });
    },
  };
  return scope;
}

/** Renders a template source in a scope. */
export const renderIn = (cache: TemplateCache, src: string, scope: RenderScope): string => renderTemplate(cache.get(src), scope);

/**
 * Renders and records the fields whose VERIFIED (or REP) guard section was taken: `{?f.X.verified}…{/?}` /
 * `{?f.X.rep}…{/?}` in its then-branch, or the `{:}` branch of the negated form. `GreetingResult.asserted`.
 */
export function renderTracked(nodes: readonly TemplateNode[], scope: RenderScope, asserted: string[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += n.text;
    else if (n.type === "var") {
      const v = scope.resolve(n.ref);
      if (v !== null) out += n.formatter ? scope.format(n.formatter, v, n.ref) : v;
    } else {
      const raw = scope.test(n.cond);
      const truth = raw !== n.cond.negate;
      const branch = truth ? n.then : n.else;
      // A true verified/rep test selects the guarded branch (then; or {:} of the negated form).
      if (n.cond.kind === "field_status" && (n.cond.status === "verified" || n.cond.status === "rep") && raw && !asserted.includes(n.cond.field)) {
        asserted.push(n.cond.field);
      }
      if (branch) out += renderTracked(branch, scope, asserted);
    }
  }
  return out;
}
