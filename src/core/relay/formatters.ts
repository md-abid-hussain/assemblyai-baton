/**
 * relay/formatters.ts - the template formatters (`{path|formatter}`) and field display kinds (PLATFORM §3.2
 * `FORMATTERS`, §3.3). WP14a. Pure and isomorphic.
 *
 * Every formatter is a thin wrapper over the legacy spoken/display functions (compiler/spoken.ts,
 * intents/add-driver.ts), so the Baton blueprint renders byte-identical text (parity, PLATFORM §4.6). The
 * `insurance.*` formatters call the legacy add-driver functions unchanged.
 */
import type { AccountRecord, BlueprintField } from "../contracts/v2/blueprint";
import { collapseWs, titleCase } from "../case/text";
import {
  STATE_NAMES, spokenChars, spokenDate, spokenDateLong, spokenDob, spokenMoney, spokenMonthly, spokenZip, stateName,
} from "../compiler/spoken";
import { displayValue, firstNameOf, licenseAdjective, licenseWords, relationWord } from "../intents/add-driver";

/** A lookup table as the formatters see it (the blueprint table def plus the account's rows). */
export interface LookupTable {
  label: string;
  idColumn: string;
  labelColumn: string;
  rows: readonly Record<string, string>[];
}

export interface FormatCtx {
  account: AccountRecord;
  /** The blueprint field the value belongs to (enum and lookup formatters need it); null for non-field paths. */
  field?: BlueprintField | null;
  /** The words behind the value ("as spoken"); the case's display when the value comes from a snapshot. */
  raw?: string | null;
  /** The field's lookup table, when it has one. */
  table?: LookupTable | null;
}

/** "all" of a lookup field that allows it: "all your vehicles" (legacy `vehicleLabelOf`). */
export const ALL_VALUE = "all";
export const allLabelOf = (table: Pick<LookupTable, "label">): string => `all your ${table.label.toLowerCase()}`;

/** The label of a lookup value: the row's label column, "all your <table>" for "all", else the value itself. */
export function lookupLabel(value: string, table: LookupTable | null | undefined): string {
  if (!table) return value;
  if (value === ALL_VALUE) return allLabelOf(table);
  const row = table.rows.find((r) => r[table.idColumn] === value);
  return row?.[table.labelColumn] ?? value;
}

const enumValueOf = (field: BlueprintField | null | undefined, value: string) => field?.enumValues?.find((e) => e.value === value);
const NO_VEHICLES: { vehicles: never[] } = { vehicles: [] };

type Formatter = (value: string, ctx: FormatCtx) => string;

const FORMATTER_IMPLS: Readonly<Record<string, Formatter>> = {
  raw: (v) => v,
  title: (v) => titleCase(v),
  first_name: (v) => firstNameOf(v),
  lower: (v) => v.toLowerCase(),
  spoken_date: (v) => spokenDate(v),
  spoken_date_long: (v) => spokenDateLong(v),
  spoken_dob: (v) => spokenDob(v),
  spoken_zip: (v) => spokenZip(v),
  spoken_chars: (v) => spokenChars(v),
  spoken_money: (v) => spokenMoney(v),
  spoken_monthly: (v) => spokenMonthly(v),
  state_name: (v) => stateName(v),
  state_with_code: (v) => (STATE_NAMES[v] ? `${stateName(v)} (${v})` : v),
  enum_label: (v, c) => enumValueOf(c.field, v)?.label ?? v.replace(/_/g, " "),
  enum_word: (v, c) => { const e = enumValueOf(c.field, v); return e?.word ?? e?.label.toLowerCase() ?? v.replace(/_/g, " "); },
  lookup_label: (v, c) => lookupLabel(v, c.table),
  underscore_to_space: (v) => v.replace(/_/g, " "),
  as_spoken: (v, c) => (c.raw ? collapseWs(c.raw) : v),
  "insurance.relation_word": (v, c) => relationWord(v, c.raw),
  "insurance.relation_display": (v, c) => displayValue("driver_relation", v, NO_VEHICLES, c.raw),
  "insurance.license_words": (v) => licenseWords(v),
  "insurance.license_adjective": (v) => licenseAdjective(v),
  "insurance.incidents_display": (v, c) => displayValue("incidents_3y", v, NO_VEHICLES, c.raw),
};

/** Formatter names this build implements (= `FORMATTERS`; the contracts test pins the equality). */
export const IMPLEMENTED_FORMATTERS: readonly string[] = Object.keys(FORMATTER_IMPLS);

/** Applies a formatter. An unknown name returns the value unchanged (lint L3 reports it). */
export function formatValue(formatter: string, value: string, ctx: FormatCtx): string {
  const f = FORMATTER_IMPLS[formatter];
  return f ? f(value, ctx) : value;
}
