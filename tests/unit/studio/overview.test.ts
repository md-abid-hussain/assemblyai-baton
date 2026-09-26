/**
 * The Overview tab's model (SAAS §5.5, WP15·2).
 *
 * Overview is read-only, so the only thing that can be wrong with it is what it *says*. These tests pin the two
 * claims it makes that a reader would act on: which side of the baton each field sits on, and how many problems
 * block what.
 *
 * Offline, $0.
 */
import { describe, expect, it } from "vitest";

import { buildTrack, codeHref, exitLabel, joinWords, lintSummary, SET_BY_LABEL, STAGE_KIND_LABEL } from "@/client/studio/overview";
import type { Blueprint } from "@/core/contracts/v2";
import type { CodeDiagnostic } from "@/core/relay-code";

import { commentedDental, parse } from "./helpers";

const diag = (over: Partial<CodeDiagnostic> = {}): CodeDiagnostic => ({
  source: "lint", code: "L1", severity: "error", path: [], message: "m", range: null, ...over,
});

const bp: Blueprint = parse(commentedDental());

describe("buildTrack", () => {
  const track = buildTrack(bp);

  it("splits the fields at the baton: what the rep holds, and what the assistant may finish", () => {
    const repIds = track.rep.fields.map((f) => f.id);
    const aiIds = track.aiWrites.map((f) => f.id);
    expect(repIds.filter((id) => aiIds.includes(id))).toEqual([]);
    expect(repIds.length + aiIds.length).toBe(bp.fields.length);
    for (const f of track.aiWrites) {
      expect(f.setBy).toBe("ai_allowed");
      expect(f.adviceDomain).toBe(false);
    }
  });

  it("keeps a rep decision on the rep's side even when it is marked ai_allowed", () => {
    const rigged: Blueprint = {
      ...bp,
      fields: bp.fields.map((f, i) => (i === 0 ? { ...f, setBy: "ai_allowed" as const, adviceDomain: true } : f)),
    };
    const t = buildTrack(rigged);
    expect(t.rep.fields.map((f) => f.id)).toContain(rigged.fields[0]!.id);
    expect(t.aiWrites.map((f) => f.id)).not.toContain(rigged.fields[0]!.id);
  });

  it("orders both lanes by capture priority, not by the order in the file", () => {
    const shuffled: Blueprint = { ...bp, fields: [...bp.fields].reverse() };
    const priorities = buildTrack(shuffled).rep.fields.map((f) => bp.fields.find((x) => x.id === f.id)!.capture.priority);
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
  });

  it("names the fields that gate Pass by their label, not their id", () => {
    const gates = bp.handoff.allowedWhen.requireVerified;
    expect(track.rep.gates).toHaveLength(gates.length);
    for (const id of gates) expect(track.rep.gates).toContain(bp.fields.find((f) => f.id === id)!.label);
    for (const f of track.rep.fields) expect(f.gatesPass).toBe(gates.includes(f.id));
  });

  it("falls back to the id when a gate names a field that is not there (the state lint reports)", () => {
    const broken: Blueprint = {
      ...bp,
      handoff: { ...bp.handoff, allowedWhen: { ...bp.handoff.allowedWhen, requireVerified: ["ghost_field"] } },
    };
    expect(buildTrack(broken).rep.gates).toEqual(["ghost_field"]);
  });

  it("carries the handoff lines through untouched", () => {
    expect(track.baton.repLine).toBe(bp.handoff.repLine);
    expect(track.baton.acceptance).toBe(bp.handoff.acceptance.phrase);
    expect(track.baton.autoBaton).toBe(bp.handoff.autoBaton);
  });

  it("gives every stage a sentence for its exit, and a disclosure title where there is one", () => {
    expect(track.stages).toHaveLength(bp.playbook.stages.length);
    for (const s of track.stages) {
      expect(s.exit.length).toBeGreaterThan(0);
      expect(STAGE_KIND_LABEL[s.kind]).toBeTruthy();
    }
    const disclose = bp.playbook.stages.find((s) => s.exit.kind === "disclosure_accepted");
    const exit = disclose?.exit;
    if (disclose && exit?.kind === "disclosure_accepted") {
      const shown = track.stages.find((s) => s.id === disclose.id)!;
      expect(shown.disclosureTitle).toBe(bp.playbook.disclosures.find((d) => d.id === exit.disclosure)!.title);
    }
  });

  it("is pure: the same blueprint gives the same track", () => {
    expect(JSON.stringify(buildTrack(bp))).toBe(JSON.stringify(buildTrack(bp)));
  });

  it("labels every setBy value", () => {
    for (const f of bp.fields) expect(SET_BY_LABEL[f.setBy]).toBeTruthy();
  });
});

describe("exitLabel", () => {
  it("names the disclosure and the connector rather than printing an id", () => {
    const d = bp.playbook.disclosures[0];
    if (d) expect(exitLabel({ kind: "disclosure_accepted", disclosure: d.id }, bp)).toContain(d.title);
    const c = bp.connectors[0];
    if (c) expect(exitLabel({ kind: "connector_succeeded", connector: c.id }, bp)).toContain(c.label);
  });

  it("falls back to the id when the reference is dangling", () => {
    expect(exitLabel({ kind: "disclosure_accepted", disclosure: "nope" }, bp)).toContain("nope");
    expect(exitLabel({ kind: "connector_succeeded", connector: "nope" }, bp)).toContain("nope");
  });

  it("covers the two conditions with no reference", () => {
    expect(exitLabel({ kind: "all_required_verified" }, bp)).toMatch(/verified/);
    expect(exitLabel({ kind: "end" }, bp)).toMatch(/ends/);
  });
});

describe("joinWords", () => {
  it("reads as a sentence", () => {
    expect(joinWords([])).toBe("");
    expect(joinWords(["a"])).toBe("a");
    expect(joinWords(["a", "b"])).toBe("a and b");
    expect(joinWords(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("lintSummary", () => {
  it("separates what blocks saving from what blocks test and publish (SAAS §5.2)", () => {
    const s = lintSummary([
      diag({ source: "schema", code: "SCHEMA_X" }),
      diag({ source: "lint", code: "L1" }),
      diag({ source: "lint", code: "W2", severity: "warn" }),
      diag({ source: "syntax", code: "CODEC_SYNTAX" }),
    ]);
    expect(s.blocking).toBe(2); // schema + syntax
    expect(s.lintErrors).toBe(1);
    expect(s.warnings).toBe(1);
    expect(s.items).toHaveLength(4);
  });

  it("is empty and clean for a document with no diagnostics", () => {
    expect(lintSummary([])).toEqual({ blocking: 0, lintErrors: 0, warnings: 0, items: [] });
  });

  it("orders errors before warnings, then syntax → schema → codec → lint, then by line", () => {
    const s = lintSummary([
      diag({ source: "lint", code: "L9", severity: "warn" }),
      diag({ source: "lint", code: "L2", range: { startLine: 40, startCol: 0, endLine: 40, endCol: 1 } }),
      diag({ source: "lint", code: "L1", range: { startLine: 9, startCol: 0, endLine: 9, endCol: 1 } }),
      diag({ source: "syntax", code: "CODEC_SYNTAX" }),
      diag({ source: "schema", code: "SCHEMA_X" }),
    ]);
    expect(s.items.map((d) => d.code)).toEqual(["CODEC_SYNTAX", "SCHEMA_X", "L1", "L2", "L9"]);
  });

  it("does not mutate the list it is given", () => {
    const list = [diag({ code: "B", severity: "warn" }), diag({ code: "A" })];
    lintSummary(list);
    expect(list.map((d) => d.code)).toEqual(["B", "A"]);
  });
});

describe("codeHref", () => {
  it("carries the range as a 1-based caret, since the codec's column is 0-based", () => {
    expect(codeHref("rly_1", { range: { startLine: 8, startCol: 10, endLine: 8, endCol: 14 } })).toBe("/app/relays/rly_1/code#L8:11");
  });

  it("links to the tab with no fragment when the diagnostic has no range", () => {
    expect(codeHref("rly_1", { range: null })).toBe("/app/relays/rly_1/code");
  });

  it("escapes the relay id", () => {
    expect(codeHref("a/b", { range: null })).toBe("/app/relays/a%2Fb/code");
  });
});
