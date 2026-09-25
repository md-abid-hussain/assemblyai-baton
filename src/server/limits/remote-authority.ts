import "server-only";

import { LimitsRoutes, type LimitsRouteName, type SessionReport } from "../../core/contracts/api";
import type { AppFlags, LimitsAuthority, SlotResult, SpendLedger } from "../../core/contracts/services";

/**
 * RemoteLimitsAuthority: the HTTP client of route #28 (`POST {LIMITS_AUTHORITY_URL}/api/internal/limits/<op>` with
 * `x-limits-key`), used by every opener that is not the Zerops app: local `next dev`, scripts, integration tests,
 * synthetic checks elsewhere, the Vercel mirror (DESIGN §2.3). Same zod schemas as the in-process calls
 * (`LimitsRoutes` in contracts/api.ts): requests are validated before sending, responses after receiving.
 *
 * Unreachable authority (network error, timeout or 5xx): if a `fallback` authority is given (the split budget of
 * DESIGN §2.3: 2 opens/min and 1 VA session, locally guarded), that call goes to it and a warning is logged;
 * otherwise the error propagates. 4xx answers (bad key, bad request) never fall back: they are bugs.
 *
 * Deliberately free of `env()` and of the database: Node scripts import it (scripts/lib/remote.ts registers it with
 * `registerRemoteAuthorityFactory`; scripts run with `tsx --conditions=react-server`, which resolves `server-only` to
 * its empty module). Never logs the key.
 */

export class LimitsHttpError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`[limits] ${op} → HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "LimitsHttpError";
  }
}

export interface RemoteAuthorityOptions {
  fetchImpl?: typeof fetch;
  /** Per-request timeout (default 5 s). */
  timeoutMs?: number;
  /** Used when the authority is unreachable (split budget). */
  fallback?: LimitsAuthority;
  onWarn?: (msg: string, data?: Record<string, unknown>) => void;
}

const defaultWarn = (msg: string, data?: Record<string, unknown>): void => {
  console.warn(JSON.stringify({ t: new Date().toISOString(), level: "warn", component: "limits-remote", msg, ...(data ?? {}) }));
};

export class RemoteLimitsAuthority implements LimitsAuthority {
  readonly ledger: SpendLedger;
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private lastWarnAt = 0;

  constructor(
    url: string,
    private readonly key: string,
    private readonly opts: RemoteAuthorityOptions = {},
  ) {
    if (!url) throw new Error("RemoteLimitsAuthority: url is required");
    if (!key) throw new Error("RemoteLimitsAuthority: key is required (value never printed)");
    this.base = url.replace(/\/+$/, "");
    this.f = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    const self = this;
    this.ledger = {
      reserve: (e) => self.call("reserve", e, (fb) => fb.ledger.reserve(e)),
      settle: async (id, actualUsd) => {
        await self.call("settle", { id, actualUsd }, (fb) => fb.ledger.settle(id, actualUsd).then(() => ({ ok: true as const })));
      },
      release: async (id) => {
        await self.call("release", { id }, (fb) => fb.ledger.release(id).then(() => ({ ok: true as const })));
      },
      summary: () => self.call("summary", {}, (fb) => fb.ledger.summary()),
    };
  }

  private warn(msg: string, data?: Record<string, unknown>): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 60_000) return;
    this.lastWarnAt = now;
    (this.opts.onWarn ?? defaultWarn)(msg, data);
  }

  /** POST one op; validate both directions with the contract schemas. */
  async call<N extends LimitsRouteName>(
    op: N,
    body: unknown,
    fallback?: (fb: LimitsAuthority) => Promise<unknown>,
  ): Promise<ReturnType<(typeof LimitsRoutes)[N]["response"]["parse"]>> {
    const spec = LimitsRoutes[op];
    const req = spec.request.parse(body);
    let res: Response;
    try {
      res = await this.f(`${this.base}/api/internal/limits/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-limits-key": this.key },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return this.fallBack(op, fallback, e instanceof Error ? e.message : String(e));
    }
    const text = await res.text();
    if (res.status >= 500) return this.fallBack(op, fallback, `HTTP ${res.status}`, new LimitsHttpError(op, res.status, text));
    if (!res.ok) throw new LimitsHttpError(op, res.status, text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LimitsHttpError(op, res.status, `non-JSON response: ${text.slice(0, 100)}`);
    }
    return spec.response.parse(parsed) as ReturnType<(typeof LimitsRoutes)[N]["response"]["parse"]>;
  }

  private async fallBack<T>(op: string, fallback: ((fb: LimitsAuthority) => Promise<unknown>) | undefined, why: string, err?: Error): Promise<T> {
    if (fallback && this.opts.fallback) {
      this.warn("limits authority unreachable: using the local split budget", { op, why });
      return (await fallback(this.opts.fallback)) as T;
    }
    throw err ?? new Error(`[limits] ${op}: authority unreachable (${why})`);
  }

  async sttAcquire(req: Parameters<LimitsAuthority["sttAcquire"]>[0]): Promise<SlotResult> {
    return this.call("stt-acquire", req, (fb) => fb.sttAcquire(req));
  }

  async sttCancel(ticket: string): Promise<void> {
    await this.call("stt-cancel", { ticket }, (fb) => fb.sttCancel(ticket).then(() => ({ ok: true })));
  }

  async vaHold(req: Parameters<LimitsAuthority["vaHold"]>[0]): ReturnType<LimitsAuthority["vaHold"]> {
    return this.call("va-hold", req, (fb) => fb.vaHold(req));
  }

  async vaAcquire(req: Parameters<LimitsAuthority["vaAcquire"]>[0]): ReturnType<LimitsAuthority["vaAcquire"]> {
    return this.call("va-acquire", req, (fb) => fb.vaAcquire(req));
  }

  async release(liveSessionIdOrHoldId: string, reason: string): Promise<void> {
    await this.call("va-release", { id: liveSessionIdOrHoldId, reason }, (fb) => fb.release(liveSessionIdOrHoldId, reason).then(() => ({ ok: true })));
  }

  async heartbeat(liveSessionId: string): Promise<void> {
    await this.call("heartbeat", { liveSessionId }, (fb) => fb.heartbeat(liveSessionId).then(() => ({ ok: true })));
  }

  async report(r: SessionReport): Promise<void> {
    await this.call("report", r, (fb) => fb.report(r).then(() => ({ ok: true })));
  }

  async flags(): Promise<AppFlags> {
    return this.call("flags", {}, (fb) => fb.flags());
  }
}
