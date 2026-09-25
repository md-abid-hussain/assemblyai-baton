import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** WP7 acceptance 4 (second half): no console component, page or client module imports src/server/**. */
const ROOT = join(__dirname, "..", "..", "..");
const DIRS = [
  "src/components/call", "src/components/case", "src/components/qa", "src/components/hud", "src/components/common", "src/components/layout",
  "src/client/store", "src/client/fixtures", "src/client/session", "src/app/call", "src/app/dev/ui",
];

function files(dir: string): string[] {
  const abs = join(ROOT, dir);
  let out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(abs);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(abs, e);
    if (statSync(p).isDirectory()) out = out.concat(files(join(dir, e)));
    else if (/\.(ts|tsx)$/.test(e)) out.push(join(dir, e).replace(/\\/g, "/"));
  }
  return out;
}

describe("WP7 UI boundaries", () => {
  const all = DIRS.flatMap(files);

  it("finds the UI files", () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it("no WP7 file imports src/server/**", () => {
    const bad = all.filter((f) => /from\s+["'](?:@\/server|(?:\.\.\/)+server)\//.test(readFileSync(join(ROOT, f), "utf8")));
    expect(bad).toEqual([]);
  });

  it("only the server lookup under src/app/call touches Node built-ins, and it is server-only", () => {
    const node = all.filter((f) => /from\s+["']node:/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(node).toEqual(["src/app/call/call-entry.ts"]);
    expect(readFileSync(join(ROOT, "src/app/call/call-entry.ts"), "utf8")).toMatch(/^import "server-only";/m);
  });

  it("every src/components/** console module is a client module", () => {
    const comp = all.filter((f) => f.startsWith("src/components/") && f.endsWith(".tsx"));
    const missing = comp.filter((f) => !/^["']use client["']/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(missing).toEqual([]);
  });
});
