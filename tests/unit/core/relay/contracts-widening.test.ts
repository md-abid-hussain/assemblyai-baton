/**
 * The P§4.7 contract-widening commit (WP14a·4, TASKS-v2 WP14a T4). One kernel serves every relay, so the three
 * vocabularies that used to be Baton literals - field ids, tool names and disclosure kinds - are now the platform
 * id grammar, `cases.intent` carries "relay", and `ToolOutcome` carries `nextStep`.
 *
 * Every assertion here is about the WIDENING being additive: what parsed before still parses, with the same type.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CaseStateSchema, DisclosureKindSchema, FieldIdSchema, ID_RE, ToolNameSchema, BatonToolNameSchema,
  BatonDisclosureKindSchema, DISCLOSURE_KINDS, TOOL_NAMES, parseToolArgs, safeParseToolArgs,
} from "../../../../src/core/contracts";
import type { CaseState, FieldId, ToolName, ToolOutcome } from "../../../../src/core/contracts";
import { FIELD_IDS, fieldKindOf, fieldLabelOf, type BatonFieldId } from "../../../../src/core/intents/add-driver.fields";

const ids = [FieldIdSchema, ToolNameSchema, DisclosureKindSchema] as const;

describe("P§4.7: the id grammar replaces three literal unions", () => {
  it("every Baton id still parses, under all three schemas", () => {
    for (const s of ids) {
      for (const f of FIELD_IDS) expect(s.safeParse(f).success, f).toBe(true);
      for (const t of TOOL_NAMES) expect(s.safeParse(t).success, t).toBe(true);
      for (const d of DISCLOSURE_KINDS) expect(s.safeParse(d).success, d).toBe(true);
    }
  });

  it("a relay's own ids parse; malformed ids do not", () => {
    for (const s of ids) {
      for (const ok of ["appointment_date", "book_slot", "deposit_terms", "a1", "x".repeat(40)]) {
        expect(s.safeParse(ok).success, ok).toBe(true);
      }
      for (const bad of ["", "A", "Driver_DOB", "1field", "_field", "has-dash", "has space", "x".repeat(41), "ä"]) {
        expect(s.safeParse(bad).success, bad).toBe(false);
      }
    }
  });

  it("the grammar is the one PLATFORM names, and the same source as v2's IdSchema", async () => {
    expect(ID_RE.source).toBe("^[a-z][a-z0-9_]{1,39}$");
    const { IdSchema } = await import("../../../../src/core/contracts/v2/blueprint");
    for (const x of ["appointment_date", "Driver_DOB", "a", "a1"]) {
      expect(IdSchema.safeParse(x).success, x).toBe(FieldIdSchema.safeParse(x).success);
    }
  });
});

describe("P§4.7: what stays Baton's", () => {
  it("the literal-keyed maps keep the flagship vocabulary and answer for any id", () => {
    const f: BatonFieldId = "driver_dob";
    expect(fieldLabelOf(f)).toBe("Date of birth");
    expect(fieldKindOf(f)).toEqual({ t: "date" });
    // A relay's field: the id is its own label, and it has no legacy value kind.
    expect(fieldLabelOf("appointment_date")).toBe("appointment_date");
    expect(fieldKindOf("appointment_date")).toBeNull();
  });

  it("the Baton-only schemas still reject anything outside the flagship's vocabulary", () => {
    expect(BatonToolNameSchema.safeParse("made_up_tool").success).toBe(false);
    expect(BatonToolNameSchema.safeParse("get_disclosure").success).toBe(true);
    expect(BatonDisclosureKindSchema.safeParse("deposit_terms").success).toBe(false);
    expect(BatonDisclosureKindSchema.safeParse("premium_change").success).toBe(true);
  });

  it("the six built-in tools keep their exact arg types; any other name is validated as an object", () => {
    expect(parseToolArgs("get_disclosure", { kind: "esign_consent" })).toEqual({ kind: "esign_consent" });
    expect(() => parseToolArgs("get_disclosure", { kind: "deposit_terms" })).toThrow();
    // A relay tool: `validateToolArgs(params, args)` is what checks the shape; here only "it is an object".
    const generic: ToolName = "book_slot";
    expect(parseToolArgs(generic, { day: "friday", n: 2 })).toEqual({ day: "friday", n: 2 });
    expect(() => parseToolArgs(generic, "nope")).toThrow(z.ZodError);
    expect(safeParseToolArgs(generic, 42)).toMatchObject({ ok: false, result: { ok: false, reason: "invalid_args" } });
  });
});

describe("P§4.7: the case record", () => {
  const baton = (): CaseState => ({
    caseId: "case_1", intent: "add_driver", version: 0, callClockMs: 0,
    fields: {
      driver_dob: {
        field: "driver_dob", status: "MISSING", reason: "absent", value: null, display: null,
        source: null, evidence: [], conflict: null, flags: [], updatedAtMs: 0,
      },
    },
    readiness: { verified: 0, pending: 0, missing: 1, requiredTotal: 10, ready: false },
    conflicts: [], stage: null, disclosuresGiven: [], payment: null, confirmationNumber: null,
  });

  it('carries "relay" and a relay\'s fields and disclosures', () => {
    const s = baton();
    const relay: CaseState = {
      ...s,
      intent: "relay",
      fields: { appointment_date: { ...s.fields.driver_dob!, field: "appointment_date" } },
      disclosuresGiven: ["deposit_terms"],
    };
    expect(CaseStateSchema.safeParse(relay).success).toBe(true);
    expect(CaseStateSchema.safeParse(s).success).toBe(true);
    expect(CaseStateSchema.safeParse({ ...relay, intent: "book_appointment" }).success).toBe(false);
  });

  it("a FieldId is any id, and a Baton field id is still one", () => {
    const anyField: FieldId = "appointment_date";
    const batonField: FieldId = "driver_dob";   // the union is assignable to the widened type
    expect([anyField, batonField].every((x) => FieldIdSchema.safeParse(x).success)).toBe(true);
  });
});

describe("P§4.7: ToolOutcome.nextStep", () => {
  it("is optional on the v1 outcome and required on the relay outcome", async () => {
    const withoutIt: ToolOutcome = { result: { ok: true } };
    const withIt: ToolOutcome = { result: { ok: true }, nextStep: "Take the deposit." };
    const cleared: ToolOutcome = { result: { ok: true }, nextStep: null };
    expect([withoutIt.nextStep, withIt.nextStep, cleared.nextStep]).toEqual([undefined, "Take the deposit.", null]);

    const { ToolResponseSchema } = await import("../../../../src/core/contracts/api");
    expect(ToolResponseSchema.parse({ result: {}, nextStep: "Take the deposit." }).nextStep).toBe("Take the deposit.");
    expect(ToolResponseSchema.parse({ result: {} }).nextStep).toBeUndefined();
    expect(ToolResponseSchema.safeParse({ result: {}, nextStep: 3 }).success).toBe(false);
  });
});
