/**
 * `RunsReadModel` (SAAS §6.2). WP20·1.
 *
 * The queries are exercised against a fake `execute` that captures the rendered SQL, so the two properties
 * that actually matter can be asserted without a database: **every query carries the tenant predicate**, and
 * **every filter value is a bound parameter** rather than concatenated text.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db";
import { RunsReadModel, decodeCursor, encodeCursor, qaOf } from "@/server/read-models/runs";
import { resetSchemaProbe } from "@/server/read-models/tenant";

const dialect = new PgDialect();

interface Capture {
  sql: string;
  params: unknown[];
}

/** Answers the schema probe with "no org_id" and records every other query. */
function capturingDb(rows: Record<string, unknown>[] = []): { db: Db; queries: Capture[] } {
  const queries: Capture[] = [];
  const db = {
    execute: async (q: unknown) => {
      const rendered = dialect.sqlToQuery(q as never);
      if (rendered.sql.includes("information_schema")) return { rows: [{ n: 0 }] };
      queries.push({ sql: rendered.sql, params: rendered.params });
      return { rows };
    },
  } as unknown as Db;
  return { db, queries };
}

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "cs_1",
  mode: "live",
  status: "completed",
  created_at: new Date("2026-09-20T10:00:00.000Z"),
  updated_at: new Date("2026-09-20T10:03:00.000Z"),
  sim_call_id: null,
  takeover_id: "tk_1",
  armed_at: new Date("2026-09-20T10:01:00.000Z"),
  ended_at: new Date("2026-09-20T10:03:00.000Z"),
  metrics: {},
  verification_status: "completed",
  qa: null,
  payment_status: null,
  relay_id: null,
  relay_title: null,
  relay_version: null,
  source: "recorded",
  outcome: "completed",
  readiness: { verified: 7, requiredTotal: 10 },
  duration_ms: 180000,
  ...over,
});

beforeEach(() => resetSchemaProbe());

describe("cursors", () => {
  it("round-trip", () => {
    const at = new Date("2026-09-20T10:00:00.000Z");
    const back = decodeCursor(encodeCursor(at, "cs_1"));
    expect(back).toEqual({ createdAt: at.toISOString(), id: "cs_1" });
  });

  it("treats junk as 'no cursor' rather than as an error", () => {
    for (const bad of [undefined, "", "!!!", "Zm9v", Buffer.from("|cs_1").toString("base64url")]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});

describe("qaOf", () => {
  const base = {
    provisional: false, reAsked: 1, newlyAsked: 2, pendingConfirmed: 3, verifiedReconfirmed: 4,
    disclosures: [], clickToFirstAudibleMs: 900, deadAirAfterRepMs: 100, turnLatencyP50Ms: 500,
    payment: "unpaid" as const, handedBack: false, aiSeconds: 42, adviceFlags: 0, details: [],
  };

  it("prefers the verified result", () => {
    const r = qaOf({ qa: base, metrics: { provisionalQa: { ...base, aiSeconds: 1 } } });
    expect(r.qa?.aiSeconds).toBe(42);
    expect(r.provisional).toBe(false);
  });

  it("falls back to the takeover's provisional numbers, and says they are provisional", () => {
    const r = qaOf({ qa: null, metrics: { provisionalQa: { ...base, provisional: true } } });
    expect(r.qa?.aiSeconds).toBe(42);
    expect(r.provisional).toBe(true);
  });

  it("reports nothing rather than a half-parsed result", () => {
    expect(qaOf({ qa: { aiSeconds: 5 }, metrics: null })).toEqual({ qa: null, provisional: false });
  });
});

describe("every query is tenant-scoped and fully parameterized", () => {
  it("list()", async () => {
    const { db, queries } = capturingDb([row()]);
    await new RunsReadModel(db).list("ws_vid", { source: "simulated", since: "2026-09-01", limit: 5 });
    const q = queries[0]!;
    expect(q.sql).toContain("c.visitor_id = $1");
    expect(q.params[0]).toBe("vid");
    expect(q.params).toContain("simulated");
    expect(q.params).toContain("2026-09-01T00:00:00.000Z");
    // The filter VALUES are compared against placeholders, never spliced in. (`'simulated'` does appear in the
    // statement, but only inside the fixed `case` expression that derives the source column.)
    expect(q.sql).toMatch(/end\) = \$\d+/);
    expect(q.sql).not.toContain("2026-09-01");
  });

  it("get(), relayOptions(), analytics(), aiMinutesThisMonth() and count()", async () => {
    const { db, queries } = capturingDb([]);
    const m = new RunsReadModel(db);
    await m.get("ws_vid", "cs_1");
    await m.relayOptions("ws_vid");
    await m.analytics("ws_vid", 30);
    await m.aiMinutesThisMonth("ws_vid");
    await m.count("ws_vid");
    expect(queries).toHaveLength(5);
    for (const q of queries) {
      expect(q.sql).toContain("c.visitor_id = $1");
      expect(q.params[0]).toBe("vid");
    }
  });

  it("an org with no rows in this schema generation can reach nothing", async () => {
    const { db, queries } = capturingDb([row()]);
    await new RunsReadModel(db).list("org_someone_else", {});
    expect(queries[0]!.sql).toContain("false");
    expect(queries[0]!.sql).not.toContain("visitor_id");
  });
});

describe("list()", () => {
  it("maps a row onto the view type", async () => {
    const { db } = capturingDb([row()]);
    const page = await new RunsReadModel(db).list("ws_vid");
    expect(page.items[0]).toMatchObject({
      id: "cs_1",
      source: "recorded",
      outcome: "completed",
      durationMs: 180000,
      readiness: { verified: 7, requiredTotal: 10 },
      simulated: false,
    });
  });

  it("names a legacy Baton run rather than leaving the relay column blank", async () => {
    const { db } = capturingDb([row({ relay_title: null })]);
    const page = await new RunsReadModel(db).list("ws_vid");
    expect(page.items[0]!.relayTitle).toBe("Baton · insurance add-a-driver");
  });

  it("returns a cursor only when there is another page", async () => {
    const one = await new RunsReadModel(capturingDb([row()]).db).list("ws_vid", { limit: 1 });
    expect(one.nextCursor).toBeNull();

    const two = await new RunsReadModel(capturingDb([row({ id: "cs_1" }), row({ id: "cs_2" })]).db).list("ws_vid", {
      limit: 1,
    });
    expect(two.items).toHaveLength(1);
    expect(decodeCursor(two.nextCursor ?? undefined)?.id).toBe("cs_1");
  });

  it("clamps the limit to 1..100", async () => {
    for (const [given, expected] of [
      [0, 1],
      [1000, 100],
      [undefined, 20],
    ] as const) {
      const { db, queries } = capturingDb([]);
      await new RunsReadModel(db).list("ws_vid", { limit: given });
      // limit + 1 is asked for, so the model can tell whether another page exists.
      expect(queries[0]!.params).toContain(expected + 1);
    }
  });
});

describe("analytics()", () => {
  it("keeps sources apart and never produces a blended total rate", async () => {
    const { db } = capturingDb([
      { source: "recorded", outcome: "completed", runs: 3, ai_seconds: 180, first_at: new Date("2026-09-01T00:00:00Z"), last_at: new Date("2026-09-10T00:00:00Z") },
      { source: "simulated", outcome: "failed", runs: 1, ai_seconds: 30, first_at: new Date("2026-09-05T00:00:00Z"), last_at: new Date("2026-09-05T00:00:00Z") },
    ]);
    const view = await new RunsReadModel(db).analytics("ws_vid", 30);
    expect(view.totalRuns).toBe(4);
    expect(view.bySource).toEqual([
      { source: "recorded", runs: 3, aiMinutes: 3 },
      { source: "simulated", runs: 1, aiMinutes: 0.5 },
    ]);
    expect(view.byOutcome).toEqual([
      { outcome: "completed", runs: 3 },
      { outcome: "failed", runs: 1 },
    ]);
    expect(view.firstRunAt).toBe("2026-09-01T00:00:00.000Z");
    expect(view.lastRunAt).toBe("2026-09-10T00:00:00.000Z");
    expect(Object.keys(view)).not.toContain("successRate");
  });
});

describe("aiMinutesThisMonth()", () => {
  it("splits by provenance and gives a text dry run no AI minutes", async () => {
    const { db } = capturingDb([
      { source: "recorded", ai_seconds: 120 },
      { source: "simulated", ai_seconds: 60 },
      { source: "text_dry_run", ai_seconds: 999 },
    ]);
    const out = await new RunsReadModel(db).aiMinutesThisMonth("ws_vid");
    expect(out).toMatchObject({ recorded: 2, simulated: 1, published: 0 });
  });
});
