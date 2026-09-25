/**
 * WP7·2: the QA card's provisional numbers (DESIGN S3), computed on the page from the agent's own captions and tool
 * rail with WP1's `computeQa`, before WP8's verified result arrives.
 */
import { describe, expect, it } from "vitest";

import { fixtureLog } from "@/client/fixtures";
import { S01_POLICY } from "@/client/fixtures/builder";
import { criticalTokensOf, provisionalQa, provisionalQaInput } from "@/client/session/provisional-qa";
import { initialUiState, reduceEntry, type UiState } from "@/client/store/reduce";
import { disclosureText } from "@/core/compiler";
import type { CaseState } from "@/core/contracts/case";
import type { UiLogEntry } from "@/core/contracts/ext/wp7-ui";

/** s01-full folded up to the takeover's `done` (before the fixture's own QA events), plus the snapshot at `compiling`. */
function atDone(name = "s01-full"): { s: UiState; snapshot: CaseState | null } {
  const log = (fixtureLog(name) ?? []) as UiLogEntry[];
  let s = initialUiState();
  let snapshot: CaseState | null = null;
  for (const e of log) {
    if (e.type === "qa") continue;
    s = reduceEntry(s, e);
    if (e.type === "takeover.phase" && e.phase === "compiling") snapshot = s.caseState;
    if (e.type === "takeover.phase" && e.phase === "done") break;
  }
  return { s, snapshot };
}

describe("provisional QA", () => {
  it("scores the s01 AI half from its captions: nothing re-asked, both disclosures read, paid by webhook", () => {
    const { s, snapshot } = atDone();
    expect(s.qa.provisional).toBeNull();
    const qa = provisionalQa(s, snapshot);
    expect(qa).not.toBeNull();
    expect(qa).toMatchObject({ provisional: true, reAsked: 0, payment: "verified_webhook", handedBack: false });
    expect(qa!.disclosures.map((d) => d.kind)).toEqual(["premium_change", "esign_consent"]);
    for (const d of qa!.disclosures) expect(d.similarity).toBeGreaterThan(0.8);
    expect(qa!.aiSeconds).toBeGreaterThan(20);
    expect(qa!.clickToFirstAudibleMs).not.toBeNull();
  });

  it("anchors each disclosure window on its get_disclosure result (page clock relative to the arm)", () => {
    const { s, snapshot } = atDone();
    const input = provisionalQaInput(s, snapshot)!;
    expect(input.ch2[0]!.startMs).toBeGreaterThanOrEqual(0);
    const [prem, esign] = input.disclosures;
    expect(prem!.atMs).toBeGreaterThan(0);
    expect(esign!.atMs).toBeGreaterThan(prem!.atMs!);
    expect(esign!.criticalTokens).toEqual(["8207", "electronically", "paper copy"]);
    // tool pre-ambles are never scored (§5.10 rule 2)
    expect(input.ch2.some((u) => u.text === "")).toBe(false);
  });

  it("the hand-back run is scored as handed back and unpaid", () => {
    const { s, snapshot } = atDone("s01-handback");
    const qa = provisionalQa(s, snapshot);
    expect(qa).toMatchObject({ handedBack: true, payment: "unpaid" });
  });

  it("nothing to score before a pass", () => {
    expect(provisionalQa(initialUiState(), null)).toBeNull();
  });

  it("reads WP1's disclosure templates back into their critical tokens", () => {
    const snapshot = atDone().snapshot!;
    const ctx = { snapshot, policy: S01_POLICY, monthlyUsd: "142.00", dueTodayUsd: "23.40" };
    for (const kind of ["premium_change", "esign_consent"] as const) {
      const d = disclosureText(kind, ctx);
      expect(criticalTokensOf(kind, d.text, S01_POLICY)).toEqual(d.criticalTokens);
    }
  });
});
