import { describe, expect, it } from "vitest";
import { STAGES, TOOL_NAMES, VaFunctionToolSchema, type Stage } from "../../../../src/core/contracts";
import { checkToolSchema } from "../../../../src/core/compiler/first-update";
import { PAY_LINK_PUSH_TOOL, STAGE_TOOL_NAMES, TOOL_SCHEMAS, toolsForStage } from "../../../../src/core/compiler/tool-schemas";
import { AI_SETTABLE } from "../../../../src/core/intents/add-driver.fields";

describe("TOOL_SCHEMAS (DESIGN §5.8)", () => {
  it("one schema per tool name, each a valid VaFunctionTool using only allowed keywords", () => {
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual([...TOOL_NAMES].sort());
    for (const [name, tool] of Object.entries(TOOL_SCHEMAS)) {
      expect(tool.name).toBe(name);
      expect(VaFunctionToolSchema.parse(tool)).toEqual(tool);
      expect(() => checkToolSchema(tool.parameters, name)).not.toThrow();
      expect(JSON.stringify(tool)).not.toMatch(/"format"|"oneOf"|"anyOf"|"\$ref"/);
    }
  });

  it("exact modes, timeouts and key constraints", () => {
    expect(Object.fromEntries(Object.values(TOOL_SCHEMAS).map((t) => [t.name, `${t.execution_mode}/${t.timeout_seconds}`]))).toEqual({
      confirm_effective_date: "interactive/10",
      get_disclosure: "interactive/10",
      send_esign_and_pay_link: "hold/120",
      send_confirmation: "interactive/10",
      update_case_field: "interactive/10",
      hand_back_to_rep: "interactive/10",
    });
    const date = (TOOL_SCHEMAS.confirm_effective_date.parameters.properties as Record<string, Record<string, unknown>>).date!;
    expect(date).toEqual({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD", examples: ["2026-10-02"] });
    const field = (TOOL_SCHEMAS.update_case_field.parameters.properties as Record<string, Record<string, unknown>>).field!;
    expect(field.enum).toEqual([...AI_SETTABLE]);
    expect(TOOL_SCHEMAS.send_confirmation.parameters).toEqual({ type: "object", required: [], properties: {} });
    expect(PAY_LINK_PUSH_TOOL.execution_mode).toBe("interactive");
    expect(PAY_LINK_PUSH_TOOL.timeout_seconds).toBeLessThanOrEqual(30);
  });
});

describe("toolsForStage (§5.8 stage lists)", () => {
  it("exact lists per stage", () => {
    expect(Object.fromEntries(STAGES.map((s) => [s, toolsForStage(s).map((t) => t.name)]))).toMatchInlineSnapshot(`
      {
        "close": [
          "send_confirmation",
          "update_case_field",
          "hand_back_to_rep",
        ],
        "confirm": [
          "confirm_effective_date",
          "update_case_field",
          "hand_back_to_rep",
        ],
        "disclose": [
          "get_disclosure",
          "confirm_effective_date",
          "update_case_field",
          "hand_back_to_rep",
        ],
        "pay": [
          "send_esign_and_pay_link",
          "get_disclosure",
          "update_case_field",
          "hand_back_to_rep",
        ],
      }
    `);
  });

  it("every stage includes update_case_field and hand_back_to_rep; only pay has the hold tool", () => {
    for (const s of STAGES as readonly Stage[]) {
      const names = STAGE_TOOL_NAMES[s];
      expect(names).toContain("update_case_field");
      expect(names).toContain("hand_back_to_rep");
      const holds = toolsForStage(s).filter((t) => t.execution_mode === "hold").map((t) => t.name);
      expect(holds).toEqual(s === "pay" ? ["send_esign_and_pay_link"] : []);
    }
    expect(toolsForStage("pay", { payToolMode: "push" }).every((t) => t.execution_mode === "interactive")).toBe(true);
  });

  it("returns fresh copies", () => {
    const a = toolsForStage("confirm");
    a[0]!.description = "mutated";
    expect(toolsForStage("confirm")[0]!.description).not.toBe("mutated");
    expect(TOOL_SCHEMAS.confirm_effective_date.description).not.toBe("mutated");
  });
});
