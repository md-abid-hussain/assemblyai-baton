/**
 * The overview read model: the checklist and the meter (SAAS §8.3). WP20·1.
 *
 * The checklist is the judge path, so the property under test is honesty: an item is done **only** when a
 * signal says so, and an item whose signal does not exist yet is not done. The temptation this guards against
 * is the friendly default — ticking "Open the relay as code" because the workspace has a relay.
 */
import { describe, expect, it } from "vitest";

import { CHECKLIST_IDS } from "@/core/contracts/ext/wp20-app";
import { PLANS } from "@/core/contracts/v3/plans";
import { checklistFrom, meterFrom, type ChecklistSignals } from "@/server/read-models/overview";

const NOTHING: ChecklistSignals = {
  runs: 0,
  relayEdited: false,
  sourceStored: false,
  published: false,
  isGuest: true,
  plan: "guest",
};

const ctx = { featuredCallId: "s01_take", relayId: "rl_1" };
const byId = (s: ChecklistSignals) => new Map(checklistFrom(s, ctx).map((i) => [i.id, i]));

describe("the checklist", () => {
  it("covers exactly the eight SAAS §8.3 items, in order", () => {
    expect(checklistFrom(NOTHING, ctx).map((i) => i.id)).toEqual([...CHECKLIST_IDS]);
  });

  it("starts entirely undone for a brand-new guest workspace", () => {
    expect(checklistFrom(NOTHING, ctx).every((i) => !i.done)).toBe(true);
  });

  it("ticks an item only on its own signal", () => {
    expect(byId({ ...NOTHING, runs: 1 }).get("watch_handoff")?.done).toBe(true);
    expect(byId({ ...NOTHING, runs: 1 }).get("try_edit")?.done).toBe(false);

    expect(byId({ ...NOTHING, relayEdited: true }).get("try_edit")?.done).toBe(true);
    // Having edited a relay does NOT mean the code view was opened.
    expect(byId({ ...NOTHING, relayEdited: true }).get("open_code")?.done).toBe(false);

    expect(byId({ ...NOTHING, sourceStored: true }).get("open_code")?.done).toBe(true);
    expect(byId({ ...NOTHING, published: true }).get("publish")?.done).toBe(true);
    expect(byId({ ...NOTHING, isGuest: false }).get("create_account")?.done).toBe(true);
  });

  it("counts only a paid plan as an upgrade", () => {
    expect(byId({ ...NOTHING, plan: "free", isGuest: false }).get("upgrade")?.done).toBe(false);
    expect(byId({ ...NOTHING, plan: "pro", isGuest: false }).get("upgrade")?.done).toBe(true);
    expect(byId({ ...NOTHING, plan: "business", isGuest: false }).get("upgrade")?.done).toBe(true);
  });

  it("tells a guest why the account-only items are locked, and offers the account", () => {
    const guest = byId(NOTHING);
    for (const id of ["api_key", "webhook"] as const) {
      expect(guest.get(id)?.blockedReason).toMatch(/Create a free account/i);
    }
    const account = byId({ ...NOTHING, isGuest: false });
    expect(account.get("api_key")?.blockedReason).toBeNull();
  });

  it("deep-links every item, and never to a bare '#'", () => {
    for (const item of checklistFrom(NOTHING, ctx)) {
      expect(item.href.startsWith("/")).toBe(true);
      expect(item.href).not.toBe("#");
    }
    expect(byId(NOTHING).get("watch_handoff")?.href).toBe("/call/s01_take?express=1");
    expect(byId(NOTHING).get("open_code")?.href).toBe("/app/relays/rl_1/code");
  });

  it("still links somewhere sane when there is no featured call and no relay yet", () => {
    const items = new Map(
      checklistFrom(NOTHING, { featuredCallId: null, relayId: null }).map((i) => [i.id, i]),
    );
    expect(items.get("watch_handoff")?.href).toBe("/call");
    expect(items.get("open_code")?.href).toBe("/app/relays");
  });

  it("never marks a done item as blocked", () => {
    const all: ChecklistSignals = {
      runs: 3, relayEdited: true, sourceStored: true, published: true, isGuest: false, plan: "pro",
    };
    for (const item of checklistFrom(all, ctx)) {
      if (item.done) expect(item.blockedReason).toBeNull();
    }
  });
});

describe("the minutes meter", () => {
  it("sums the provenance split and reads its allowance from the plan", () => {
    const m = meterFrom("free", { recorded: 2.5, simulated: 1.25, published: 0 }, "2026-09");
    expect(m.usedMinutes).toBe(3.75);
    expect(m.allowanceMinutes).toBe(PLANS.free.limits.aiMinutesPerMonth);
    expect(m.period).toBe("2026-09");
  });

  it("says the numbers are derived, not billed", () => {
    expect(meterFrom("guest", { recorded: 0, simulated: 0, published: 0 }, "2026-09").basis).toBe("runs");
  });
});
