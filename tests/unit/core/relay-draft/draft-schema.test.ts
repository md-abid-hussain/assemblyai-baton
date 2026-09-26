/**
 * The `draft_blueprint` strict schema (PLATFORM §7.4 step 2; acceptance 6: "the sim_script and draft schemas pass
 * assertStrictSchema"). Everything here is offline and costs nothing.
 */
import { describe, expect, it } from "vitest";

import { INDUSTRIES, VA_VOICES } from "@/core/contracts/v2/blueprint";
import { assertStrictSchema, STRICT_ENUM_MAX } from "@/core/relay/extractor";
import {
  DRAFT_CONNECTOR_TYPES, DRAFT_FIELD_TYPES, DRAFT_MAX_FIELDS, DraftBlueprintSchema, draftBlueprintFormat,
} from "@/core/relay/draft/schema";
import { draftFixture } from "./helpers";

/** TASKS-v3 §2 rule 19: these words never appear in a string the product ships or sends to a model. */
const BANNED = /no-code|drag-and-drop|canvas/i;

const walk = (node: unknown, visit: (n: Record<string, unknown>) => void): void => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return void node.forEach((x) => walk(x, visit));
  visit(node as Record<string, unknown>);
  for (const v of Object.values(node)) walk(v, visit);
};

describe("draftBlueprintFormat", () => {
  const format = draftBlueprintFormat();

  it("is a legal OpenAI strict schema", () => {
    expect(() => assertStrictSchema(format)).not.toThrow();
    expect(format.name).toBe("draft_blueprint");
    expect(format.strict).toBe(true);
  });

  it("keeps every enum inside the strict-mode limit", () => {
    const sizes: number[] = [];
    walk(format.schema, (n) => {
      if (Array.isArray(n.enum)) sizes.push(n.enum.length);
    });
    expect(sizes.length).toBeGreaterThan(4);
    for (const n of sizes) expect(n).toBeLessThanOrEqual(STRICT_ENUM_MAX);
    expect(sizes).toContain(INDUSTRIES.length);
    expect(sizes).toContain(VA_VOICES.length);
    expect(sizes).toContain(DRAFT_FIELD_TYPES.length);
    expect(sizes).toContain(DRAFT_CONNECTOR_TYPES.length);
  });

it("describes every list and every top-level slot, because the descriptions are half the prompt", () => {
    const root = format.schema as { properties: Record<string, { description?: unknown }> };
    for (const [name, node] of Object.entries(root.properties)) {
      expect(typeof node.description, `meta.${name}`).toBe("string");
    }
    const lists: unknown[] = [];
    walk(format.schema, (n) => {
      if (n.type === "array") lists.push(n.description);
    });
    expect(lists.length).toBeGreaterThan(5);
    for (const d of lists) expect(typeof d).toBe("string");
  });

  it("never writes a word the product does not use (rule 19)", () => {
    expect(BANNED.test(JSON.stringify(format))).toBe(false);
  });

  it("only offers field types a drafted relay can actually normalize", () => {
    expect(DRAFT_FIELD_TYPES).not.toContain("lookup");
    expect(DRAFT_FIELD_TYPES).not.toContain("signed_money");
  });
});

describe("DraftBlueprintSchema", () => {
  it("accepts a realistic draft and keeps it byte-identical", () => {
    const d = draftFixture();
    const parsed = DraftBlueprintSchema.parse(d);
    expect(parsed).toEqual(d);
  });

  it("refuses a draft with no fields, or more than the wizard allows", () => {
    expect(DraftBlueprintSchema.safeParse(draftFixture({ fields: [] })).success).toBe(false);
    const many = Array.from({ length: DRAFT_MAX_FIELDS + 1 }, (_, i) => ({ ...draftFixture().fields[0]!, id: `f_${i}` }));
    expect(DraftBlueprintSchema.safeParse(draftFixture({ fields: many })).success).toBe(false);
  });

  it("refuses ids and slugs the blueprint schema would reject later", () => {
    const badId = draftFixture();
    badId.fields[0]!.id = "Patient Name";
    expect(DraftBlueprintSchema.safeParse(badId).success).toBe(false);
    expect(DraftBlueprintSchema.safeParse(draftFixture({ meta: { ...draftFixture().meta, slug: "Riverbend Deposit" } })).success).toBe(false);
  });
});
