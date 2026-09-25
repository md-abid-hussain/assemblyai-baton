/**
 * WP13: the public copy follows the naming and claim rules (P§1.1, P§1.4, P§12, `docs/pitch/positioning.md`), and no
 * public pitch file leaks the private research notes (research/ is private except research/10*).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ABOUT, FIELD_NOTES, ITERATION_LOG, LANDING, LLM_GATEWAY_LINE, PITCH_NUMBERS, plainText, statusPillText,
} from "@/content";

import { ROOT, readRepoFile, repoFileExists, textBlockUnder } from "./md";

/** Every string reachable from a value (objects, arrays, rich text). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** Rich text is split into parts; join each paragraph so phrase checks see whole sentences. */
const aboutParagraphs = ABOUT.sections.flatMap((s) => [s.title, ...s.paragraphs.map(plainText)]);
const fieldNoteTexts = FIELD_NOTES.flatMap((n) => [plainText(n.finding), n.consequence, n.ref]);

const descriptions = readRepoFile("docs/pitch/descriptions.md");
const lablab = ["Title", "Short description", "Long description"].map((h) => textBlockUnder(descriptions, h));

const APP_COPY: string[] = [
  ...strings({ ...LANDING, hero: { ...LANDING.hero, subline: plainText(LANDING.hero.subline) }, fieldNotes: null }),
  ...aboutParagraphs,
  ...fieldNoteTexts,
  ...ITERATION_LOG,
  LLM_GATEWAY_LINE,
  ...PITCH_NUMBERS.flatMap((n) => [n.label, n.provenance]),
];
const PUBLIC_COPY = [...APP_COPY, ...lablab];

const BANNED: { name: string; re: RegExp }[] = [
  { name: "first-claim", re: /\b(?:first[- ]ever|(?:the )?first (?:to|platform|product|studio|company|tool|of its kind))\b/i },
  { name: "only-claim", re: /\b(?:the only|only (?:platform|product|tool|studio|company|one))\b/i },
  { name: "absolute-market-claim", re: /\b(?:no one else|nobody else|every builder|all builders)\b/i },
  { name: "real-call", re: /\breal calls?\b|\breal customers?\b/i },
  { name: "bot", re: /\bbots?\b/i },
  { name: "Relay Studio", re: /\bRelay Studio\b/ },
  { name: "Changeover AI", re: /\bChangeover AI\b/ },
  { name: "Transfer button", re: /\bTransfer\b/ },
  { name: "capitalised Relay mid-sentence", re: /[a-z,;] Relay\b/ },
  { name: "not-found wording", re: /not found (?!in our market scan)/i },
  { name: "legal claim", re: /\b(?:legally )?compliant\b/i },
];

describe("public copy wording (P§1.4)", () => {
  it("collects a meaningful amount of copy", () => {
    expect(PUBLIC_COPY.length).toBeGreaterThan(60);
  });

  it("the detectors catch the banned forms and pass the allowed ones", () => {
    const flagged = (s: string) => BANNED.filter((b) => b.re.test(s)).map((b) => b.name);
    expect(flagged("The first platform to do human-to-AI handoff")).toContain("first-claim");
    expect(flagged("We are the only studio for this")).toContain("only-claim");
    expect(flagged("Every builder hands calls to humans")).toContain("absolute-market-claim");
    expect(flagged("Watch a real call")).toContain("real-call");
    expect(flagged("Our bot finishes it")).toContain("bot");
    expect(flagged("Open Relay Studio")).toContain("Relay Studio");
    expect(flagged("Press Transfer")).toContain("Transfer button");
    expect(flagged("build a Relay today")).toContain("capitalised Relay mid-sentence");
    expect(flagged("not found anywhere else")).toContain("not-found wording");
    expect(flagged("The first update, the first viewport; asks only for what is missing; not found in our market scan"))
      .toEqual([]);
  });

  for (const { name, re } of BANNED) {
    it(`never uses ${name}`, () => {
      const hits = PUBLIC_COPY.filter((s) => re.test(s));
      expect(hits).toEqual([]);
    });
  }

  it('always names the flagship "Baton · insurance add-a-driver" (the fallback link may say "blueprint behind Baton")', () => {
    for (const s of PUBLIC_COPY) {
      const all = (s.match(/\bBaton\b/g) ?? []).length;
      const ok = (s.match(/Baton · insurance add-a-driver|blueprint behind Baton/g) ?? []).length;
      expect(all, s).toBe(ok);
    }
  });

  it("pairs the first relay agent with human→AI handoff (hero, short and long description)", () => {
    for (const text of [plainText(LANDING.hero.subline), lablab[1] ?? "", lablab[2] ?? ""]) {
      const i = text.search(/relay agents?/);
      expect(i, text).toBeGreaterThanOrEqual(0);
      expect(text.slice(i, i + 40), text).toContain("human→AI handoff");
    }
  });

  it("the direction claim carries its market-scan qualifier", () => {
    const ours = LANDING.directions.items.filter((d) => d.ours);
    expect(ours).toHaveLength(1);
    expect(ours[0]?.example).toBe("not found in our market scan");
    expect(LANDING.directions.items).toHaveLength(4);
  });
});

describe("first viewport (P§12.1)", () => {
  const hero = [
    LANDING.hero.h1,
    plainText(LANDING.hero.subline),
    LANDING.hero.primaryCta.label,
    ...LANDING.hero.primaryCta.details,
    LANDING.hero.secondaryLink.label,
    ...Object.values(LANDING.statusPill),
  ].join(" \n ");

  it("uses the PLATFORM H1 and one primary CTA with the honest qualifiers", () => {
    expect(LANDING.hero.h1).toBe("Your rep starts the call. AI finishes it.");
    expect(LANDING.hero.primaryCta.label).toBe("Watch the handoff");
    expect(LANDING.hero.primaryCta.details).toEqual(["recorded role-play over a real phone line", "no signup", "no mic", "~3 min"]);
    expect(LANDING.hero.primaryCta.target).toEqual({ kind: "featured-call", express: true });
  });

  it("keeps console and Studio vocabulary out of the first viewport", () => {
    for (const term of ["human half", "AI half", "blueprint", "provenance", "Changeover Studio", "Baton"]) {
      expect(hero.includes(term), term).toBe(false);
    }
  });

  it("the pass loop has an accessible description even before the MP4 exists", () => {
    expect(LANDING.hero.passLoop.alt.length).toBeGreaterThan(40);
    expect(LANDING.hero.passLoop.captions.length).toBeGreaterThanOrEqual(2);
  });
});

describe("gallery and limits", () => {
  it("only the flagship claims recorded role-play; the others say simulated or not yet run", () => {
    for (const c of LANDING.gallery.cards) {
      if (c.slug === "baton-add-driver") expect(c.badge).toBe("Flagship · recorded role-play");
      else expect(c.badge).not.toContain("recorded");
    }
  });

  it("honest limits cover 8 kHz audio, replay windows, simulated audio, fictional data and deletion", () => {
    const limits = LANDING.limits.items.join(" ");
    for (const k of ["8 kHz", "labelled recording", "simulated", "fictional", "not legal advice", "7 days"]) {
      expect(limits, k).toContain(k);
    }
  });

  it("privacy copy never claims DELETE ends a live session (wp8-to-wp13)", () => {
    const privacy = PUBLIC_COPY.join(" \n ");
    expect(privacy).not.toMatch(/delet\w* (?:ends|stops) (?:a |the )?live/i);
    expect(plainText(ABOUT.sections.find((s) => s.id === "privacy")?.paragraphs[0] ?? [])).toContain("after 7 days");
  });
});

describe("field notes (P§12.5)", () => {
  it("has 8–11 dated items, each pointing at a public file that exists", () => {
    expect(FIELD_NOTES.length).toBeGreaterThanOrEqual(8);
    expect(FIELD_NOTES.length).toBeLessThanOrEqual(11);
    for (const n of FIELD_NOTES) {
      expect(n.date).toMatch(/^2026-09-\d\d$/);
      const files = [...n.ref.matchAll(/((?:research|docs\/notes)\/[\w./-]+\.md)/g)].map((m) => m[1] ?? "");
      expect(files.length, n.ref).toBeGreaterThan(0);
      for (const f of files) {
        expect(repoFileExists(f), f).toBe(true);
        expect(/^research\/(?!10)/.test(f), f).toBe(false);
      }
    }
  });

  it("has a three-line iteration log", () => {
    expect(ITERATION_LOG).toHaveLength(3);
  });
});

describe("status pill", () => {
  const copy = LANDING.statusPill;

  it("says live, replay with the next IST window, or unknown when the API is down", () => {
    expect(statusPillText(copy, null)).toBe(copy.unknown);
    expect(statusPillText(copy, { aiHalfAvailable: true })).toBe("Live AI calls available");
    expect(statusPillText(copy, { aiHalfAvailable: false, nextLiveAt: "2026-09-25T12:00:00Z" })).toBe(
      "Replay mode · next live window 17:30 IST",
    );
    expect(statusPillText(copy, { aiHalfAvailable: false, nextLiveAt: null })).toBe("Replay mode");
    expect(statusPillText(copy, { aiHalfAvailable: false, nextLiveAt: "not a date" })).toBe("Replay mode");
  });
});

describe("research privacy", () => {
  const PUBLIC_FILES = [
    ...readdirSync(join(ROOT, "docs/pitch")).map((f) => `docs/pitch/${f}`),
    ...readdirSync(join(ROOT, "src/content")).map((f) => `src/content/${f}`),
    "src/core/contracts/ext/wp13-content.ts",
  ];

  it("no public pitch or content file cites a private research note, a pool entry or a win estimate", () => {
    for (const f of PUBLIC_FILES) {
      const text = readRepoFile(f);
      expect(text, f).not.toMatch(/research\/(?:0\d|1[1-9])\b|research\/(?:0\d|1[1-9])-/);
      expect(text, f).not.toMatch(/win[- ]?prob|probability of winning|hackathon pool|pool entr/i);
    }
  });
});
