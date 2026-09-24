import { describe, expect, it } from "vitest";

import {
  buildQaInput,
  disclosuresOf,
  keytermsOf,
  latencyOf,
  paymentOf,
  readMetrics,
  relMs,
  toolCallsOf,
  utterancesByChannel,
} from "@/server/qa/build-input";
import { artifactUrl, listSessionsSince } from "@/server/aai/va-rest";
import { webhookTarget } from "@/server/jobs/verify-takeover";
import { endedSession, FakeVaRest, field, POLICY, snapshot, TIMELINE_FIXTURE, transcriptFixture } from "./helpers";

describe("timeline → tool calls", () => {
  it("converts epoch-ms timeline times to session-relative ms (observed shape, WP5b T-D1-12 timeline)", () => {
    expect(relMs(1790273420248, 1790273390171)).toBe(30077);
    expect(relMs(30077, 1790273390171)).toBe(30077);
    expect(relMs(null, 1)).toBeNull();
  });

  it("keeps known tools only, stamped with the result time, in time order", () => {
    const calls = toolCallsOf(TIMELINE_FIXTURE);
    expect(calls).toEqual([{ name: "get_disclosure", atMs: 30077, args: { kind: "premium_change" } }]);
  });

  it("parses JSON-string arguments and tolerates a missing timeline", () => {
    expect(toolCallsOf(null)).toEqual([]);
    const t = { started_at_unix_ms: 0, turns: [{ tool_calls: [{ name: "get_disclosure", arguments: '{"kind":"esign_consent"}', dispatched_at_ms: 5 }] }] };
    expect(toolCallsOf(t)[0]).toEqual({ name: "get_disclosure", atMs: 5, args: { kind: "esign_consent" } });
  });
});

describe("async transcript → channels", () => {
  it("splits ch2 (agent) and ch1 (user) with word timings, sorted by start", () => {
    const { ch1, ch2 } = utterancesByChannel(transcriptFixture("t1"));
    expect(ch2.map((u) => u.startMs)).toEqual([560, 12000]);
    expect(ch1).toHaveLength(2);
    expect(ch2[0]!.words![0]).toEqual({ text: "Hi", startMs: 560, endMs: 810 });
  });
});

describe("metrics, disclosures, payment, latency", () => {
  const metrics = readMetrics({
    hud: { click_to_first_audible: 812, dead_air_after_rep: 400, turn_audible_latency: 950 },
    disclosures: { premium_change: { text: "Your new premium is $171 a month.", criticalTokens: ["171"] }, esign_consent: { text: "Is it OK if I text you?", criticalTokens: [] } },
    other: { kept: true },
  });

  it("anchors each disclosure on its get_disclosure result time, else null", () => {
    const d = disclosuresOf(metrics, toolCallsOf(TIMELINE_FIXTURE));
    expect(d).toEqual([
      { kind: "premium_change", text: "Your new premium is $171 a month.", criticalTokens: ["171"], atMs: 30077 },
      { kind: "esign_consent", text: "Is it OK if I text you?", criticalTokens: [], atMs: null },
    ]);
  });

  it("reads latency from metrics.hud and tolerates junk metrics", () => {
    expect(latencyOf(metrics)).toEqual({ clickToFirstAudibleMs: 812, deadAirAfterRepMs: 400, turnLatencyP50Ms: 950 });
    expect(latencyOf(readMetrics("junk"))).toEqual({ clickToFirstAudibleMs: null, deadAirAfterRepMs: null, turnLatencyP50Ms: null });
  });

  it("maps payments.status_source (only a succeeded payment counts)", () => {
    expect(paymentOf(null)).toBe("unpaid");
    expect(paymentOf({ status: "open", statusSource: "webhook", simulated: false })).toBe("unpaid");
    expect(paymentOf({ status: "succeeded", statusSource: "webhook", simulated: false })).toBe("verified_webhook");
    expect(paymentOf({ status: "succeeded", statusSource: "server_poll", simulated: false })).toBe("verified_poll");
    expect(paymentOf({ status: "succeeded", statusSource: "mock", simulated: true })).toBe("simulated");
  });
});

describe("keyterms", () => {
  it("uses entity displays, names and vehicle models; ≤50 chars, ≤6 words, deduped, capped", () => {
    const snap = snapshot({
      driver_full_name: field("driver_full_name", "VERIFIED", "lucas delgado", "Lucas Delgado"),
      garaging_zip: field("garaging_zip", "VERIFIED", "78701"),
      driver_dob: field("driver_dob", "PENDING", "2008-03-14", "March 14, 2008"),
      vehicle_assignment: field("vehicle_assignment", "PENDING", "veh1", "2014 Toyota Corolla"),
    });
    const k = keytermsOf(snap, POLICY);
    expect(k).toContain("Lucas Delgado");
    expect(k).toContain("78701");
    expect(k).toContain("Mark Delgado");
    expect(k).toContain("Toyota Corolla");
    expect(k).not.toContain("March 14, 2008"); // dates are not entity keyterms
    expect(new Set(k.map((x) => x.toLowerCase())).size).toBe(k.length);
    expect(keytermsOf(snap, POLICY, 2)).toHaveLength(2);
    expect(keytermsOf(null, null)).toEqual([]);
  });
});

describe("buildQaInput", () => {
  it("assembles a non-provisional input without prepending the greeting (the recording has it)", () => {
    const input = buildQaInput({
      snapshot: snapshot(),
      policy: POLICY,
      transcript: transcriptFixture("t1"),
      timeline: TIMELINE_FIXTURE,
      greeting: "Hi Mark",
      outcome: "handed_back",
      metrics: { disclosures: { premium_change: { text: "x", criticalTokens: [] } } },
      payment: null,
      durationSec: 62.4567,
    });
    expect(input.provisional).toBe(false);
    expect(input.prependGreeting).toBe(false);
    expect(input.handedBack).toBe(true);
    expect(input.aiSeconds).toBe(62.457);
    expect(input.toolCalls).toEqual([{ name: "get_disclosure", atMs: 30077 }]);
    expect(input.disclosures[0]!.atMs).toBe(30077);
    expect(input.ch2).toHaveLength(2);
  });
});

describe("va-rest helpers", () => {
  it("artifactUrl finds a typed artifact", () => {
    const s = endedSession("sess_a");
    expect(artifactUrl(s, "audio")).toMatch(/audio\.ogg/);
    expect(artifactUrl({ id: "x" }, "audio")).toBeNull();
  });

  it("listSessionsSince follows has_more/next_cursor and stops at the window", async () => {
    const rest = new FakeVaRest();
    const now = Date.now();
    const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    rest.pages = [
      { sessions: [{ id: "s1", created_at: iso(1) }, { id: "s2", created_at: iso(5) }], hasMore: true, nextCursor: "c1" },
      { sessions: [{ id: "s3", created_at: iso(30) }], hasMore: true, nextCursor: "c2" },
      { sessions: [{ id: "s4", created_at: iso(59) }, { id: "s5", created_at: iso(61) }], hasMore: true, nextCursor: "c3" },
      { sessions: [{ id: "s6", created_at: iso(90) }], hasMore: false, nextCursor: null },
    ];
    const r = await listSessionsSince(rest, { sinceMs: now - 60 * 60_000 });
    expect(r.sessions.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(r.pages).toBe(3);
    expect(rest.calls).toEqual(["list:", "list:c1", "list:c2"]);
  });

  it("listSessionsSince stops on a repeated cursor (an ignored cursor parameter)", async () => {
    const rest = new FakeVaRest();
    rest.pages = [{ sessions: [{ id: "s1" }], hasMore: true, nextCursor: "c0" }];
    const r = await listSessionsSince(rest, { sinceMs: 0, maxPages: 5 });
    expect(r.truncated).toBe(true);
    expect(r.pages).toBeLessThanOrEqual(2);
  });
});

describe("webhookTarget", () => {
  it("is poll-only on localhost, http, or without a secret", () => {
    expect(webhookTarget({ appUrl: "http://localhost:3110", webhookSecret: "s" }, "j")).toBeNull();
    expect(webhookTarget({ appUrl: "https://127.0.0.1", webhookSecret: "s" }, "j")).toBeNull();
    expect(webhookTarget({ appUrl: "https://baton.zerops.app", webhookSecret: null }, "j")).toBeNull();
    expect(webhookTarget({ appUrl: "https://baton.zerops.app/", webhookSecret: "s" }, "j 1")).toEqual({
      url: "https://baton.zerops.app/api/webhooks/assemblyai?job=j%201",
      secret: "s",
    });
  });
});
