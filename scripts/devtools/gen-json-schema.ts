/**
 * devtools/gen-json-schema.ts - generate `public/schemas/blueprint-2.0.json` from `BlueprintSchema` (SAAS §5.4).
 * WP23.
 *
 *   npx tsx scripts/devtools/gen-json-schema.ts           # write the file
 *   npx tsx scripts/devtools/gen-json-schema.ts --check    # exit 1 if the committed file has drifted
 *
 * The file is committed, served at `/schemas/blueprint-2.0.json`, returned by `GET /api/v1/schemas/blueprint`, and
 * pointed at by the `# yaml-language-server: $schema=…` header of every example - so VS Code (with the Red Hat YAML
 * extension) completes and validates a blueprint offline. `tests/unit/devtools/schema.test.ts` regenerates it and
 * compares, and also validates every gallery blueprint against it with ajv AND with zod, so the two can never
 * disagree about a valid file.
 *
 * The zod shapes carry no descriptions (contracts/v2/blueprint.ts is a verbatim copy of PLATFORM §3.2), so the
 * hover text comes from ./schema-docs.ts, and the safe-regex note is attached by IDENTITY: the walker knows a
 * property is a blueprint regex because its schema is the very `RegexSchema` object, not because of its name.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  BLUEPRINT_SCHEMA, BlueprintSchema, RegexSchema, TemplateSchema, ToolPatternSchema,
} from "../../src/core/contracts/v2/blueprint";
import { childSchema, unwrap } from "../../src/core/relay-code/order";
import {
  REGEX_NOTE, ROOT_DESCRIPTION, ROOT_TITLE, SCHEMA_DOCS, SCHEMA_KEY_DESCRIPTION, TEMPLATE_NOTE,
} from "./schema-docs";

/** The deployed app (`APP_URL`); the COMMITTED file always carries this one (SAAS §5.4). */
export const PRODUCTION_APP_URL = "https://app-2b25-3000.prg1.zerops.app";
/** Where the generated file lives, relative to the repository root. */
export const SCHEMA_FILE = "public/schemas/blueprint-2.0.json";
/** The `$defs` name given to the one recursive schema (`ValueRefSchema` is a `z.lazy`). */
export const VALUE_REF_DEF = "ValueRef";

type JsonNode = Record<string, unknown>;
type AnySchema = z.ZodType;

const isNode = (value: unknown): value is JsonNode => value !== null && typeof value === "object" && !Array.isArray(value);
const unionOptions = (schema: AnySchema): AnySchema[] =>
  ((schema as unknown as { options?: AnySchema[] }).options ?? []) as AnySchema[];

const withNote = (description: unknown, note: string): string =>
  typeof description === "string" && description.length > 0 ? `${description} ${note}` : note;

/** Walk the JSON Schema and the zod tree together, adding hover text. */
function annotate(node: unknown, schema: AnySchema | null, path: string, applied: Set<string>): void {
  if (!isNode(node)) return;
  const documented = SCHEMA_DOCS[path];
  if (documented !== undefined) {
    node.description = documented;
    applied.add(path);
  }
  const resolved = schema ? unwrap(schema) : null;
  if (resolved === RegexSchema || resolved === ToolPatternSchema) node.description = withNote(node.description, REGEX_NOTE);
  else if (resolved === TemplateSchema) node.description = withNote(node.description, TEMPLATE_NOTE);

  // A union is `anyOf`, a DISCRIMINATED union is `oneOf`; both list their options in the zod declaration order,
  // so a documented path like "connectors[].url" reaches every option that has that property.
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    const options = resolved ? unionOptions(resolved) : [];
    branches.forEach((option, index) => annotate(option, options[index] ?? null, path, applied));
  }
  if (isNode(node.properties)) {
    for (const [key, child] of Object.entries(node.properties)) {
      if (path === "" && key === "$schema") continue;
      annotate(child, resolved ? childSchema(resolved, key, {}) : null, path === "" ? key : `${path}.${key}`, applied);
    }
  }
  if (isNode(node.items)) annotate(node.items, resolved ? childSchema(resolved, 0, []) : null, `${path}[]`, applied);
  if (isNode(node.additionalProperties)) {
    annotate(node.additionalProperties, resolved ? childSchema(resolved, "*", {}) : null, `${path}{}`, applied);
  }
  if (Array.isArray(node.prefixItems)) {
    node.prefixItems.forEach((item, index) => annotate(item, resolved ? childSchema(resolved, index, []) : null, `${path}[]`, applied));
  }
}

/**
 * zod writes its own marker into `format` for `.startsWith()` / `.endsWith()` / `.includes()`. No validator knows
 * those names (ajv in strict mode rejects them), and the `pattern` beside them already carries the rule, so drop them.
 */
const ZOD_ONLY_FORMATS = new Set(["starts_with", "ends_with", "includes"]);
function dropNonStandardFormats(node: unknown): void {
  if (Array.isArray(node)) { node.forEach(dropNonStandardFormats); return; }
  if (!isNode(node)) return;
  if (typeof node.format === "string" && ZOD_ONLY_FORMATS.has(node.format)) delete node.format;
  for (const value of Object.values(node)) dropNonStandardFormats(value);
}

/** Rename zod's generated `$defs` keys (`__schema0`) to stable names, and rewrite every `$ref` to them. */
function renameDefs(schema: JsonNode): void {
  const defs = schema.$defs;
  if (!isNode(defs)) return;
  const generated = Object.keys(defs).filter((name) => /^__schema\d+$/.test(name)).sort();
  if (generated.length === 0) return;
  const renamed: Record<string, string> = {};
  generated.forEach((name, index) => { renamed[name] = index === 0 ? VALUE_REF_DEF : `Def${index + 1}`; });

  const next: JsonNode = {};
  for (const [name, value] of Object.entries(defs)) next[renamed[name] ?? name] = value;
  schema.$defs = next;

  const rewrite = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(rewrite); return; }
    if (!isNode(node)) return;
    if (typeof node.$ref === "string") {
      const name = node.$ref.replace("#/$defs/", "");
      if (renamed[name]) node.$ref = `#/$defs/${renamed[name]}`;
    }
    for (const value of Object.values(node)) rewrite(value);
  };
  rewrite(schema);
}

/** The generated schema plus the doc paths it used (the test asserts every documented path was found). */
export function buildWithCoverage(appUrl: string = PRODUCTION_APP_URL): { schema: JsonNode; applied: Set<string> } {
  const generated = z.toJSONSchema(BlueprintSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
    cycles: "ref",
  }) as JsonNode;

  const { $schema: dialect, properties, ...rest } = generated;
  const schema: JsonNode = {
    $schema: dialect,
    $id: `${appUrl}/schemas/${SCHEMA_FILE.split("/").pop()}`,
    title: ROOT_TITLE,
    description: ROOT_DESCRIPTION,
    "x-blueprint-schema": BLUEPRINT_SCHEMA,
    ...rest,
    properties: {
      $schema: { type: "string", description: SCHEMA_KEY_DESCRIPTION },
      ...(isNode(properties) ? properties : {}),
    },
  };
  // `type`, `required` and `$defs` come from `rest`; put `properties` back where a reader expects it.
  const ordered: JsonNode = {};
  for (const key of ["$schema", "$id", "title", "description", "x-blueprint-schema", "type", "properties", "required", "$defs"]) {
    if (key in schema) ordered[key] = schema[key];
  }
  for (const [key, value] of Object.entries(schema)) if (!(key in ordered)) ordered[key] = value;

  dropNonStandardFormats(ordered);
  renameDefs(ordered);
  const applied = new Set<string>();
  annotate(ordered, BlueprintSchema, "", applied);
  const defs = ordered.$defs;
  if (isNode(defs) && isNode(defs[VALUE_REF_DEF])) {
    (defs[VALUE_REF_DEF] as JsonNode).title = "Named value reference";
    (defs[VALUE_REF_DEF] as JsonNode).description =
      "Where a named value comes from: a case field, an account fact, a fixed string, a table lookup, a built-in, "
      + "or `first_of`, which tries its refs in order.";
  }
  return { schema: ordered, applied };
}

export const buildBlueprintJsonSchema = (appUrl: string = PRODUCTION_APP_URL): JsonNode => buildWithCoverage(appUrl).schema;

/** The exact bytes of the committed file, so the drift test compares text and not object identity. */
export const renderSchemaFile = (appUrl: string = PRODUCTION_APP_URL): string =>
  `${JSON.stringify(buildBlueprintJsonSchema(appUrl), null, 2)}\n`;

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function main(argv: string[]): number {
  const appUrl = process.env.APP_URL?.replace(/\/+$/, "") || PRODUCTION_APP_URL;
  const target = resolve(ROOT, SCHEMA_FILE);
  const next = renderSchemaFile(appUrl);
  if (argv.includes("--check")) {
    const current = readFileSync(target, "utf8");
    if (current === next) {
      process.stdout.write(`${SCHEMA_FILE} is up to date\n`);
      return 0;
    }
    process.stderr.write(`${SCHEMA_FILE} has drifted from BlueprintSchema; run: npx tsx scripts/devtools/gen-json-schema.ts\n`);
    return 1;
  }
  writeFileSync(target, next);
  process.stdout.write(`wrote ${SCHEMA_FILE} (${next.length} bytes, $id ${appUrl}/schemas/blueprint-2.0.json)\n`);
  return 0;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) process.exit(main(process.argv.slice(2)));
