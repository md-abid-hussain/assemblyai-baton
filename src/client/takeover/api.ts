import "client-only";

import {
  ArmResponseSchema,
  CompiledTakeoverSchema,
  EndTakeoverResponseSchema,
  VaTokenResponseSchema,
  type ArmRequest,
  type EndTakeoverRequest,
  type SessionReport,
  type TakeoverEventsRequest,
  type VaTokenRequest,
} from "@/core/contracts/api";
import { ApiErrorSchema, type ErrorCode } from "@/core/contracts/errors";
import type { DrainReport } from "@/core/contracts/takeover";

import { TakeoverApiError, type RequestOpts, type TakeoverApi } from "./ports";

/**
 * `TakeoverApi` over fetch (DESIGN §4.4 #5b, #7, #9–#13). Bearer tokens in `Authorization`; the signed visitor token
 * in `x-baton-visitor` when cookies are blocked (§4.3). Errors become `TakeoverApiError` with the ApiError code.
 * pagehide requests use `keepalive: true` (G0 rule 10: never sendBeacon, which cannot carry Authorization).
 */
export interface HttpTakeoverApiOptions {
  fetch?: typeof fetch;
  /** "" = same origin. */
  baseUrl?: string;
  /** Cookie-less browsers (CreateCaseResponse.visitorToken). */
  visitorToken?: () => string | null | undefined;
  /** Per-request timeout (the protocol machine has its own, shorter ones). */
  timeoutMs?: number;
}

const TRANSPORT_CODE: ErrorCode = "E_VA_TRANSIENT";

export class HttpTakeoverApi implements TakeoverApi {
  private readonly f: typeof fetch;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(private readonly o: HttpTakeoverApiOptions = {}) {
    this.f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.base = o.baseUrl ?? "";
    this.timeoutMs = o.timeoutMs ?? 8000;
  }

  private async post(path: string, body: unknown, token: string, opts: RequestOpts = {}): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const vt = this.o.visitorToken?.();
    if (vt) headers["x-baton-visitor"] = vt;
    const ctl = opts.keepalive ? null : new AbortController();
    const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method: "POST",
        headers,
        body: body === undefined ? "{}" : JSON.stringify(body),
        ...(opts.keepalive ? { keepalive: true } : {}),
        ...(ctl ? { signal: ctl.signal } : {}),
      });
    } catch (e) {
      throw new TakeoverApiError(TRANSPORT_CODE, 0, `network error on ${path}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = ApiErrorSchema.safeParse(data);
      if (err.success) throw new TakeoverApiError(err.data.error.code, res.status, err.data.error.message, err.data.error.fallback ?? null);
      throw new TakeoverApiError(res.status >= 500 ? "E_INTERNAL" : "E_BAD_REQUEST", res.status, `HTTP ${res.status} on ${path}`);
    }
    return data;
  }

  async arm(req: ArmRequest, caseToken: string) {
    return ArmResponseSchema.parse(await this.post("/api/takeovers", req, caseToken));
  }

  async compile(takeoverId: string, drain: DrainReport, takeoverToken: string) {
    return CompiledTakeoverSchema.parse(await this.post(`/api/takeovers/${encodeURIComponent(takeoverId)}/compile`, { drain }, takeoverToken));
  }

  async events(takeoverId: string, body: TakeoverEventsRequest, takeoverToken: string, opts?: RequestOpts) {
    await this.post(`/api/takeovers/${encodeURIComponent(takeoverId)}/events`, body, takeoverToken, opts);
  }

  async end(takeoverId: string, body: EndTakeoverRequest, takeoverToken: string, opts?: RequestOpts) {
    const data = await this.post(`/api/takeovers/${encodeURIComponent(takeoverId)}/end`, body, takeoverToken, opts);
    // A keepalive response may be unreadable while the page unloads; never fail on it.
    const r = EndTakeoverResponseSchema.safeParse(data);
    return r.success ? r.data : { ok: true as const, verificationJobId: null };
  }

  async vaToken(req: VaTokenRequest, takeoverToken: string) {
    return VaTokenResponseSchema.parse(await this.post("/api/va/token", req, takeoverToken));
  }

  async releaseRun(runId: string, caseToken: string, opts?: RequestOpts) {
    await this.post(`/api/runs/${encodeURIComponent(runId)}/release`, undefined, caseToken, opts);
  }

  async reportSession(r: SessionReport, token: string) {
    await this.post("/api/sessions/report", r, token);
  }
}
