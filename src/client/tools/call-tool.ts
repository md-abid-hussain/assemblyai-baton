import "client-only";

import { ToolResponseSchema, type ToolResponse } from "../../core/contracts/api";
import type { CallTool } from "../../core/contracts/ext/wp6-payments";
import type { ToolName } from "../../core/contracts/tools";

/**
 * `callTool()` (WP6): route #14 as a function, for WP5b's Voice Agent controller (`VaToolCaller`). The browser
 * handler sends the returned `result` verbatim as `tool.result` (and, when `stage` is present, the controller sends
 * `session.update{system_prompt, tools}` first, DESIGN §5.9.4).
 *
 * Failure policy: one retry (after 500 ms) on a network error, a 409 (the first attempt of this call_id was aborted),
 * a 429 or a 5xx; the retry reuses the same VA `call_id`, so the server's idempotency makes it safe. Any other
 * non-2xx throws `ToolCallError`, which the controller turns into an `is_error` tool result.
 */

export class ToolCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolCallError";
  }
}

export interface CallToolOptions {
  /** The takeover-scoped case token (re-issued by POST /api/takeovers). */
  token: () => string;
  /** The signed visitor token (`visitorToken` of POST /api/cases) for cookie-less browsers: sent as `x-baton-visitor`. */
  visitorToken?: () => string | null;
  fetch?: typeof fetch;
  /** Same-origin by default. */
  base?: string;
  retryDelayMs?: number;
}

/** The auth headers of every WP6 browser call: the case token, plus the visitor token when the page has one. */
export function authHeaders(token: string, visitorToken: string | null | undefined): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(visitorToken ? { "x-baton-visitor": visitorToken } : {}) };
}

const RETRYABLE = (s: number) => s === 409 || s === 429 || s >= 500;

export function createCallTool(o: CallToolOptions): CallTool {
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.base ?? "";
  const delay = o.retryDelayMs ?? 500;
  return async (name: ToolName, args: unknown, ctx: { takeoverId: string; callId: string }): Promise<ToolResponse> => {
    const body = JSON.stringify({ takeoverId: ctx.takeoverId, callId: ctx.callId, args: args ?? {} });
    let last: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delay));
      let res: Response;
      try {
        res = await f(`${base}/api/tools/${encodeURIComponent(name)}`, {
          method: "POST",
          headers: { ...authHeaders(o.token(), o.visitorToken?.()), "content-type": "application/json" },
          body,
        });
      } catch (e) {
        last = e;
        continue;
      }
      if (res.ok) return ToolResponseSchema.parse(await res.json());
      const err = await readError(res);
      last = err;
      if (!RETRYABLE(res.status)) throw err;
    }
    throw last instanceof ToolCallError ? last : new ToolCallError(0, "E_NETWORK", last instanceof Error ? last.message : "network error");
  };
}

async function readError(res: Response): Promise<ToolCallError> {
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string } };
    return new ToolCallError(res.status, j.error?.code ?? `HTTP_${res.status}`, j.error?.message ?? res.statusText);
  } catch {
    return new ToolCallError(res.status, `HTTP_${res.status}`, res.statusText);
  }
}
