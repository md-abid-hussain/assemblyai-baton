/**
 * contracts/ext/wp5-takeover.ts - additive types for the takeover controller (WP5; TASKS §0.2 "missing types go in
 * ext/"). TYPES ONLY. The frozen seam `TakeoverController` stays in services.ts; this extends it with what WP7 (the
 * call console and protocol stepper) and WP4 (the STT manager's `late` flag) need.
 */
import type { Channel } from "../case";
import type { ErrorCode } from "../errors";
import type { TakeoverPhase } from "../events";
import type { TakeoverController } from "../services";
import type { TakeoverOutcome, TakeoverSource } from "../takeover";

/** What the UI shows about the current pass (a read-only projection of the protocol machine). */
export interface TakeoverClientView {
  phase: TakeoverPhase;
  manualPassAllowed: boolean;
  /** Passes armed on this page (≤ MAX_TAKEOVERS_PER_CASE). */
  passes: number;
  lastOutcome: TakeoverOutcome | null;
  pass: {
    source: TakeoverSource;
    takeoverId: string | null;
    tArmMs: number;
    tCutMs: number | null;
    midUtterance: boolean;
    capHit: boolean;
    speakingCh: Channel | null;
    /** 0 or 1 (RETRYING used the one retry). */
    attempt: 0 | 1;
    compiledBy: "server" | "client" | null;
    leadMs: number;
    /** AssemblyAI Voice Agent session id, once ready. */
    vaSessionId: string | null;
    /** ms since the click, per protocol step (armed, sealed, finals, drained, compiled, sessionUpdateSent, …). */
    timings: Record<string, number>;
  } | null;
  /** The last user-facing notice (e.g. "the AI half could not start"), or null. */
  notice: { level: "info" | "error"; code: ErrorCode | null; message: string } | null;
  /** From POST /end (WP8's verification job), once known. */
  verificationJobId: string | null;
}

export interface TakeoverControllerExt extends TakeoverController {
  view(): TakeoverClientView;
  /** Called on every change of `view()` (phase, timings, notice). */
  subscribe(cb: () => void): () => void;
  /** The judge's "End call" during the AI half (outcome `abandoned`). `abort(reason)` does the same. */
  endCall(reason: string): void;
  /** Every STT final (WP4 `stt.final`): the machine marks the in-progress turn `cut` when the 1.5 s cap forced the seal. */
  noteFinal(turn: { turnId: string; channel: Channel; startMs: number; endMs: number }): void;
  /** WP4's `SttManagerOptions.takeover` (the `late` flag, DESIGN §5.1.7). */
  armInfo(): { armed: boolean; tArmMs: number | null };
  /** Detach every listener and timer (page unmount). Does not end anything: use pagehide semantics for that. */
  dispose(): void;
}
