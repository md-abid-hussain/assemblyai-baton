/**
 * The run detail composition: the provenance strip and the QA status (SAAS §6.2, PLATFORM §7.6). WP20·1.
 *
 * The strip exists so nobody mistakes a simulation for a recording, so the property under test is that the
 * derived strip **under-claims**: a run with no observable AI half reports `none`, never a hopeful `live`.
 */
import { describe, expect, it } from "vitest";

import type { RunListItem } from "@/core/contracts/ext/wp20-app";
import { ProvenanceStripSchema } from "@/core/contracts/v2/api";
import { provenanceOf, qaStatusOf } from "@/server/read-models/detail";

const run = (over: Partial<RunListItem> = {}): RunListItem => ({
  id: "cs_1",
  relayId: null,
  relayTitle: "Baton · insurance add-a-driver",
  relayVersion: null,
  source: "recorded",
  outcome: "completed",
  status: "completed",
  startedAt: "2026-09-20T10:00:00.000Z",
  endedAt: "2026-09-20T10:03:00.000Z",
  durationMs: 180000,
  aiSeconds: 42,
  readiness: { verified: 7, requiredTotal: 10 },
  qaProvisional: false,
  paymentStatus: null,
  simulated: false,
  ...over,
});

describe("provenanceOf", () => {
  it("returns WP7's persisted strip verbatim when the takeover carries one", () => {
    const persisted = {
      humanHalf: "recorded" as const,
      transcription: { kind: "cached" as const, date: "2026-09-19" },
      aiHalf: { kind: "recorded" as const, date: "2026-09-19" },
      customerInAiHalf: "mic" as const,
      detail: "Replayed from a cached transcript.",
    };
    expect(provenanceOf(run(), { provenance: persisted })).toEqual(persisted);
  });

  it("ignores a malformed persisted strip and derives instead", () => {
    const strip = provenanceOf(run(), { provenance: { humanHalf: "nonsense" } });
    expect(ProvenanceStripSchema.safeParse(strip).success).toBe(true);
    expect(strip.humanHalf).toBe("recorded");
  });

  it("marks a simulated run's human half and its synthetic customer", () => {
    const strip = provenanceOf(run({ source: "simulated", simulated: true }), {});
    expect(strip.humanHalf).toBe("simulated");
    expect(strip.customerInAiHalf).toBe("synthetic");
  });

  it("marks a text dry run as having no customer audio", () => {
    const strip = provenanceOf(run({ source: "text_dry_run", simulated: true, aiSeconds: 0 }), {});
    expect(strip.humanHalf).toBe("text_dry_run");
    expect(strip.customerInAiHalf).toBe("none");
    expect(strip.transcription.kind).toBe("cached");
  });

  it("under-claims the AI half rather than guessing it ran", () => {
    expect(provenanceOf(run({ aiSeconds: null }), {}).aiHalf).toEqual({ kind: "none", date: null });
    expect(provenanceOf(run({ aiSeconds: 0 }), {}).aiHalf.kind).toBe("none");
    expect(provenanceOf(run({ outcome: "in_progress" }), {}).aiHalf.kind).toBe("none");
    expect(provenanceOf(run({ aiSeconds: 12 }), {}).aiHalf.kind).toBe("live");
  });

  it("always produces a strip the v2 contract accepts", () => {
    for (const source of ["recorded", "simulated", "text_dry_run", "published"] as const) {
      const strip = provenanceOf(run({ source, simulated: source !== "recorded" }), null);
      expect(ProvenanceStripSchema.safeParse(strip).success).toBe(true);
    }
  });
});

describe("qaStatusOf", () => {
  const qa = {} as never;

  it("separates verified from provisional", () => {
    expect(qaStatusOf({ qa, provisional: false, verificationStatus: "completed" })).toBe("verified");
    expect(qaStatusOf({ qa, provisional: true, verificationStatus: "completed" })).toBe("provisional");
    // Numbers exist but the verifier has not finished: still provisional, never verified.
    expect(qaStatusOf({ qa, provisional: false, verificationStatus: "pending" })).toBe("provisional");
  });

  it("distinguishes 'still verifying' from 'there is no QA'", () => {
    expect(qaStatusOf({ qa: null, provisional: false, verificationStatus: "pending" })).toBe("pending");
    expect(qaStatusOf({ qa: null, provisional: false, verificationStatus: null })).toBe("none");
  });
});
