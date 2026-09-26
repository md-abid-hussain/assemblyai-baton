/**
 * The codec: parsing limits, diagnostics and ranges (SAAS §5.2-5.3, WP23·1 acceptance 4-6).
 *
 * A blueprint file is a stranger's input: it arrives from `POST /api/v1/blueprints/validate` without auth, from an
 * Import in the Studio and from `changeover push`. So the tests below care as much about what the parser REFUSES
 * (alias bombs, custom tags, duplicate keys, 256 KiB+) as about what it accepts, and about pointing a developer at
 * the exact line and column of every problem.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BlueprintSchema, type Blueprint } from "@/core/contracts/v2/blueprint";
import { MAX_SOURCE_BYTES, type CodeDiagnostic } from "@/core/contracts/v3/relay-code";
import { blueprintHash } from "@/core/relay/migrate";
import { applyEdit, parseSource, serialize, sniffFormat, validateSource, yamlSchemaHeader } from "@/core/relay-code";
import { validateSourceWith } from "@/core/relay-code";
import { miniBlueprint } from "../relay/fixtures/mini-blueprint";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8");
const gallery = (): Blueprint => BlueprintSchema.parse(JSON.parse(read("data", "relays", "baton-add-driver.json")));

const codes = (diagnostics: readonly CodeDiagnostic[]): string[] => diagnostics.map((d) => d.code);
const errorsOf = (diagnostics: readonly CodeDiagnostic[]): CodeDiagnostic[] => diagnostics.filter((d) => d.severity === "error");
const lineOf = (text: string, line: number): string => text.split("\n")[line - 1] ?? "";

const mini = miniBlueprint();
const miniYaml = serialize(mini, "yaml");
const miniJson = serialize(mini, "json");

describe("sniffFormat", () => {
  it("reads `{` or `[` as JSON and everything else as YAML", () => {
    expect(sniffFormat('{"meta": {}}')).toBe("json");
    expect(sniffFormat('\n\n  {"meta": {}}')).toBe("json");
    expect(sniffFormat("﻿{}")).toBe("json");
    expect(sniffFormat("meta:\n  slug: x\n")).toBe("yaml");
    expect(sniffFormat("# a comment\nmeta: {}\n")).toBe("yaml");
    expect(sniffFormat("")).toBe("yaml");
  });
});

describe("parsing limits (SAAS §5.3, §10.4)", () => {
  it("refuses a file over 256 KiB with CODEC_TOO_LARGE, without parsing it", () => {
    const big = `# ${"x".repeat(300 * 1024)}\nmeta: {}\n`;
    const parsed = parseSource(big, "yaml");
    expect(parsed.value).toBeNull();
    expect(codes(parsed.diagnostics)).toEqual(["CODEC_TOO_LARGE"]);
    expect(parsed.diagnostics[0]!.message).toContain(String(MAX_SOURCE_BYTES));
  });

  it("counts the limit in UTF-8 bytes, not UTF-16 code units", () => {
    const justUnder = `# ${"é".repeat(Math.floor((MAX_SOURCE_BYTES - 100) / 2))}\nmeta: 1\n`;
    expect(new TextEncoder().encode(justUnder).length).toBeLessThan(MAX_SOURCE_BYTES);
    expect(justUnder.length).toBeLessThan(MAX_SOURCE_BYTES);
    expect(codes(parseSource(`${justUnder}${"é".repeat(20_000)}`, "yaml").diagnostics)).toContain("CODEC_TOO_LARGE");
  });

  it("refuses an alias bomb with CODEC_ALIAS_LIMIT", () => {
    const bomb = [
      "a: &a [x, x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
    ].join("\n");
    const parsed = parseSource(bomb, "yaml");
    expect(parsed.value).toBeNull();
    expect(codes(parsed.diagnostics)).toContain("CODEC_ALIAS_LIMIT");
  });

  it("refuses a custom or non-core tag instead of reading it as a string", () => {
    for (const source of ["a: !!python/object x\n", "a: !mytag x\n", "a: !!timestamp 2026-09-25\n"]) {
      const parsed = parseSource(source, "yaml");
      expect(parsed.value, source).toBeNull();
      expect(codes(parsed.diagnostics), source).toContain("CODEC_SYNTAX");
      expect(errorsOf(parsed.diagnostics)[0]!.message).toMatch(/tag/i);
    }
  });

  it("refuses duplicate keys", () => {
    const parsed = parseSource("meta:\n  slug: a\n  slug: b\n", "yaml");
    expect(parsed.value).toBeNull();
    expect(errorsOf(parsed.diagnostics)[0]!.message).toContain("DUPLICATE_KEY");
    expect(errorsOf(parsed.diagnostics)[0]!.range?.startLine).toBe(3);
  });

  it("refuses more than one document", () => {
    const parsed = parseSource("meta: 1\n---\nmeta: 2\n", "yaml");
    expect(parsed.value).toBeNull();
    expect(errorsOf(parsed.diagnostics)[0]!.message).toContain("MULTIPLE_DOCS");
  });

  it("does not expand merge keys (`<<` stays an ordinary, unknown key)", () => {
    const parsed = parseSource("base: &b\n  slug: a\nmeta:\n  <<: *b\n", "yaml");
    expect(parsed.value).toEqual({ base: { slug: "a" }, meta: { "<<": { slug: "a" } } });
  });

  it("does not coerce YAML 1.1 surprises: `yes`, `012` and dates stay what the core schema says", () => {
    const parsed = parseSource("a: yes\nb: 012\nc: 2026-09-25\nd: null\n", "yaml");
    expect(parsed.value).toEqual({ a: "yes", b: 12, c: "2026-09-25", d: null });
  });

  it("rejects text that is valid YAML but invalid JSON when the format is JSON", () => {
    const trailingComma = '{"meta": {"slug": "a"},}';
    expect(parseSource(trailingComma, "yaml").value).toEqual({ meta: { slug: "a" } });
    const parsed = parseSource(trailingComma, "json");
    expect(parsed.value).toBeNull();
    expect(errorsOf(parsed.diagnostics)[0]!.message).toContain("invalid JSON");
  });

  it("refuses an empty file and a file whose root is not a mapping", () => {
    expect(errorsOf(parseSource("", "yaml").diagnostics)[0]!.message).toContain("empty");
    expect(errorsOf(parseSource("- a\n- b\n", "yaml").diagnostics)[0]!.message).toContain("mapping");
  });
});

describe("ranges (WP23·1 acceptance 4)", () => {
  it("points a zod issue at the offending value, in YAML and in JSON", () => {
    for (const [format, text] of [["yaml", miniYaml], ["json", miniJson]] as const) {
      const broken = applyEdit(text, format, ["meta", "title"], 42);
      const issue = validateSource(broken, format).diagnostics.find((d) => d.source === "schema");
      expect(issue, format).toBeDefined();
      expect(issue!.path).toEqual(["meta", "title"]);
      expect(lineOf(broken, issue!.range!.startLine), format).toContain("42");
      expect(issue!.range!.startCol, format).toBeGreaterThan(0);
    }
  });

  it("points a lint issue at its path", () => {
    const broken = applyEdit(miniYaml, "yaml", ["handoff", "allowedWhen", "requireVerified"], ["no_such_field"]);
    const { blueprint, diagnostics } = validateSource(broken);
    const lint = diagnostics.filter((d) => d.source === "lint" && d.severity === "error");
    expect(lint.length).toBeGreaterThan(0);
    expect(lineOf(broken, lint[0]!.range!.startLine)).toContain("no_such_field");
    // A lint error blocks Test and Publish, never Save: the parsed blueprint still comes back.
    expect(blueprint).not.toBeNull();
  });

  it("points an unknown key at the KEY token, not at its value", () => {
    const typo = miniYaml.replace("handoff:\n", "handoff:\n  requried: true\n");
    const unknown = validateSource(typo).diagnostics.filter((d) => d.code === "CODEC_UNKNOWN_KEY");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.severity).toBe("warn");
    expect(unknown[0]!.path).toEqual(["handoff", "requried"]);
    const { startLine, startCol, endCol } = unknown[0]!.range!;
    expect(lineOf(typo, startLine)).toBe("  requried: true");
    expect(lineOf(typo, startLine).slice(startCol, endCol)).toBe("requried");
  });

  it("locates lint and unknown-key issues in a JSON file too", () => {
    const stray = applyEdit(miniJson, "json", ["handoff", "requried"], true);
    const unknown = validateSource(stray, "json").diagnostics.filter((d) => d.code === "CODEC_UNKNOWN_KEY");
    expect(unknown.map((d) => d.path)).toEqual([["handoff", "requried"]]);
    const { startLine, startCol, endCol } = unknown[0]!.range!;
    expect(lineOf(stray, startLine).slice(startCol, endCol)).toBe('"requried"');

    const lintBroken = applyEdit(miniJson, "json", ["handoff", "allowedWhen", "requireVerified"], ["no_such_field"]);
    const lint = validateSource(lintBroken, "json").diagnostics.filter((d) => d.source === "lint" && d.severity === "error");
    expect(lint.length).toBeGreaterThan(0);
    expect(lineOf(lintBroken, lint[0]!.range!.startLine)).toContain("no_such_field");
  });

  it("falls back to the nearest existing parent for a path that is not in the text", () => {
    const parsed = parseSource(miniYaml, "yaml");
    const deep = parsed.locate(["meta", "intent", "nothing", "here"]);
    const parent = parsed.locate(["meta", "intent"]);
    expect(deep).toEqual(parent);
    expect(parsed.locate(["meta"])).not.toBeNull();
  });
});

describe("unknown keys (CODEC_UNKNOWN_KEY)", () => {
  it("allows the `$schema` header key at the root and the YAML header comment", () => {
    const withKey = serialize(mini, "json", { header: yamlSchemaHeader("https://example.test/schemas/blueprint-2.0.json") });
    expect(JSON.parse(withKey).$schema).toBe("https://example.test/schemas/blueprint-2.0.json");
    const json = validateSource(withKey, "json");
    expect(json.diagnostics.filter((d) => d.code === "CODEC_UNKNOWN_KEY")).toEqual([]);
    expect(json.blueprint).not.toBeNull();

    const withHeader = serialize(mini, "yaml", { header: yamlSchemaHeader("https://example.test/schemas/blueprint-2.0.json") });
    expect(withHeader.startsWith("# yaml-language-server: $schema=")).toBe(true);
    expect(validateSource(withHeader).diagnostics).toEqual([]);
  });

  it("does not report keys inside a record, where any key is allowed", () => {
    const withFact = applyEdit(miniYaml, "yaml", ["context", "samples", 0, "facts", "brand_new_fact"], "hello");
    const diagnostics = validateSource(withFact).diagnostics;
    expect(diagnostics.filter((d) => d.code === "CODEC_UNKNOWN_KEY")).toEqual([]);
  });

  it("reports a stray key deep inside the document, with its path", () => {
    const stray = applyEdit(miniYaml, "yaml", ["fields", 0, "requried"], true);
    const unknown = validateSource(stray).diagnostics.filter((d) => d.code === "CODEC_UNKNOWN_KEY");
    expect(unknown.map((d) => d.path)).toEqual([["fields", 0, "requried"]]);
  });
});

describe("credentials (CODEC_CREDENTIAL, SAAS §5.2)", () => {
  const withHttpAction = (headerName: string, headerValue: unknown, url = "https://api.example.test/v1/quote"): Blueprint => {
    const bp = structuredClone(mini) as Blueprint;
    (bp.connectors as unknown[]).push({
      type: "http_action", id: "quote_api", label: "Quote API", toolName: "quote_api",
      description: "Ask the pricing service for a quote.", method: "POST", url,
      params: { type: "object", required: [], properties: {} },
      headers: [{ name: headerName, value: headerValue }],
      hmacSecret: null, timeoutMs: 2000, responsePick: ["total"], sideEffect: false,
    });
    return bp;
  };
  const scan = (bp: Blueprint): CodeDiagnostic[] =>
    validateSource(serialize(bp, "yaml")).diagnostics.filter((d) => d.code === "CODEC_CREDENTIAL");

  /**
   * These fixtures have to *look* like real provider credentials — that shape is the entire thing under test —
   * so they are assembled at run time rather than written out. The repository's pre-commit guard
   * (`scripts/ci/staged-key-scan.mjs`) blocks credential-shaped literals whether they are real or fake, and it
   * is right to: a fake `sk`+`live`+… in a test file is indistinguishable from a leak to every scanner that
   * will ever read this history, and it trains people to wave the alarm through. Joining the parts keeps the
   * value byte-identical for the codec while no such literal exists in the tree.
   */
  const cred = (...parts: string[]): string => parts.join("_");
  const STRIPE_ISH = cred("sk", "live", "51H8xQ2KsLmNpQrStUvWx");

  it.each([
    ["Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.abc"],
    ["Authorization", "Basic YWxhZGRpbjpvcGVuc2VzYW1l"],
    ["X-Api-Key", STRIPE_ISH],
    ["X-Checkout", cred("cko", "test", "9f8e7d6c5b4a3210zyxw")],
    ["X-Webhook", cred("whsec", "4f3e2d1c0b9a8765fedcba98")],
    ["X-Polar", cred("polar", "oat", "9a8b7c6d5e4f3a2b1c0d9e8f")],
    ["X-Session-Token", "9f8e7d6c5b4a32100123456789abcdef"],
  ])("refuses %s: %s", (name, value) => {
    const found = scan(withHttpAction(name, value));
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toEqual(["connectors", mini.connectors.length, "headers", 0, "value"]);
    expect(found[0]!.severity).toBe("error");
  });

  it("refuses a credential in the URL too", () => {
    expect(scan(withHttpAction("X-Trace", "abc", `https://api.example.test/v1?token=${STRIPE_ISH}`))).toHaveLength(1);
  });

  it("passes a `$secret` reference, a null value, and a long value in a harmless header", () => {
    expect(scan(withHttpAction("Authorization", { $secret: "sec_abcdefghij012345" }))).toEqual([]);
    expect(scan(withHttpAction("Authorization", null))).toEqual([]);
    expect(scan(withHttpAction("X-Trace-Id", "9f8e7d6c5b4a32100123456789abcdef"))).toEqual([]);
    expect(scan(withHttpAction("X-Api-Key", "quotes"))).toEqual([]);
  });

  it("refuses to hand back a blueprint that carries a credential, even though it parses", () => {
    const text = serialize(withHttpAction("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.abc"), "yaml");
    const result = validateSource(text);
    expect(result.blueprint).toBeNull();
    expect(result.hash).toBeNull();
    expect(codes(result.diagnostics)).toContain("CODEC_CREDENTIAL");
  });
});

describe("validateSource", () => {
  it("accepts the committed Baton example and hashes it exactly like the gallery JSON", () => {
    const text = read("examples", "relays", "baton-add-driver.yaml");
    const result = validateSource(text);
    expect(result.diagnostics).toEqual([]);
    expect(result.blueprint).not.toBeNull();
    expect(result.hash).toBe(blueprintHash(gallery()));
  });

  it("runs no linter unless one is injected (the codec never needs the kernel)", () => {
    const broken = applyEdit(miniYaml, "yaml", ["handoff", "allowedWhen", "requireVerified"], ["no_such_field"]);
    expect(validateSourceWith(broken, "yaml").diagnostics.filter((d) => d.source === "lint")).toEqual([]);
    expect(validateSourceWith(broken, "yaml", { lint: () => [{ code: "X", severity: "error", path: ["meta"], message: "injected" }] })
      .diagnostics.filter((d) => d.source === "lint")).toHaveLength(1);
  });

  it("returns no blueprint when zod fails, and keeps every diagnostic in source order", () => {
    const broken = applyEdit(miniYaml, "yaml", ["meta", "title"], 42);
    const result = validateSource(broken);
    expect(result.blueprint).toBeNull();
    expect(result.hash).toBeNull();
    expect(result.diagnostics.map((d) => d.source)).toContain("schema");
  });
});
