/**
 * relay/template.ts - the blueprint template grammar (PLATFORM §3.3): parser, printer, renderer and reference
 * extraction. WP14a. Pure and isomorphic. Templates are parsed and linted, never evaluated as code.
 *
 *   template := (TEXT | var | section)*
 *   var      := "{" path ("|" FORMATTER)? "}"
 *   section  := "{?" cond "}" template ("{:}" template)? "{/?}"            nesting depth ≤ 3
 *   cond     := "!"? ( "f." ID "." ("verified"|"pending"|"missing"|"known"|"rep")
 *                    | "f." ID "=" VALUE | "v." ID | "opt." ID )
 *   path     := customer.firstName | customer.lastName | customer.fullName | customer.phoneLast4
 *             | org.name | rep.firstName | call.date | fact.ID | v.ID
 *             | f.ID | f.ID.display | f.ID.raw
 *             | subject | clause.ID | phrase.confirm | phrase.ask | stage | stage.goal | case.json | intent.summary
 *             | roles.rep | roles.customer | roles.org | persona.tone      (kernel prompts only, PLATFORM §4.4 and §5)
 *   "{{" and "}}" are literal braces; a lone "}" is a syntax error.
 *
 * The parser checks SHAPE (a path must fit the grammar; a formatter must look like a formatter name). Whether a
 * fact, field, value, clause, option or formatter EXISTS, and whether a path is allowed where the template is
 * used, is lint L3 (relay/lint.ts). `printTemplate(parseTemplate(s)) === s` for every valid `s`.
 */

export const TEMPLATE_MAX_DEPTH = 3;
/** Runtime options usable as `{?opt.<id>}` (Baton: `tax_suffix` = DISCLOSURE_TAX_SUFFIX). */
export const TEMPLATE_OPTIONS = ["tax_suffix"] as const;
export const FIELD_CONDITIONS = ["verified", "pending", "missing", "known", "rep"] as const;
export type FieldCondition = (typeof FIELD_CONDITIONS)[number];

export type PathRef =
  | { kind: "customer"; key: "firstName" | "lastName" | "fullName" | "phoneLast4" }
  | { kind: "org"; key: "name" }
  | { kind: "rep"; key: "firstName" }
  | { kind: "call"; key: "date" }
  | { kind: "fact"; key: string }
  | { kind: "value"; id: string }
  | { kind: "field"; id: string; part: "value" | "display" | "raw" }
  | { kind: "subject" }
  | { kind: "clause"; id: string }
  | { kind: "phrase"; which: "confirm" | "ask" }
  | { kind: "stage"; part: "name" | "goal" }
  | { kind: "case_json" }
  | { kind: "intent"; key: "summary" }
  | { kind: "roles"; key: "rep" | "customer" | "org" }
  | { kind: "persona"; key: "tone" };
export type PathKind = PathRef["kind"];

export type TemplateCond =
  | { kind: "field_status"; negate: boolean; field: string; status: FieldCondition }
  | { kind: "field_eq"; negate: boolean; field: string; value: string }
  | { kind: "value"; negate: boolean; id: string }
  | { kind: "opt"; negate: boolean; id: string };

export type TemplateNode =
  | { type: "text"; text: string }
  | { type: "var"; path: string; ref: PathRef; formatter: string | null }
  | { type: "section"; cond: TemplateCond; then: TemplateNode[]; else: TemplateNode[] | null };

export class TemplateSyntaxError extends Error {
  constructor(message: string, readonly index: number) {
    super(`${message} (at ${index})`);
    this.name = "TemplateSyntaxError";
  }
}

// Regex literals (not `new RegExp`): src/core/relay/** never constructs a RegExp (boundaries-regex test). ID = IdSchema.
const FIELD_PATH_RE = /^f\.([a-z][a-z0-9_]{1,39})(?:\.(display|raw))?$/;
const FACT_PATH_RE = /^fact\.([a-z][a-z0-9_]{1,39})$/;
const VALUE_PATH_RE = /^v\.([a-z][a-z0-9_]{1,39})$/;
const CLAUSE_PATH_RE = /^clause\.([a-z][a-z0-9_]{1,39})$/;
const COND_STATUS_RE = /^f\.([a-z][a-z0-9_]{1,39})\.(verified|pending|missing|known|rep)$/;
const COND_EQ_RE = /^f\.([a-z][a-z0-9_]{1,39})=([A-Za-z0-9_.-]{1,60})$/;
const COND_VALUE_RE = /^v\.([a-z][a-z0-9_]{1,39})$/;
const COND_OPT_RE = /^opt\.([a-z][a-z0-9_]{1,39})$/;
const FORMATTER_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/;

const FIXED_PATHS: Readonly<Record<string, PathRef>> = {
  "customer.firstName": { kind: "customer", key: "firstName" },
  "customer.lastName": { kind: "customer", key: "lastName" },
  "customer.fullName": { kind: "customer", key: "fullName" },
  "customer.phoneLast4": { kind: "customer", key: "phoneLast4" },
  "org.name": { kind: "org", key: "name" },
  "rep.firstName": { kind: "rep", key: "firstName" },
  "call.date": { kind: "call", key: "date" },
  subject: { kind: "subject" },
  "phrase.confirm": { kind: "phrase", which: "confirm" },
  "phrase.ask": { kind: "phrase", which: "ask" },
  stage: { kind: "stage", part: "name" },
  "stage.goal": { kind: "stage", part: "goal" },
  "case.json": { kind: "case_json" },
  "intent.summary": { kind: "intent", key: "summary" },
  "roles.rep": { kind: "roles", key: "rep" },
  "roles.customer": { kind: "roles", key: "customer" },
  "roles.org": { kind: "roles", key: "org" },
  "persona.tone": { kind: "persona", key: "tone" },
};

/** A path of the grammar (also used for `caseJson.header[].from` and `extraction.context[].from`), or null. */
export function parseTemplatePath(path: string): PathRef | null {
  const fixed = FIXED_PATHS[path];
  if (fixed) return fixed;
  let m = FIELD_PATH_RE.exec(path);
  if (m) return { kind: "field", id: m[1]!, part: (m[2] as "display" | "raw" | undefined) ?? "value" };
  if ((m = FACT_PATH_RE.exec(path))) return { kind: "fact", key: m[1]! };
  if ((m = VALUE_PATH_RE.exec(path))) return { kind: "value", id: m[1]! };
  if ((m = CLAUSE_PATH_RE.exec(path))) return { kind: "clause", id: m[1]! };
  return null;
}

/** A section condition of the grammar, or null. */
export function parseTemplateCond(src: string): TemplateCond | null {
  const negate = src.startsWith("!");
  const s = negate ? src.slice(1) : src;
  let m = COND_STATUS_RE.exec(s);
  if (m) return { kind: "field_status", negate, field: m[1]!, status: m[2] as FieldCondition };
  if ((m = COND_EQ_RE.exec(s))) return { kind: "field_eq", negate, field: m[1]!, value: m[2]! };
  if ((m = COND_VALUE_RE.exec(s))) return { kind: "value", negate, id: m[1]! };
  if ((m = COND_OPT_RE.exec(s))) return { kind: "opt", negate, id: m[1]! };
  return null;
}

export function printCond(c: TemplateCond): string {
  const body = c.kind === "field_status" ? `f.${c.field}.${c.status}`
    : c.kind === "field_eq" ? `f.${c.field}=${c.value}`
    : c.kind === "value" ? `v.${c.id}` : `opt.${c.id}`;
  return `${c.negate ? "!" : ""}${body}`;
}

type Term = "eof" | "else" | "close";

/** Parses a template; throws `TemplateSyntaxError` with the offset of the problem. */
export function parseTemplate(src: string): TemplateNode[] {
  let i = 0;
  const parseSeq = (depth: number): { nodes: TemplateNode[]; term: Term } => {
    const nodes: TemplateNode[] = [];
    let buf = "";
    const flush = () => { if (buf) { nodes.push({ type: "text", text: buf }); buf = ""; } };
    while (i < src.length) {
      const c = src[i]!;
      if (c === "}") {
        if (src[i + 1] === "}") { buf += "}"; i += 2; continue; }
        throw new TemplateSyntaxError("a lone \"}\" (write \"}}\" for a literal brace)", i);
      }
      if (c !== "{") { buf += c; i++; continue; }
      if (src[i + 1] === "{") { buf += "{"; i += 2; continue; }
      if (src.startsWith("{:}", i)) { flush(); return { nodes, term: "else" }; }
      if (src.startsWith("{/?}", i)) { flush(); return { nodes, term: "close" }; }
      if (src[i + 1] === "?") {
        const start = i;
        const close = src.indexOf("}", i + 2);
        if (close < 0) throw new TemplateSyntaxError("unterminated section condition", start);
        const condSrc = src.slice(i + 2, close);
        const cond = parseTemplateCond(condSrc);
        if (!cond) throw new TemplateSyntaxError(`unknown section condition "${condSrc}"`, start);
        if (depth + 1 > TEMPLATE_MAX_DEPTH) throw new TemplateSyntaxError(`sections nest deeper than ${TEMPLATE_MAX_DEPTH}`, start);
        flush();
        i = close + 1;
        const thenPart = parseSeq(depth + 1);
        if (thenPart.term === "eof") throw new TemplateSyntaxError("a section is never closed with \"{/?}\"", start);
        let elsePart: TemplateNode[] | null = null;
        if (thenPart.term === "else") {
          i += 3;
          const e = parseSeq(depth + 1);
          if (e.term === "else") throw new TemplateSyntaxError("a section has two \"{:}\"", i);
          if (e.term === "eof") throw new TemplateSyntaxError("a section is never closed with \"{/?}\"", start);
          elsePart = e.nodes;
        }
        i += 4; // "{/?}"
        nodes.push({ type: "section", cond, then: thenPart.nodes, else: elsePart });
        continue;
      }
      const start = i;
      const close = src.indexOf("}", i + 1);
      if (close < 0) throw new TemplateSyntaxError("unterminated \"{\"", start);
      const inner = src.slice(i + 1, close);
      if (inner.includes("{")) throw new TemplateSyntaxError("\"{\" inside a variable", start);
      const parts = inner.split("|");
      if (parts.length > 2) throw new TemplateSyntaxError(`a variable takes at most one formatter: "{${inner}}"`, start);
      const path = parts[0]!;
      const ref = parseTemplatePath(path);
      if (!ref) throw new TemplateSyntaxError(`unknown path "${path}"`, start);
      const formatter = parts.length === 2 ? parts[1]! : null;
      if (formatter !== null && !FORMATTER_RE.test(formatter)) throw new TemplateSyntaxError(`bad formatter name "${formatter}"`, start);
      flush();
      nodes.push({ type: "var", path, ref, formatter });
      i = close + 1;
    }
    flush();
    return { nodes, term: "eof" };
  };
  const res = parseSeq(0);
  if (res.term === "else") throw new TemplateSyntaxError("\"{:}\" outside a section", i);
  if (res.term === "close") throw new TemplateSyntaxError("\"{/?}\" without an open section", i);
  return res.nodes;
}

export type TemplateParse = { ok: true; nodes: TemplateNode[] } | { ok: false; message: string; index: number };

/** Non-throwing `parseTemplate`. */
export function tryParseTemplate(src: string): TemplateParse {
  try {
    return { ok: true, nodes: parseTemplate(src) };
  } catch (e) {
    if (e instanceof TemplateSyntaxError) return { ok: false, message: e.message, index: e.index };
    throw e;
  }
}

const escapeText = (t: string): string => t.replace(/[{}]/g, (b) => b + b);

/** The canonical source of an AST (the inverse of `parseTemplate`). */
export function printTemplate(nodes: readonly TemplateNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += escapeText(n.text);
    else if (n.type === "var") out += `{${n.path}${n.formatter ? `|${n.formatter}` : ""}}`;
    else out += `{?${printCond(n.cond)}}${printTemplate(n.then)}${n.else ? `{:}${printTemplate(n.else)}` : ""}{/?}`;
  }
  return out;
}

// ============================================================================================ rendering

/** What a render needs. The kernel builds one per render; lint builds a sample-account one. */
export interface RenderScope {
  /** A var's value, or null (renders as ""). */
  resolve(ref: PathRef): string | null;
  /** A condition's truth, WITHOUT its `negate` (the renderer applies it). */
  test(cond: TemplateCond): boolean;
  /** Applies a formatter (FORMATTERS, relay/formatters.ts) to a resolved value. */
  format(formatter: string, value: string, ref: PathRef): string;
}

/** Pure render. Whitespace is left exactly as written; callers normalize if they need to. */
export function renderTemplate(nodes: readonly TemplateNode[], scope: RenderScope): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += n.text;
    else if (n.type === "var") {
      const v = scope.resolve(n.ref);
      if (v !== null) out += n.formatter ? scope.format(n.formatter, v, n.ref) : v;
    } else {
      const truth = scope.test(n.cond) !== n.cond.negate;
      const branch = truth ? n.then : n.else;
      if (branch) out += renderTemplate(branch, scope);
    }
  }
  return out;
}

// ============================================================================================ reference extraction

/** A section that encloses a var, and which branch the var is in. */
export interface Guard { cond: TemplateCond; branch: "then" | "else" }
export interface VarUse { path: string; ref: PathRef; formatter: string | null; guards: Guard[] }

/** Every var with the sections enclosing it (outermost first), in source order. */
export function templateVars(nodes: readonly TemplateNode[]): VarUse[] {
  const out: VarUse[] = [];
  const walk = (ns: readonly TemplateNode[], guards: Guard[]) => {
    for (const n of ns) {
      if (n.type === "var") out.push({ path: n.path, ref: n.ref, formatter: n.formatter, guards });
      else if (n.type === "section") {
        walk(n.then, [...guards, { cond: n.cond, branch: "then" }]);
        if (n.else) walk(n.else, [...guards, { cond: n.cond, branch: "else" }]);
      }
    }
  };
  walk(nodes, []);
  return out;
}

/** Every section condition, in source order. */
export function templateConds(nodes: readonly TemplateNode[]): TemplateCond[] {
  const out: TemplateCond[] = [];
  const walk = (ns: readonly TemplateNode[]) => {
    for (const n of ns) {
      if (n.type !== "section") continue;
      out.push(n.cond);
      walk(n.then);
      if (n.else) walk(n.else);
    }
  };
  walk(nodes);
  return out;
}

export interface TemplateRefs {
  fields: string[]; facts: string[]; values: string[]; clauses: string[]; opts: string[]; formatters: string[];
  kinds: PathKind[];
}

/** Distinct references of a template (vars and conditions), for lint and dependency tracking. */
export function templateRefs(nodes: readonly TemplateNode[]): TemplateRefs {
  const sets = { fields: new Set<string>(), facts: new Set<string>(), values: new Set<string>(), clauses: new Set<string>(),
    opts: new Set<string>(), formatters: new Set<string>(), kinds: new Set<PathKind>() };
  for (const v of templateVars(nodes)) {
    sets.kinds.add(v.ref.kind);
    if (v.formatter) sets.formatters.add(v.formatter);
    if (v.ref.kind === "field") sets.fields.add(v.ref.id);
    else if (v.ref.kind === "fact") sets.facts.add(v.ref.key);
    else if (v.ref.kind === "value") sets.values.add(v.ref.id);
    else if (v.ref.kind === "clause") sets.clauses.add(v.ref.id);
  }
  for (const c of templateConds(nodes)) {
    if (c.kind === "field_status" || c.kind === "field_eq") sets.fields.add(c.field);
    else if (c.kind === "value") sets.values.add(c.id);
    else sets.opts.add(c.id);
  }
  return {
    fields: [...sets.fields], facts: [...sets.facts], values: [...sets.values], clauses: [...sets.clauses],
    opts: [...sets.opts], formatters: [...sets.formatters], kinds: [...sets.kinds],
  };
}

/** Max section nesting depth of a parsed template (≤ 3 by construction). */
export function templateDepth(nodes: readonly TemplateNode[]): number {
  let max = 0;
  for (const n of nodes) {
    if (n.type !== "section") continue;
    max = Math.max(max, 1 + templateDepth(n.then), 1 + (n.else ? templateDepth(n.else) : 0));
  }
  return max;
}
