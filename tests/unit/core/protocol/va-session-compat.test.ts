/**
 * Type-level contract between WP5's controller ports and WP5b's Voice Agent controller (merged at G1): the page passes
 * `createVoiceAgentController(...)` straight to `createVa`, with no adapter. `tsc` (npm run typecheck) is the check;
 * the runtime assertions only keep vitest from reporting an empty file.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import type { VaSession, VaSessionEvent } from "../../../../src/client/takeover/ports";
import type { VoiceAgentControllerImpl } from "../../../../src/client/va/controller";
import type { VaControllerEvent } from "../../../../src/core/contracts/ext/wp5b-va";

describe("WP5b VoiceAgentControllerImpl as a WP5 VaSession", () => {
  it("satisfies the VaSession port", () => {
    expectTypeOf<VoiceAgentControllerImpl>().toMatchTypeOf<VaSession>();
    const asSession = (v: VoiceAgentControllerImpl): VaSession => v;
    expect(typeof asSession).toBe("function");
  });

  it("every WP5b event is a VaSessionEvent", () => {
    expectTypeOf<VaControllerEvent>().toMatchTypeOf<VaSessionEvent>();
    const widen = (e: VaControllerEvent): VaSessionEvent => e;
    expect(widen({ type: "close_ready" })).toEqual({ type: "close_ready" });
  });
});
