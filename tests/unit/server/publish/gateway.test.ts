/**
 * WP18·1: the published gateway and THE ONE state route over real Postgres (PLATFORM §6.6, §8.3).
 * TASKS-v2 §6 WP18 acceptance 3: a bad key → 401; no active run → `no_active_call`; a repeat within 30 s returns the
 * stored result and executes nothing; a stage change carries `next_step`. Plus SAAS §10.1 rule 5: a published run
 * executes in the PUBLICATION's org, never the visitor's. $0.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PublishedToolContext } from "@/core/contracts/ext/wp18-publish";
import { connectorCalls } from "@/server/db/schema";
import { PublishGateway } from "@/server/publish/gateway";
import { PgPublisher } from "@/server/publish/service";
import { readPublishedRunState } from "@/server/publish/state";
import { resetSaasPorts, setOrgCounter } from "@/server/saas/ports";
import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";
import { publishFixture, seedRelay, seedRun, type PublishFixture } from "./helpers";

const WS = "ws_owner";
const VISITOR = "visitorX";
const ACTOR = { orgId: WS, visitorId: "owner", ipKey: "ip", userId: null, kind: "visitor" as const, label: "owner" };

describe.skipIf(!HAS_DB)("published gateway", () => {
  let t: TestDb;
  let f: PublishFixture;
  let publisher: PgPublisher;
  let gateway: PublishGateway;
  let pubId: string;
  let key: string;
  let versionId: string;
  let run: { caseId: string; takeoverId: string };

  beforeAll(async () => {
    t = await createTestDb("wp18_gateway", { poolMax: 4 });
  });
  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.db.execute(sql`truncate table relay_publications, connector_calls, takeovers, cases, relay_versions, relays restart identity cascade`);
    resetSaasPorts();
    setOrgCounter("livePublications", () => 0);
    f = publishFixture(t.db);
    publisher = new PgPublisher(f.deps);
    gateway = new PublishGateway(f.deps, publisher);
    const relay = await seedRelay(f.registry, WS);
    const r = await publisher.publishFor(relay.id, ACTOR);
    pubId = r.view.id;
    key = (f.rest.created[0]!.def.tools![0] as { http: { headers: { value?: string }[] } }).http.headers[0]!.value!;
    versionId = (await publisher.byId(pubId))!.versionId;
    run = await seedRun(t.db, { visitorId: VISITOR, relayVersionId: versionId, stage: "pay" });
  });

  const call = (o: Partial<{ tool: string; key: string | null; args: unknown }> = {}) =>
    gateway.handle({
      publicationId: pubId,
      tool: o.tool ?? "send_deposit_link",
      key: o.key === undefined ? key : o.key,
      args: "args" in o ? o.args : { amount_usd: 25 },
      origin: "https://changeover.example",
    });

  it("401s a wrong or missing key and never touches the tool service", async () => {
    await publisher.acquireRun(pubId, run.takeoverId);
    expect((await call({ key: "b".repeat(64) })).status).toBe(401);
    expect((await call({ key: null })).status).toBe(401);
    expect(f.tools.calls).toHaveLength(0);

    const unknown = await gateway.handle({ publicationId: "pub_nope", tool: "send_deposit_link", key, args: {}, origin: "o" });
    expect(unknown.status).toBe(404);
  });

  it("answers `no_active_call` (HTTP 200, so the agent can speak) when no run holds the slot", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "no_active_call" });
    expect(f.tools.calls).toHaveLength(0);

    // ... and again once the lease has run out
    await publisher.acquireRun(pubId, run.takeoverId);
    f.clock.now += 10 * 60_000;
    expect((await call()).body).toEqual({ status: "no_active_call" });
  });

  it("runs the tool in the PUBLICATION's org with the run's case, and carries next_step in-band", async () => {
    await publisher.acquireRun(pubId, run.takeoverId);
    f.tools.next = { result: { status: "link_sent", data: { amount: "25.00" } }, stage: "close", nextStep: "Send the confirmation and close warmly.", ui: { sms: "pay here" } };

    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "link_sent", data: { amount: "25.00" }, next_step: "Send the confirmation and close warmly." });

    expect(f.tools.calls).toHaveLength(1);
    const ctx = f.tools.calls[0]!.ctx as PublishedToolContext;
    expect(ctx.mode).toBe("published");
    expect(ctx.publicationId).toBe(pubId);
    expect(ctx.workspaceId).toBe(WS); // the relay owner's workspace, NOT the visitor's
    expect(ctx.orgId).toBe(WS);
    expect(ctx.caseId).toBe(run.caseId);
    expect(ctx.takeoverId).toBe(run.takeoverId);
    expect(ctx.callId).toBeNull(); // AssemblyAI sends no call id (WP18·0 P-2)
    expect(f.tools.calls[0]!.args).toEqual({ amount_usd: 25 });

    const [row] = await t.db.select().from(connectorCalls);
    expect(row!.mode).toBe("published");
    expect(row!.publicationId).toBe(pubId);
    expect(row!.relayVersionId).toBe(versionId);
    expect(row!.connectorId).toBe("deposit_link");
    expect(row!.argsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dedupes the same (run, tool, args) within 30 s: the stored body comes back and nothing executes twice", async () => {
    await publisher.acquireRun(pubId, run.takeoverId);
    f.tools.next = { result: { status: "link_sent", checkout: "co_1" }, nextStep: null };
    const first = await call();

    f.clock.now += 5_000;
    f.tools.next = { result: { status: "link_sent", checkout: "co_2" }, nextStep: null };
    const again = await call();
    expect(again.body).toEqual(first.body); // the stored result, not a second checkout
    expect(f.tools.calls).toHaveLength(1);
    expect(await t.db.$count(connectorCalls)).toBe(1);

    // different arguments are a different call
    await gateway.handle({ publicationId: pubId, tool: "send_deposit_link", key, args: { amount_usd: 50 }, origin: "o" });
    expect(f.tools.calls).toHaveLength(2);

    // and past the window the same arguments execute again
    f.clock.now += 31_000;
    const third = await call();
    expect(third.body).toMatchObject({ checkout: "co_2" });
    expect(f.tools.calls).toHaveLength(3);
  });

  it("degrades to a spoken-answer status instead of a 500: no tool service, a thrown handler, bad args", async () => {
    await publisher.acquireRun(pubId, run.takeoverId);
    const noTools = publishFixture(t.db);
    const bare = new PublishGateway({ ...noTools.deps, db: t.db, tools: () => null }, publisher);
    const r = await bare.handle({ publicationId: pubId, tool: "send_deposit_link", key, args: {}, origin: "o" });
    expect(r).toEqual({ status: 200, body: { status: "unavailable" } });

    f.tools.throws = new Error("boom");
    const thrown = await call({ args: { amount_usd: 99 } });
    expect(thrown.body).toEqual({ status: "failed" });
    f.tools.throws = null;

    expect((await call({ args: [1, 2] })).body).toEqual({ status: "failed", error: "bad_arguments" });
    expect((await call({ tool: "NOT A TOOL" })).status).toBe(404);
  });

  it("every call keeps the run's lease alive", async () => {
    await publisher.acquireRun(pubId, run.takeoverId);
    f.clock.now += 50_000;
    await call();
    const row = (await publisher.byId(pubId))!.pub;
    expect(new Date(row.activeUntil!).getTime()).toBeGreaterThan(f.clock.now);
  });
});

describe.skipIf(!HAS_DB)("the one state route", () => {
  let t: TestDb;
  let f: PublishFixture;
  let publisher: PgPublisher;
  let gateway: PublishGateway;
  let pubId: string;
  let key: string;
  let run: { caseId: string; takeoverId: string };

  beforeAll(async () => {
    t = await createTestDb("wp18_state", { poolMax: 4 });
  });
  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.db.execute(sql`truncate table relay_publications, connector_calls, takeovers, cases, relay_versions, relays restart identity cascade`);
    resetSaasPorts();
    setOrgCounter("livePublications", () => 0);
    f = publishFixture(t.db);
    publisher = new PgPublisher(f.deps);
    gateway = new PublishGateway(f.deps, publisher);
    const relay = await seedRelay(f.registry, WS);
    const r = await publisher.publishFor(relay.id, ACTOR);
    pubId = r.view.id;
    key = (f.rest.created[0]!.def.tools![0] as { http: { headers: { value?: string }[] } }).http.headers[0]!.value!;
    const versionId = (await publisher.byId(pubId))!.versionId;
    run = await seedRun(t.db, { visitorId: VISITOR, relayVersionId: versionId, stage: "confirm" });
    await publisher.acquireRun(pubId, run.takeoverId);
  });

  const state = (after = 0, visitorId: string | null = VISITOR) =>
    readPublishedRunState(f.deps, publisher, { publicationId: pubId, takeoverId: run.takeoverId, after, visitorId });

  it("serves the stage, a recompiled prompt with the published rules, and no events yet", async () => {
    const r = await state();
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.state.stage).toBe("confirm");
    expect(r.state.stageSeq).toBe(0);
    expect(r.state.systemPrompt).toContain("next_step");
    expect(r.state.systemPrompt).toContain("baton-deploy=test-wp18");
    expect(r.state.transcriptionMode).toBe("balanced");
    expect(r.state.events).toEqual([]);
    expect(r.state.cursor).toBe(0);
    expect(r.state.ended).toBe(false);
    expect(r.state.activeUntil).not.toBeNull();
  });

  it("turns gateway calls into UI events and advances the cursor", async () => {
    f.tools.next = { result: { status: "link_sent" }, stage: "pay", nextStep: "Text the deposit link and wait.", ui: { sms: "Brightside: pay here" } };
    await gateway.handle({ publicationId: pubId, tool: "send_deposit_link", key, args: { amount_usd: 25 }, origin: "o" });

    const r = await state();
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.state.events).toHaveLength(1);
    expect(r.state.events[0]).toMatchObject({ seq: 1, tool: "send_deposit_link", status: "ok", stage: "pay", ui: { sms: "Brightside: pay here" } });
    expect(r.state.cursor).toBe(1);
    expect(r.state.nextStep).toBe("Text the deposit link and wait.");

    const after = await state(1);
    if (after.kind !== "ok") throw new Error("expected ok");
    expect(after.state.events).toEqual([]);
    expect(after.state.cursor).toBe(1);
  });

  it("reports `ended` when the run loses the slot or the takeover finishes, and hides another visitor's run", async () => {
    await publisher.release(pubId, run.takeoverId);
    const released = await state();
    if (released.kind !== "ok") throw new Error("expected ok");
    expect(released.state.ended).toBe(true);

    const other = await state(0, "someone_else");
    expect(other.kind).toBe("forbidden");

    const missing = await readPublishedRunState(f.deps, publisher, { publicationId: pubId, takeoverId: "tko_nope", after: 0, visitorId: VISITOR });
    expect(missing.kind).toBe("not_found");
  });
});
