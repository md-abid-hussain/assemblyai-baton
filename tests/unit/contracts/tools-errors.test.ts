/** Tool argument/result contracts (DESIGN §5.8), error helpers (§7.4) and the shared protocol constants (§5.5.2). */
import { describe, expect, it } from "vitest";
import { AI_SETTABLE } from "../../../src/core/intents/add-driver.fields";
import {
  BatonError, ERROR_CODES, ERROR_HTTP_STATUS, INVALID_ARGS_RESULTS, TAKEOVER_TIMING, TOOL_NAMES, ToolArgsSchemas,
  ToolResultSchemas, apiError, cachedTurnIdOf, cutTurnIdOf, explorerDataPath, isBatonError, parseToolArgs,
  parseTurnId, safeParseToolArgs, sweepKeyOf, turnIdOf, vaAbsoluteCeilingMs, ApiErrorSchema,
} from "../../../src/core/contracts";

describe("tool args", () => {
  it("covers every tool name", () => {
    expect(Object.keys(ToolArgsSchemas).sort()).toEqual([...TOOL_NAMES].sort());
    expect(Object.keys(ToolResultSchemas).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("parses valid args and strips unknown keys", () => {
    expect(parseToolArgs("confirm_effective_date", { date: "2026-10-02", customer_words: "next Friday", junk: 1 })).toEqual({
      date: "2026-10-02",
      customer_words: "next Friday",
    });
    expect(parseToolArgs("send_confirmation", {})).toEqual({});
    expect(parseToolArgs("send_confirmation", { extra: true })).toEqual({});
    expect(parseToolArgs("hand_back_to_rep", { reason: "advice_requested", summary: "Asked about limits." })).toEqual({
      reason: "advice_requested",
      summary: "Asked about limits.",
    });
  });

  it("restricts update_case_field.field to AI_SETTABLE", () => {
    for (const f of AI_SETTABLE) expect(ToolArgsSchemas.update_case_field.safeParse({ field: f, value: "x", reason: "newly_provided" }).success).toBe(true);
    for (const f of ["premium_new_monthly_usd", "coverage_change", "good_student_discount", "effective_date"]) {
      expect(ToolArgsSchemas.update_case_field.safeParse({ field: f, value: "x", reason: "newly_provided" }).success).toBe(false);
    }
  });

  it("rejects bad enums and types", () => {
    expect(() => parseToolArgs("get_disclosure", { kind: "privacy" })).toThrow();
    expect(() => parseToolArgs("send_esign_and_pay_link", { customer_agreed_to_text: "yes", paper_copy_requested: false, customer_words: "ok" })).toThrow();
  });

  it("hand_back_to_rep args never fail (G0): a bad reason becomes other", () => {
    expect(parseToolArgs("hand_back_to_rep", { reason: "bored", summary: "" })).toEqual({ reason: "other", summary: "" });
    expect(parseToolArgs("hand_back_to_rep", { reason: "customer_request" })).toEqual({ reason: "customer_request", summary: "" });
    expect(parseToolArgs("hand_back_to_rep", "garbage")).toEqual({ reason: "other", summary: "" });
  });

  it("safeParseToolArgs answers invalid args with the tool's 200 rejection result (G0)", () => {
    const bad = safeParseToolArgs("update_case_field", { field: "premium_new_monthly_usd", value: "1", reason: "newly_provided" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.result).toEqual({ result: "rejected", reason: "invalid_args" });
      expect(bad.issues.join(" ")).toMatch(/field/);
    }
    const good = safeParseToolArgs("get_disclosure", { kind: "esign_consent" });
    expect(good).toEqual({ ok: true, args: { kind: "esign_consent" } });
    for (const [name, result] of Object.entries(INVALID_ARGS_RESULTS)) {
      expect(ToolResultSchemas[name as keyof typeof ToolResultSchemas].safeParse(result).success, name).toBe(true);
      expect(safeParseToolArgs(name as keyof typeof INVALID_ARGS_RESULTS, 42)).toMatchObject({ ok: false, result });
    }
  });

  it("accepts the §5.8 result shapes verbatim", () => {
    const ok: [keyof typeof ToolResultSchemas, unknown][] = [
      ["confirm_effective_date", { accepted: true, effective_date: "2026-10-02", spoken: "Friday, October 2nd", next: "disclose" }],
      ["confirm_effective_date", { accepted: false, reason: "out_of_range", allowed: "today to October 25th" }],
      ["update_case_field", { result: "accepted", field: "license_state", status: "VERIFIED", value: "WI" }],
      ["update_case_field", { result: "conflict", field: "vehicle_assignment", recorded_value: "2021 Honda Civic", instruction: "Read back the recorded value and ask which is right." }],
      ["update_case_field", { result: "rejected", reason: "unparseable" }],
      ["get_disclosure", { ok: true, disclosure_id: "dsc_1", text: "Here's the change.", instruction: "Read this exactly, then wait for the answer." }],
      ["get_disclosure", { ok: false, missing: ["license_state"] }],
      ["send_esign_and_pay_link", { status: "not_sent", reason: "consent_required" }],
      ["send_esign_and_pay_link", { status: "link_sent" }],
      ["send_esign_and_pay_link", { status: "paid", amount: "$23.40", receipt: "PAY-1", verified_by: "polar_webhook" }],
      ["send_esign_and_pay_link", { status: "timeout", instruction: "Tell the customer the link stays valid for 24 hours." }],
      ["send_confirmation", { ok: true, confirmation_number: "END-48213", spoken: "E N D 4 8 2 1 3", sms_sent: true }],
      ["send_confirmation", { ok: false, reason: "payment_not_confirmed" }],
      ["hand_back_to_rep", { status: "transferring", message: "Tell the customer Daniel is coming back on the line now." }],
    ];
    for (const [name, value] of ok) expect(ToolResultSchemas[name].safeParse(value).success, `${name} ${JSON.stringify(value)}`).toBe(true);
    expect(ToolResultSchemas.send_esign_and_pay_link.safeParse({ status: "paid", amount: 23.4 }).success).toBe(false);
  });
});

describe("errors", () => {
  it("maps every ErrorCode to an HTTP status", () => {
    for (const c of ERROR_CODES) expect(ERROR_HTTP_STATUS[c]).toBeGreaterThanOrEqual(400);
    expect(ERROR_HTTP_STATUS.E_BAD_REQUEST).toBe(400);
    expect(ERROR_HTTP_STATUS.E_FORBIDDEN).toBe(403);
    expect(ERROR_HTTP_STATUS.E_NOT_FOUND).toBe(404);
    expect(ERROR_HTTP_STATUS.E_RATE_LIMITED).toBe(429);
    expect(ERROR_HTTP_STATUS.E_BUDGET).toBe(503);
    expect(ERROR_HTTP_STATUS.E_CASE_TOKEN).toBe(401);
    expect(ERROR_HTTP_STATUS.E_CASE_STATE).toBe(409);
  });

  it("apiError builds a valid ApiError and omits absent extras", () => {
    const e = apiError("E_VA_CAPACITY", "Live AI is busy", { fallback: "recorded_ai_session" });
    expect(e).toEqual({ error: { code: "E_VA_CAPACITY", message: "Live AI is busy", fallback: "recorded_ai_session" } });
    expect(ApiErrorSchema.parse(e)).toEqual(e);
    expect(apiError("E_DB", "db")).toEqual({ error: { code: "E_DB", message: "db" } });
  });

  it("BatonError carries its code and converts to ApiError", () => {
    const err = new BatonError("E_VA_CONFIG", "hold tool in the first update", { cause: new Error("x") });
    expect(isBatonError(err)).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("E_VA_CONFIG");
    expect(err.toApiError()).toEqual({ error: { code: "E_VA_CONFIG", message: "hold tool in the first update" } });
    expect(new BatonError("E_RATE_LIMITED", "slow down", { retryAfterMs: 5000 }).toApiError().error.retryAfterMs).toBe(5000);
  });
});

describe("takeover constants and turn ids", () => {
  it("keeps the DESIGN §5.5.2 values", () => {
    expect(TAKEOVER_TIMING).toMatchObject({
      ARM_TURN_END_MAX_MS: 1500,
      QUIET_REQUIRED_MS: 400,
      SEAL_TAIL_MS: 250,
      FINALS_WAIT_MAX_MS: 900,
      DRAIN_MAX_MS: 2000,
      COMPILE_TIMEOUT_MS: 1500,
      VA_TOKEN_TIMEOUT_MS: 3000,
      VA_WS_OPEN_TIMEOUT_MS: 3000,
      SESSION_READY_TIMEOUT_MS: 3000,
      FIRST_AUDIBLE_TIMEOUT_MS: 5000,
      CLOSE_GRACE_MS: 2500,
      DEFAULT_LEAD_MS: 900,
    });
  });

  it("keeps the hold and cap constants (G0, §5.8 / §5.9.5)", () => {
    expect(TAKEOVER_TIMING).toMatchObject({
      HOLD_DEADLINE_MS: 60_000,
      HOLD_EXTEND_STEP_MS: 30_000,
      HOLD_MAX_MS: 180_000,
      REASSURE_EVERY_MS: 45_000,
      AUTOPILOT_IDLE_MS: 15_000,
      AUTOPILOT_COUNTDOWN_MS: 10_000,
      PAYMENT_POLL_MS: 1_500,
      WRAP_UP_WARNING_MS: 20_000,
    });
    expect(vaAbsoluteCeilingMs(420_000)).toBe(600_000);
  });

  it("formats turn ids", () => {
    expect(turnIdOf("rep", 13)).toBe("rep-13");
    expect(turnIdOf("customer", 4, 1)).toBe("customer-4-r1");
    expect(cachedTurnIdOf("rep", 0)).toBe("rep-c0");
    expect(cutTurnIdOf("customer", 2)).toBe("customer-cut-2");
  });

  it("keeps live, reconnect, cached and cut ids apart and parses them back (G0)", () => {
    const ids = [turnIdOf("rep", 0), turnIdOf("rep", 0, 1), turnIdOf("rep", 0, 2), cachedTurnIdOf("rep", 0), cutTurnIdOf("rep", 0)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(parseTurnId("rep-12")).toEqual({ channel: "rep", kind: "live", order: 12, generation: 0 });
    expect(parseTurnId("customer-3-r2")).toEqual({ channel: "customer", kind: "live", order: 3, generation: 2 });
    expect(parseTurnId("customer-c7")).toEqual({ channel: "customer", kind: "cached", order: 7, generation: 0 });
    expect(parseTurnId("rep-cut-1")).toEqual({ channel: "rep", kind: "cut", order: 1, generation: 0 });
    for (const bad of ["rep", "rep-", "rep-1-r0", "agent-1", "rep-c", "rep-cut-", "rep-1-r1-r2", "Rep-1"]) expect(parseTurnId(bad), bad).toBeNull();
  });

  it("names sweep configurations and explorer files (G0)", () => {
    expect(sweepKeyOf("v3", "pc_ctx")).toBe("v3.pc_ctx");
    expect(sweepKeyOf("v3", "pc_ctx", "verifier_off")).toBe("v3.pc_ctx.verifier_off");
    expect(explorerDataPath("s01_20260925T101503Z", "v1", "pc_noctx")).toBe("/data/explorer/s01_20260925T101503Z/v1.pc_noctx.json");
  });
});
