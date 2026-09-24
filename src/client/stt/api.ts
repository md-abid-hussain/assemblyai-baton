/**
 * api.ts - the browser side of routes #5 (POST /api/stt/token), #6 (DELETE /api/stt/queue/[ticket]) and
 * #7 (POST /api/sessions/report), all authorised with the case token (DESIGN §4.3/§4.4). The `closed` report on
 * pagehide uses `fetch(…, {keepalive:true})` with the Authorization header, never `sendBeacon` (G0 decision 10).
 */
import "client-only";

import {
  SttTokenResponseSchema, type SessionReport, type SttTokenRequest, type SttTokenResponse,
} from "@/core/contracts/api";

export interface SttApi {
  token(req: SttTokenRequest): Promise<SttTokenResponse>;
  cancel(ticket: string): Promise<void>;
  report(r: SessionReport, opts?: { keepalive?: boolean }): Promise<void>;
}

export interface HttpSttApiOptions {
  caseToken: string;
  visitorToken?: string;
  fetchImpl?: typeof fetch;
  base?: string;
}

export class HttpSttApi implements SttApi {
  private readonly o: HttpSttApiOptions;
  private readonly f: typeof fetch;

  constructor(o: HttpSttApiOptions) {
    this.o = o;
    this.f = o.fetchImpl ?? fetch.bind(globalThis);
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.o.caseToken}`,
      ...(this.o.visitorToken ? { "x-baton-visitor": this.o.visitorToken } : {}),
    };
  }

  async token(req: SttTokenRequest): Promise<SttTokenResponse> {
    const res = await this.f(`${this.o.base ?? ""}/api/stt/token`, { method: "POST", headers: this.headers(), body: JSON.stringify(req) });
    const body: unknown = await res.json().catch(() => null);
    const parsed = SttTokenResponseSchema.safeParse(body);
    if (parsed.success) return parsed.data;
    // An ApiError (4xx/5xx) or an unexpected shape: the page shows the labelled cached replay, never a generic 502.
    const msg = (body as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    return { status: "denied", code: res.status === 429 ? "E_RATE_LIMITED" : "E_BUDGET", message: msg, fallback: "cached_turn_replay" };
  }

  async cancel(ticket: string): Promise<void> {
    await this.f(`${this.o.base ?? ""}/api/stt/queue/${encodeURIComponent(ticket)}`, { method: "DELETE", headers: this.headers() }).catch(() => undefined);
  }

  async report(r: SessionReport, opts: { keepalive?: boolean } = {}): Promise<void> {
    await this.f(`${this.o.base ?? ""}/api/sessions/report`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(r),
      ...(opts.keepalive ? { keepalive: true } : {}),
    }).catch(() => undefined);
  }
}
