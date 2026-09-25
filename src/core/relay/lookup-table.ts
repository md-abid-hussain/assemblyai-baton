/**
 * relay/lookup-table.ts - the `lookup_table` parser (PLATFORM §6.1). WP14a. Pure and isomorphic: ONE parser for the
 * runtime connector (WP16), the lint's view of a pasted table and any kernel `lookup` use, so they never disagree.
 * Moved here from WP16·1's `src/server/connectors/lookup-table.ts` (request wp16-to-wp14a.md §2) with the same
 * exports and behaviour; only the byte count changed (`TextEncoder` instead of Node's `Buffer`).
 *
 * Pasted CSV or JSON, parsed once, ≤ 200 rows, ≤ 32 KiB, ≤ 8 columns. `lookup_<table>({key})` returns the row under
 * `data` (the same `{data:{…}}` wrapper as `http_action`, so the kernel safety block treats it as data), or
 * `{status:"not_found"}`. Keys match after Unicode NFKC, trimming, collapsing whitespace and lower-casing.
 * CSV: RFC 4180 (quoted fields, `""` escapes, CRLF or LF, a UTF-8 BOM, a trailing newline); the first row is the
 * header. JSON: an array of flat objects whose values are strings, finite numbers or booleans (stored as strings).
 */

export const LOOKUP_LIMITS = { maxRows: 200, maxBytes: 32_768, maxColumns: 8, maxCell: 200, maxColumnName: 40 } as const;

export interface LookupTable {
  columns: string[];
  keyColumn: string;
  rows: Record<string, string>[];
  /** normalised key → row index */
  index: Map<string, number>;
}

export type ParseLookupTableResult = { ok: true; table: LookupTable } | { ok: false; errors: string[] };

export interface ParseLookupTableInput {
  format: "csv" | "json";
  data: string;
  keyColumn: string;
  /** When given (the blueprint's `TableDef.columns`), every parsed column must be one of these. */
  expectColumns?: readonly string[];
}

const UTF8 = new TextEncoder();
/** UTF-8 byte length (isomorphic `Buffer.byteLength(s, "utf8")`). */
export const utf8Bytes = (s: string): number => UTF8.encode(s).length;

export function normalizeLookupKey(v: string): string {
  return v.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** RFC 4180 CSV → rows of cells. Returns an error string for an unterminated quote. */
export function parseCsv(text: string): string[][] | string {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      i++;
    } else if (ch === ",") {
      endCell();
      i++;
    } else if (ch === "\r" && src[i + 1] === "\n") {
      endRow();
      i += 2;
    } else if (ch === "\n" || ch === "\r") {
      endRow();
      i++;
    } else {
      cell += ch;
      i++;
    }
  }
  if (quoted) return "unterminated quoted field";
  if (cell !== "" || row.length > 0) endRow();
  // Drop blank lines (a single empty cell).
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
}

function fromJson(data: string, errors: string[]): { columns: string[]; rows: Record<string, string>[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    errors.push("the JSON does not parse");
    return null;
  }
  if (!Array.isArray(parsed)) {
    errors.push("the JSON must be an array of objects");
    return null;
  }
  const columns: string[] = [];
  const rows: Record<string, string>[] = [];
  parsed.forEach((item, n) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push(`row ${n + 1} is not an object`);
      return;
    }
    const row: [string, string][] = [];
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      const col = k.trim();
      if (typeof v === "string") row.push([col, v]);
      else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") row.push([col, String(v)]);
      else if (v === null) row.push([col, ""]);
      else {
        errors.push(`row ${n + 1}, column "${col.slice(0, 40)}": only strings, numbers and booleans are allowed`);
        continue;
      }
      if (!columns.includes(col)) columns.push(col);
    }
    rows.push(Object.fromEntries(row));
  });
  return { columns, rows };
}

function fromCsv(data: string, errors: string[]): { columns: string[]; rows: Record<string, string>[] } | null {
  const cells = parseCsv(data);
  if (typeof cells === "string") {
    errors.push(`the CSV is invalid: ${cells}`);
    return null;
  }
  if (cells.length === 0) {
    errors.push("the CSV has no header row");
    return null;
  }
  const columns = cells[0]!.map((c) => c.trim());
  const rows: Record<string, string>[] = [];
  cells.slice(1).forEach((r, n) => {
    if (r.length !== columns.length) {
      errors.push(`row ${n + 1} has ${r.length} cells; the header has ${columns.length}`);
      return;
    }
    rows.push(Object.fromEntries(columns.map((c, j) => [c, r[j]!.trim()])));
  });
  return { columns, rows };
}

export function parseLookupTable(i: ParseLookupTableInput): ParseLookupTableResult {
  const errors: string[] = [];
  const bytes = utf8Bytes(i.data);
  if (bytes > LOOKUP_LIMITS.maxBytes) return { ok: false, errors: [`the table is ${bytes} bytes (max ${LOOKUP_LIMITS.maxBytes})`] };
  const parsed = i.format === "csv" ? fromCsv(i.data, errors) : fromJson(i.data, errors);
  if (!parsed) return { ok: false, errors };
  const { columns, rows } = parsed;

  if (columns.length === 0) errors.push("the table has no columns");
  if (columns.length > LOOKUP_LIMITS.maxColumns) errors.push(`the table has ${columns.length} columns (max ${LOOKUP_LIMITS.maxColumns})`);
  if (new Set(columns).size !== columns.length) errors.push("column names must be unique");
  for (const c of columns) {
    if (c === "" || c.length > LOOKUP_LIMITS.maxColumnName) errors.push(`column name "${c.slice(0, 40)}" must be 1–${LOOKUP_LIMITS.maxColumnName} characters`);
    if (i.expectColumns && !i.expectColumns.includes(c)) errors.push(`column "${c.slice(0, 40)}" is not declared in the table definition`);
  }
  if (!columns.includes(i.keyColumn)) errors.push(`the key column "${i.keyColumn}" is not in the table`);
  if (rows.length === 0) errors.push("the table has no rows");
  if (rows.length > LOOKUP_LIMITS.maxRows) errors.push(`the table has ${rows.length} rows (max ${LOOKUP_LIMITS.maxRows})`);

  const index = new Map<string, number>();
  if (columns.includes(i.keyColumn)) {
    rows.forEach((r, n) => {
      for (const [c, v] of Object.entries(r)) {
        if (v.length > LOOKUP_LIMITS.maxCell) errors.push(`row ${n + 1}, column "${c}" is over ${LOOKUP_LIMITS.maxCell} characters`);
      }
      const key = normalizeLookupKey(r[i.keyColumn] ?? "");
      if (!key) errors.push(`row ${n + 1} has an empty key`);
      else if (index.has(key)) errors.push(`the key "${key.slice(0, 40)}" appears twice`);
      else index.set(key, n);
    });
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  // Every row gets every column (missing JSON keys → "").
  const full = rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? ""])));
  return { ok: true, table: { columns, keyColumn: i.keyColumn, rows: full, index } };
}

/** What the agent sees for `lookup_<table>({key})`. */
export type LookupResult = { data: Record<string, string> } | { status: "not_found" };

export function lookupRow(t: LookupTable, key: unknown): LookupResult {
  if (typeof key !== "string" && typeof key !== "number") return { status: "not_found" };
  const n = t.index.get(normalizeLookupKey(String(key)));
  return n === undefined ? { status: "not_found" } : { data: { ...t.rows[n]! } };
}
