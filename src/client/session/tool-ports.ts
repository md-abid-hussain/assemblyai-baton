/**
 * client/session/tool-ports.ts - the Voice Agent controller's HTTP ports for routes #14 (`POST /api/tools/[name]`) and
 * #15 (`GET /api/payments/[id]`), written against the frozen contracts only.
 *
 * WP6 owns the real client (`src/client/tools/{call-tool,payments}.ts`, not on main yet). These are a contract-exact
 * stand-in so /call runs end to end before WP6 merges; at G2 `createBrowserControllers({ toolPorts })` takes WP6's
 * `createCallTool` / `createPaymentsClient` instead (docs/notes/wp7.md "WP7·1 → integrator"). Same retry policy as
 * WP6's: one retry after 500 ms on a network error, 409, 429 or 5xx (the server is idempotent on `(takeoverId, callId)`).
 */
import "client-only";

import { PaymentViewSchema, ToolResponseSchema, type PaymentView, type ToolResponse } from "@/core/contracts/api";
import type { VaPaymentPoller, VaToolCaller } from "@/core/contracts/ext/wp5b-va";
import type { ToolName } from "@/core/contracts/tools";

export interface ToolPorts {
  callTool: VaToolCaller;
  pollPayment: VaPaymentPoller;
}

/** Builds the ports for one takeover (its token authorises #14 and #15). */
export type ToolPortsFactory = (o: { takeoverToken: () => string; visitorToken?: () => string | undefined }) => ToolPorts;

export class ToolHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolHttpError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const RETRYABLE = (s: number) => s === 409 || s === 429 || s >= 500;

async function readError(res: Response): Promise<ToolHttpError> {
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string } };
    return new ToolHttpError(res.status, j.error?.code ?? `HTTP_${res.status}`, j.error?.message ?? `HTTP ${res.status}`);
  } catch {
    return new ToolHttpError(res.status, `HTTP_${res.status}`, `HTTP ${res.status}`);
  }
}

export function createHttpToolPorts(o: {
  takeoverToken: () => string;
  visitorToken?: () => string | undefined;
  fetch?: FetchLike;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): ToolPorts {
  const f: FetchLike = o.fetch ?? ((i, init) => fetch(i, init));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const headers = (json: boolean): Record<string, string> => {
    const h: Record<string, string> = { authorization: `Bearer ${o.takeoverToken()}` };
    if (json) h["content-type"] = "application/json";
    const v = o.visitorToken?.();
    if (v) h["x-baton-visitor"] = v;
    return h;
  };

  const callTool: VaToolCaller = async (name: ToolName, args: unknown, ctx): Promise<ToolResponse> => {
    const body = JSON.stringify({ takeoverId: ctx.takeoverId, callId: ctx.callId, args: args ?? {} });
    let last: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(o.retryDelayMs ?? 500);
      let res: Response;
      try {
        res = await f(`/api/tools/${encodeURIComponent(name)}`, { method: "POST", headers: headers(true), body, credentials: "same-origin" });
      } catch (e) {
        last = e;
        continue;
      }
      if (res.ok) return ToolResponseSchema.parse(await res.json());
      const err = await readError(res);
      last = err;
      if (!RETRYABLE(res.status)) throw err;
    }
    throw last instanceof ToolHttpError ? last : new ToolHttpError(0, "E_NETWORK", last instanceof Error ? last.message : "network error");
  };

  const pollPayment: VaPaymentPoller = async (paymentId: string): Promise<PaymentView> => {
    const res = await f(`/api/payments/${encodeURIComponent(paymentId)}`, { method: "GET", headers: headers(false), credentials: "same-origin" });
    if (!res.ok) throw await readError(res);
    return PaymentViewSchema.parse(await res.json());
  };

  return { callTool, pollPayment };
}
