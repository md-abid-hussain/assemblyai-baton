/**
 * QA-FIX (docs/notes/qa-fix.md): every internal link the app renders resolves to a page.
 *
 * Both QA passes opened with `GET /` → 404, and the same class of defect was sitting in three more places at
 * once: the app shell's **Docs** link, the sign-up form's **terms** link, and four rows of the settings nav —
 * each of them a link we put in front of a judge, pointing at a route nobody had built. None of it was
 * detectable by typecheck, by any unit test, or by reading the diff of the WP that added the link, because the
 * page it points at belongs to a *different* WP's slot.
 *
 * So this walks the literal hrefs in `src/**` and the ones in WP13's copy, and asks the filesystem. A link to a
 * page a WP has not merged yet is fine — but then something has to exist at that path saying so, which is the
 * ruling the Studio's tab strip already took (`src/components/studio/tabs.ts`).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LANDING } from "@/content";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const APP = join(ROOT, "src", "app");
const toPosix = (p: string) => p.split(sep).join("/");

function sources(dir: string): string[] {
  return (readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name))
    .map((d) => toPosix(relative(ROOT, join(d.parentPath, d.name))));
}

/** Every `href="/…"` written as a literal, with the file that writes it. */
function literalLinks(): { href: string; from: string }[] {
  const out: { href: string; from: string }[] = [];
  for (const file of [...sources("src/components"), ...sources("src/app"), ...sources("src/client")]) {
    const src = readFileSync(join(ROOT, file), "utf8");
    for (const m of src.matchAll(/href="(\/[A-Za-z0-9/_.-]*)"/g)) out.push({ href: m[1]!, from: file });
  }
  // WP13's copy carries links too; the landing renders this one as its secondary call to action.
  out.push({ href: LANDING.hero.secondaryLink.href, from: "src/content/landing.ts" });
  return out;
}

/** A path served by a page, a route handler, a static file under `public/`, or a dynamic segment above it. */
function resolves(href: string): boolean {
  const path = href.split(/[?#]/)[0]!.replace(/\/$/, "");
  const segments = path.split("/").filter(Boolean);
  if (existsSync(join(APP, ...segments, "page.tsx"))) return true;
  if (existsSync(join(APP, ...segments, "route.ts"))) return true;
  if (existsSync(join(ROOT, "public", ...segments))) return true;
  // A catch-all or an optional catch-all one level up ( `/studio` → `studio/[[...rest]]/page.tsx` ).
  const parent = join(APP, ...segments);
  if (existsSync(parent)) {
    for (const entry of readdirSync(parent)) {
      if (/^\[\[?\.\.\./.test(entry) && existsSync(join(parent, entry, "page.tsx"))) return true;
    }
  }
  return false;
}

describe("every internal link resolves to something the server can serve", () => {
  const links = literalLinks();

  it("collects a meaningful number of links", () => {
    expect(links.length).toBeGreaterThan(10);
  });

  it.each([...new Set(links.map((l) => l.href))].sort())("%s", (href) => {
    const from = links.filter((l) => l.href === href).map((l) => l.from);
    expect(resolves(href), `${href} is linked from ${from.join(", ")} and nothing serves it`).toBe(true);
  });

  it("the root page is one of them (the blocker both QA passes opened with)", () => {
    expect(resolves("/")).toBe(true);
    expect(links.some((l) => l.href === "/")).toBe(true);
  });
});
