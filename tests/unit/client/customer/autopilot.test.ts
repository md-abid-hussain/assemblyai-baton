/** WP11·1: WHEN the autopilot customer speaks (DESIGN §5.15 "Autopilot"). Pure, no timers. */
import { describe, expect, it } from "vitest";

import { AUTOPILOT_ARM_MS, AUTOPILOT_STALL_MS, planAutopilot, samePlan, type AutopilotSnapshot } from "@/client/customer/autopilot";

const base: AutopilotSnapshot = {
  now: 10_000,
  live: true,
  agentBusy: false,
  paying: false,
  replyDoneAt: 9_900,
  lastSpokeAt: null,
  isRequest: true,
  paySpoken: false,
};

describe("planAutopilot (DESIGN §5.15)", () => {
  it("answers 600 ms after a reply that ends in a request", () => {
    expect(planAutopilot(base)).toEqual({ at: 9_900 + AUTOPILOT_ARM_MS, reason: "reply" });
  });

  it("waits the 4 s stall timer when the reply was not a request", () => {
    expect(planAutopilot({ ...base, isRequest: false })).toEqual({ at: 9_900 + AUTOPILOT_STALL_MS, reason: "stall" });
  });

  it("never plans a moment in the past", () => {
    const p = planAutopilot({ ...base, now: 20_000 });
    expect(p).toEqual({ at: 20_000, reason: "reply" });
  });

  it("stays quiet while the agent is speaking, thinking or running a tool", () => {
    expect(planAutopilot({ ...base, agentBusy: true })).toBeNull();
  });

  it("stays quiet when autopilot is off or the AI half is not live", () => {
    expect(planAutopilot({ ...base, live: false })).toBeNull();
  });

  it("stays quiet before the first agent reply", () => {
    expect(planAutopilot({ ...base, replyDoneAt: null })).toBeNull();
  });

  it("answers each reply once: a customer line after the reply silences it until the next one", () => {
    expect(planAutopilot({ ...base, lastSpokeAt: 9_950 })).toBeNull();
    // A new reply after that line re-arms.
    expect(planAutopilot({ ...base, lastSpokeAt: 9_950, replyDoneAt: 10_100 })).toEqual({ at: 10_100 + AUTOPILOT_ARM_MS, reason: "reply" });
  });

  describe("during pay (§5.8 step 6: one line, never the card)", () => {
    const paying = { ...base, paying: true };
    it("says its one line 600 ms after the agent finishes", () => {
      expect(planAutopilot(paying)).toEqual({ at: 9_900 + AUTOPILOT_ARM_MS, reason: "pay" });
    });
    it("says it once", () => {
      expect(planAutopilot({ ...paying, paySpoken: true })).toBeNull();
    });
    it("does not fall back to the stall timer while paying", () => {
      expect(planAutopilot({ ...paying, isRequest: false, paySpoken: true })).toBeNull();
    });
  });

  it("samePlan compares the moment and the reason", () => {
    expect(samePlan(null, null)).toBe(true);
    expect(samePlan({ at: 1, reason: "reply" }, { at: 1, reason: "reply" })).toBe(true);
    expect(samePlan({ at: 1, reason: "reply" }, { at: 1, reason: "stall" })).toBe(false);
    expect(samePlan({ at: 1, reason: "reply" }, null)).toBe(false);
  });
});
