/**
 * `/legal/terms` (WP7b·2 owns the real page).
 *
 * **A placeholder, and it says so.** The sign-up form links here — "by creating an account you agree to the
 * terms" with a 404 behind it is the worst possible version of this page, and it sat on the judge path's
 * step 8. Until the QA-FIX pass that is exactly what it was.
 *
 * **It invents no legal text.** Every sentence below is either WP13's reviewed copy (`LANDING.limits` and
 * `ABOUT`'s privacy section, both covered by `tests/unit/content/wording.test.ts`) or the plain statement that
 * this is a hackathon demo with no commercial agreement behind it. Writing plausible-looking terms of service
 * would be worse than having none: it would be a promise nobody made.
 */
import type { Metadata } from "next";
import Link from "next/link";

import { Rich } from "@/components/marketing/rich-text";
import { ABOUT, LANDING } from "@/content";

export const metadata: Metadata = {
  title: { absolute: "Terms · Changeover" },
  description: "What this demo is, what it does with what you type, and what it does not promise.",
  robots: { index: false, follow: true },
};

const privacy = ABOUT.sections.find((s) => s.id === "privacy");

export default function TermsPage() {
  return (
    <main className="bg-background text-foreground min-h-dvh px-4 py-14 sm:px-6">
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <header className="space-y-2">
          <Link href="/" className="text-muted-foreground text-sm underline underline-offset-4">
            Changeover
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Terms</h1>
          <p className="text-muted-foreground text-sm text-pretty">
            Changeover is a hackathon demo, not a commercial service. There is no contract behind this page, no
            fee, no service level and no warranty — and no lawyer has written one for it. What follows is the
            plain description of what the demo does, which is the only thing we can honestly promise.
          </p>
        </header>

        <section aria-labelledby="limits-title" className="space-y-3">
          <h2 id="limits-title" className="text-lg font-semibold tracking-tight">
            {LANDING.limits.title}
          </h2>
          <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-sm">
            {LANDING.limits.items.map((item) => (
              <li key={item} className="text-pretty">
                {item}
              </li>
            ))}
          </ul>
        </section>

        {privacy ? (
          <section aria-labelledby="privacy-title" className="space-y-3">
            <h2 id="privacy-title" className="text-lg font-semibold tracking-tight">
              {privacy.title}
            </h2>
            {privacy.paragraphs.map((p, i) => (
              <p key={i} className="text-sm text-pretty">
                <Rich text={p} />
              </p>
            ))}
          </section>
        ) : null}

        <p className="text-muted-foreground text-sm text-pretty">
          Please use test data only. If you would like something removed, the repository is at{" "}
          <a href={LANDING.footer.githubHref} rel="noreferrer noopener" className="underline underline-offset-4">
            GitHub
          </a>
          .
        </p>
      </div>
    </main>
  );
}
