/**
 * util.ts - small formatting / date / table helpers shared by the commands.
 */
import { createHash } from "node:crypto";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 2026-09-25T10:15:03.123Z -> 20260925T101503Z (Windows-safe, sortable). */
export function compactUtc(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Seconds -> "m:ss". */
export function fmtDuration(totalS: number | null | undefined): string {
  if (totalS == null || !Number.isFinite(totalS)) return "-";
  const s = Math.max(0, Math.round(totalS));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const money = (n: number): string => `$${n.toFixed(2)}`;
export const signedMoney = (n: number): string => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function utcParts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return { y, m, d };
}

/** Whole years between two ISO dates (age on `onIso` of someone born `dobIso`). */
export function ageOn(dobIso: string, onIso: string): number {
  const b = utcParts(dobIso);
  const o = utcParts(onIso);
  let age = o.y - b.y;
  if (o.m < b.m || (o.m === b.m && o.d < b.d)) age -= 1;
  return age;
}

/** Signed day difference b - a. */
export function daysBetween(aIso: string, bIso: string): number {
  return Math.round((Date.parse(`${bIso}T00:00:00Z`) - Date.parse(`${aIso}T00:00:00Z`)) / 86_400_000);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-10-02" -> "Friday, October 2, 2026" (locale-independent). */
export function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "2009-03-14" -> "March 14, 2009". */
export function monthDayYear(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** Plain-text table with padded columns. */
export function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

/** Local-time "YYYY-MM-DD HH:MM" for display. */
export function localStamp(d: Date | string | null | undefined): string {
  if (!d) return "-";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
