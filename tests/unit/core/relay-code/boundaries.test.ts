/**
 * `src/core/relay-code/**` is ISOMORPHIC (SAAS §5.3, WP23·1 acceptance 7).
 *
 * The same codec runs in three places: the Studio's Code tab in a browser, the server on save, and the CLI bundled
 * by esbuild into one file. One `node:fs` import, one `process.env` read or one `window` reference would break the
 * browser build or the bundle, and it would be found late - so it is checked here on every run, the same way
 * tests/unit/boundaries.test.ts guards the rest of `src/core/**`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DIR = join(ROOT, "src", "core", "relay-code");

/** Strip `//` and block comments, keeping string contents (import specifiers live in strings). */
function stripComments(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; ) {
    const c = source[i]!;
    const d = source[i + 1];
    if (c === "/" && d === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) { if (source[i] === "\n") out += "\n"; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c; i++;
      while (i < source.length && source[i] !== c) { if (source[i] === "\\") { out += source[i]; i++; } out += source[i]; i++; }
      out += c; i++;
      continue;
    }
    out += c; i++;
  }
  return out;
}

const files = readdirSync(DIR, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name));

const importsOf = (source: string): string[] =>
  [...source.matchAll(/(?:^|\s)(?:import|export)[^;]*?from\s*["']([^"']+)["']/g), ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)]
    .map((match) => match[1]!);

/** The only packages the codec may depend on (SAAS §5.3: the `yaml` package and the contracts' zod). */
const ALLOWED_PACKAGES = new Set(["yaml", "zod"]);

describe("src/core/relay-code is isomorphic", () => {
  it("has the five modules of SAAS §5.3", () => {
    expect(files.map((f) => relative(DIR, f).split(sep).join("/")).sort())
      .toEqual(["codec.ts", "diagnostics.ts", "diff.ts", "index.ts", "order.ts"]);
  });

  it.each(files.map((f) => [relative(ROOT, f).split(sep).join("/"), f] as const))("%s imports nothing from node, the DOM or the server", (name, file) => {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const specifier of importsOf(source)) {
      if (specifier.startsWith(".")) {
        expect(specifier.replace(/\\/g, "/"), name).not.toMatch(/\.\.\/(server|client|app|components)\//);
        continue;
      }
      expect(specifier.startsWith("@/server") || specifier.startsWith("@/client") || specifier.startsWith("@/app") || specifier.startsWith("@/components"), `${name} imports ${specifier}`).toBe(false);
      expect(specifier.startsWith("node:"), `${name} imports ${specifier}`).toBe(false);
      const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
      expect(ALLOWED_PACKAGES.has(packageName), `${name} imports ${specifier}`).toBe(true);
    }
  });

  it.each(files.map((f) => [relative(ROOT, f).split(sep).join("/"), f] as const))("%s touches no node or DOM global", (name, file) => {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const banned of [/\bprocess\s*\./, /\brequire\s*\(/, /\b__dirname\b/, /\bwindow\s*\./, /\bdocument\s*\./, /\bnavigator\s*\./, /\blocalStorage\b/, /\bBuffer\s*\./]) {
      expect(banned.test(source), `${name} uses ${banned}`).toBe(false);
    }
  });

  it("only relies on globals that exist in both a browser and node 22", () => {
    for (const global of ["TextEncoder", "JSON", "Math", "Int32Array"]) {
      expect(typeof (globalThis as Record<string, unknown>)[global]).not.toBe("undefined");
    }
  });
});
