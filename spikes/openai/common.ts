/** common.ts - shared scaffolding for the OpenAI smoke tests (not part of the reusable client). */
import OpenAI from "openai";
import { VERSION as OPENAI_SDK_VERSION } from "openai/version";
import { OPENAI_API_KEY } from "../lib/env.ts";
import type { JsonlLogger } from "../lib/log.ts";
import { createOpenAI } from "./client.ts";

/** No retries: latency numbers must not hide a retry. */
export const oa: OpenAI = createOpenAI(OPENAI_API_KEY, { maxRetries: 0, timeoutMs: 180_000 });

export interface ErrInfo {
  name: string;
  status?: number | undefined;
  code?: string | null | undefined;
  param?: string | null | undefined;
  type?: string | undefined;
  message: string;
  request_id?: string | null | undefined;
}

export function errInfo(e: unknown): ErrInfo {
  if (e instanceof OpenAI.APIError) {
    return {
      name: e.name,
      status: e.status,
      code: e.code,
      param: e.param,
      type: e.type,
      message: e.message.slice(0, 600),
      request_id: e.requestID,
    };
  }
  if (e instanceof Error) return { name: e.name, message: e.message.slice(0, 600) };
  return { name: "unknown", message: String(e).slice(0, 600) };
}

export const round1 = (n: number) => Math.round(n * 10) / 10;

export function stats(xs: number[]): { n: number; min: number; median: number; mean: number; max: number } | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
  return { n: s.length, min: round1(s[0]!), median: round1(mid), mean: round1(s.reduce((a, b) => a + b, 0) / s.length), max: round1(s.at(-1)!) };
}

/** Truncate long strings for verbatim-but-short reporting. */
export const trunc = (s: string | null | undefined, n = 240): string => {
  const v = s ?? "";
  return v.length > n ? `${v.slice(0, n)}...[+${v.length - n}]` : v;
};

export function header(log: JsonlLogger, test: string, extra: Record<string, unknown> = {}): void {
  log.note("start", { test, node: process.version, openai_sdk: OPENAI_SDK_VERSION, ...extra });
}
