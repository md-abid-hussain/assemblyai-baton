import "server-only";

/**
 * `publicHttpsPost` — the SSRF-guarded POST that WP24's outbound webhooks send on (SAAS §7.4, §10.3), exported by
 * WP16·3 so there is exactly ONE guarded HTTPS client in the app.
 *
 * It is `executeHttpAction`'s wire half (`sendGuarded`) with a webhook-shaped skin:
 *  - `https:` + port 443 only, no userinfo, no `localhost`/single-label host (`parseDestination`);
 *  - c-ares resolution with the 1.5 s budget, every answer checked against the `ipaddr.js` unicast allowlist, the
 *    chosen address PINNED for the connection (no rebinding), `autoSelectFamily:false`, a fresh agent per call;
 *  - no redirects, no `Accept-Encoding`, no compressed body, one deadline, a byte cap on the response.
 *
 * **No connector host policy** (SAAS §7.4): a webhook endpoint is the customer's own URL, so the §5.6 allowlist —
 * which exists to stop a *blueprint* turning us into a fetch proxy — does not apply. The address guard still does.
 *
 * It never throws: the caller gets `{ok:false, errorCode}` and decides whether to retry. The response body is
 * returned as text (capped) so the delivery log can store a short excerpt; it is never parsed or interpreted here.
 */
import { CONNECTOR_USER_AGENT } from "@/core/contracts/v2/api";
import { parseDestination } from "./destination";
import { createConnectorResolver, resolvePublic, type ConnectorResolver } from "./dns";
import { isConnectorError } from "./errors";
import { MAX_REQUEST_BYTES, sendGuarded, type HttpRequestFn } from "./http";

/** SAAS §7.4: 5 s per delivery attempt. */
export const WEBHOOK_TIMEOUT_MS = 5000;
/** Enough for a diagnostic excerpt of the endpoint's answer; the body is never used for anything else. */
export const WEBHOOK_MAX_RESPONSE_BYTES = 8192;

export interface PublicHttpsPostOptions {
  /** Delivery headers (signature, id, timestamp). `Content-Type`, `Content-Length` and `User-Agent` are set here. */
  headers?: Record<string, string>;
  /** The exact bytes to send. A string is sent as UTF-8; the signature must be over these same bytes. */
  body: string | Buffer;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Tests inject a transport and a resolver; production uses `https.request` and a fresh c-ares resolver. */
  request?: HttpRequestFn;
  resolver?: ConnectorResolver;
  now?: () => number;
}

export interface PublicHttpsPostResult {
  /** True only for a 2xx answer within the limits. */
  ok: boolean;
  status: number | null;
  /** `E_CONN_*` (`errors.ts`) when the attempt failed before or instead of a 2xx. */
  errorCode: string | null;
  /** Owner-facing reason; never a header value or a secret. */
  message: string | null;
  /** The response body as text, capped. Empty string when there was none. */
  bodyText: string;
  ms: number;
  /** The pinned address that was connected to (for the delivery log). */
  address: string | null;
}

export async function publicHttpsPost(url: string, opts: PublicHttpsPostOptions): Promise<PublicHttpsPostResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const out: PublicHttpsPostResult = { ok: false, status: null, errorCode: null, message: null, bodyText: "", ms: 0, address: null };
  const done = (): PublicHttpsPostResult => {
    out.ms = Math.max(0, now() - started);
    return out;
  };

  try {
    const dest = parseDestination(url);
    const body = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, "utf8");
    if (body.length > MAX_REQUEST_BYTES) {
      out.errorCode = "E_CONN_REQUEST_TOO_LARGE";
      out.message = `The payload is ${body.length} bytes (max ${MAX_REQUEST_BYTES}).`;
      return done();
    }
    const headers: Record<string, string> = {
      ...(opts.headers ?? {}),
      "User-Agent": CONNECTOR_USER_AGENT,
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
    };
    const pinned = dest.literal?.ok
      ? { address: dest.literal.address, family: dest.literal.family }
      : await resolvePublic(dest.host, opts.resolver ?? createConnectorResolver());
    out.address = pinned.address;

    const res = await sendGuarded({
      host: dest.host,
      isLiteral: dest.literal !== null,
      path: `${dest.url.pathname}${dest.url.search}`,
      method: "POST",
      headers,
      body,
      timeoutMs: Math.max(500, Math.floor(opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS)),
      pinned,
      maxResponseBytes: opts.maxResponseBytes ?? WEBHOOK_MAX_RESPONSE_BYTES,
      request: opts.request,
    });
    out.status = res.status;
    out.bodyText = res.buf.toString("utf8");
    out.ok = res.status >= 200 && res.status <= 299;
    if (!out.ok) {
      out.errorCode = "E_CONN_HTTP";
      out.message = `The endpoint answered HTTP ${res.status}.`;
    }
    return done();
  } catch (e) {
    if (isConnectorError(e)) {
      out.errorCode = e.code;
      out.message = e.message;
    } else {
      out.errorCode = "E_CONN_NETWORK";
      out.message = "The delivery failed unexpectedly.";
    }
    return done();
  }
}
