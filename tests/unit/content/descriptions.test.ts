/**
 * WP13: the lablab copy in `docs/pitch/descriptions.md` fits lablab's limits (title ≤ 50 characters, short ≤ 255
 * characters, long ≥ 100 words), names the AssemblyAI products, and quotes only numbers from `numbers.md`.
 */
import { describe, expect, it } from "vitest";

import { numberRows, readRepoFile, textBlockUnder, wordCount } from "./md";

const md = readRepoFile("docs/pitch/descriptions.md");
const title = textBlockUnder(md, "Title");
const short = textBlockUnder(md, "Short description");
const long = textBlockUnder(md, "Long description");
const techTags = textBlockUnder(md, "Technology tags");
const categoryTags = textBlockUnder(md, "Category tags");

/** Characters as a person counts them (code points), which is also the stricter count for "→" and "·". */
const chars = (s: string) => [...s].length;

describe("lablab title", () => {
  it("is at most 50 characters and leads with the product name", () => {
    expect(chars(title)).toBeLessThanOrEqual(50);
    expect(title.startsWith("Changeover")).toBe(true);
    expect(title).not.toMatch(/Changeover AI\b/);
  });
});

describe("lablab short description", () => {
  it("is at most 255 characters", () => {
    expect(chars(short)).toBeLessThanOrEqual(255);
  });

  it("names the AssemblyAI products explicitly (P§12.2)", () => {
    expect(short).toContain("AssemblyAI Universal-3.5 Pro Realtime");
    expect(short).toContain("Voice Agent API");
    expect(short).toContain("async transcription");
  });

  it("pairs relay agents with human→AI handoff and uses the button's name", () => {
    expect(short).toMatch(/relay agents?: human→AI handoff/);
    expect(short).toContain("Pass the baton");
  });
});

describe("lablab long description", () => {
  it("is at least 100 words", () => {
    expect(wordCount(long)).toBeGreaterThanOrEqual(100);
  });

  it("names the flagship in full, says what is simulated, and names the three AssemblyAI products", () => {
    expect(long).toContain("Baton · insurance add-a-driver");
    expect(long).toContain("recorded role-play");
    expect(long).toMatch(/simulated/);
    for (const p of ["Universal-3.5 Pro Realtime", "Voice Agent", "async transcription"]) expect(long).toContain(p);
  });

  it("quotes only numbers that numbers.md carries with a value", () => {
    const shown = new Set(numberRows(readRepoFile("docs/pitch/numbers.md")).filter((r) => r.number !== "pending").map((r) => r.number));
    const quoted = [...long.matchAll(/\$?\d+(?:[.,]\d+)?%?/g)].map((m) => m[0]).filter((q) => q.includes("%") || q.startsWith("$"));
    for (const q of quoted) expect([...shown].some((s) => s.includes(q)), `${q} not in numbers.md`).toBe(true);
  });
});

describe("tags", () => {
  it("technology tags name the AssemblyAI products and OpenAI", () => {
    for (const t of ["AssemblyAI Voice Agent API", "Universal-3.5 Pro Realtime", "AssemblyAI async transcription", "OpenAI"]) {
      expect(techTags.split(", ")).toContain(t);
    }
  });

  it("category tags include Voice AI and the wedge vertical", () => {
    const cats = categoryTags.split(", ");
    expect(cats).toContain("Voice AI");
    expect(cats).toContain("Insurance");
  });
});
