/**
 * client/customer/autopilot.ts - WHEN the autopilot customer speaks (DESIGN §5.15 "Autopilot"). Pure: the runner in
 * customer-input.ts turns a plan into one timer and re-plans on every store change.
 *
 *   - 600 ms after a spoken reply that ENDS IN A REQUEST -> the top suggestion;
 *   - a 4 s stall timer after any other spoken reply (outside `paying`) -> the best candidate anyway;
 *   - during `pay`: one line ("Okay, I'm paying now."), never card details - the visible countdown and the
 *     simulate tap are the MockPhone's (DESIGN §5.8 step 6);
 *   - never over the agent, never twice for the same reply, off the moment the judge takes over.
 *
 * The loop breaker ("her date of birth is March 14th, 2009" after the second ask about one field) is not here: it
 * lives in `suggestReplies`, which counts the asks in the reply history. This module only decides the moment.
 */
import "client-only";

/** DESIGN §5.15: the top suggested reply auto-plays 600 ms after each agent request. */
export const AUTOPILOT_ARM_MS = 600;
/** DESIGN §5.15: no agent audio and no customer input for 4 s after a reply.done -> answer anyway. */
export const AUTOPILOT_STALL_MS = 4000;

export type AutopilotReason = "reply" | "stall" | "pay";

export interface AutopilotSnapshot {
  /** Page clock now. */
  now: number;
  /** Autopilot is on AND the AI half is live (a recorded bundle or a finished call is not). */
  live: boolean;
  /** The agent is speaking, thinking or running a tool: never talk over it (§5.10 barge-in is the mic's job). */
  agentBusy: boolean;
  /** The pay stage is open (stage `pay`, the paying phase, or a payment in flight). */
  paying: boolean;
  /** Page clock of the last COMPLETED spoken agent reply; null before the first one. */
  replyDoneAt: number | null;
  /** Page clock of the last customer clip queued by anyone (chip, typed or autopilot). */
  lastSpokeAt: number | null;
  /** The agent's last sentence is a request (the §5.13 lexicon, via `classifyAgentText`). */
  isRequest: boolean;
  /** The one pay line was already spoken for this pay stage. */
  paySpoken: boolean;
}

export interface AutopilotPlan {
  /** Page clock at which to speak (never earlier than `now`). */
  at: number;
  reason: AutopilotReason;
}

/**
 * The next thing autopilot would do, or null if it should stay quiet. Called on every store change; the runner
 * only re-arms its timer when `at`/`reason` actually move.
 */
export function planAutopilot(s: AutopilotSnapshot): AutopilotPlan | null {
  if (!s.live || s.agentBusy) return null;
  const at = (t: number, reason: AutopilotReason): AutopilotPlan => ({ at: Math.max(t, s.now), reason });

  if (s.paying) {
    // One line, once, and only after the agent has finished saying the pay instruction.
    if (s.paySpoken || s.replyDoneAt === null) return null;
    if (s.lastSpokeAt !== null && s.lastSpokeAt >= s.replyDoneAt) return null;
    return at(s.replyDoneAt + AUTOPILOT_ARM_MS, "pay");
  }
  if (s.replyDoneAt === null) return null;
  // Already answered this reply: wait for the next one.
  if (s.lastSpokeAt !== null && s.lastSpokeAt >= s.replyDoneAt) return null;
  return s.isRequest ? at(s.replyDoneAt + AUTOPILOT_ARM_MS, "reply") : at(s.replyDoneAt + AUTOPILOT_STALL_MS, "stall");
}

export const samePlan = (a: AutopilotPlan | null, b: AutopilotPlan | null): boolean =>
  a === null ? b === null : b !== null && a.at === b.at && a.reason === b.reason;
