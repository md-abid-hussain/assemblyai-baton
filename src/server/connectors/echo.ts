import "server-only";

import { CHANGEOVER_DEMO_ECHO_SECRET, CONNECTOR_HEADERS, V2_ERROR_STATUS, type EchoResponse } from "@/core/contracts/v2/api";
import { verifyHmac } from "./hmac";

/**
 * `GET|POST /api/connectors/echo` (PLATFORM §6.2 "Demo target"): the built-in HMAC-verifying echo, so the gallery and
 * the test console work with no external service.
 *
 * - Verifies with the FIXED, PUBLISHED demo secret `CHANGEOVER_DEMO_ECHO_SECRET` (demo-only by design; not a secret).
 * - Unsigned → 200 with `signature:"absent"`; valid → 200 `"valid"`; tampered, stale (±300 s) or half-signed → 401
 *   `E_ECHO_SIGNATURE`.
 * - Echoes method, query, the parsed body and the request headers, lower-cased, with credential-bearing values
 *   redacted and proxy/infrastructure headers left out. Bodies over 8 KiB → 400.
 */

export const ECHO_MAX_BODY_BYTES = 8192;

const REDACTED = "‹redacted›";
const DROP_HEADER = /^(x-forwarded-|x-real-ip$|forwarded$|via$|true-client-ip$|cf-|x-zerops-|x-vercel-|x-middleware-|x-invoke-|next-|rsc$)/;
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-changeover-key)$|secret|token|password|api[-_]?key|session/;

function echoHeaders(h: Headers): Record<string, string> {
  const out: [string, string][] = [];
  h.forEach((value, name) => {
    const n = name.toLowerCase();
    if (DROP_HEADER.test(n)) return;
    out.push([n, SECRET_HEADER.test(n) ? REDACTED : value.slice(0, 500)]);
  });
  return Object.fromEntries(out);
}

function v2Error(code: "E_ECHO_SIGNATURE" | "E_BAD_REQUEST", message: string): Response {
  const status = code === "E_BAD_REQUEST" ? 400 : V2_ERROR_STATUS[code];
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleEcho(req: Request, nowMs: number = Date.now()): Promise<Response> {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "POST") return v2Error("E_BAD_REQUEST", "The echo accepts GET and POST.");
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ECHO_MAX_BODY_BYTES) {
    return v2Error("E_BAD_REQUEST", `The echo accepts bodies up to ${ECHO_MAX_BODY_BYTES} bytes.`);
  }
  const raw = method === "POST" ? await req.text() : "";
  if (Buffer.byteLength(raw, "utf8") > ECHO_MAX_BODY_BYTES) {
    return v2Error("E_BAD_REQUEST", `The echo accepts bodies up to ${ECHO_MAX_BODY_BYTES} bytes.`);
  }

  const verdict = verifyHmac({
    secret: CHANGEOVER_DEMO_ECHO_SECRET,
    signature: req.headers.get(CONNECTOR_HEADERS.signature),
    timestamp: req.headers.get(CONNECTOR_HEADERS.timestamp),
    rawBody: raw,
    nowSec: Math.floor(nowMs / 1000),
  });
  if (verdict !== "absent" && verdict !== "valid") {
    const why = verdict === "stale" ? "the timestamp is outside ±300 s" : verdict === "malformed" ? "the signature headers are incomplete" : "the signature does not match";
    return v2Error("E_ECHO_SIGNATURE", `Signature rejected: ${why}.`);
  }

  let body: unknown = null;
  if (raw) {
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("json")) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    } else body = raw;
  }
  const url = new URL(req.url);
  const query: Record<string, string> = Object.fromEntries([...url.searchParams.entries()].map(([k, v]) => [k, v.slice(0, 500)]));
  const payload: EchoResponse = {
    ok: true,
    signature: verdict,
    method,
    query,
    body,
    headers: echoHeaders(req.headers),
    receivedAt: new Date(nowMs).toISOString(),
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
