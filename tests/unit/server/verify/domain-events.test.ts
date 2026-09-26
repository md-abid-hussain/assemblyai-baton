/**
 * WP18·1 org hook: `case.verified` from the async verification job (SAAS §7.1, §12 WP18 row).
 *
 * The event may only go out when the run carries an org (`cases.org_id`, WP19's `0002_saas`), and TASKS-v3 §2 rule 14
 * forbids WP18 from adding that column itself — so the emitter feature-detects it. This suite proves both halves:
 * silence before the column exists, a thin, validated payload once it does, and idempotence on a re-run. $0.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CaseVerifiedData } from "@/core/contracts/v3/events";
import type { QaResult } from "@/core/contracts/events";
import { emitCaseVerified, orgOfCase, resetCaseOrgColumnCache, runLinks } from "@/server/qa/domain-events";
import { createMemoryDomainEvents, resetSaasPorts, setDomainEvents, type MemoryDomainEvents } from "@/server/saas/ports";
import { createTestDb, HAS_DB, seedTakeover, type TestDb } from "./helpers";

const qaOf = (over: Partial<QaResult> = {}): QaResult => ({
  provisional: false,
  reAsked: 2,
  newlyAsked: 1,
  pendingConfirmed: 0,
  verifiedReconfirmed: 0,
  disclosures: [{ kind: "premium_change", similarity: 0.97, ok: true, missingCritical: [] }],
  clickToFirstAudibleMs: 900,
  deadAirAfterRepMs: null,
  turnLatencyP50Ms: 820,
  payment: "verified_webhook",
  handedBack: false,
  aiSeconds: 42,
  adviceFlags: 0,
  details: [],
  ...over,
});

describe.skipIf(!HAS_DB)("case.verified", () => {
  let t: TestDb;
  let events: MemoryDomainEvents;

  beforeAll(async () => {
    t = await createTestDb("wp18_events");
  });
  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.db.execute(sql`truncate table takeovers, cases restart identity cascade`);
    // WP19's 0002_saas has landed, so the migrated table HAS `org_id` and the drizzle schema puts it in every
    // INSERT — dropping it here (as this suite used to) makes `seedTakeover` fail before the assertion runs.
    // The column is now the starting state; the one test that needs it absent drops it *after* seeding.
    await t.db.execute(sql`alter table cases add column if not exists org_id text`);
    resetSaasPorts();
    resetCaseOrgColumnCache();
    events = createMemoryDomainEvents();
    setDomainEvents(events);
  });

  it("emits nothing while `cases.org_id` does not exist (SAAS §2.6: events are not back-filled)", async () => {
    const run = await seedTakeover(t.db);
    // Seed first, then remove the column: this is a pre-0002 database (a Zerops container between deploys).
    await t.db.execute(sql`alter table cases drop column org_id`);
    resetCaseOrgColumnCache();
    expect(await orgOfCase(t.db, run.caseId)).toBeNull();
    expect(await emitCaseVerified(t.db, { takeoverId: run.takeoverId, qa: qaOf(), appUrl: "https://x.test" })).toBe(false);
    expect(events.events).toEqual([]);
  });

  it("emits nothing for a provisional QA, an unknown takeover, or a run whose org is still null", async () => {
    const run = await seedTakeover(t.db);
    await t.db.execute(sql`alter table cases add column if not exists org_id text`);
    resetCaseOrgColumnCache();

    expect(await emitCaseVerified(t.db, { takeoverId: run.takeoverId, qa: qaOf({ provisional: true }), appUrl: null })).toBe(false);
    expect(await emitCaseVerified(t.db, { takeoverId: "tko_nope", qa: qaOf(), appUrl: null })).toBe(false);
    expect(await emitCaseVerified(t.db, { takeoverId: run.takeoverId, qa: qaOf(), appUrl: null })).toBe(false); // org_id is null
    expect(events.events).toEqual([]);
  });

  it("emits one thin, schema-valid payload once the run has an org, and is idempotent on a re-run", async () => {
    const run = await seedTakeover(t.db);
    await t.db.execute(sql`alter table cases add column if not exists org_id text`);
    resetCaseOrgColumnCache();
    await t.db.execute(sql`update cases set org_id = 'org_acme' where id = ${run.caseId}`);
    expect(await orgOfCase(t.db, run.caseId)).toBe("org_acme");

    expect(await emitCaseVerified(t.db, { takeoverId: run.takeoverId, qa: qaOf(), appUrl: "https://x.test/" })).toBe(true);
    expect(events.events).toHaveLength(1);
    const e = events.events[0]!;
    expect(e.orgId).toBe("org_acme");
    expect(e.type).toBe("case.verified");
    expect(e.dedupeKey).toBe(`case.verified:${run.takeoverId}`);

    const data = CaseVerifiedData.parse(e.data);
    expect(data.run_id).toBe(run.takeoverId);
    expect(data.relay_id).toBeNull(); // a legacy Baton run has no relay version
    expect(data.qa).toEqual({
      re_asked: 2,
      disclosures: [{ id: "premium_change", similarity: 0.97, ok: true }],
      verified_from_recording: true,
      provisional: false,
    });
    expect(data.fields_at_pass.required).toBeGreaterThan(0);
    expect(data.links).toEqual(runLinks("https://x.test/", run.takeoverId));

    // no case field values, no transcript text rode along
    const json = JSON.stringify(data);
    expect(json).not.toContain("Mark");

    // a retried verification does not double the delivery
    expect(await emitCaseVerified(t.db, { takeoverId: run.takeoverId, qa: qaOf(), appUrl: "https://x.test/" })).toBe(false);
    expect(events.events).toHaveLength(1);
  });

  it("builds absolute links, and relative ones when APP_URL is unset", () => {
    expect(runLinks("https://app.test", "tko_1")).toEqual({ run: "https://app.test/app/runs/tko_1", api: "https://app.test/api/v1/runs/tko_1" });
    expect(runLinks(null, "tko_1")).toEqual({ run: "/app/runs/tko_1", api: "/api/v1/runs/tko_1" });
  });
});
