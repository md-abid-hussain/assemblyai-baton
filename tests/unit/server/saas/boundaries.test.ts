/**
 * WP19·1 boundaries rule (SAAS §14; TASKS-v3 §6): **`better-auth` is imported only from the identity layer.**
 *
 * `src/server/identity/**`, `src/client/identity/**` and the two `*-plugin.ts` files are the whole surface. If a
 * route, a service or a component imports `better-auth` directly, tenancy stops being decidable by reading
 * `requirePrincipal` — which is the one thing SAAS §10.1 rule 1 depends on. The rule lands at C3, before
 * `better-auth` is even installed (WP19·2), so it can never be "added later".
 *
 * `stripComments` is a local copy rather than an import from `tests/unit/boundaries.test.ts`: importing a test
 * module would register that file's suites inside this one.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const CODE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const SELF = "tests/unit/server/saas/boundaries.test.ts";

const toPosix = (p: string) => p.split(sep).join("/");

/** Drop `//` and block comments, keeping string contents (import specifiers live there). */
function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") {
          out += src[i]! + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (c !== "`" && src[i] === "\n") break;
        out += src[i]!;
        i++;
      }
      if (i < src.length) out += src[i]!;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function listFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return (readdirSync(abs, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((d) => d.isFile() && CODE_EXT.test(d.name))
    .map((d) => toPosix(relative(ROOT, join(d.parentPath, d.name))))
    .filter((p) => !p.includes("/node_modules/"));
}

/** Where `better-auth` (and its plugins and adapters) may be imported. */
const IDENTITY_LAYER = [
  /^src\/server\/identity\//,
  /^src\/client\/identity\//,
  /^src\/server\/api-v1\/[\w-]*plugin\.ts$/,
  /^src\/server\/billing\/[\w-]*plugin\.ts$/,
  /^tests\/unit\/server\/identity\//,
];

const BETTER_AUTH_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](?:better-auth|@better-auth\/[^"']*|@polar-sh\/better-auth)(?:\/[^"']*)?["']/;

/** Every import/require specifier in a file, with its line number. */
function specifiers(file: string): { spec: string; line: number }[] {
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  const out: { spec: string; line: number }[] = [];
  stripComments(readFileSync(join(ROOT, file), "utf8"))
    .split("\n")
    .forEach((text, i) => {
      for (const m of text.matchAll(re)) out.push({ spec: m[1]!, line: i + 1 });
    });
  return out;
}

/**
 * Where a **relative** specifier lands, as a repo-relative posix path. A bare specifier returns null (those are
 * judged by the deny-regexes above). This is what catches `../../server/db` — an alias- and `node:`-free escape
 * that the prefix regex alone cannot see, and relative cross-imports (`../case`) are already idiomatic in v3.
 */
function relativeTarget(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return toPosix(relative(ROOT, resolve(join(ROOT, file), "..", spec)));
}

function hits(files: string[], re: RegExp): string[] {
  const out: string[] = [];
  for (const file of files) {
    stripComments(readFileSync(join(ROOT, file), "utf8"))
      .split("\n")
      .forEach((text, i) => {
        if (re.test(text)) out.push(`${file}:${i + 1} ${text.trim().slice(0, 140)}`);
      });
  }
  return out;
}

describe("better-auth stays inside the identity layer", () => {
  it("nothing outside src/{server,client}/identity and the two plugin files imports better-auth", () => {
    const files = [...listFiles("src"), ...listFiles("scripts"), ...listFiles("tests")].filter(
      (f) => f !== SELF && !IDENTITY_LAYER.some((re) => re.test(f)),
    );
    expect(hits(files, BETTER_AUTH_IMPORT).join("\n")).toBe("");
  });

  it("the detector catches the package, its scoped plugins and the Polar plugin, and ignores comments", () => {
    const flagged = (src: string) => BETTER_AUTH_IMPORT.test(stripComments(src));
    expect(flagged('import { betterAuth } from "better-auth";')).toBe(true);
    expect(flagged('import { organization } from "better-auth/plugins";')).toBe(true);
    expect(flagged('import { apiKey } from "@better-auth/api-key";')).toBe(true);
    expect(flagged('import { polar } from "@polar-sh/better-auth";')).toBe(true);
    expect(flagged('const m = await import("better-auth/adapters/drizzle");')).toBe(true);
    expect(flagged('require("better-auth")')).toBe(true);
    expect(flagged("// better-auth is mounted in src/server/identity/auth.ts")).toBe(false);
    expect(flagged('import { createAuthClient } from "@/client/identity/auth-client";')).toBe(false);
    expect(flagged('import { polarClient } from "@polar-sh/sdk";')).toBe(false);
  });
});

describe("the C3 plugin stubs", () => {
  it("both exist, return an empty list and pull in no dependency", async () => {
    const keys = await import("@/server/api-v1/keys-plugin");
    const polar = await import("@/server/billing/polar-plugin");
    expect(keys.apiKeyPlugins()).toEqual([]);
    expect(polar.polarPlugins()).toEqual([]);
    expect(keys.API_KEYS_ENABLED).toBe(false);
    expect(polar.POLAR_BILLING_ENABLED).toBe(false);
  });
});

describe("contracts v3 stays pure", () => {
  it("no server, client or node import reaches src/core/contracts/v3", () => {
    const files = listFiles("src/core/contracts/v3");
    expect(files.length).toBeGreaterThan(0);
    const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](?:node:|@\/(?:server|client|app|components)|server-only|client-only)/;
    expect(hits(files, re).join("\n")).toBe("");
  });

  it("no relative import escapes src/core/** either", () => {
    const files = listFiles("src/core/contracts/v3");
    expect(files.length).toBeGreaterThan(0);
    const escapes: string[] = [];
    for (const file of files) {
      for (const { spec, line } of specifiers(file)) {
        const target = relativeTarget(file, spec);
        if (target !== null && !target.startsWith("src/core/")) escapes.push(`${file}:${line} ${spec} -> ${target}`);
      }
    }
    expect(escapes.join("\n")).toBe("");
  });

  it("that check actually catches an escape (the sibling imports pass, a reach into src/server does not)", () => {
    const f = "src/core/contracts/v3/events.ts";
    expect(relativeTarget(f, "../case")).toBe("src/core/contracts/case");
    expect(relativeTarget(f, "./identity")).toBe("src/core/contracts/v3/identity");
    expect(relativeTarget(f, "../../../server/db")).toBe("src/server/db");
    expect(relativeTarget(f, "../../../../scripts/x")).toBe("scripts/x");
    expect(relativeTarget(f, "zod")).toBeNull();
    for (const bad of ["../../../server/db", "../../../../scripts/x"]) {
      expect([bad, relativeTarget(f, bad)!.startsWith("src/core/")]).toEqual([bad, false]);
    }
  });

  it("the v1 and v2 barrels do not re-export v3, so the frozen names cannot collide", () => {
    for (const f of ["src/core/contracts/index.ts", "src/core/contracts/v2/index.ts"]) {
      expect([f, readFileSync(join(ROOT, f), "utf8").includes("v3")]).toEqual([f, false]);
    }
  });
});
