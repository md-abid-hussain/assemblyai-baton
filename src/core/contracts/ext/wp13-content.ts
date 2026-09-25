/**
 * contracts/ext/wp13-content.ts - additive WP13 types (TASKS-v2 §2 rule 3): the shape of the typed public copy in
 * `src/content/**` that WP7b renders on `/` (the landing, with `/about` folded in, P§12.2) and that the README, the
 * slides and the video reuse. Pure: types only, no imports.
 *
 * Rules the types encode (P§1.4, P§12, TASKS-v2 WP13):
 * - every number shown to a judge is a `PitchNumber` with a provenance tag, mirrored row for row in
 *   `docs/pitch/numbers.md` (a unit test keeps the two in sync);
 * - a measured number that has not been measured yet has `value: null` and must not be rendered;
 * - rich copy is an `Inline[]`, so renderers can bold the product terms without parsing markdown.
 */

// ============================================================================================ numbers

/** measured = we measured it (states n and k); sourced = a public source (URL); assumption = our estimate. */
export type NumberTag = "measured" | "sourced" | "assumption";

export interface PitchNumber {
  /** Stable id, identical to the ID column of `docs/pitch/numbers.md` (`N-…`). */
  id: string;
  /** Short label as shown on the page ("Re-asked by the AI"). */
  label: string;
  /** Display value ("611–672 ms"). `null` = not measured yet: renderers skip it, never show a placeholder number. */
  value: string | null;
  tag: NumberTag;
  /** One line of provenance: "n runs over k distinct recorded takes", the source's name, or the assumption's basis. */
  provenance: string;
  /** Public URL, or a repo-relative path to a public file (`research/10*.md`, `docs/notes/*.md`). Required for sourced. */
  source?: string;
  /** ISO date the number was measured or the source was read. */
  asOf: string;
}

// ============================================================================================ rich text

/** Inline copy: plain text, bold (product terms, the action), or code (API names in field notes). */
export type Inline = string | { strong: string } | { code: string };
export type RichText = readonly Inline[];

// ============================================================================================ landing

/** Where the primary CTA goes. WP7b resolves `featured-call` to the `featured` entry of `src/generated/calls.json`. */
export interface CtaTarget {
  kind: "featured-call";
  /** Express = the human half starts 25 s before the pass (the default at every entry point, P§10.3). */
  express: boolean;
}

export interface LandingHero {
  h1: string;
  subline: RichText;
  passLoop: {
    /** `/landing/pass-loop.mp4` once WP13 cuts it (D3 22:00); null until then. */
    videoSrc: string | null;
    /** Still frame shown until the MP4 exists; null until a console screenshot exists. */
    posterSrc: string | null;
    /** Accessible description of the loop (used as the video's aria-label and the placeholder's text). */
    alt: string;
    /** Burned-in or track captions, in order. */
    captions: readonly string[];
  };
  primaryCta: {
    /** The button text ("Watch the handoff"). */
    label: string;
    /** The qualifiers, rendered after the label joined by " · ". */
    details: readonly string[];
    target: CtaTarget;
    /** Seconds of countdown before Express starts (P§12.1). */
    countdownSec: number;
    /** The "Full call instead" link shown during the countdown. */
    fullCallLabel: string;
    /** The provenance text shown as a banner when the run opens. */
    provenanceBanner: string;
  };
  secondaryLink: {
    label: string;
    href: string;
    /** Label used when the Studio ships read-only (Baton-first fallback, P§13.4). */
    fallbackLabel: string;
  };
}

/** Copy for the status pill (fed by `/api/status` `nextLiveAt`). `{time}` is replaced with an IST "HH:MM". */
export interface StatusPillCopy {
  live: string;
  replay: string;
  /** The API is down or unreachable (the landing still renders, WP7b acceptance 1). */
  unknown: string;
}

export interface PipelineStep {
  key: "shadow" | "pass" | "prove";
  title: string;
  /** The exact AssemblyAI product name for this step. */
  product: string;
  body: string;
}

export interface Direction {
  label: string;
  /** How the market does it ("warm transfer"); for ours, the short claim. */
  example: string;
  ours: boolean;
}

export type GalleryBadge =
  | "Flagship · recorded role-play"
  | "Template · simulated audio"
  | "Template · not yet run";

export interface GalleryCardCopy {
  /** The relay slug (`data/relays/<slug>.json`); the API's own title wins when it differs. */
  slug: string;
  title: string;
  badge: GalleryBadge;
  /** The act stage this relay shows (P8: three relays, three different act stages). */
  act: string;
  body: string;
}

export interface FieldNote {
  /** ISO date of the live test. */
  date: string;
  /** What we saw, as measured. */
  finding: RichText;
  /** What we changed because of it. */
  consequence: string;
  /** Public reference: the test id and the public file that holds the log. */
  ref: string;
  /** `PitchNumber` ids quoted in the finding (kept in sync with numbers.md by a unit test). */
  numberIds?: readonly string[];
}

export interface LandingContent {
  meta: { title: string; description: string };
  hero: LandingHero;
  statusPill: StatusPillCopy;
  pipeline: { title: string; steps: readonly PipelineStep[] };
  directions: { title: string; items: readonly Direction[]; footnote: string };
  numbersRow: {
    title: string;
    /** Headline metrics from recorded takes only. Items whose value is null are skipped. */
    ids: readonly string[];
    note: string;
    /** Shown instead while no headline metric is measured yet. */
    fallbackTitle: string;
    fallbackIds: readonly string[];
  };
  gallery: {
    title: string;
    runLabel: string;
    openLabel: string;
    cards: readonly GalleryCardCopy[];
  };
  fieldNotes: { title: string; intro: string; items: readonly FieldNote[]; iterationLog: readonly string[] };
  limits: { title: string; items: readonly string[] };
  footer: { githubHref: string; builtFor: string; license: string };
}

// ============================================================================================ about (folded into /)

export interface AboutSection {
  id: string;
  title: string;
  paragraphs: readonly RichText[];
}

export interface AboutContent {
  sections: readonly AboutSection[];
}
