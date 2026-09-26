/**
 * QA-FIX (docs/notes/qa-fix.md): `/` exists and renders WP13's copy.
 *
 * Both QA passes opened with the same finding: `GET /` answered Next's generic 404, because `src/app/page.tsx`
 * had never existed on any branch — `git log --all -- src/app/page.tsx` was empty. `src/content/landing.ts` and
 * `src/content/about.ts` were written, reviewed, and enforced by `tests/unit/content/wording.test.ts`, and not
 * one word of them reached a browser. The sign-out button's redirect target 404'd for the same reason.
 *
 * So this file guards two different things:
 *  1. the **route file exists** — the cheap structural check that the 404 cannot come back;
 *  2. the page **renders the content module**, rather than a copy of it typed into JSX where the wording test
 *     cannot see it. Every assertion below reads its expected value out of `@/content`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ABOUT, LANDING, plainText } from "@/content";
import { Landing } from "@/components/marketing/landing";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const CTA = "/call/s01?express=1";
const html = renderToStaticMarkup(<Landing ctaHref={CTA} />);

/** Text as a reader sees it: tags dropped, entities undone, whitespace collapsed. */
const text = html
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x27;|&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&")
  .replace(/&#x2F;/g, "/")
  .replace(/\s+/g, " ")
  // Tag boundaries inside a sentence ("<strong>relay agents</strong>:") leave a space before the punctuation.
  .replace(/ ([,.;:])/g, "$1");

describe("the `/` route", () => {
  it("exists (the missing file was blocker #1 in both QA reports)", () => {
    expect(existsSync(join(ROOT, "src/app/page.tsx"))).toBe(true);
  });

  it("renders the content module instead of its own copy of the words", () => {
    const src = readFileSync(join(ROOT, "src/app/page.tsx"), "utf8");
    expect(src).toContain("@/content");
    expect(src).toContain("@/components/marketing/landing");
    // The h1 is a contract (`H1` in landing.ts); a literal here would drift out of the wording test's reach.
    expect(src).not.toContain(LANDING.hero.h1);
  });
});

describe("the landing page body", () => {
  it("shows the hero, the subline and the primary CTA's own label", () => {
    expect(text).toContain(LANDING.hero.h1);
    expect(text).toContain(plainText(LANDING.hero.subline).slice(0, 60).replace(/ ([,.;:])/g, "$1"));
    expect(text).toContain(LANDING.hero.primaryCta.label);
    expect(html).toContain(`href="${CTA}"`);
  });

  it("carries the provenance banner and the qualifiers next to the CTA (P§12.1: never an unlabelled claim)", () => {
    expect(text).toContain(LANDING.hero.primaryCta.provenanceBanner.slice(0, 60));
    for (const d of LANDING.hero.primaryCta.details) expect(text).toContain(d);
  });

  it("renders every pipeline step with its exact AssemblyAI product name", () => {
    for (const step of LANDING.pipeline.steps) {
      expect(text).toContain(step.title);
      expect(text).toContain(step.product);
    }
  });

  it("renders the directions strip with the market-scan wording and its footnote", () => {
    for (const d of LANDING.directions.items) expect(text).toContain(d.label);
    expect(text).toContain("not found in our market scan");
    expect(text).toContain(LANDING.directions.footnote.slice(0, 50));
  });

  it("never renders a headline metric that has not been measured", () => {
    // Every `PitchNumber` with `value: null` must be absent, title and all (P§1.4).
    expect(text).not.toContain("null");
    expect(text).toContain(LANDING.numbersRow.fallbackTitle);
  });

  it("renders the gallery, the honest limits and the about sections", () => {
    for (const card of LANDING.gallery.cards) expect(text).toContain(card.title);
    expect(text).toContain(LANDING.limits.title);
    for (const item of LANDING.limits.items) expect(text).toContain(item.slice(0, 40));
    for (const s of ABOUT.sections) expect(text).toContain(s.title);
  });

  it("offers both ways in: the guest start and the account", () => {
    expect(html).toContain('href="/start"');
    expect(html).toContain('href="/sign-in"');
  });

  it("swaps the secondary label when the Studio ships read-only (P§13.4)", () => {
    expect(text).toContain(LANDING.hero.secondaryLink.label);
    const readOnly = renderToStaticMarkup(<Landing ctaHref={CTA} studioWritable={false} />);
    expect(readOnly).toContain(LANDING.hero.secondaryLink.fallbackLabel);
  });

  it("has exactly one <main> and labels every section (axe: landmark-one-main, region)", () => {
    expect(html.match(/<main[\s>]/g) ?? []).toHaveLength(1);
    const sections = html.match(/<section[^>]*>/g) ?? [];
    expect(sections.length).toBeGreaterThan(4);
    for (const s of sections) expect(s, s).toContain("aria-labelledby=");
    // Every `aria-labelledby` target exists on the page.
    for (const id of sections.map((s) => /aria-labelledby="([^"]+)"/.exec(s)?.[1])) {
      expect(html, String(id)).toContain(`id="${id}"`);
    }
  });

  it("renders no raw HTML from the copy (RichText is rendered as elements, never injected)", () => {
    expect(html).not.toContain("dangerouslySetInnerHTML");
    expect(html).toContain("<strong");
  });
});
