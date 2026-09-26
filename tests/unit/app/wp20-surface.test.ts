/**
 * Structural guards over WP20's own surface. WP20·1.
 *
 * Two rules that are cheap to state and expensive to notice by eye:
 *
 * 1. **Every `/app` page resolves a principal** (TASKS-v3 §2 rule 13, SAAS §2.3). A page is a read path into
 *    tenant data exactly like a route is, and `orgId` may only ever come from the principal. A new page that
 *    forgets the call would render *somebody's* runs — most likely the developer's own, which is precisely why
 *    it would pass a manual check.
 * 2. **The banned words** (TASKS-v3 §2 rule 19). WP13 owns the repo-wide test; this one fails inside WP20's
 *    own slot the moment it is introduced, rather than at the next integration.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const toPosix = (p: string) => p.split(sep).join("/");

/** WP20's paths (TASKS-v3 §6), minus the ones other WPs own inside `src/app/app`. */
const OWNED = [
  "src/app/app",
  "src/app/start",
  "src/app/sign-in",
  "src/app/sign-up",
  "src/app/accept-invite",
  "src/client/app",
  "src/components/app-shell",
  "src/components/auth",
  "src/components/onboarding",
  "src/components/runs",
  "src/components/settings",
  "src/server/read-models",
];

/**
 * Pages that resolve no principal, and why each one is allowed not to.
 *
 * The list is the point: a page is exempt only when it renders **nothing that depends on a tenant**, and saying
 * so here is cheaper than discovering later that a data page slipped in behind a blanket exception.
 */
const NO_PRINCIPAL_PAGES: Readonly<Record<string, string>> = Object.freeze({
  // A bare redirect to the first settings panel; it reads nothing and renders nothing.
  "src/app/app/settings/page.tsx": "redirect only",
  // Same shape, added at G3: `/app/relays/:id` 307s to the default tab. The tab page resolves the principal.
  "src/app/app/relays/[id]/page.tsx": "redirect only",
});

function filesUnder(dir: string, ext = /\.(ts|tsx|css)$/): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return (readdirSync(abs, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((d) => d.isFile() && ext.test(d.name))
    .map((d) => toPosix(relative(ROOT, join(d.parentPath, d.name))));
}

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments may discuss the words (this file does); only rendered strings and code must not use them. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("every /app page resolves a principal", () => {
  const pages = filesUnder("src/app/app", /^page\.tsx$/);

  // The inventory is the guard: a new `/app` page has to be added here deliberately, which is the moment
  // somebody asks whether it resolves a principal. Grown at G3 with WP15's Studio and WP21's billing pages.
  it("finds the pages WP20·1 and WP20·2 ship, plus WP15's and WP21's under /app", () => {
    expect(pages.sort()).toEqual([
      "src/app/app/analytics/page.tsx",
      "src/app/app/connectors/page.tsx",
      "src/app/app/page.tsx",
      "src/app/app/relays/[id]/[tab]/page.tsx",
      "src/app/app/relays/[id]/page.tsx",
      "src/app/app/relays/new/page.tsx",
      "src/app/app/relays/page.tsx",
      "src/app/app/runs/[id]/page.tsx",
      "src/app/app/runs/page.tsx",
      "src/app/app/settings/audit/page.tsx",
      "src/app/app/settings/billing/page.tsx",
      "src/app/app/settings/billing/simulated-checkout/page.tsx",
      "src/app/app/settings/members/page.tsx",
      "src/app/app/settings/organization/page.tsx",
      "src/app/app/settings/page.tsx",
      "src/app/app/settings/profile/page.tsx",
    ]);
  });

  it.each(pages)("%s calls appPrincipal", (page) => {
    const src = read(page);
    if (page in NO_PRINCIPAL_PAGES) {
      // An exempt page must earn it: no read model, no principal, nothing but the redirect.
      expect(stripComments(src)).not.toMatch(/read-models\/(?!app-guard)/);
      return;
    }
    expect(src).toMatch(/appPrincipal\s*\(/);
  });

  it("the settings layout resolves a context but NEVER redirects", () => {
    const src = stripComments(read("src/app/app/settings/layout.tsx"));
    expect(src).toMatch(/appContextOrNull\s*\(/);
    expect(src).not.toMatch(/redirect\s*\(/);
    expect(src).not.toMatch(/appPrincipal\s*\(/);
  });

  it("the layout resolves a context but NEVER redirects", () => {
    const src = stripComments(read("src/app/app/layout.tsx"));
    expect(src).toMatch(/appContextOrNull\s*\(/);
    // Next renders the layout and the page concurrently, so a redirect here races the page's and wins with
    // the wrong path — `/start?next=/app` instead of the page the visitor actually asked for (acceptance 1).
    expect(src).not.toMatch(/\bredirect\s*\(/);
    expect(src).not.toMatch(/\bappPrincipal\s*\(/);
  });

  it("no page reads orgId from a query string or a header", () => {
    for (const page of [...pages, "src/app/app/layout.tsx"]) {
      const src = stripComments(read(page));
      expect(src).not.toMatch(/searchParams[^;]*\borgId\b/);
      expect(src).not.toMatch(/headers\(\)[^;]*\borgId\b/);
    }
  });
});

describe("no component in WP20's slot imports src/server (DESIGN §3.1)", () => {
  const components = [
    ...filesUnder("src/components/app-shell", /\.tsx?$/),
    ...filesUnder("src/components/auth", /\.tsx?$/),
    ...filesUnder("src/components/onboarding", /\.tsx?$/),
    ...filesUnder("src/components/runs", /\.tsx?$/),
    ...filesUnder("src/components/settings", /\.tsx?$/),
    ...filesUnder("src/client/app", /\.tsx?$/),
  ];

  it.each(components)("%s", (file) => {
    const src = stripComments(read(file));
    expect(src).not.toMatch(/from\s+["'](@\/server\/|\.\.\/\.\.\/server\/)/);
  });
});

describe("the banned words (TASKS-v3 §2 rule 19)", () => {
  const BANNED = ["no-code", "drag-and-drop", "canvas"];
  const files = OWNED.flatMap((d) => filesUnder(d));

  it("covers WP20's whole slot", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(files)("%s", (file) => {
    const src = stripComments(read(file)).toLowerCase();
    for (const word of BANNED) expect(src).not.toContain(word);
  });
});

/**
 * Pinned by the browser pass, because neither is visible in a component test.
 *
 * A layout's `title.template` applies to its **child** segments, never to its own page, so `/app/page.tsx` fell
 * through to the root template and rendered "Overview · Baton" — SAAS §8.2 says the app is called Changeover,
 * and the overview is the first screen a judge sees. The pages outside `/app` never had a Changeover template
 * at all. Both are fixed by an `absolute` title, and this is what keeps them fixed.
 */
describe("the pages that cannot inherit a Changeover title template", () => {
  const pages = [
    "src/app/app/page.tsx",
    "src/app/start/page.tsx",
    "src/app/sign-in/page.tsx",
    "src/app/sign-up/page.tsx",
    "src/app/accept-invite/[id]/page.tsx",
  ];

  it.each(pages)("%s sets an absolute title naming Changeover", (page) => {
    const src = stripComments(read(page));
    expect(src).toMatch(/title:\s*\{\s*absolute:\s*"[^"]*Changeover"/);
  });
});
