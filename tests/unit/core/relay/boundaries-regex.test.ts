/**
 * TASKS-v2 §2 rule 10 and WP14a acceptance 8 (the parts WP14a owns): blueprint regexes are matched only through
 * contracts/v2/regex.ts, and src/core/relay/** stays pure (no Node, DOM or server imports). The global layering
 * rules stay in tests/unit/boundaries.test.ts (WP12).
 *
 * The rule is enforced structurally: nothing in the kernel constructs a RegExp from a string. Kernel code uses regex
 * LITERALS for its own grammar and `safeTest`/`compileSafeRegex` for blueprint strings. Server/client code that
 * handles blueprint strings (WP14b, WP16, WP17, WP18) is scanned too: those dirs may not call `new RegExp(`
 * at all; a legitimate non-blueprint dynamic regex there goes through a request to WP14a.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function listFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push(relative(ROOT, p).split(sep).join("/"));
    }
  };
  walk(abs);
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const RAW_REGEXP = /\bnew\s+RegExp\s*\(|(?<![.\w$])RegExp\s*\(/;

const BLUEPRINT_DIRS = [
  "src/core/relay", "src/core/contracts/v2", "src/server/relays", "src/server/engine", "src/server/connectors",
  "src/server/draft", "src/server/sim", "src/server/publish", "src/server/analytics", "src/components/studio",
  "src/client/studio",
];
const ALLOWED = new Set(["src/core/contracts/v2/regex.ts"]);

describe("blueprint regex boundary (TASKS-v2 §2 rule 10)", () => {
  it("no RegExp is constructed from a string outside contracts/v2/regex.ts", () => {
    const hits: string[] = [];
    for (const f of BLUEPRINT_DIRS.flatMap(listFiles)) {
      if (ALLOWED.has(f)) continue;
      stripComments(readFileSync(join(ROOT, f), "utf8")).split("\n").forEach((line, i) => {
        if (RAW_REGEXP.test(line)) hits.push(`${f}:${i + 1} ${line.trim()}`);
      });
    }
    expect(hits.join("\n")).toBe("");
  });

  it("src/core/relay is pure: no Node, DOM, server or client imports", () => {
    const hits: string[] = [];
    const rules = [
      /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']node:/,
      /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](?:fs|path|crypto|http|https|net|dns|os|child_process|url|util)["']/,
      /["']@\/(?:server|client|app|components)(?:\/|["'])/,
      /["'](?:\.\.\/)+(?:server|client|app|components)\//,
      /(?<![.\w$])(?:window|document)\s*[.[]/,
      /\bprocess\s*\.\s*env\b/,
    ];
    for (const f of listFiles("src/core/relay")) {
      stripComments(readFileSync(join(ROOT, f), "utf8")).split("\n").forEach((line, i) => {
        if (rules.some((r) => r.test(line))) hits.push(`${f}:${i + 1} ${line.trim()}`);
      });
    }
    expect(hits.join("\n")).toBe("");
  });

  it("the scanner catches a raw RegExp (self-test)", () => {
    expect(RAW_REGEXP.test("const re = new RegExp(bp.qa.ask[0], 'i');")).toBe(true);
    expect(RAW_REGEXP.test("const re = RegExp(src);")).toBe(true);
    expect(RAW_REGEXP.test("const re = /abc/i; x instanceof RegExp")).toBe(false);
  });
});
