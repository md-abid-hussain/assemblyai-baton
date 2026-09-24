/**
 * DESIGN D13 / §4.1: the case schema IS the recording kit's schema. This test imports the kit module
 * (tools/recording-kit/src/scenarios.ts, read-only) and asserts that our field registry and enums equal the kit's,
 * then checks every data/scenarios/sNN.json against our contracts (read-only).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as kit from "../../../tools/recording-kit/src/scenarios.ts";
import {
  AI_SETTABLE, DISCOUNT_VALUES, FIELD_IDS, FIELD_KIND, FIELD_LABEL, FIELD_STATUSES, HANDOFF_RESPONSES, LANGUAGES,
  LICENSE_STATUSES, OPERATOR_TYPES, RELATIONS, REQUIRED_FIELDS, US_STATES, type FieldId,
} from "../../../src/core/intents/add-driver.fields";
import { FieldIdSchema, FieldStatusSchema, ToolArgsSchemas } from "../../../src/core/contracts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCENARIOS = join(ROOT, "data", "scenarios");

// Compile-time parity: the kit's FactField union is exactly our FieldId.
type Same<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const same = <T extends true>(): T | undefined => undefined;
same<Same<kit.FactField, FieldId>>();
same<Same<kit.Status, (typeof FIELD_STATUSES)[number]>>();
same<Same<kit.Relation, (typeof RELATIONS)[number]>>();

describe("field registry = recording kit", () => {
  it("FACT_FIELDS (order included)", () => {
    expect([...FIELD_IDS]).toEqual([...kit.FACT_FIELDS]);
    expect(FieldIdSchema.options).toEqual([...kit.FACT_FIELDS]);
  });
  it("REQUIRED_FIELDS", () => {
    expect([...REQUIRED_FIELDS]).toEqual([...kit.REQUIRED_FIELDS]);
    expect(REQUIRED_FIELDS).toHaveLength(10);
  });
  it("RELATIONS, LICENSE_STATUSES, OPERATOR_TYPES, DISCOUNT_VALUES, STATUSES, LANGUAGES, HANDOFF_RESPONSES, US_STATES", () => {
    expect([...RELATIONS]).toEqual([...kit.RELATIONS]);
    expect([...LICENSE_STATUSES]).toEqual([...kit.LICENSE_STATUSES]);
    expect([...OPERATOR_TYPES]).toEqual([...kit.OPERATOR_TYPES]);
    expect([...DISCOUNT_VALUES]).toEqual([...kit.DISCOUNT_VALUES]);
    expect([...FIELD_STATUSES]).toEqual([...kit.STATUSES]);
    expect(FieldStatusSchema.options).toEqual([...kit.STATUSES]);
    expect([...LANGUAGES]).toEqual([...kit.LANGUAGES]);
    expect([...HANDOFF_RESPONSES]).toEqual([...kit.HANDOFF_RESPONSES]);
    expect([...US_STATES]).toEqual([...kit.US_STATES]);
  });
  it("FIELD_KIND and FIELD_LABEL", () => {
    expect(JSON.parse(JSON.stringify(FIELD_KIND))).toEqual(JSON.parse(JSON.stringify(kit.FIELD_KIND)));
    expect({ ...FIELD_LABEL }).toEqual({ ...kit.FIELD_LABEL });
  });
  it("the update_case_field enum is AI_SETTABLE and a subset of the kit fields", () => {
    expect(ToolArgsSchemas.update_case_field.shape.field.options).toEqual([...AI_SETTABLE]);
    for (const f of AI_SETTABLE) expect(kit.FACT_FIELDS).toContain(f);
  });
});

describe("data/scenarios conform to our contracts", () => {
  const files = readdirSync(SCENARIOS).filter((f) => /^s\d{2}\.json$/.test(f)).sort();
  const shared = JSON.parse(readFileSync(join(SCENARIOS, "shared.json"), "utf8")) as { required_fields: string[]; intent: string };

  it("finds the scenario set", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(shared.intent).toBe("add_driver");
    expect(shared.required_fields).toEqual([...REQUIRED_FIELDS]);
  });

  for (const file of files) {
    it(`${file}: fact fields, required set and enum values`, () => {
      const s = JSON.parse(readFileSync(join(SCENARIOS, file), "utf8")) as kit.Scenario;
      expect(s.intent).toBe("add_driver");
      expect(LANGUAGES).toContain(s.language);
      expect(HANDOFF_RESPONSES).toContain(s.handoff.customer_response);
      const facts = s.facts as Record<string, kit.Fact>;
      for (const k of Object.keys(facts)) expect(FIELD_IDS as readonly string[]).toContain(k);
      for (const f of REQUIRED_FIELDS) expect(facts[f], `${file} ${f}`).toBeDefined();
      const vehicleIds = s.customer.vehicles.map((v) => v.id);
      for (const [name, fact] of Object.entries(facts)) {
        expect(FIELD_STATUSES).toContain(fact.status_at_handoff);
        const kind = FIELD_KIND[name as FieldId];
        const v = fact.value;
        switch (kind.t) {
          case "enum":
            expect(kind.values, `${file} ${name}`).toContain(v);
            break;
          case "state":
            expect(US_STATES as readonly string[]).toContain(v);
            break;
          case "zip":
            expect(String(v)).toMatch(/^\d{5}$/);
            break;
          case "date":
            expect(String(v)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            break;
          case "vehicle":
            expect([...vehicleIds, "all"]).toContain(v);
            break;
          case "money":
          case "signed_money":
          case "int":
            expect(typeof v).toBe("number");
            break;
          case "boolean":
            expect(typeof v).toBe("boolean");
            break;
          case "string":
            expect(typeof v).toBe("string");
            break;
        }
      }
    });
  }
});
