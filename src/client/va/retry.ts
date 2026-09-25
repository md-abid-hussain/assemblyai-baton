/**
 * client/va/retry.ts - GREETING-phase retry of the Voice Agent (DESIGN §5.5.3 RETRYING, §5.9.6, §9.2 "VA retry").
 * WP5's TakeoverController owns the phase machine; this helper runs the part that touches the Voice Agent so the
 * rule lives in one place:
 *
 *   attempt 0: connect(token₀) (possibly pre-opened at ARMED) → start(compiled)
 *   failure before the first audible chunk PLAYED (retryable session.error, E_VA_AUTH, socket close, ready timeout,
 *   or no audible within FIRST_AUDIBLE_TIMEOUT_MS of max(ready, holdUntil)):
 *     abort the old socket (session.end if ready) → reportFailure(code) (POST /events {failure}) →
 *     mintToken(1) (POST /api/va/token {attempt:1}; the server releases the failed slot FIRST) →
 *     new controller → connect → start(the SAME compiled config)
 *   a second failure, or a non-retryable one (E_VA_CONFIG, E_AAI_BALANCE, budget/capacity refusals of the mint)
 *   → throws VaStartFailed (the owner goes to FALLBACK: recorded AI session, or FAILED).
 */
import "client-only";

import { BatonError, type ErrorCode } from "@/core/contracts/errors";
import type { VaControllerEvent } from "@/core/contracts/ext/wp5b-va";
import { TAKEOVER_TIMING, type CompiledTakeover } from "@/core/contracts/takeover";

import type { VoiceAgentControllerImpl } from "./controller";

export class VaStartFailed extends BatonError {
  readonly attempts: number;
  constructor(code: ErrorCode, message: string, attempts: number, cause?: unknown) {
    super(code, message, { fallback: "recorded_ai_session", ...(cause !== undefined ? { cause } : {}) });
    this.name = "VaStartFailed";
    this.attempts = attempts;
  }
}

export interface StartWithRetryOptions {
  compiled: CompiledTakeover;
  holdAudioUntilCtxMs: number;
  /** POST /api/va/token {takeoverId, attempt}. Attempt 1 must release the failed slot before acquiring (server side). */
  mintToken: (attempt: 0 | 1) => Promise<{ token: string; liveSessionId: string }>;
  makeController: (attempt: 0 | 1) => VoiceAgentControllerImpl;
  /** POST /api/takeovers/[id]/events {failure:{code}} (sets last_failure_at). */
  reportFailure: (code: ErrorCode) => Promise<void>;
  /** WS pre-opened at ARMED with token₀ (T-D1-3 part A): skips attempt 0's mint + connect. */
  preopened?: VoiceAgentControllerImpl;
  now: () => number;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  onAttempt?: (attempt: 0 | 1, controller: VoiceAgentControllerImpl) => void;
}

const NON_RETRYABLE: ReadonlySet<ErrorCode> = new Set(["E_VA_CONFIG", "E_AAI_BALANCE", "E_BUDGET", "E_MODE_REPLAY_ONLY", "E_VA_CAPACITY", "E_RATE_LIMITED"]);

/**
 * Resolves once the greeting's first audible chunk has PLAYED, with the live controller. Rejects with VaStartFailed.
 * After this resolves, later failures are the owner's (retry is only for the GREETING phase).
 */
export async function startVoiceAgentWithRetry(o: StartWithRetryOptions): Promise<{ controller: VoiceAgentControllerImpl; sessionId: string; attempt: 0 | 1 }> {
  const timers = o.timers ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  let lastCode: ErrorCode = "E_VA_TRANSIENT";
  let lastErr: unknown;
  for (const attempt of [0, 1] as const) {
    let ctl: VoiceAgentControllerImpl | null = null;
    try {
      if (attempt === 0 && o.preopened) ctl = o.preopened;
      else {
        const { token } = await o.mintToken(attempt);
        ctl = o.makeController(attempt);
        o.onAttempt?.(attempt, ctl);
        await ctl.connect(token);
      }
      if (attempt === 0 && o.preopened) o.onAttempt?.(0, ctl);
      const c = ctl;
      // listen for failures from the moment the first update goes out until the first audible chunk plays
      const outcome = new Promise<{ ok: true } | { ok: false; code: ErrorCode; message: string; retryable: boolean }>((resolve) => {
        let timer: unknown = null;
        const off = c.onEvent((e: VaControllerEvent) => {
          if (e.type === "ready") {
            const base = Math.max(o.now(), o.holdAudioUntilCtxMs);
            timer = timers.setTimeout(() => {
              off();
              resolve({ ok: false, code: "E_VA_TIMEOUT", message: "no audible greeting within 5 s", retryable: true });
            }, base - o.now() + TAKEOVER_TIMING.FIRST_AUDIBLE_TIMEOUT_MS);
          } else if (e.type === "first_audible") {
            if (timer !== null) timers.clearTimeout(timer);
            off();
            resolve({ ok: true });
          } else if (e.type === "error") {
            if (timer !== null) timers.clearTimeout(timer);
            off();
            resolve({ ok: false, code: e.code, message: e.message, retryable: e.retryable });
          }
        });
      });
      const started = c.start(o.compiled, { holdAudioUntilCtxMs: o.holdAudioUntilCtxMs }).catch(() => undefined);
      const r = await outcome;
      await started;
      if (r.ok) return { controller: c, sessionId: c.sessionId ?? "", attempt };
      lastCode = r.code;
      lastErr = new BatonError(r.code, r.message);
      if (!r.retryable || NON_RETRYABLE.has(r.code)) throw new VaStartFailed(r.code, r.message, attempt + 1);
    } catch (e) {
      if (e instanceof VaStartFailed) {
        if (ctl) await ctl.end("failed").catch(() => undefined);
        throw e;
      }
      lastErr = e;
      lastCode = e instanceof BatonError ? e.code : "E_VA_TRANSIENT";
      if (NON_RETRYABLE.has(lastCode)) {
        if (ctl) await ctl.end("failed").catch(() => undefined);
        throw new VaStartFailed(lastCode, e instanceof Error ? e.message : String(e), attempt + 1, e);
      }
    }
    // abort the old socket (session.end if it was ready), record the failure, then retry once
    if (ctl) await ctl.end("retry").catch(() => undefined);
    await o.reportFailure(lastCode).catch(() => undefined);
  }
  throw new VaStartFailed(lastCode, lastErr instanceof Error ? lastErr.message : String(lastErr), 2, lastErr);
}
