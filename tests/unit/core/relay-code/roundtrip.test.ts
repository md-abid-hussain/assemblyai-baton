/**
 * The round-trip property (SAAS §5.3, WP23·1 acceptance 2-3): a blueprint survives every trip through text.
 *
 *   serialize → validateSource            gives back the same blueprint, in YAML and in JSON
 *   applyEdit → parseSource               gives back exactly the edited object, 200 random form edits deep
 *   applyEdit on an annotated file        keeps every comment the author wrote
 *   convert YAML ⇄ JSON                   keeps the data and carries the `$schema` header across
 *
 * The edits are the ones the Studio's FORMS make (a toggle, a renamed label, a new field block, a cleared optional
 * key), because that is the path that must never damage a developer's YAML file.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BlueprintSchema, type Blueprint } from "@/core/contracts/v2/blueprint";
import type { SourceFormat } from "@/core/contracts/v3/relay-code";
import { blueprintHash } from "@/core/relay/migrate";
import { applyEdit, convert, parseSource, serialize, validateSource, yamlSchemaHeader, type Path } from "@/core/relay-code";
import { miniBlueprint } from "../relay/fixtures/mini-blueprint";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCHEMA_URL = "https://app.example.test/schemas/blueprint-2.0.json";

const galleryNames = (): string[] =>
  readdirSync(join(ROOT, "data", "relays")).filter((n) => n.endsWith(".json") && !n.endsWith(".presets.json")).sort();
const galleryBlueprint = (name: string): Blueprint =>
  BlueprintSchema.parse(JSON.parse(readFileSync(join(ROOT, "data", "relays", name), "utf8")));

/** A deterministic PRNG, so a failure is reproducible from its seed (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Leaf = { path: Path; value: unknown };

/** Every leaf a form could edit: a string, number or boolean somewhere in the document. */
function leaves(node: unknown, path: Path = [], out: Leaf[] = []): Leaf[] {
  if (node === null) return out;
  if (Array.isArray(node)) {
    node.forEach((item, index) => leaves(item, [...path, index], out));
    return out;
  }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) leaves(value, [...path, key], out);
    return out;
  }
  if (path.length > 0) out.push({ path, value: node });
  return out;
}

/** The new value a form would write for this leaf: the same JSON type, so the document stays a blueprint. */
function editValue(leaf: Leaf, random: () => number, index: number): unknown {
  if (typeof leaf.value === "boolean") return !leaf.value;
  if (typeof leaf.value === "number") return Number.isInteger(leaf.value) ? leaf.value + 1 : Math.round((leaf.value + 0.5) * 100) / 100;
  const text = String(leaf.value);
  if (random() < 0.25) return `${text}\nsecond line ${index}`;       // becomes a block scalar in YAML
  if (random() < 0.25) return `${text}: with punctuation #${index}`;  // has to be quoted in YAML
  return `edited ${index} ${text}`.slice(0, 60);
}

const getIn = (root: unknown, path: Path): unknown =>
  path.reduce<unknown>((node, key) => (node === null || typeof node !== "object" ? undefined : (node as Record<string | number, unknown>)[key]), root);

function setIn(root: unknown, path: Path, value: unknown): void {
  const parent = getIn(root, path.slice(0, -1)) as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  if (value === undefined) {
    if (Array.isArray(parent) && typeof last === "number") parent.splice(last, 1);
    else delete parent[last];
    return;
  }
  parent[last] = value;
}

describe("serialize → validateSource", () => {
  it.each(galleryNames())("round-trips the gallery blueprint %s in YAML and JSON", (name) => {
    const blueprint = galleryBlueprint(name);
    for (const format of ["yaml", "json"] as SourceFormat[]) {
      const text = serialize(blueprint, format, { header: yamlSchemaHeader(SCHEMA_URL) });
      const result = validateSource(text, format);
      expect(result.diagnostics, `${name} ${format}`).toEqual([]);
      expect(result.blueprint, `${name} ${format}`).toEqual(blueprint);
      expect(result.hash).toBe(blueprintHash(blueprint));
    }
  });

  it("round-trips every committed example file", () => {
    const dir = join(ROOT, "examples", "relays");
    const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".yaml") || n.endsWith(".json")) : [];
    expect(files).toContain("baton-add-driver.yaml");
    for (const file of files) {
      const result = validateSource(readFileSync(join(dir, file), "utf8"));
      expect(result.diagnostics, file).toEqual([]);
      expect(result.blueprint, file).not.toBeNull();
    }
  });

  it("writes keys in the declaration order of the zod shapes, not alphabetically", () => {
    const text = serialize(miniBlueprint(), "yaml");
    const topLevel = text.split("\n").filter((line) => /^[a-z]/.test(line)).map((line) => line.split(":")[0]);
    expect(topLevel).toEqual(["meta", "context", "fields", "values", "listening", "handoff", "playbook", "connectors", "qa", "extraction", "compliance"]);
    const metaKeys = text.split("\n").filter((line) => /^ {2}[a-z]+:/.test(line)).map((line) => line.trim().split(":")[0]);
    expect(metaKeys.slice(0, 9)).toEqual(["schema", "slug", "title", "tagline", "industry", "locale", "intent", "roles", "origin"]);
    expect(serialize(miniBlueprint(), "yaml")).toBe(text);   // deterministic
  });

  it("uses block scalars for multi-line strings and quotes only when it has to", () => {
    const blueprint = structuredClone(miniBlueprint()) as Blueprint;
    blueprint.playbook.persona.tone = "line one\nline two";
    blueprint.meta.tagline = "colons: they need quotes";
    const text = serialize(blueprint, "yaml");
    expect(text).toContain("tone: |-\n");
    expect(text).toContain('tagline: "colons: they need quotes"');
    expect(text).toContain("slug: mini-dental");
    expect(validateSource(text).blueprint).toEqual(blueprint);
  });
});

describe("applyEdit → parseSource (200 random form edits)", () => {
  const editRun = (blueprint: Blueprint, format: SourceFormat, count: number, seed: number): void => {
    const random = rng(seed);
    const text = serialize(blueprint, format);
    const all = leaves(JSON.parse(JSON.stringify(blueprint)));
    expect(all.length).toBeGreaterThan(100);
    for (let i = 0; i < count; i++) {
      const leaf = all[Math.floor(random() * all.length)]!;
      const remove = random() < 0.1 && leaf.path.length > 1;
      const value = remove ? undefined : editValue(leaf, random, i);
      const expected = JSON.parse(JSON.stringify(blueprint));
      setIn(expected, leaf.path, value);
      const edited = applyEdit(text, format, leaf.path, value);
      const parsed = parseSource(edited, format);
      expect(parsed.diagnostics, `${format} edit ${i} at ${JSON.stringify(leaf.path)}`).toEqual([]);
      expect(parsed.value, `${format} edit ${i} at ${JSON.stringify(leaf.path)}`).toEqual(expected);
    }
  };

  it("keeps the mini blueprint exact through 200 YAML edits and 200 JSON edits", () => {
    editRun(miniBlueprint(), "yaml", 200, 20260925);
    editRun(miniBlueprint(), "json", 200, 4242);
  });

  it.each(galleryNames())("keeps %s exact through 200 YAML edits", (name) => {
    editRun(galleryBlueprint(name), "yaml", 200, 777);
  });

  it("still validates after the edits a form actually makes", () => {
    const blueprint = miniBlueprint();
    let text = serialize(blueprint, "yaml", { header: yamlSchemaHeader(SCHEMA_URL) });
    text = applyEdit(text, "yaml", ["fields", 0, "label"], "Member ID");
    text = applyEdit(text, "yaml", ["fields", 0, "required"], false);
    text = applyEdit(text, "yaml", ["handoff", "autoBaton"], false);
    const result = validateSource(text);
    expect(result.blueprint?.fields[0]?.label).toBe("Member ID");
    expect(result.blueprint?.fields[0]?.required).toBe(false);
    expect(result.blueprint?.handoff.autoBaton).toBe(false);
    expect(result.hash).not.toBe(blueprintHash(blueprint));
  });

  it("refuses to edit text that does not parse", () => {
    expect(() => applyEdit("meta:\n  slug: a\n  slug: b\n", "yaml", ["meta", "slug"], "c")).toThrow(/duplicate|unique/i);
    expect(() => applyEdit(serialize(miniBlueprint(), "yaml"), "yaml", [], "x")).toThrow();
  });
});

describe("comments", () => {
  const annotate = (text: string): string =>
    `# The dental deposit relay - keep this file in git.\n${
      text
        .replace("fields:\n", "# The case fields, in the order the agent asks for them.\nfields:\n")
        .replace("  autoBaton: true", "  autoBaton: true # armed on the rep line")}`;

  it("keeps every comment when a form edit is applied to a YAML file", () => {
    const annotated = annotate(serialize(miniBlueprint(), "yaml", { header: yamlSchemaHeader(SCHEMA_URL) }));
    expect(validateSource(annotated).diagnostics).toEqual([]);

    let edited = annotated;
    edited = applyEdit(edited, "yaml", ["meta", "title"], "Dental deposit v2");
    edited = applyEdit(edited, "yaml", ["fields", 0, "required"], false);
    edited = applyEdit(edited, "yaml", ["playbook", "voice"], "eve");

    expect(edited).toContain("# yaml-language-server: $schema=");
    expect(edited).toContain("# The dental deposit relay - keep this file in git.");
    expect(edited).toContain("# The case fields, in the order the agent asks for them.");
    expect(edited).toContain("# armed on the rep line");
    const result = validateSource(edited);
    expect(result.diagnostics).toEqual([]);
    expect(result.blueprint?.meta.title).toBe("Dental deposit v2");
    expect(result.blueprint?.playbook.voice).toBe("eve");
  });

  it("does not create a new version for a comment-only change (the hash is of the data)", () => {
    const text = serialize(miniBlueprint(), "yaml");
    const commented = annotate(text);
    expect(commented).not.toBe(text);
    expect(validateSource(commented).hash).toBe(validateSource(text).hash);
  });
});

describe("convert", () => {
  it("moves the `$schema` header between the YAML comment and the JSON key", () => {
    const yamlText = serialize(miniBlueprint(), "yaml", { header: yamlSchemaHeader(SCHEMA_URL) });
    const jsonText = convert(yamlText, "json");
    expect(JSON.parse(jsonText).$schema).toBe(SCHEMA_URL);
    expect(validateSource(jsonText, "json").blueprint).toEqual(miniBlueprint());

    const backToYaml = convert(jsonText, "yaml");
    expect(backToYaml.split("\n")[0]).toBe(`# yaml-language-server: $schema=${SCHEMA_URL}`);
    expect(validateSource(backToYaml).blueprint).toEqual(miniBlueprint());
    expect(parseSource(backToYaml).value).toEqual(parseSource(yamlText).value);
  });

  it("is a no-op for the format the text is already in, and loses comments going to JSON", () => {
    const yamlText = `# a comment\n${serialize(miniBlueprint(), "yaml")}`;
    expect(convert(yamlText, "yaml")).toBe(yamlText);
    expect(convert(yamlText, "json")).not.toContain("a comment");
  });
});
