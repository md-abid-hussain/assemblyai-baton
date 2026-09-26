/**
 * `/` — the landing page (P§12.1–P§12.2, WP7b).
 *
 * **This file did not exist.** `src/app/page.tsx` was missing on every branch, so the bare domain answered Next's
 * generic 404 — and so did the redirect the sign-out button sends people to. `src/content/landing.ts` and
 * `src/content/about.ts` were written, reviewed and enforced by `tests/unit/content/wording.test.ts`, and nothing
 * rendered a word of them. Both QA passes made it their first finding; it is fixed here (docs/notes/qa-fix.md).
 *
 * The copy stays in `src/content/**` (WP13's) and the markup in `src/components/marketing/**` (WP7b's). This file
 * is the route: metadata, and the one asynchronous thing the page needs — which recorded call the primary CTA
 * opens. `CtaTarget.kind === "featured-call"` resolves to the `featured` entry of `src/generated/calls.json`
 * (`contracts/ext/wp13-content.ts`), and `/call` already does exactly that lookup and redirects, so an absent
 * manifest degrades to that route's own fallback instead of a dead link here.
 */
import type { Metadata } from "next";

import { Landing } from "@/components/marketing/landing";
import { LANDING } from "@/content";

import { lookupCall } from "./call/call-entry";

export const metadata: Metadata = {
  title: { absolute: LANDING.meta.title },
  description: LANDING.meta.description,
  robots: { index: true, follow: true },
};

// The manifest is read per request (the same rule `/call` states): never freeze a build-time call id.
export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const { featuredId } = await lookupCall(null).catch(() => ({ featuredId: null as string | null }));
  const express = LANDING.hero.primaryCta.target.express ? "?express=1" : "";
  const ctaHref = featuredId ? `/call/${encodeURIComponent(featuredId)}${express}` : "/call";

  return <Landing ctaHref={ctaHref} />;
}
