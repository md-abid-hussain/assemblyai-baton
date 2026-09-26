/**
 * components/marketing/landing.tsx - the landing page body (P§12.1–P§12.2), rendered by `/` (`src/app/page.tsx`).
 *
 * **Every word on this page comes from `src/content/**`.** WP13 owns the copy and `tests/unit/content/wording.test.ts`
 * enforces the naming and claim rules over it; a sentence typed here instead would be a marketing claim nothing
 * checks. The only strings in this file are the two nav actions and the section plumbing.
 *
 * The component is **synchronous and takes its links as props**, so `renderToStaticMarkup` can assert the whole
 * page in a unit test (`tests/unit/app/landing-page.test.tsx`) without a server, a database or a fetch. `/` does
 * the one asynchronous thing — resolving the featured call — and passes the href in.
 *
 * Landmarks are deliberate (`<main>` once, every section labelled): the break-it pass's axe run found
 * `landmark-one-main` and two `region` violations on this page's absence, and a page made of unlabelled `<div>`s
 * would have reproduced them.
 */
import Link from "next/link";

import { ABOUT, LANDING, plainText, renderableNumbers } from "@/content";

import { Rich } from "./rich-text";
import { StatusPill } from "./status-pill";

export interface LandingProps {
  /** Where "Watch the handoff" goes: the featured recorded call in Express mode. */
  ctaHref: string;
  /** False when the Studio ships read-only (P§13.4 Baton-first fallback), which swaps the secondary label. */
  studioWritable?: boolean;
}

const SECTION = "border-border/60 border-t px-4 py-14 sm:px-6";
const INNER = "mx-auto w-full max-w-5xl";

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="text-xl font-semibold tracking-tight sm:text-2xl">
      {children}
    </h2>
  );
}

export function Landing({ ctaHref, studioWritable = true }: LandingProps) {
  const { hero, pipeline, directions, numbersRow, gallery, fieldNotes, limits, footer } = LANDING;
  const headline = renderableNumbers(numbersRow.ids);
  const numbers = headline.length > 0 ? headline : renderableNumbers(numbersRow.fallbackIds);
  const numbersTitle = headline.length > 0 ? numbersRow.title : numbersRow.fallbackTitle;

  return (
    <div className="bg-background text-foreground min-h-dvh">
      <header className="border-border/60 border-b px-4 py-3 sm:px-6">
        <nav aria-label="Main" className={`${INNER} flex items-center justify-between gap-4`}>
          <span className="text-sm font-semibold tracking-tight">Changeover</span>
          <div className="flex items-center gap-2">
            <Link
              href="/sign-in"
              className="hover:bg-accent inline-flex h-9 items-center rounded-md px-3 text-sm font-medium transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/start"
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium transition-colors"
            >
              Try it free
            </Link>
          </div>
        </nav>
      </header>

      <main>
        {/* ---------------------------------------------------------------------------------------- hero */}
        <section aria-labelledby="hero-title" className="px-4 py-14 sm:px-6 sm:py-20">
          <div className={`${INNER} space-y-6`}>
            <StatusPill copy={LANDING.statusPill} />
            <h1 id="hero-title" className="max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
              {hero.h1}
            </h1>
            <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg">
              <Rich text={hero.subline} />
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <Link
                href={ctaHref}
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-11 items-center rounded-md px-5 text-sm font-medium transition-colors"
              >
                {hero.primaryCta.label}
              </Link>
              <Link
                href={hero.secondaryLink.href}
                className="hover:bg-accent inline-flex h-11 items-center rounded-md border px-5 text-sm font-medium transition-colors"
              >
                {studioWritable ? hero.secondaryLink.label : hero.secondaryLink.fallbackLabel}
              </Link>
            </div>
            <p className="text-muted-foreground text-xs">{hero.primaryCta.details.join(" · ")}</p>

            <figure className="border-border bg-muted/40 rounded-xl border p-4">
              {hero.passLoop.videoSrc ? (
                <video
                  className="w-full rounded-lg"
                  src={hero.passLoop.videoSrc}
                  poster={hero.passLoop.posterSrc ?? undefined}
                  aria-label={hero.passLoop.alt}
                  autoPlay
                  loop
                  muted
                  playsInline
                />
              ) : (
                <p className="text-muted-foreground text-sm text-pretty">{hero.passLoop.alt}</p>
              )}
              <figcaption className="text-muted-foreground mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {hero.passLoop.captions.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </figcaption>
            </figure>
            <p className="text-muted-foreground max-w-3xl text-xs text-pretty">{hero.primaryCta.provenanceBanner}</p>
          </div>
        </section>

        {/* ------------------------------------------------------------------------------------ pipeline */}
        <section aria-labelledby="pipeline-title" className={SECTION}>
          <div className={`${INNER} space-y-6`}>
            <SectionHeading id="pipeline-title">{pipeline.title}</SectionHeading>
            <ol className="grid gap-4 sm:grid-cols-3">
              {pipeline.steps.map((step) => (
                <li key={step.key} className="border-border rounded-xl border p-4">
                  <h3 className="text-sm font-semibold">{step.title}</h3>
                  <p className="text-muted-foreground mt-1 text-xs font-medium">{step.product}</p>
                  <p className="mt-3 text-sm text-pretty">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ---------------------------------------------------------------------------------- directions */}
        <section aria-labelledby="directions-title" className={SECTION}>
          <div className={`${INNER} space-y-6`}>
            <SectionHeading id="directions-title">{directions.title}</SectionHeading>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {directions.items.map((d) => (
                <li
                  key={d.label}
                  className={`rounded-xl border p-4 ${d.ours ? "border-foreground/40 bg-muted/50" : "border-border"}`}
                >
                  <p className="text-sm font-semibold">{d.label}</p>
                  <p className="text-muted-foreground mt-1 text-sm text-pretty">{d.example}</p>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground max-w-3xl text-xs text-pretty">{directions.footnote}</p>
          </div>
        </section>

        {/* ------------------------------------------------------------------------------------- numbers */}
        {numbers.length > 0 ? (
          <section aria-labelledby="numbers-title" className={SECTION}>
            <div className={`${INNER} space-y-6`}>
              <SectionHeading id="numbers-title">{numbersTitle}</SectionHeading>
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {numbers.map((n) => (
                  <div key={n.id} className="border-border rounded-xl border p-4">
                    <dt className="text-muted-foreground text-xs">{n.label}</dt>
                    <dd className="cx-num mt-1 text-lg font-semibold">{n.value}</dd>
                    <p className="text-muted-foreground mt-2 text-xs text-pretty">{n.provenance}</p>
                  </div>
                ))}
              </dl>
              <p className="text-muted-foreground text-xs">{numbersRow.note}</p>
            </div>
          </section>
        ) : null}

        {/* ------------------------------------------------------------------------------------- gallery */}
        <section aria-labelledby="gallery-title" className={SECTION}>
          <div className={`${INNER} space-y-6`}>
            <SectionHeading id="gallery-title">{gallery.title}</SectionHeading>
            <ul className="grid gap-4 lg:grid-cols-3">
              {gallery.cards.map((card) => (
                <li key={card.slug} className="border-border flex flex-col rounded-xl border p-4">
                  <p className="text-muted-foreground text-xs">{card.badge}</p>
                  <h3 className="mt-1 text-sm font-semibold">{card.title}</h3>
                  <p className="text-muted-foreground mt-1 text-xs">Ends at: {card.act}</p>
                  <p className="mt-3 grow text-sm text-pretty">{card.body}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {card.badge.startsWith("Flagship") ? (
                      <Link
                        href={ctaHref}
                        className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-md px-3 text-sm font-medium transition-colors"
                      >
                        {gallery.runLabel}
                      </Link>
                    ) : null}
                    <Link
                      href="/app/relays"
                      className="hover:bg-accent inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors"
                    >
                      {gallery.openLabel}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* --------------------------------------------------------------------------------- field notes */}
        <section aria-labelledby="notes-title" className={SECTION}>
          <div className={`${INNER} space-y-6`}>
            <SectionHeading id="notes-title">{fieldNotes.title}</SectionHeading>
            <p className="text-muted-foreground max-w-3xl text-sm text-pretty">{fieldNotes.intro}</p>
            <ul className="space-y-4">
              {fieldNotes.items.map((note) => (
                <li key={note.ref} className="border-border rounded-xl border p-4">
                  <p className="text-muted-foreground cx-num text-xs">{note.date}</p>
                  <p className="mt-1 text-sm text-pretty">
                    <Rich text={note.finding} />
                  </p>
                  <p className="text-muted-foreground mt-2 text-sm text-pretty">{note.consequence}</p>
                  <p className="text-muted-foreground mt-2 text-xs">{note.ref}</p>
                </li>
              ))}
            </ul>
            {fieldNotes.iterationLog.length > 0 ? (
              <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
                {fieldNotes.iterationLog.map((line) => (
                  <li key={line} className="text-pretty">
                    {line}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>

        {/* ----------------------------------------------------------------------------- how a relay runs */}
        {ABOUT.sections.map((s) => (
          <section key={s.id} aria-labelledby={`about-${s.id}`} className={SECTION}>
            <div className={`${INNER} space-y-4`}>
              <SectionHeading id={`about-${s.id}`}>{s.title}</SectionHeading>
              {s.paragraphs.map((para) => (
                <p key={plainText(para).slice(0, 40)} className="max-w-3xl text-sm text-pretty">
                  <Rich text={para} />
                </p>
              ))}
            </div>
          </section>
        ))}

        {/* -------------------------------------------------------------------------------------- limits */}
        <section aria-labelledby="limits-title" className={SECTION}>
          <div className={`${INNER} space-y-4`}>
            <SectionHeading id="limits-title">{limits.title}</SectionHeading>
            <ul className="text-muted-foreground max-w-3xl list-disc space-y-2 pl-5 text-sm">
              {limits.items.map((item) => (
                <li key={item} className="text-pretty">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-border/60 border-t px-4 py-8 sm:px-6">
        <div className={`${INNER} text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-xs`}>
          <a href={footer.githubHref} className="underline underline-offset-4" rel="noreferrer noopener">
            GitHub
          </a>
          <span>{footer.builtFor}</span>
          <span>{footer.license}</span>
        </div>
      </footer>
    </div>
  );
}
