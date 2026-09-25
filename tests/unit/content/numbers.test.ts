/**
 * WP13: `docs/pitch/numbers.md` and `src/content/numbers.ts` agree, and every number the app renders has a
 * provenance tag and a public source (TASKS-v2 WP13 acceptance: "every number in the deck and video appears in
 * numbers.md with its provenance").
 */
import { describe, expect, it } from "vitest";

import { FIELD_NOTES, LANDING, PITCH_NUMBERS, pitchNumber, plainText, renderableNumbers } from "@/content";

import { numberRows, readRepoFile, repoFileExists } from "./md";

const md = readRepoFile("docs/pitch/numbers.md");
const rows = numberRows(md);
const rowById = new Map(rows.map((r) => [r.id, r]));
const TAGS = new Set(["measured", "sourced", "assumption"]);

/** Backticked repo paths in a cell (`research/10-….md`, `docs/notes/wp5b.md`). */
const repoPaths = (cell: string) => [...cell.matchAll(/`([\w./-]+\.md)`/g)].map((m) => m[1] ?? "");

describe("docs/pitch/numbers.md", () => {
  it("has rows, unique ids and a valid tag on every row", () => {
    expect(rows.length).toBeGreaterThanOrEqual(30);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) expect(TAGS.has(r.tag), `${r.id} tag "${r.tag}"`).toBe(true);
  });

  it("only measured numbers may be pending, and pending rows still say how they will be measured", () => {
    for (const r of rows.filter((x) => x.number === "pending")) {
      expect(r.tag, r.id).toBe("measured");
      expect(r.provenance.length, r.id).toBeGreaterThan(20);
    }
  });

  it("headline metrics are stated as n runs over k distinct recorded takes", () => {
    for (const id of ["N-facts-at-pass", "N-reasked", "N-verbatim", "N-dead-air-p50"]) {
      expect(rowById.get(id)?.provenance, id).toContain("n runs over k distinct recorded takes");
    }
  });

  it("sourced rows carry a URL (or point at the section that lists them)", () => {
    for (const r of rows.filter((x) => x.tag === "sourced")) {
      expect(/https?:\/\//.test(r.source) || r.source === "this section", `${r.id}: ${r.source}`).toBe(true);
    }
  });

  it("measured rows with a value cite a public file in this repo that exists", () => {
    for (const r of rows.filter((x) => x.tag === "measured" && x.number !== "pending")) {
      const paths = repoPaths(r.source);
      expect(paths.length, `${r.id} cites no file`).toBeGreaterThan(0);
      for (const p of paths) {
        expect(repoFileExists(p), `${r.id}: ${p} missing`).toBe(true);
        expect(/^research\/(?!10)/.test(p), `${r.id}: ${p} is private research`).toBe(false);
      }
    }
  });

  it("assumption rows state their basis", () => {
    for (const r of rows.filter((x) => x.tag === "assumption")) expect(r.provenance.length, r.id).toBeGreaterThan(20);
  });

  it("keeps freed rep time locked until the s01 handoff line is confirmed", () => {
    expect(rowById.get("N-tail-cost")?.provenance).toContain("LOCKED");
    expect(md).toMatch(/Status of the s01 handoff line \(rule 3\):\*\* unconfirmed/);
  });
});

describe("src/content/numbers.ts mirrors numbers.md", () => {
  it("every registry entry has a row with the same tag, and the same value (or pending)", () => {
    for (const n of PITCH_NUMBERS) {
      const row = rowById.get(n.id);
      expect(row, `${n.id} missing from numbers.md`).toBeDefined();
      if (!row) continue;
      expect(row.tag, n.id).toBe(n.tag);
      if (n.value === null) expect(row.number, n.id).toBe("pending");
      else expect(row.number, n.id).toContain(n.value);
    }
  });

  it("registry sources exist: URLs for sourced numbers, public repo files for measured ones", () => {
    for (const n of PITCH_NUMBERS as readonly { id: string; tag: string; value: string | null; source?: string }[]) {
      if (n.tag === "measured" && n.value === null) continue;
      expect(n.source, n.id).toBeTruthy();
      const src = n.source ?? "";
      if (/^https?:\/\//.test(src)) continue;
      expect(repoFileExists(src), `${n.id}: ${src}`).toBe(true);
      expect(/^research\/(?!10)/.test(src), `${n.id}: private research`).toBe(false);
    }
  });

  it("never carries a freed-rep-time number", () => {
    expect(PITCH_NUMBERS.some((n) => /tail-cost|freed|rep-min/.test(n.id))).toBe(false);
  });

  it("pitchNumber throws on unknown ids; renderableNumbers drops unmeasured ones", () => {
    expect(() => pitchNumber("N-nope")).toThrow(/unknown/);
    expect(renderableNumbers(["N-reasked", "N-va-ready"]).map((n) => n.id)).toEqual(["N-va-ready"]);
  });
});

describe("content references resolve", () => {
  it("the numbers row shows recorded-take metrics only, and its fallback has values", () => {
    for (const id of LANDING.numbersRow.ids) expect(pitchNumber(id).tag, id).toBe("measured");
    for (const id of LANDING.numbersRow.fallbackIds) expect(pitchNumber(id).value, id).not.toBeNull();
  });

  it("each field note quotes its numbers verbatim", () => {
    for (const note of FIELD_NOTES) {
      const text = plainText(note.finding);
      for (const id of note.numberIds ?? []) {
        const value = pitchNumber(id).value;
        expect(value, id).not.toBeNull();
        expect(text, `${id} in "${text}"`).toContain(value ?? "");
      }
    }
  });
});
