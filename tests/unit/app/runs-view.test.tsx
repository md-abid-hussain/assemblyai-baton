/**
 * The runs list, the case record and analytics, server-rendered (SAAS §6.2, §8.5, PLATFORM §7.6). WP20·1.
 *
 * The recurring assertion: **evidence is never overstated**. A simulated run says so, a provisional QA result
 * says so, a field with no evidence says so, and the analytics page produces no blended total.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/app/runs", useRouter: () => ({ refresh() {} }) }));

import { AnalyticsPanels } from "@/components/runs/analytics";
import { OutcomeBadge, QaBadge, ReadinessBadge, SourceBadge } from "@/components/runs/badges";
import { CaseRecord } from "@/components/runs/case-record";
import { ProvenanceStripView } from "@/components/runs/provenance-strip";
import { QaSummary } from "@/components/runs/qa-summary";
import { RunsTable } from "@/components/runs/runs-table";
import { RUN_SOURCES, type AnalyticsView, type CaseRecordView, type RunListItem } from "@/core/contracts/ext/wp20-app";

const run = (over: Partial<RunListItem> = {}): RunListItem => ({
  id: "cs_1",
  relayId: "rl_1",
  relayTitle: "Dental deposit (your copy)",
  relayVersion: 3,
  source: "simulated",
  outcome: "completed",
  status: "completed",
  startedAt: "2026-09-20T10:00:00.000Z",
  endedAt: "2026-09-20T10:03:00.000Z",
  durationMs: 183000,
  aiSeconds: 42,
  readiness: { verified: 7, requiredTotal: 10 },
  qaProvisional: true,
  paymentStatus: "paid",
  simulated: true,
  ...over,
});

describe("the runs table", () => {
  it("renders both densities: cards for 390 px and a real table above it", () => {
    const html = renderToStaticMarkup(<RunsTable runs={[run()]} />);
    expect(html).toContain("<table");
    expect(html).toContain("sm:hidden");
    expect(html).toContain("Dental deposit (your copy)");
  });

  it("links each run to its record", () => {
    expect(renderToStaticMarkup(<RunsTable runs={[run()]} />)).toContain("/app/runs/cs_1");
  });

  it("labels the source and the outcome in words, never in colour alone", () => {
    const html = renderToStaticMarkup(<RunsTable runs={[run()]} />);
    expect(html).toContain("Simulated");
    expect(html).toContain("Completed");
  });

  it("formats durations and timestamps identically on server and client (UTC, locale-free)", () => {
    const html = renderToStaticMarkup(<RunsTable runs={[run()]} />);
    expect(html).toContain("3:03");
    expect(html).toContain("20 Sep 2026, 10:00 UTC");
  });

  it("gives the accessible row link a name that identifies the run", () => {
    expect(renderToStaticMarkup(<RunsTable runs={[run()]} />)).toContain(
      "Open the run of Dental deposit (your copy)",
    );
  });

  it("renders an empty list without throwing", () => {
    expect(renderToStaticMarkup(<RunsTable runs={[]} />)).toContain("<table");
  });
});

describe("badges", () => {
  it("has a distinct label and hint for every source", () => {
    const labels = RUN_SOURCES.map((s) => renderToStaticMarkup(<SourceBadge source={s} />));
    expect(new Set(labels).size).toBe(RUN_SOURCES.length);
    expect(labels.join("")).toContain("A simulated call: synthetic voices, fictional people.");
    expect(labels.join("")).toContain("A recorded role-play call, transcribed for real.");
  });

  it("never claims a verified QA result while the verifier is still running", () => {
    expect(renderToStaticMarkup(<QaBadge status="provisional" />)).toContain("Provisional");
    expect(renderToStaticMarkup(<QaBadge status="pending" />)).toContain("Verifying");
    expect(renderToStaticMarkup(<QaBadge status="verified" />)).toContain("Verified");
  });

  it("marks an unfinished run as in progress", () => {
    expect(renderToStaticMarkup(<OutcomeBadge outcome="in_progress" />)).toContain("In progress");
  });

  it("shows a dash rather than 0/0 when there is no readiness", () => {
    expect(renderToStaticMarkup(<ReadinessBadge readiness={null} />)).toContain("—");
    expect(renderToStaticMarkup(<ReadinessBadge readiness={{ verified: 7, requiredTotal: 10 }} />)).toContain("7/10");
  });
});

describe("the provenance strip", () => {
  it("names all four segments of a simulated run", () => {
    const html = renderToStaticMarkup(
      <ProvenanceStripView
        strip={{
          humanHalf: "simulated",
          transcription: { kind: "live", date: "2026-09-20" },
          aiHalf: { kind: "live", date: "2026-09-20" },
          customerInAiHalf: "synthetic",
          detail: "Synthetic voices; the people are fictional.",
        }}
      />,
    );
    expect(html).toContain("Simulated call");
    expect(html).toContain("Transcribed live");
    expect(html).toContain("Live voice agent");
    expect(html).toContain("Synthetic customer");
    expect(html).toContain("Synthetic voices; the people are fictional.");
  });

  it("says plainly when no AI half ran", () => {
    const html = renderToStaticMarkup(
      <ProvenanceStripView
        strip={{
          humanHalf: "recorded",
          transcription: { kind: "cached", date: null },
          aiHalf: { kind: "none", date: null },
          customerInAiHalf: "none",
          detail: null,
        }}
      />,
    );
    expect(html).toContain("No AI half");
    expect(html).toContain("No customer audio");
  });
});

describe("the case record", () => {
  const record: CaseRecordView = {
    caseId: "cs_1",
    intent: "add_driver",
    stage: "confirm",
    readiness: { verified: 1, pending: 1, missing: 1, requiredTotal: 3, ready: false },
    fields: [
      {
        field: "driver_full_name",
        label: "Driver full name",
        status: "VERIFIED",
        conflict: false,
        value: "Maya Patel",
        reason: "Acknowledged by the customer at 01:12.",
        evidence: [{ channel: "customer", startMs: 72000, endMs: 74500, quote: "Yes, Maya Patel.", source: "stt_cache" }],
        required: true,
      },
      {
        field: "driver_dob",
        label: "Date of birth",
        status: "MISSING",
        conflict: false,
        value: null,
        reason: "Not mentioned yet.",
        evidence: [],
        required: true,
      },
      {
        field: "driver_relation",
        label: "Relationship to you",
        status: "PENDING",
        conflict: true,
        value: "daughter",
        reason: "The parties said different things.",
        evidence: [],
        required: true,
      },
    ],
    disclosures: [
      { kind: "premium_change", given: true, similarity: 0.92, ok: true, missingCritical: [] },
      { kind: "esign_consent", given: true, similarity: 0.4, ok: false, missingCritical: ["consent"] },
    ],
    confirmationNumber: "CNF-4821",
  };

  it("shows readiness, the stage and the confirmation number", () => {
    const html = renderToStaticMarkup(<CaseRecord record={record} />);
    expect(html).toContain("1/3");
    expect(html).toContain("required facts verified");
    expect(html).toContain("CNF-4821");
    expect(html).toContain("confirm");
  });

  it("quotes the evidence with its timecode and who said it", () => {
    const html = renderToStaticMarkup(<CaseRecord record={record} />);
    expect(html).toContain("Yes, Maya Patel.");
    expect(html).toContain("1:12");
    expect(html).toContain("Customer");
  });

  it("says a field was not captured rather than showing an empty value", () => {
    expect(renderToStaticMarkup(<CaseRecord record={record} />)).toContain("Not captured");
  });

  it("shows CONFLICT rather than the raw status when the parties disagree", () => {
    const html = renderToStaticMarkup(<CaseRecord record={record} />);
    expect(html).toContain("Conflict");
    expect(html).toContain("The parties said different things.");
  });

  it("reports a failed disclosure with what was missing", () => {
    expect(renderToStaticMarkup(<CaseRecord record={record} />)).toContain("Missing: consent");
  });
});

describe("the QA summary", () => {
  const qa = {
    provisional: true, reAsked: 0, newlyAsked: 3, pendingConfirmed: 2, verifiedReconfirmed: 1,
    disclosures: [], clickToFirstAudibleMs: 940, deadAirAfterRepMs: 120, turnLatencyP50Ms: 510,
    payment: "simulated" as const, handedBack: false, aiSeconds: 95, adviceFlags: 0, details: [],
  };

  it("says which numbers these are", () => {
    expect(renderToStaticMarkup(<QaSummary qa={qa} status="provisional" />)).toContain(
      "the verifier has not confirmed it yet",
    );
    expect(renderToStaticMarkup(<QaSummary qa={qa} status="verified" />)).toContain("Re-read from the recording");
  });

  it("flags advice given outside a disclosure, and says the target is zero", () => {
    const html = renderToStaticMarkup(<QaSummary qa={{ ...qa, adviceFlags: 2 }} status="verified" />);
    expect(html).toContain("2 agent sentences matched the advice lexicon");
    expect(html).toContain("The target is zero.");
  });

  it("explains an absent result instead of rendering blank", () => {
    expect(renderToStaticMarkup(<QaSummary qa={null} status="pending" />)).toContain("Verification is still running");
    expect(renderToStaticMarkup(<QaSummary qa={null} status="none" />)).toContain("no QA result");
  });
});

describe("analytics", () => {
  const view: AnalyticsView = {
    totalRuns: 4,
    bySource: [
      { source: "recorded", runs: 3, aiMinutes: 3 },
      { source: "simulated", runs: 1, aiMinutes: 0.5 },
    ],
    byOutcome: [
      { outcome: "completed", runs: 3 },
      { outcome: "failed", runs: 1 },
    ],
    firstRunAt: "2026-09-01T00:00:00.000Z",
    lastRunAt: "2026-09-10T00:00:00.000Z",
    windowDays: 30,
  };

  it("carries the 'never blended' note", () => {
    expect(renderToStaticMarkup(<AnalyticsPanels view={view} />)).toContain(
      "Recorded and simulated runs are counted separately and never blended.",
    );
  });

  it("reports no combined success rate", () => {
    const html = renderToStaticMarkup(<AnalyticsPanels view={view} />).toLowerCase();
    expect(html).not.toContain("success rate");
    expect(html).not.toContain("overall rate");
  });

  it("keeps the per-source counts and minutes apart", () => {
    const html = renderToStaticMarkup(<AnalyticsPanels view={view} />);
    expect(html).toContain("Recorded");
    expect(html).toContain("Simulated");
    expect(html).toContain("3 min");
    expect(html).toContain("0.5 min");
  });
});
