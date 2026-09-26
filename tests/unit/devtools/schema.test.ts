/**
 * The published JSON Schema and the examples (SAAS §5.4, WP23·1 acceptance 1-2).
 *
 * `public/schemas/blueprint-2.0.json` is committed and served, so an editor can validate a blueprint offline. Two
 * things must therefore stay true on every commit: the file is exactly what `BlueprintSchema` generates today (the
 * drift test), and the schema and zod agree about a valid file - checked by validating every gallery blueprint and
 * every committed example with ajv AND with zod.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import AjvModule from "ajv/dist/2020";
import { describe, expect, it } from "vitest";

import { BlueprintSchema } from "@/core/contracts/v2/blueprint";
import { validateSource } from "@/core/relay-code";
import {
  PRODUCTION_APP_URL, SCHEMA_FILE, VALUE_REF_DEF, buildWithCoverage, renderSchemaFile,
} from "../../../scripts/devtools/gen-json-schema";
import { EXAMPLES_DIR, GALLERY_DIR, exampleNameFor, galleryFiles, renderExample } from "../../../scripts/devtools/gen-examples";
import { REGEX_NOTE, SCHEMA_DOCS } from "../../../scripts/devtools/schema-docs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8");
const committed = (): Record<string, unknown> => JSON.parse(read(SCHEMA_FILE));

/** ajv ships CJS; under both interop styles this is the constructor. */
const Ajv = ((AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule) as unknown as typeof AjvModule;

function validator(): (value: unknown) => { ok: boolean; errors: string } {
  const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false });
  ajv.addKeyword("x-blueprint-schema");
  const validate = ajv.compile(committed());
  return (value: unknown) => ({
    ok: validate(value) === true,
    errors: (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join("; "),
  });
}

describe("the committed JSON Schema", () => {
  it("has not drifted from BlueprintSchema (regenerate with: npx tsx scripts/devtools/gen-json-schema.ts)", () => {
    expect(read(SCHEMA_FILE)).toBe(renderSchemaFile());
  });

  it("is a draft 2020-12 schema identified by the production URL", () => {
    const schema = committed();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe(`${PRODUCTION_APP_URL}/schemas/blueprint-2.0.json`);
    expect(schema["x-blueprint-schema"]).toBe("changeover.blueprint/2.0");
    expect(schema.title).toContain("blueprint");
    expect(renderSchemaFile("https://other.example.test").includes("https://other.example.test/schemas/blueprint-2.0.json")).toBe(true);
  });

  it("compiles under ajv in strict mode, with no zod-only keyword left in it", () => {
    expect(() => validator()).not.toThrow();
    expect(read(SCHEMA_FILE)).not.toContain('"format": "starts_with"');
    expect(read(SCHEMA_FILE)).not.toContain("__schema0");
  });

  it("allows the `$schema` header key and names the recursive value reference", () => {
    const schema = committed();
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.$schema?.type).toBe("string");
    expect(Object.keys(schema.$defs as object)).toContain(VALUE_REF_DEF);
    expect(JSON.stringify(schema)).toContain(`#/$defs/${VALUE_REF_DEF}`);
  });

  it("states the safe-regex rule on every blueprint regex, and documents the sections", () => {
    const schema = committed();
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const compliance = properties.compliance!.properties as Record<string, Record<string, unknown>>;
    expect(compliance.recordingNoticePattern!.description).toContain(REGEX_NOTE);
    const fieldProps = ((properties.fields!.items as Record<string, unknown>).properties) as Record<string, Record<string, unknown>>;
    expect((fieldProps.validation!.properties as Record<string, Record<string, unknown>>).pattern!.description).toContain(REGEX_NOTE);
    expect(fieldProps.id!.description).toBe(SCHEMA_DOCS["fields[].id"]);
    expect(properties.meta!.description).toBe(SCHEMA_DOCS.meta);
  });

  it("uses every description in schema-docs.ts (a renamed key cannot leave a stale one behind)", () => {
    const { applied } = buildWithCoverage();
    expect([...Object.keys(SCHEMA_DOCS)].filter((path) => !applied.has(path))).toEqual([]);
  });
});

describe("gallery blueprints and examples", () => {
  const validate = validator();

  it.each(galleryFiles(ROOT))("%s validates with ajv and with zod", (name) => {
    const json = JSON.parse(read(GALLERY_DIR, name));
    const result = validate(json);
    expect(result.ok, result.errors).toBe(true);
    expect(BlueprintSchema.safeParse(json).success).toBe(true);
  });

  it("rejects a blueprint that zod also rejects, at the same place", () => {
    const json = JSON.parse(read(GALLERY_DIR, galleryFiles(ROOT)[0]!)) as Record<string, unknown>;
    (json.meta as Record<string, unknown>).slug = "NOT A SLUG";
    const result = validate(json);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("/meta/slug");
    expect(BlueprintSchema.safeParse(json).success).toBe(false);
  });

  it("accepts the `$schema` header key that an editor adds", () => {
    const json = { $schema: `${PRODUCTION_APP_URL}/schemas/blueprint-2.0.json`, ...JSON.parse(read(GALLERY_DIR, galleryFiles(ROOT)[0]!)) };
    expect(validate(json).ok).toBe(true);
  });

  it("has a committed example for the flagship, and no example has drifted", () => {
    const dir = join(ROOT, EXAMPLES_DIR);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toContain("baton-add-driver.yaml");
    for (const name of galleryFiles(ROOT)) {
      const example = join(dir, exampleNameFor(name));
      if (!existsSync(example)) continue;   // WP17's dental JSON lands before its example does
      expect(readFileSync(example, "utf8"), exampleNameFor(name)).toBe(renderExample(JSON.parse(read(GALLERY_DIR, name))));
    }
  });

  it.each(readdirSync(join(ROOT, EXAMPLES_DIR)))("the example %s validates with the codec, with ajv and with zod", (name) => {
    const text = read(EXAMPLES_DIR, name);
    expect(text.startsWith("# yaml-language-server: $schema=")).toBe(true);
    expect(text).toContain(`${PRODUCTION_APP_URL}/schemas/blueprint-2.0.json`);
    const result = validateSource(text);
    expect(result.diagnostics).toEqual([]);
    const blueprint = result.blueprint;
    expect(blueprint).not.toBeNull();
    const checked = validate(JSON.parse(JSON.stringify(blueprint)));
    expect(checked.ok, checked.errors).toBe(true);
  });
});
