/**
 * src/content/landing.ts - the landing page copy (P§12.1–P§12.2), rendered by WP7b on `/`. `/about` is folded into
 * `/` (its sections are in `about.ts`).
 *
 * Wording rules (P§1.1, P§1.4, TASKS-v2 WP13; enforced by `tests/unit/content/wording.test.ts`):
 * - the first viewport (hero + status pill) uses at most three terms: Changeover, Pass the baton, relay agent, and
 *   "relay agent" is paired with "human→AI handoff" on first use;
 * - the direction claim appears only in the directions strip, with "not found in our market scan"; never "first",
 *   "only" or "every builder";
 * - Baton is always "Baton · insurance add-a-driver"; its calls are "recorded role-play", never "real calls";
 * - every number comes from `numbers.ts` (ids), and headline metrics render only once measured.
 */
import type { LandingContent } from "@/core/contracts/ext/wp13-content";

import { FIELD_NOTES, FIELD_NOTES_INTRO, FIELD_NOTES_TITLE, ITERATION_LOG } from "./field-notes";

export const H1 = "Your rep starts the call. AI finishes it.";

export const LANDING: LandingContent = {
  meta: {
    title: "Changeover: your rep starts the call, AI finishes it",
    description:
      "Changeover builds relay agents: human→AI handoff, mid-call. AssemblyAI Universal-3.5 Pro Realtime shadows your " +
      "rep; press Pass the baton and an AssemblyAI Voice Agent finishes the call, already knowing what was said.",
  },

  hero: {
    h1: H1,
    subline: [
      "Changeover builds ",
      { strong: "relay agents" },
      ": human→AI handoff, mid-call. AssemblyAI Universal-3.5 Pro shadows your rep; press ",
      { strong: "Pass the baton" },
      " and an AssemblyAI Voice Agent takes over, already knowing everything that was said.",
    ],
    passLoop: {
      videoSrc: null,
      posterSrc: null,
      alt:
        "A call console: the case card fills with facts from the rep's side of the call, the rep presses Pass the " +
        "baton, and the AI greets the customer with those facts.",
      captions: [
        "The rep talks; the case fills in, each fact linked to its audio.",
        "Pass the baton.",
        "The AI picks up with the facts already on the card.",
      ],
    },
    primaryCta: {
      label: "Watch the handoff",
      details: ["recorded role-play over a real phone line", "no signup", "no mic", "~3 min"],
      target: { kind: "featured-call", express: true },
      countdownSec: 3,
      fullCallLabel: "Full call instead",
      provenanceBanner:
        "Recorded role-play: two consented volunteers over a real phone line; the customer and policy are fictional. " +
        "Transcription and the AI half run live on AssemblyAI inside the daily budget, and as a labelled recording outside it.",
    },
    secondaryLink: {
      label: "Build a relay →",
      href: "/studio",
      fallbackLabel: "See the blueprint behind Baton →",
    },
  },

  statusPill: {
    live: "Live AI calls available",
    replay: "Replay mode · next live window {time} IST",
    unknown: "Status unavailable · recorded runs still play",
  },

  pipeline: {
    title: "Shadow → Pass → Prove",
    steps: [
      {
        key: "shadow",
        title: "Shadow",
        product: "AssemblyAI Universal-3.5 Pro Realtime",
        body:
          "One streaming session per channel transcribes the rep and the customer separately and builds an " +
          "evidence-linked case: every fact has a status and the audio clip it came from.",
      },
      {
        key: "pass",
        title: "Pass the baton",
        product: "AssemblyAI Voice Agent API",
        body:
          "The rep presses Pass the baton. A Voice Agent takes over with the case, asks only for what is still " +
          "missing, reads the required disclosure word for word, and finishes the paperwork: payment, e-sign, confirmation.",
      },
      {
        key: "prove",
        title: "Prove it",
        product: "AssemblyAI async transcription",
        body:
          "After the call, the AI half's own recording is transcribed and checked: was the disclosure read verbatim, " +
          "and did the AI re-ask anything the customer had already said?",
      },
    ],
  },

  directions: {
    title: "Four ways a call changes hands",
    items: [
      { label: "AI → human", example: "warm transfer", ours: false },
      { label: "AI → AI", example: "squads", ours: false },
      { label: "human cues AI", example: "whisper", ours: false },
      { label: "human → AI, mid-call", example: "not found in our market scan", ours: true },
    ],
    footnote:
      "We checked 22 voice-agent, contact-center and payment vendors in September 2026, from their docs and product " +
      "pages (some only through secondary pages). A desk scan, not an exhaustive search.",
  },

  numbersRow: {
    title: "Measured on recorded role-play",
    ids: ["N-facts-at-pass", "N-reasked", "N-verbatim", "N-dead-air-p50"],
    note: "Every metric is stated as n runs over k distinct recorded takes.",
    fallbackTitle: "Measured on AssemblyAI's APIs while building",
    fallbackIds: ["N-smoke-tests", "N-va-ready", "N-stage-change", "N-per-channel"],
  },

  gallery: {
    title: "Run a relay",
    runLabel: "Run",
    openLabel: "Open in Studio",
    cards: [
      {
        slug: "baton-add-driver",
        title: "Baton · insurance add-a-driver",
        badge: "Flagship · recorded role-play",
        act: "payment",
        body:
          "An insurance rep talks through adding a teenage driver, then passes the baton. The AI confirms the open " +
          "details, reads the premium disclosure word for word, and texts the e-sign and payment link.",
      },
      {
        slug: "dental-deposit",
        title: "Dental deposit",
        badge: "Template · simulated audio",
        act: "payment",
        body:
          "A front-desk coordinator books a procedure at a fictional clinic, then passes the baton. The AI confirms " +
          "the booking and collects the deposit through a payment link.",
      },
      {
        slug: "telecom-plan-change",
        title: "Telecom plan change",
        badge: "Template · simulated audio",
        act: "e-sign",
        body:
          "A rep settles on a new plan with the customer, then passes the baton. The AI reads the plan terms and " +
          "sends an e-sign link. No payment.",
      },
    ],
  },

  fieldNotes: {
    title: FIELD_NOTES_TITLE,
    intro: FIELD_NOTES_INTRO,
    items: FIELD_NOTES,
    iterationLog: ITERATION_LOG,
  },

  limits: {
    title: "Honest limits",
    items: [
      "Recorded calls are 8 kHz phone audio. Turn detection is tuned for it, and the tuning is still provisional.",
      "This runs on free-tier credits. Live AI calls are released in four windows a day; outside a window, runs " +
        "play a labelled recording and the status pill says when the next window opens.",
      "Only Baton · insurance add-a-driver has recorded role-play calls. Every other relay runs on simulated calls " +
        "(two TTS voices), and its provenance strip says so.",
      "Customers, policies and clinics are fictional. Disclosures are samples, not legal advice. Payments use the " +
        "Polar sandbox.",
      "The AI half is recorded by AssemblyAI so we can verify it; we delete those recordings after 7 days. Please " +
        "don't share real personal information.",
      "Relays you build live in an anonymous workspace tied to this browser. It is a public demo: use test data only.",
    ],
  },

  footer: {
    githubHref: "https://github.com/md-abid-hussain/assemblyai-baton",
    builtFor: "Built for the AssemblyAI Voice Agent Hackathon",
    license: "MIT",
  },
};
