/**
 * client/session/api.ts - the page orchestrator's HTTP calls (DESIGN §4.4 #2, #3, #5a, #5b, #20). Responses are
 * validated with the frozen zod schemas; an ApiError body becomes a thrown BatonError with its code.
 * pagehide requests use `fetch(..., { keepalive: true })` with the Authorization header, never sendBeacon (G0 #10).
 */
import "client-only";

import { z } from "zod";

import {
  CreateCaseResponseSchema, StatusResponseSchema, VerificationViewSchema, type CreateCaseResponse,
  type StartRunRequest, type StatusResponse, type VerificationView,
} from "@/core/contracts/api";
import { ApiErrorSchema, BatonError } from "@/core/contracts/errors";
import { RunPlanSchema, type RunPlan } from "@/core/contracts/run";
import { CreateCaseResponseV2Schema, type CreateCaseRequestV2, type CreateCaseResponseV2 } from "@/core/contracts/v2/api";

/**
 * A relay other than the flagship carries a **widened** case state: its own field ids, and `intent` from its own
 * blueprint. `CaseStateSchema` is frozen Baton-shaped (an `add_driver` literal and an exhaustive record over the 21
 * Baton field ids), so such a state cannot parse with it and never will until the P§4.7 widening.
 *
 * The console therefore validates the whole response strictly **except** the case state, which it takes as the
 * server sent it: the server is the authority on a case, and a field the console does not understand simply renders
 * as "—" rather than failing the page. Every other field — the tokens, the relay spec, the provenance, the run —
 * still goes through the frozen schemas.
 */
export const WidenedCreateCaseResponseSchema = CreateCaseResponseV2Schema.omit({ state: true }).extend({
  state: z.looseObject({ caseId: z.string(), fields: z.record(z.string(), z.unknown()) }),
});

/**
 * A case as the console needs it: the frozen #3 response, plus the v2 fields (`relay`, `provenance`, `listening`,
 * `account`) when the server is new enough to send them. A v1 server simply leaves them null and the console falls
 * back to the flagship spec, so `/call` keeps working against either.
 */
export type CreatedCase = CreateCaseResponse & Partial<Omit<CreateCaseResponseV2, keyof CreateCaseResponse>>;

export interface SessionApi {
  status(): Promise<StatusResponse | null>;
  createCase(req: CreateCaseRequestV2): Promise<CreatedCase>;
  startRun(req: StartRunRequest, caseToken: string): Promise<RunPlan>;
  /** #5b; `keepalive` on pagehide. Never throws. */
  releaseRun(runId: string, caseToken: string, keepalive?: boolean): Promise<void>;
  verification(takeoverId: string, token: string): Promise<VerificationView>;
  /** A public JSON asset (peaks, cached turns); null on any failure (the page degrades, never breaks). */
  getJson(url: string): Promise<unknown>;
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
    createCase: (req) =>
      call("/api/cases", { method: "POST", headers: headers(), body: JSON.stringify(req), credentials: "same-origin" }, (b) => {
        // The v2 fields are additive: take them when they are all there, else the frozen v1 shape, else a relay
        // whose case state is widened (above). Each step validates everything the step before it did.
        const v2 = CreateCaseResponseV2Schema.safeParse(b);
        if (v2.success) return v2.data as CreatedCase;
        const v1 = CreateCaseResponseSchema.safeParse(b);
        if (v1.success) return v1.data as CreatedCase;
        return WidenedCreateCaseResponseSchema.parse(b) as unknown as CreatedCase;
      }),
    startRun: (req, token) => call("/api/runs", { method: "POST", headers: headers(token), body: JSON.stringify(req), credentials: "same-origin" }, (b) => RunPlanSchema.parse(b)),
    async releaseRun(runId, token, keepalive = false) {
      try {
        await f(`/api/runs/${encodeURIComponent(runId)}/release`, { method: "POST", headers: headers(token), keepalive, credentials: "same-origin" });
      } catch {
        /* best effort: the registry sweeper frees stale holds (F5) */
      }
    },
    verification: (id, token) => call(`/api/verifications/${encodeURIComponent(id)}`, { method: "GET", headers: headers(token) }, (b) => VerificationViewSchema.parse(b)),
    async getJson(url) {
      try {
        const res = await f(url, { method: "GET" });
        return res.ok ? ((await res.json()) as unknown) : null;
      } catch {
        return null;
      }
    },
  };
}
