/**
 * client/session/api.ts - the page orchestrator's HTTP calls (DESIGN §4.4 #2, #3, #5a, #5b, #20). Responses are
 * validated with the frozen zod schemas; an ApiError body becomes a thrown BatonError with its code.
 * pagehide requests use `fetch(..., { keepalive: true })` with the Authorization header, never sendBeacon (G0 #10).
 */
import "client-only";

import {
  CreateCaseResponseSchema, StatusResponseSchema, VerificationViewSchema, type CreateCaseRequest, type CreateCaseResponse,
  type StartRunRequest, type StatusResponse, type VerificationView,
} from "@/core/contracts/api";
import { ApiErrorSchema, BatonError } from "@/core/contracts/errors";
import { RunPlanSchema, type RunPlan } from "@/core/contracts/run";

export interface SessionApi {
  status(): Promise<StatusResponse | null>;
  createCase(req: CreateCaseRequest): Promise<CreateCaseResponse>;
  startRun(req: StartRunRequest, caseToken: string): Promise<RunPlan>;
  /** #5b; `keepalive` on pagehide. Never throws. */
  releaseRun(runId: string, caseToken: string, keepalive?: boolean): Promise<void>;
  verification(takeoverId: string, token: string): Promise<VerificationView>;
  peaks(url: string): Promise<unknown>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createHttpApi(o: { fetch?: FetchLike; visitorToken?: () => string | undefined } = {}): SessionApi {
  const f: FetchLike = o.fetch ?? ((i, init) => fetch(i, init));
  const headers = (token?: string): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (token) h.authorization = `Bearer ${token}`;
    const v = o.visitorToken?.();
    if (v) h["x-baton-visitor"] = v;
    return h;
  };
  async function call<T>(url: string, init: RequestInit, parse: (x: unknown) => T): Promise<T> {
    let res: Response;
    try {
      res = await f(url, init);
    } catch (e) {
      throw new BatonError("E_INTERNAL", "The network request failed. Check your connection and try again.", { cause: e });
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = ApiErrorSchema.safeParse(body);
      if (err.success) {
        throw new BatonError(err.data.error.code, err.data.error.message, {
          ...(err.data.error.fallback ? { fallback: err.data.error.fallback } : {}),
          ...(err.data.error.retryAfterMs !== undefined ? { retryAfterMs: err.data.error.retryAfterMs } : {}),
        });
      }
      throw new BatonError(res.status === 404 ? "E_NOT_FOUND" : "E_INTERNAL", `The server answered ${res.status}.`);
    }
    return parse(body);
  }
  return {
    async status() {
      try {
        return await call("/api/status", { method: "GET", headers: headers() }, (b) => StatusResponseSchema.parse(b));
      } catch {
        return null; // S1: status-unavailable → the page still works
      }
    },
    createCase: (req) => call("/api/cases", { method: "POST", headers: headers(), body: JSON.stringify(req), credentials: "same-origin" }, (b) => CreateCaseResponseSchema.parse(b)),
    startRun: (req, token) => call("/api/runs", { method: "POST", headers: headers(token), body: JSON.stringify(req), credentials: "same-origin" }, (b) => RunPlanSchema.parse(b)),
    async releaseRun(runId, token, keepalive = false) {
      try {
        await f(`/api/runs/${encodeURIComponent(runId)}/release`, { method: "POST", headers: headers(token), keepalive, credentials: "same-origin" });
      } catch {
        /* best effort: the registry sweeper frees stale holds (F5) */
      }
    },
    verification: (id, token) => call(`/api/verifications/${encodeURIComponent(id)}`, { method: "GET", headers: headers(token) }, (b) => VerificationViewSchema.parse(b)),
    peaks: (url) => call(url, { method: "GET" }, (b) => b),
  };
}
