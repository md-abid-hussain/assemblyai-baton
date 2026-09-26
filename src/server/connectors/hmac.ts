import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { HMAC_SIGNATURE_VERSION, HMAC_WINDOW_SEC } from "@/core/contracts/v2/api";

/**
 * Connector request signing (PLATFORM §6.2 "HMAC"), the documented algorithm:
 *
 *   X-Changeover-Timestamp: <unix seconds>
 *   X-Changeover-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 *
 * The raw body is the exact bytes sent (the empty string for GET, whose args travel in the query). Receivers accept
 * a timestamp within ±300 s (`HMAC_WINDOW_SEC`). `verifyHmac` is what `/api/connectors/echo` runs; it compares in
 * constant time and accepts a comma-separated list of `v1=` values (key rotation).
 */

export function hmacHex(secret: string, timestampSec: number | string, rawBody: string | Buffer): string {
  const h = createHmac("sha256", secret);
  h.update(`${timestampSec}.`);
  h.update(rawBody);
  return h.digest("hex");
}

/** The `X-Changeover-Signature` value: `v1=<hex>`. */
export function signatureHeader(secret: string, timestampSec: number | string, rawBody: string | Buffer): string {
  return `${HMAC_SIGNATURE_VERSION}=${hmacHex(secret, timestampSec, rawBody)}`;
}

export type HmacVerdict = "absent" | "valid" | "tampered" | "stale" | "malformed";

export interface VerifyHmacInput {
  secret: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  rawBody: string | Buffer;
  nowSec: number;
  windowSec?: number;
}

/**
 * `absent` = neither header; `malformed` = one header without the other, or a non-integer timestamp;
 * `stale` = outside the window; `tampered` = no `v1=` value matches; `valid` otherwise.
 */
export function verifyHmac(i: VerifyHmacInput): HmacVerdict {
  const sig = i.signature?.trim() ?? "";
  const ts = i.timestamp?.trim() ?? "";
  if (!sig && !ts) return "absent";
  if (!sig || !ts || !/^\d{1,12}$/.test(ts)) return "malformed";
  const windowSec = i.windowSec ?? HMAC_WINDOW_SEC;
  if (Math.abs(i.nowSec - Number(ts)) > windowSec) return "stale";
  const expected = Buffer.from(hmacHex(i.secret, ts, i.rawBody), "hex");
  const prefix = `${HMAC_SIGNATURE_VERSION}=`;
  let match = false;
  for (const part of sig.split(",")) {
    const p = part.trim();
    if (!p.startsWith(prefix)) continue;
    const hex = p.slice(prefix.length);
    if (!/^[0-9a-f]{64}$/i.test(hex)) continue;
    const got = Buffer.from(hex, "hex");
    if (got.length === expected.length && timingSafeEqual(got, expected)) match = true;
  }
  return match ? "valid" : "tampered";
}
