/**
 * http-log.ts - a `fetch` drop-in that logs every request/response (redacted) into a JsonlLogger.
 *
 * Pass it as the `fetch` option to the async client (./client.ts) or the Gateway client
 * (../gateway/client.ts, which forwards it to the OpenAI SDK). Keys never reach the log:
 * `authorization` headers are masked by lib/log.ts, and every registered secret is scrubbed.
 *
 * - Binary request bodies (uploads) are logged as {bytes}.
 * - JSON bodies are parsed so the JSONL shows real structure.
 * - SSE responses are NOT buffered (that would defeat streaming). Only status + headers + TTFB are logged.
 */
import type { JsonlLogger } from "../lib/log.ts";

export interface LoggingFetchOptions {
  /** Optional label attached to every line (e.g. the sub-test name). Can change between calls. */
  label?: () => string | undefined;
}

function headersToObject(h: unknown): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h as [string, string][]);
  return { ...(h as Record<string, string>) };
}

export function loggingFetch(log: JsonlLogger, opts: LoggingFetchOptions = {}): typeof fetch {
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = headersToObject(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    let body: unknown = init?.body ?? undefined;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep text */
      }
    }
    const label = opts.label?.();
    log.event("http", { phase: "request", label, method, url, headers, body });
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(input, init);
    } catch (err) {
      log.event("http", { phase: "network-error", label, method, url, ms: Math.round(performance.now() - t0), error: String(err) });
      throw err;
    }
    const ttfbMs = Math.round(performance.now() - t0);
    const resHeaders = Object.fromEntries(res.headers.entries());
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream") || method === "HEAD") {
      log.event("http", { phase: "response", label, status: res.status, ttfbMs, headers: resHeaders, body: method === "HEAD" ? null : "<SSE stream - not buffered by logger>" });
      return res;
    }
    const text = await res.clone().text();
    const ms = Math.round(performance.now() - t0);
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    log.event("http", { phase: "response", label, status: res.status, ttfbMs, ms, headers: resHeaders, body: parsed });
    return res;
  };
  return f as typeof fetch;
}
