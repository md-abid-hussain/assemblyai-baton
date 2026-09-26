import "server-only";

import { randomUUID } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import https from "node:https";

import type { ConnectorOutcomeStatus } from "@/core/contracts/ext/wp16-connectors";
import { CONNECTOR_HEADERS, CONNECTOR_USER_AGENT, type ConnectorRequestBody } from "@/core/contracts/v2/api";
import { assertHostAllowed, parseDestination, type DestinationPolicy } from "./destination";
import { createConnectorResolver, pinnedLookup, resolvePublic, type ConnectorResolver } from "./dns";
import { ConnectorError, isConnectorError } from "./errors";
import { signatureHeader } from "./hmac";
import {
  filterDeclaredHeaders, pickResponse, redactDeep, redactText, type DeclaredHeader, type PickedValue, type SecretForRedaction,
} from "./shape";

/**
 * The guarded HTTPS runtime behind `http_action` (PLATFORM §6.2). One call = one `executeHttpAction`, which never
 * throws and always returns an `HttpActionReport`:
 *
 * 1. URL: `https:` + port 443 only, no userinfo (`parseDestination`); the production host allowlist.
 * 2. DNS: c-ares, 1.5 s, `resolve4` ∥ `resolve6`; every answer must be public unicast (ipaddr.js); IP literals are
 *    checked directly. The first IPv4 (else IPv6) answer is PINNED through a custom `lookup` (anti-rebinding),
 *    with `autoSelectFamily: false`, `servername` = the host, and a fresh agent per call (no pooled sockets).
 * 3. Request: POST JSON `{tool, args, run}` (≤ 8 KiB) or GET with the args in the query; only the allowed declared
 *    headers (secret values resolved by the caller) plus `User-Agent`, `X-Changeover-Delivery`, and when signing
 *    `X-Changeover-Timestamp` + `X-Changeover-Signature`. No `Accept-Encoding` is ever sent.
 * 4. Response: 3xx → `E_CONN_REDIRECT` (never followed); any `Content-Encoding` (or gzip magic) → `E_CONN_ENCODING`
 *    (never decompressed); > 8192 bytes → `E_CONN_TOO_LARGE` (aborted); JSON or text/plain only; `timeoutMs` (≤ 5000)
 *    across connect, TLS and body → `E_CONN_TIMEOUT`.
 * 5. Result to the agent: `{data:{<responsePick paths>}, http_status}`; non-2xx → `{status:"failed", http_status}`.
 *    Secret values are redacted from the agent result and the raw text (an echo service would reflect them).
 */

export const MAX_RESPONSE_BYTES = 8192;
export const MAX_REQUEST_BYTES = 8192;
export const MAX_TIMEOUT_MS = 5000;
export const MIN_TIMEOUT_MS = 500;

export type HttpRequestFn = (options: https.RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;

export interface HttpActionInput {
  url: string;
  method: "GET" | "POST";
  toolName: string;
  args: Record<string, unknown>;
  run: ConnectorRequestBody["run"];
  /** Declared headers with secret refs already resolved (names of secret-backed ones in `secretName`). */
  headers: readonly DeclaredHeader[];
  /** The resolved HMAC secret, or null for an unsigned call. */
  hmac: { name: string; value: string } | null;
  timeoutMs: number;
  responsePick: readonly string[];
}

export interface HttpActionDeps {
  policy: DestinationPolicy;
  /**
   * WP16·3 (SAAS §5.6): the org-aware host check. When set it REPLACES the env-only `assertHostAllowed`, so an
   * org's own allowed hosts (Pro+) pass and a refusal can carry the plan message. It runs before any DNS lookup.
   */
  checkHost?: (host: string) => Promise<{ ok: boolean; message?: string }>;
  /** Defaults to a fresh `createConnectorResolver()` per call. */
  resolver?: ConnectorResolver;
  /** The transport; defaults to `https.request`. Tests inject a wrapper. */
  request?: HttpRequestFn;
  now?: () => number;
  uuid?: () => string;
}

export interface HttpActionReport {
  status: ConnectorOutcomeStatus;
  errorCode: string | null;
  /** Owner-facing explanation (console, logs); never a secret, header value or raw body. */
  message: string | null;
  httpStatus: number | null;
  ms: number;
  reqBytes: number;
  resBytes: number;
  /** Exactly what the agent sees. */
  agentResult: Record<string, unknown>;
  /** The redacted request line and headers (secret values as `‹secret:name›`); null when refused before building it. */
  request: { method: "GET" | "POST"; url: string; headers: { name: string; value: string }[] } | null;
  /** The `X-Changeover-Signature` value sent, or null. */
  signature: string | null;
  /** The raw response text (≤ 8 KiB), secret values redacted. Owner-only: never shown to the agent. */
  raw: string | null;
  /** The pinned address that was connected to (diagnostics). */
  address: string | null;
  /** Declared headers that were dropped by the header allowlist. */
  droppedHeaders: string[];
}

/**
 * One guarded HTTPS exchange: the socket half of `executeHttpAction`, extracted in WP16·3 so outbound webhooks
 * (`publicHttpsPost`, SAAS §7.4) run on exactly the same wire rules — a pinned address, `autoSelectFamily:false`,
 * no pooled socket, no redirect, no compressed body, one deadline across connect/TLS/body, and a hard byte cap.
 * It rejects with a `ConnectorError`; it never throws synchronously.
 */
export interface GuardedRequestInput {
  /** The destination host: the TLS SNI and the `Host` header (never the pinned literal). */
  host: string;
  /** True when the URL host was an IP literal (then no `servername` is set). */
  isLiteral: boolean;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  timeoutMs: number;
  pinned: { address: string; family: 4 | 6 };
  maxResponseBytes?: number;
  request?: HttpRequestFn;
  /** Called with the running byte total, so a caller can report bytes even on a refusal. */
  onBytes?: (total: number) => void;
}

export interface GuardedResponse {
  status: number;
  contentType: string;
  buf: Buffer;
}

export function sendGuarded(i: GuardedRequestInput): Promise<GuardedResponse> {
  const cap = i.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const request = i.request ?? (https.request as unknown as HttpRequestFn);
  return new Promise<GuardedResponse>((resolve, reject) => {
    let req: ClientRequest | null = null;
    let done = false;
    const finish = (err: ConnectorError | null, value?: GuardedResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        req?.destroy();
        reject(err);
      } else resolve(value!);
    };
    const timer = setTimeout(
      () => finish(new ConnectorError("E_CONN_TIMEOUT", `No complete response within ${i.timeoutMs} ms.`)),
      i.timeoutMs,
    );
    // `autoSelectFamily` reaches net.connect through the agent; @types/node omits it from RequestOptions.
    const options: https.RequestOptions & { autoSelectFamily: boolean } = {
      protocol: "https:",
      hostname: i.host,
      port: 443,
      path: i.path,
      method: i.method,
      headers: i.headers,
      agent: false,
      lookup: pinnedLookup(i.pinned.address, i.pinned.family),
      family: i.pinned.family,
      autoSelectFamily: false,
      ...(i.isLiteral ? {} : { servername: i.host }),
    };
    try {
      req = request(options, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          return finish(new ConnectorError("E_CONN_REDIRECT", `The destination answered ${status} (redirects are never followed).`));
        }
        const enc = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
        if (enc && enc !== "identity") {
          res.destroy();
          return finish(new ConnectorError("E_CONN_ENCODING", `The response is compressed (${enc.slice(0, 40)}); compressed bodies are refused.`));
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > cap) {
          res.destroy();
          return finish(new ConnectorError("E_CONN_TOO_LARGE", `The response is ${declared} bytes (max ${cap}).`));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          i.onBytes?.(total);
          if (total > cap) {
            res.destroy();
            return finish(new ConnectorError("E_CONN_TOO_LARGE", `The response is over ${cap} bytes.`));
          }
          chunks.push(c);
        });
        res.on("end", () => finish(null, { status, contentType: String(res.headers["content-type"] ?? ""), buf: Buffer.concat(chunks) }));
        res.on("error", () => finish(new ConnectorError("E_CONN_NETWORK", "The response stream failed.")));
        res.on("close", () => {
          if (!res.complete) finish(new ConnectorError("E_CONN_NETWORK", "The response was cut short."));
        });
      });
    } catch (e) {
      return finish(new ConnectorError("E_CONN_NETWORK", `The request could not be started (${(e as Error).message.slice(0, 120)}).`));
    }
    req.on("error", (e: NodeJS.ErrnoException) =>
      finish(new ConnectorError("E_CONN_NETWORK", `The connection failed (${e.code ?? "error"}).`)),
    );
    req.end(i.body ?? undefined);
  });
}

const AGENT_FAILURE_REASON: Partial<Record<ConnectorOutcomeStatus, string>> = {
  blocked: "destination_not_allowed", refused: "not_attempted", timeout: "timeout", error: "unavailable",
};

function queryValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function isTextOrJson(contentType: string): "json" | "text" | null {
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  if (ct === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(ct)) return "json";
  if (ct === "text/plain") return "text";
  return null;
}

export async function executeHttpAction(input: HttpActionInput, deps: HttpActionDeps): Promise<HttpActionReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  const secrets: SecretForRedaction[] = [
    ...input.headers.filter((h) => h.secretName).map((h) => ({ name: h.secretName!, value: h.value })),
    ...(input.hmac ? [{ name: input.hmac.name, value: input.hmac.value }] : []),
  ];
  const report: HttpActionReport = {
    status: "error", errorCode: null, message: null, httpStatus: null, ms: 0, reqBytes: 0, resBytes: 0,
    agentResult: {}, request: null, signature: null, raw: null, address: null, droppedHeaders: [],
  };
  const fail = (e: ConnectorError): HttpActionReport => {
    report.status = e.status;
    report.errorCode = e.code;
    report.message = redactText(e.message, secrets);
    report.agentResult = e.code === "E_CONN_HTTP" && report.httpStatus !== null
      ? { status: "failed", http_status: report.httpStatus }
      : { status: "failed", reason: AGENT_FAILURE_REASON[e.status] ?? "unavailable" };
    report.ms = Math.max(0, now() - started);
    return report;
  };

  try {
    // ---- 1. URL + allowlist (before DNS: a refused host never costs a lookup)
    const dest = parseDestination(input.url);
    if (deps.checkHost) {
      const verdict = await deps.checkHost(dest.host);
      if (!verdict.ok) {
        throw new ConnectorError(
          "E_CONN_HOST_NOT_ALLOWED",
          verdict.message ?? `HTTP actions may not reach "${dest.host}" from this workspace.`,
        );
      }
    } else {
      assertHostAllowed(dest.host, deps.policy);
    }

    // ---- 3a. build the request (before DNS, so a refused request costs no lookup)
    const url = new URL(dest.url.toString());
    let body: Buffer | null = null;
    if (input.method === "GET") {
      for (const [k, v] of Object.entries(input.args)) {
        const q = queryValue(v);
        if (q !== null) url.searchParams.append(k, q);
      }
    } else {
      const payload: ConnectorRequestBody = { tool: input.toolName, args: input.args, run: input.run };
      body = Buffer.from(JSON.stringify(payload), "utf8");
      if (body.length > MAX_REQUEST_BYTES) {
        throw new ConnectorError("E_CONN_REQUEST_TOO_LARGE", `The request body is ${body.length} bytes (max ${MAX_REQUEST_BYTES}).`);
      }
    }
    const path = `${url.pathname}${url.search}`;
    if (Buffer.byteLength(path) > MAX_REQUEST_BYTES) throw new ConnectorError("E_CONN_REQUEST_TOO_LARGE", "The request URL is over 8 KiB.");

    const { kept, dropped } = filterDeclaredHeaders(input.headers);
    report.droppedHeaders = dropped;
    const headers: Record<string, string> = {};
    const shown: { name: string; value: string }[] = [];
    for (const h of kept) {
      headers[h.name] = h.value;
      shown.push({ name: h.name, value: h.secretName ? `‹secret:${h.secretName}›` : redactText(h.value, secrets) });
    }
    const fixed: [string, string][] = [
      ["User-Agent", CONNECTOR_USER_AGENT],
      [CONNECTOR_HEADERS.delivery, (deps.uuid ?? randomUUID)()],
    ];
    if (body) fixed.push(["Content-Type", "application/json"], ["Content-Length", String(body.length)]);
    if (input.hmac) {
      const ts = Math.floor(now() / 1000);
      const sig = signatureHeader(input.hmac.value, ts, body ?? "");
      fixed.push([CONNECTOR_HEADERS.timestamp, String(ts)], [CONNECTOR_HEADERS.signature, sig]);
      report.signature = sig;
    }
    for (const [n, v] of fixed) {
      headers[n] = v;
      shown.push({ name: n, value: v });
    }
    report.reqBytes = body?.length ?? 0;
    report.request = { method: input.method, url: redactText(url.toString(), secrets), headers: shown };

    // ---- 2. DNS (or the already-checked literal) → the pinned address
    const pinned = dest.literal?.ok
      ? { address: dest.literal.address, family: dest.literal.family }
      : await resolvePublic(dest.host, deps.resolver ?? createConnectorResolver());
    report.address = pinned.address;

    // ---- 4. the request itself, under one deadline
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(input.timeoutMs)));
    const res = await sendGuarded({
      host: dest.host,
      isLiteral: dest.literal !== null,
      path,
      method: input.method,
      headers,
      body,
      timeoutMs,
      pinned,
      request: deps.request,
      onBytes: (total) => {
        report.resBytes = total;
      },
    });

    // ---- 5. result
    report.httpStatus = res.status;
    report.resBytes = res.buf.length;
    if (res.buf.length >= 2 && res.buf[0] === 0x1f && res.buf[1] === 0x8b) {
      throw new ConnectorError("E_CONN_ENCODING", "The response body is gzip data; compressed bodies are refused.");
    }
    const text = res.buf.toString("utf8");
    report.raw = redactText(text, secrets);
    if (res.status < 200 || res.status > 299) {
      throw new ConnectorError("E_CONN_HTTP", `The destination answered HTTP ${res.status}.`);
    }
    let data: Record<string, PickedValue> = {};
    if (res.buf.length > 0) {
      const kind = isTextOrJson(res.contentType);
      if (!kind) throw new ConnectorError("E_CONN_CONTENT_TYPE", `The response type "${res.contentType.slice(0, 60)}" is not JSON or text/plain.`);
      if (kind === "json") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new ConnectorError("E_CONN_BAD_RESPONSE", "The response says JSON but does not parse.");
        }
        data = redactDeep(pickResponse(parsed, input.responsePick), secrets);
      }
    }
    report.status = "ok";
    report.agentResult = { data, http_status: res.status };
    report.ms = Math.max(0, now() - started);
    return report;
  } catch (e) {
    if (isConnectorError(e)) return fail(e);
    return fail(new ConnectorError("E_CONN_NETWORK", "The call failed unexpectedly."));
  }
}
