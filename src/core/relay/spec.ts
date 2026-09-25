/**
 * relay/spec.ts - `buildIntentSpec(bp)` → `IntentSpec` (PLATFORM §4.1, §4.3): the field semantics every engine
 * function reads (ids, required/rep-only/AI-settable/advice sets, next-step priority, normalize/display/compare,
 * date ranges, phrases, spoken forms, QA targeting, input modes). WP14a. Pure and isomorphic.
 *
 * For the Baton blueprint every function equals today's hand-written add-driver code (the parity suite proves it).
 * Blueprint regexes (QA lexicon, `confirmIfRaw`) are matched only through `safeTest()`.
 *
 * `capture.priority`: 1..99 orders the next steps (ascending; ties keep field order); 0 = never a next step (the AI
 * does not raise the field on its own, e.g. Baton's premium, discounts and license number).
 */
import type { InputModePlan } from "../contracts/takeover";
import type { AccountRecord, Blueprint, BlueprintField } from "../contracts/v2/blueprint";
import { compileSafeUnion, safeTest } from "../contracts/v2/regex";
import type { IntentSpec, PhraseScope } from "../contracts/v2/relay";
import { dayNumber, diffDays, ymd } from "../case/dates";
import { speechLower } from "../intents/add-driver";
import { ALL_VALUE, formatValue } from "./formatters";
import { blueprintHash } from "./migrate";
import { normalizeRaw } from "./normalizers";
import { lookupTableOf, makeScope, renderIn, TemplateCache, type Fields } from "./scope";
import { openRequiredFor } from "./spec-link";

/** An `IntentSpec` plus the blueprint it came from (kernel-internal; `CompiledRelay.spec` exposes the spec). */
export interface BlueprintSpec extends IntentSpec {
  readonly blueprint: Blueprint;
  readonly templates: TemplateCache;
  field(id: string): BlueprintField | undefined;
  /** `{subject}` for a snapshot (Baton: the VERIFIED driver's first name, else "the new driver"). */
  subject(snapshot: Fields, account: AccountRecord): string;
}

const setOf = (xs: Iterable<string>): ReadonlySet<string> => new Set(xs);

export function buildIntentSpec(bp: Blueprint, opts: { hash?: string } = {}): BlueprintSpec {
  const fields = new Map(bp.fields.map((f) => [f.id, f]));
  const templates = new TemplateCache();
  const def = (id: string): BlueprintField => {
    const f = fields.get(id);
    if (!f) throw new Error(`unknown field "${id}"`);
    return f;
  };
  const priority = bp.fields
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.capture.priority > 0)
    .sort((a, b) => a.f.capture.priority - b.f.capture.priority || a.i - b.i)
    .map(({ f }) => f.id);
  const qaFields = bp.fields.filter((f) => f.qa.ask.length > 0 || f.qa.weak.length > 0);

  const subject = (snapshot: Fields, account: AccountRecord): string =>
    renderIn(templates, bp.playbook.subject, makeScope({ bp, account, snapshot }));

  const renderPhrase = (src: string, f: string, value: string | null, pc: PhraseScope): string => {
    const scope = makeScope({
      bp, account: pc.account, snapshot: pc.snapshot,
      override: value === null ? null : { field: f, value, raw: pc.raw ?? null },
      slots: { subject: () => subject(pc.snapshot, pc.account) },
    });
    return renderIn(templates, src, scope);
  };

  const display = (f: string, norm: string, account: AccountRecord, raw?: string | null): string => {
    const fd = def(f);
    return formatValue(fd.display, norm, { account, field: fd, raw: raw ?? null, table: lookupTableOf(bp, account, fd) });
  };

  const spec: BlueprintSpec = {
    id: bp.meta.intent.id,
    hash: opts.hash ?? blueprintHash(bp),
    blueprint: bp,
    templates,
    field: (id) => fields.get(id),
    subject,
    fieldIds: bp.fields.map((f) => f.id),
    required: setOf(bp.fields.filter((f) => f.required).map((f) => f.id)),
    repOnly: setOf(bp.fields.filter((f) => f.setBy === "rep_only").map((f) => f.id)),
    aiSettable: bp.fields.filter((f) => f.setBy === "ai_allowed").map((f) => f.id),
    adviceDomain: setOf(bp.fields.filter((f) => f.adviceDomain).map((f) => f.id)),
    serverResolvable: setOf(bp.fields.filter((f) => f.serverResolvable).map((f) => f.id)),
    priority,
    entityFields: setOf(bp.fields.filter((f) => f.capture.entity).map((f) => f.id)),
    label: (f) => def(f).label,

    normalize(f, raw, ctx) {
      if (raw === null || raw === undefined) return null;
      const r = String(raw).trim();
      if (!r) return null;
      const fd = def(f);
      const norm = normalizeRaw(r, { callDate: ctx.callDate, account: ctx.account, field: fd, table: lookupTableOf(bp, ctx.account, fd) });
      if (norm === null) return null;
      return { norm, display: display(f, norm, ctx.account, r) };
    },
    display,

    compatible(f, a, b) {
      if (a === null || b === null) return false;
      if (a === b) return true;
      if (def(f).compare !== "token_subset") return false;
      const ta = new Set(a.split(" ")), tb = new Set(b.split(" "));
      const sub = (x: Set<string>, y: Set<string>) => [...x].every((t) => y.has(t));
      return sub(ta, tb) || sub(tb, ta);
    },
    merge(f, a, b) {
      if (def(f).compare !== "token_subset") return b;
      const na = a.split(" ").length, nb = b.split(" ").length;
      return na > nb ? a : na < nb ? b : a.length >= b.length ? a : b;
    },

    inRange(f, norm, callDate) {
      const v = def(f).validation;
      if (v.minDaysFromCall === undefined && v.maxDaysFromCall === undefined) return true;
      if (dayNumber(norm) === null || dayNumber(callDate) === null) return true;
      const d = diffDays(callDate, norm);
      return (v.minDaysFromCall === undefined || d >= v.minDaysFromCall) && (v.maxDaysFromCall === undefined || d <= v.maxDaysFromCall);
    },

    confirmPhrase(f, value, pc) {
      const fd = def(f);
      const ev = fd.enumValues?.find((e) => e.value === value);
      if (ev?.confirmIfRaw && pc.raw) {
        const raw = speechLower(pc.raw);
        const hit = ev.confirmIfRaw.find((c) => safeTest(c.pattern, raw));
        if (hit) return renderPhrase(hit.text, f, value, pc);
      }
      return renderPhrase(ev?.confirm ?? fd.phrases.confirm, f, value, pc);
    },
    askPhrase: (f, pc) => renderPhrase(def(f).phrases.ask, f, null, pc),

    spokenForms(f, value, account) {
      const fd = def(f);
      const forms: string[] = [];
      const fmt = (name: string) => formatValue(name, value, { account, field: fd, table: lookupTableOf(bp, account, fd) });
      if (fd.normalizer === "insurance.incidents") {
        forms.push(...(value === "none" ? ["no tickets", "no accidents", "clean record"] : [value]));
      } else if (fd.type === "person_name") {
        forms.push(fmt("title"), fmt("first_name"));
      } else if (fd.type === "date") {
        if (dayNumber(value) !== null) {
          const dob = fd.display === "spoken_dob";
          const long = fmt(dob ? "spoken_dob" : "spoken_date");
          const md = long.replace(/^\w+day, /, "").replace(/, \d{4}$/, "");
          forms.push(long, md);
          if (dob) forms.push(String(ymd(value).y));
          else forms.push(long.split(",")[0]!);
        } else forms.push(value);
      } else if (fd.type === "enum") {
        const ev = fd.enumValues?.find((e) => e.value === value);
        forms.push(...(ev && ev.spokenForms.length ? ev.spokenForms : [value.replace(/_/g, " ")]));
      } else if (fd.type === "state") {
        forms.push(fmt("state_name"));
      } else if (fd.type === "id_code") {
        forms.push(value, fmt("spoken_chars"));
      } else if (fd.type === "zip") {
        forms.push(value, fmt("spoken_zip"));
      } else if (fd.type === "money" || fd.type === "signed_money") {
        forms.push(fmt("spoken_money"));
      } else if (fd.type === "lookup") {
        const t = lookupTableOf(bp, account, fd);
        const row = t?.rows.find((r) => r[t.idColumn] === value);
        if (row && fd.lookup) for (const c of fd.lookup.matchColumns) { const x = row[c]; if (x) forms.push(x); }
        else forms.push(value === ALL_VALUE ? ALL_VALUE : value);
      } else if (fd.type === "integer" || fd.type === "number") {
        forms.push(value);
      } else {
        forms.push(value.replace(/_/g, " "));
      }
      return [...new Set(forms.filter(Boolean))];
    },

    targetedFields(sentence) {
      const strong: string[] = [];
      const weak: string[] = [];
      for (const f of qaFields) {
        if (f.qa.ask.some((re) => safeTest(re, sentence))) strong.push(f.id);
        else if (f.qa.weak.some((re) => safeTest(re, sentence))) weak.push(f.id);
      }
      return strong.length ? strong : weak;
    },
    adviceRe: compileSafeUnion(bp.qa.adviceLexicon),

    inputModeFor(next): InputModePlan {
      switch (next.kind) {
        case "ask": {
          const mode = next.field ? (fields.get(next.field)?.capture.mode ?? "balanced") : "balanced";
          if (mode === "max_accuracy") return { mode, reason: "id_capture" };
          if (mode === "min_latency") return { mode, reason: "yes_no" };
          return { mode, reason: "asks_entity" };
        }
        case "disclosure":
        case "consent":
          return { mode: "min_latency", reason: "disclosure" };
        case "confirm":
        case "none":
          return { mode: "min_latency", reason: "yes_no" };
      }
    },
  };
  return spec;
}

// ============================================================================================ spec-driven helpers
// The pure rules live in the leaf ./spec-link.ts so the legacy functions share them (WP14a·3 spec injection).

export { nextStepFor, openRequiredFor, readinessFor } from "./spec-link";

/** `min(max, base + perField × open)` in ms, from `playbook.sessionCap` (seconds) unless an env override is given. */
export function sessionCapMsFor(spec: IntentSpec, bp: Blueprint, snapshot: Fields, env?: { baseMs: number; perFieldMs: number; maxMs: number }): number {
  const cap = env ?? { baseMs: bp.playbook.sessionCap.baseSec * 1000, perFieldMs: bp.playbook.sessionCap.perFieldSec * 1000, maxMs: bp.playbook.sessionCap.maxSec * 1000 };
  return Math.min(cap.maxMs, cap.baseMs + cap.perFieldMs * openRequiredFor(spec, snapshot).length);
}
